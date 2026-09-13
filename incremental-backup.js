const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Secret FIREBASE_SERVICE_ACCOUNT non configurato.");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const auth = admin.auth();

const SOURCE_ROOT = process.argv[2] || process.env.BACKUP_SOURCE_ROOT || path.join(__dirname, "private-backup", "backups");
const OUTPUT_ROOT = process.argv[3] || process.env.BACKUP_OUTPUT_ROOT || path.join(__dirname, "backups");
const CHANGELOG_COLLECTION = process.env.BACKUP_CHANGELOG_COLLECTION || "logs";
const LEGACY_CHECKPOINT_SAFETY_MS = 10 * 60 * 1000;
const AUTH_FULL_REFRESH_MAX_AGE_DAYS = Math.max(1, Number(process.env.AUTH_FULL_REFRESH_MAX_AGE_DAYS || 28));

const FALLBACK_COLLECTIONS = [
  "availability",
  "activeBookings",
  "calendarClosures",
  "receipts",
  "mailRequests",
  "phoneClaims",
  "admins",
];

const TIMESTAMP_CHANGE_FIELDS = {
  bookings: ["updatedAt", "createdAt", "cancelledAt", "confirmedAt", "completedAt", "noShowAt"],
  users: ["updatedAt", "createdAt"],
};

function safeTimestamp() {
  return new Date().toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function serializeValue(value) {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __type: "bytes", base64: Buffer.from(value).toString("base64") };
  }
  if (value instanceof admin.firestore.Timestamp) {
    return { __type: "timestamp", seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value instanceof Date) return { __type: "date", iso: value.toISOString() };
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type: "geopoint", latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof admin.firestore.DocumentReference) {
    return { __type: "reference", path: value.path };
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serializeValue(child)]));
  }
  return value;
}

function latestBackupFolder(root) {
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
  return dirs.length ? path.join(root, dirs[dirs.length - 1]) : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPreviousState() {
  const folder = latestBackupFolder(SOURCE_ROOT);
  if (!folder) return null;
  const firestorePath = path.join(folder, "firestore.json");
  const authPath = path.join(folder, "authentication.json");
  const metadataPath = path.join(folder, "metadata.json");
  if (![firestorePath, authPath, metadataPath].every(fs.existsSync)) return null;
  return {
    folder,
    firestore: readJson(firestorePath),
    authentication: readJson(authPath),
    metadata: readJson(metadataPath),
  };
}

function serializeMultiFactor(user) {
  const factors = user.multiFactor?.enrolledFactors || [];
  if (!factors.length) return null;
  return {
    enrolledFactors: factors.map(factor => ({
      uid: factor.uid,
      displayName: factor.displayName || undefined,
      enrollmentTime: factor.enrollmentTime || undefined,
      factorId: factor.factorId,
      phoneNumber: factor.phoneNumber || undefined,
      totpInfo: factor.totpInfo || undefined,
    })),
  };
}

function summarizeAuthentication(users) {
  let passwordUsers = 0;
  let passwordHashes = 0;
  for (const user of users || []) {
    const hasPasswordProvider = (user.providerData || []).some(provider => provider.providerId === "password");
    if (!hasPasswordProvider) continue;
    passwordUsers += 1;
    if (user.passwordHash) passwordHashes += 1;
  }
  return { passwordUsers, passwordHashes };
}

async function exportAuthentication() {
  const users = [];
  const missingPasswordHashes = [];
  let pageToken;

  do {
    const result = await auth.listUsers(1000, pageToken);
    for (const user of result.users) {
      const providerData = user.providerData.map(provider => ({
        uid: provider.uid,
        email: provider.email || null,
        displayName: provider.displayName || null,
        photoURL: provider.photoURL || null,
        phoneNumber: provider.phoneNumber || null,
        providerId: provider.providerId,
      }));
      const hasPasswordProvider = providerData.some(provider => provider.providerId === "password");
      if (hasPasswordProvider && !user.passwordHash) missingPasswordHashes.push(user.uid);
      users.push({
        uid: user.uid,
        email: user.email || null,
        emailVerified: user.emailVerified,
        displayName: user.displayName || null,
        photoURL: user.photoURL || null,
        phoneNumber: user.phoneNumber || null,
        disabled: user.disabled,
        providerData,
        customClaims: user.customClaims || {},
        passwordHash: user.passwordHash || null,
        passwordSalt: user.passwordSalt || null,
        tenantId: user.tenantId || null,
        tokensValidAfterTime: user.tokensValidAfterTime || null,
        metadata: {
          creationTime: user.metadata.creationTime || null,
          lastSignInTime: user.metadata.lastSignInTime || null,
          lastRefreshTime: user.metadata.lastRefreshTime || null,
        },
        multiFactor: serializeMultiFactor(user),
      });
    }
    pageToken = result.pageToken;
  } while (pageToken);

  if (missingPasswordHashes.length) {
    throw new Error(
      "Backup Authentication incompleto: mancano gli hash password per " +
      `${missingPasswordHashes.length} utenti password.`
    );
  }

  return { users, ...summarizeAuthentication(users) };
}

function collectCandidateRefs(log) {
  const data = log.data || {};
  const refs = [];
  const add = (collection, id) => {
    if (collection && id) refs.push({ collection, id: String(id) });
  };

  switch (log.type) {
    case "booking_created":
    case "booking_updated":
    case "booking_cancelled":
    case "booking_deleted":
      add("bookings", data.bookingId);
      break;
    case "register_success":
    case "login_success":
      add("users", log.userId);
      break;
    case "backup_change":
      if (Array.isArray(data.paths)) {
        for (const value of data.paths) {
          const parts = String(value || "").split("/").filter(Boolean);
          if (parts.length === 2) add(parts[0], parts[1]);
        }
      }
      break;
  }
  return refs;
}

function resolvePreviousCheckpoint(previous) {
  const explicit = previous.metadata.changeCheckpointAt;
  if (explicit) {
    const parsed = new Date(explicit);
    if (!Number.isNaN(parsed.getTime())) return { date: parsed, legacySafetyWindow: false };
  }

  const createdAt = new Date(previous.metadata.createdAt || 0);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error("metadata.createdAt del backup precedente non valido.");
  }

  return {
    date: new Date(createdAt.getTime() - LEGACY_CHECKPOINT_SAFETY_MS),
    legacySafetyWindow: true,
  };
}

async function fetchLogsSince(date) {
  const since = admin.firestore.Timestamp.fromDate(date);
  const snapshot = await db.collection(CHANGELOG_COLLECTION).where("createdAt", ">", since).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function addTimestampCandidates(refs, sinceDate) {
  const since = admin.firestore.Timestamp.fromDate(sinceDate);
  const queryStats = [];

  for (const [collectionName, fields] of Object.entries(TIMESTAMP_CHANGE_FIELDS)) {
    for (const field of fields) {
      try {
        const snap = await db.collection(collectionName).where(field, ">", since).get();
        for (const doc of snap.docs) {
          refs.set(`${collectionName}/${doc.id}`, { collection: collectionName, id: doc.id });
        }
        queryStats.push({ collection: collectionName, field, matches: snap.size });
      } catch (error) {
        console.warn(`Query incrementale ${collectionName}.${field} non riuscita:`, error.message || error);
        queryStats.push({ collection: collectionName, field, error: String(error.message || error) });
      }
    }
  }

  return queryStats;
}

async function refreshDocument(state, collection, id) {
  const snap = await db.collection(collection).doc(id).get();
  state[collection] = state[collection] || {};
  if (!snap.exists) {
    delete state[collection][id];
    return { collection, id, action: "delete" };
  }
  state[collection][id] = { data: serializeValue(snap.data()), subcollections: {} };
  return { collection, id, action: "upsert" };
}

async function refreshFallbackCollections(state) {
  const refreshed = [];
  for (const name of FALLBACK_COLLECTIONS) {
    const snap = await db.collection(name).get();
    const docs = {};
    for (const doc of snap.docs) {
      docs[doc.id] = { data: serializeValue(doc.data()), subcollections: {} };
    }
    state[name] = docs;
    refreshed.push({ collection: name, count: snap.size });
  }
  return refreshed;
}

function refreshLogsCollection(state, logs) {
  state[CHANGELOG_COLLECTION] = state[CHANGELOG_COLLECTION] || {};
  for (const log of logs) {
    const data = { ...log };
    delete data.id;
    state[CHANGELOG_COLLECTION][log.id] = { data: serializeValue(data), subcollections: {} };
  }
}

function recordData(entry) {
  return entry?.data || entry || {};
}

function purgeDeletedAuthUsers(state, previousAuthentication, currentAuthentication) {
  const previousUids = new Set((previousAuthentication || []).map(user => user.uid).filter(Boolean));
  const currentUids = new Set((currentAuthentication || []).map(user => user.uid).filter(Boolean));
  const deletedUids = [...previousUids].filter(uid => !currentUids.has(uid));
  if (!deletedUids.length) return [];

  const deletedSet = new Set(deletedUids);
  const deleteDirect = (collection, id) => {
    if (state[collection]) delete state[collection][id];
  };

  for (const uid of deletedUids) {
    deleteDirect("users", uid);
    deleteDirect("activeBookings", uid);
    deleteDirect("admins", uid);
  }

  for (const collectionName of ["bookings", "availability", "receipts", "phoneClaims", "mailRequests"]) {
    const collection = state[collectionName] || {};
    for (const [id, entry] of Object.entries(collection)) {
      const data = recordData(entry);
      const owner = data.userId || data.uid || data.requesterUid;
      if (owner && deletedSet.has(owner)) delete collection[id];
    }
  }

  return deletedUids;
}

function authRefreshDecision(previous, logs, changed, now) {
  const reasons = [];

  if (logs.some(log => ["register_success", "auth_changed", "account_deleted"].includes(log.type))) {
    reasons.push("auth-event");
  }

  if (changed.some(item => item.collection === "users")) {
    reasons.push("user-profile-change");
  }

  const lastFullRaw = previous.metadata.lastFullAuthenticationAt || previous.metadata.createdAt;
  const lastFull = new Date(lastFullRaw || 0);
  const maxAgeMs = AUTH_FULL_REFRESH_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  if (Number.isNaN(lastFull.getTime()) || now.getTime() - lastFull.getTime() >= maxAgeMs) {
    reasons.push("periodic-reconciliation");
  }

  return {
    refresh: reasons.length > 0,
    reasons,
    lastFullAuthenticationAt: Number.isNaN(lastFull.getTime()) ? null : lastFull.toISOString(),
  };
}

async function main() {
  const changeCheckpointAt = new Date();
  const previous = getPreviousState();
  if (!previous) {
    throw new Error("Nessun backup precedente valido trovato: esegui prima un backup completo.");
  }

  const checkpoint = resolvePreviousCheckpoint(previous);
  const state = clone(previous.firestore);
  const logs = await fetchLogsSince(checkpoint.date);
  const refs = new Map();

  for (const log of logs) {
    for (const ref of collectCandidateRefs(log)) {
      refs.set(`${ref.collection}/${ref.id}`, ref);
    }
  }

  const timestampQueries = await addTimestampCandidates(refs, checkpoint.date);
  const changed = [];
  for (const ref of refs.values()) {
    changed.push(await refreshDocument(state, ref.collection, ref.id));
  }

  const fallback = await refreshFallbackCollections(state);
  refreshLogsCollection(state, logs);

  const authDecision = authRefreshDecision(previous, logs, changed, changeCheckpointAt);
  let authenticationBackup;
  let deletedAuthUsers = [];
  let lastFullAuthenticationAt = authDecision.lastFullAuthenticationAt;

  if (authDecision.refresh) {
    authenticationBackup = await exportAuthentication();
    lastFullAuthenticationAt = new Date().toISOString();
    deletedAuthUsers = purgeDeletedAuthUsers(
      state,
      previous.authentication,
      authenticationBackup.users
    );
  } else {
    const users = clone(previous.authentication || []);
    authenticationBackup = { users, ...summarizeAuthentication(users) };
  }

  const folderName = safeTimestamp();
  const out = path.join(OUTPUT_ROOT, folderName);
  fs.mkdirSync(out, { recursive: true });

  fs.writeFileSync(path.join(out, "firestore.json"), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(out, "authentication.json"), JSON.stringify(authenticationBackup.users, null, 2));
  fs.writeFileSync(path.join(out, "metadata.json"), JSON.stringify({
    schemaVersion: 4,
    backupMode: "incremental",
    baseBackup: path.basename(previous.folder),
    createdAt: new Date().toISOString(),
    changeCheckpointAt: changeCheckpointAt.toISOString(),
    previousCheckpointAt: checkpoint.date.toISOString(),
    legacyCheckpointSafetyWindowUsed: checkpoint.legacySafetyWindow,
    projectId: serviceAccount.project_id,
    firestoreCollections: Object.keys(state).sort(),
    changeLogCollection: CHANGELOG_COLLECTION,
    changeLogEntriesRead: logs.length,
    changedDocuments: changed.length,
    timestampQueries,
    fallbackCollectionsRefreshed: fallback,
    deletedAuthenticationUsersPurged: deletedAuthUsers,
    authenticationMode: authDecision.refresh ? "full-refresh" : "reused-previous",
    authenticationRefreshReasons: authDecision.reasons,
    authenticationFullRefreshMaxAgeDays: AUTH_FULL_REFRESH_MAX_AGE_DAYS,
    lastFullAuthenticationAt,
    authenticationUsers: authenticationBackup.users.length,
    authenticationPasswordUsers: authenticationBackup.passwordUsers,
    authenticationPasswordHashes: authenticationBackup.passwordHashes,
    authenticationPasswordsRestorable:
      authenticationBackup.passwordUsers === authenticationBackup.passwordHashes,
  }, null, 2));

  console.log(`Backup incrementale completato: backups/${folderName}`);
  console.log(`Base: ${path.basename(previous.folder)}`);
  console.log(`Checkpoint precedente: ${checkpoint.date.toISOString()}`);
  console.log(`Log letti: ${logs.length}`);
  console.log(`Documenti puntuali riletti: ${changed.length}`);
  console.log(`Collection fallback riallineate: ${fallback.map(item => item.collection).join(", ")}`);
  if (authDecision.refresh) {
    console.log(`Authentication riletta: ${authDecision.reasons.join(", ")}`);
  } else {
    console.log("Authentication invariata: riuso authentication.json precedente senza listUsers().");
  }
  if (deletedAuthUsers.length) {
    console.log(`Utenti eliminati rimossi dalla copia: ${deletedAuthUsers.length}`);
  }
}

main().catch(error => {
  console.error("BACKUP INCREMENTALE FALLITO");
  console.error(error);
  process.exit(1);
});
