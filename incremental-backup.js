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

function safeTimestamp() {
  return new Date().toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function serializeValue(value) {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __type: "bytes", base64: Buffer.from(value).toString("base64") };
  if (value instanceof admin.firestore.Timestamp) return { __type: "timestamp", seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof Date) return { __type: "date", iso: value.toISOString() };
  if (value instanceof admin.firestore.GeoPoint) return { __type: "geopoint", latitude: value.latitude, longitude: value.longitude };
  if (value instanceof admin.firestore.DocumentReference) return { __type: "reference", path: value.path };
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeValue(v)]));
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

async function exportAuthentication() {
  const users = [];
  let pageToken;
  do {
    const result = await auth.listUsers(1000, pageToken);
    for (const user of result.users) {
      users.push({
        uid: user.uid,
        email: user.email || null,
        emailVerified: user.emailVerified,
        displayName: user.displayName || null,
        photoURL: user.photoURL || null,
        phoneNumber: user.phoneNumber || null,
        disabled: user.disabled,
        providerData: user.providerData.map(provider => ({
          uid: provider.uid,
          email: provider.email || null,
          displayName: provider.displayName || null,
          photoURL: provider.photoURL || null,
          phoneNumber: provider.phoneNumber || null,
          providerId: provider.providerId,
        })),
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
      });
    }
    pageToken = result.pageToken;
  } while (pageToken);
  return users;
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
  }
  return refs;
}

async function fetchLogsSince(date) {
  const since = admin.firestore.Timestamp.fromDate(date);
  const snapshot = await db.collection(CHANGELOG_COLLECTION).where("createdAt", ">", since).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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

async function refreshVolatileCollections(state) {
  const names = ["availability", "activeBookings", "calendarClosures", "receipts", "mailRequests", "phoneClaims"];
  const refreshed = [];
  for (const name of names) {
    const snap = await db.collection(name).get();
    const docs = {};
    for (const doc of snap.docs) docs[doc.id] = { data: serializeValue(doc.data()), subcollections: {} };
    state[name] = docs;
    refreshed.push({ collection: name, count: snap.size });
  }
  return refreshed;
}

async function refreshLogsCollection(state, logs) {
  state[CHANGELOG_COLLECTION] = state[CHANGELOG_COLLECTION] || {};
  for (const log of logs) {
    const id = log.id;
    const data = { ...log };
    delete data.id;
    state[CHANGELOG_COLLECTION][id] = { data: serializeValue(data), subcollections: {} };
  }
}

async function main() {
  const previous = getPreviousState();
  if (!previous) {
    throw new Error("Nessun backup precedente valido trovato: esegui prima un backup completo.");
  }

  const previousCreatedAt = new Date(previous.metadata.createdAt || 0);
  if (Number.isNaN(previousCreatedAt.getTime())) throw new Error("metadata.createdAt del backup precedente non valido.");

  const state = clone(previous.firestore);
  const logs = await fetchLogsSince(previousCreatedAt);
  const refs = new Map();
  for (const log of logs) {
    for (const ref of collectCandidateRefs(log)) refs.set(`${ref.collection}/${ref.id}`, ref);
  }

  const changed = [];
  for (const ref of refs.values()) changed.push(await refreshDocument(state, ref.collection, ref.id));
  const volatile = await refreshVolatileCollections(state);
  await refreshLogsCollection(state, logs);

  const authentication = await exportAuthentication();
  const folderName = safeTimestamp();
  const out = path.join(OUTPUT_ROOT, folderName);
  fs.mkdirSync(out, { recursive: true });

  fs.writeFileSync(path.join(out, "firestore.json"), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(out, "authentication.json"), JSON.stringify(authentication, null, 2));
  fs.writeFileSync(path.join(out, "metadata.json"), JSON.stringify({
    schemaVersion: 3,
    backupMode: "incremental",
    baseBackup: path.basename(previous.folder),
    createdAt: new Date().toISOString(),
    projectId: serviceAccount.project_id,
    firestoreCollections: Object.keys(state).sort(),
    changeLogCollection: CHANGELOG_COLLECTION,
    changeLogEntriesRead: logs.length,
    changedDocuments: changed.length,
    volatileCollectionsRefreshed: volatile,
    authenticationUsers: authentication.length,
  }, null, 2));

  console.log(`Backup incrementale completato: backups/${folderName}`);
  console.log(`Base: ${path.basename(previous.folder)}`);
  console.log(`Log letti: ${logs.length}`);
  console.log(`Documenti puntuali riletti: ${changed.length}`);
}

main().catch(error => {
  console.error("BACKUP INCREMENTALE FALLITO");
  console.error(error);
  process.exit(1);
});
