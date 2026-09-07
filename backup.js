const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Secret FIREBASE_SERVICE_ACCOUNT non configurato.");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

function safeTimestamp() {
  return new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "Z");
}

function cleanupOldBackups(backupsRoot) {
  const timestampFolderPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

  const backupFolders = fs
    .readdirSync(backupsRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && timestampFolderPattern.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort();

  if (backupFolders.length < 5) {
    console.log(`Backup presenti: ${backupFolders.length}. Nessuna pulizia necessaria.`);
    return;
  }

  const foldersToDelete = backupFolders.slice(0, backupFolders.length - 1);

  console.log("");
  console.log(`Raggiunti ${backupFolders.length} backup. Pulizia backup vecchi...`);

  for (const folder of foldersToDelete) {
    const folderPath = path.join(backupsRoot, folder);
    console.log(`Elimino: backups/${folder}`);
    fs.rmSync(folderPath, { recursive: true, force: true });
  }

  console.log("Pulizia completata. Conservato solo il backup più recente.");
}

function serializeValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return {
      __type: "bytes",
      base64: Buffer.from(value).toString("base64"),
    };
  }

  if (value instanceof admin.firestore.Timestamp) {
    return {
      __type: "timestamp",
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    };
  }

  if (value instanceof Date) {
    return {
      __type: "date",
      iso: value.toISOString(),
    };
  }

  if (value instanceof admin.firestore.GeoPoint) {
    return {
      __type: "geopoint",
      latitude: value.latitude,
      longitude: value.longitude,
    };
  }

  if (value instanceof admin.firestore.DocumentReference) {
    return {
      __type: "reference",
      path: value.path,
    };
  }

  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  if (typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = serializeValue(val);
    }
    return result;
  }

  return value;
}

async function exportCollection(collectionRef) {
  const snapshot = await collectionRef.get();
  const documents = {};

  for (const doc of snapshot.docs) {
    const data = {};
    for (const [key, value] of Object.entries(doc.data())) {
      data[key] = serializeValue(value);
    }

    const subcollections = {};
    const childCollections = await doc.ref.listCollections();

    for (const childCollection of childCollections) {
      subcollections[childCollection.id] = await exportCollection(childCollection);
    }

    documents[doc.id] = {
      data,
      subcollections,
    };
  }

  return documents;
}

async function exportFirestore() {
  const collections = await db.listCollections();
  const result = {};
  const collectionNames = [];

  for (const collectionRef of collections) {
    console.log(`Backup collection: ${collectionRef.id}`);
    result[collectionRef.id] = await exportCollection(collectionRef);
    collectionNames.push(collectionRef.id);
  }

  return {
    data: result,
    collections: collectionNames.sort(),
  };
}

function serializeMultiFactor(user) {
  const factors = user.multiFactor?.enrolledFactors || [];
  if (!factors.length) {
    return null;
  }

  return {
    enrolledFactors: factors.map((factor) => ({
      uid: factor.uid,
      displayName: factor.displayName || undefined,
      enrollmentTime: factor.enrollmentTime || undefined,
      factorId: factor.factorId,
      phoneNumber: factor.phoneNumber || undefined,
      totpInfo: factor.totpInfo || undefined,
    })),
  };
}

async function exportAuthentication() {
  const users = [];
  const missingPasswordHashes = [];
  let passwordUsers = 0;
  let passwordHashes = 0;
  let pageToken;

  do {
    const result = await auth.listUsers(1000, pageToken);

    for (const user of result.users) {
      const providerData = user.providerData.map((provider) => ({
        uid: provider.uid,
        email: provider.email || null,
        displayName: provider.displayName || null,
        photoURL: provider.photoURL || null,
        phoneNumber: provider.phoneNumber || null,
        providerId: provider.providerId,
      }));

      const hasPasswordProvider = providerData.some(
        (provider) => provider.providerId === "password"
      );

      if (hasPasswordProvider) {
        passwordUsers += 1;
        if (user.passwordHash) {
          passwordHashes += 1;
        } else {
          missingPasswordHashes.push(user.uid);
        }
      }

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
        `${missingPasswordHashes.length} utenti password. ` +
        "Assegna al service account il permesso firebaseauth.configs.getHashConfig " +
        "tramite un ruolo IAM personalizzato e riesegui il backup."
    );
  }

  return {
    users,
    passwordUsers,
    passwordHashes,
  };
}

async function main() {
  const backupFolder = safeTimestamp();
  const backupsRoot = path.join(__dirname, "backups");
  const rootFolder = path.join(backupsRoot, backupFolder);

  fs.mkdirSync(rootFolder, { recursive: true });

  console.log("Avvio backup Firestore...");
  const firestoreBackup = await exportFirestore();

  fs.writeFileSync(
    path.join(rootFolder, "firestore.json"),
    JSON.stringify(firestoreBackup.data, null, 2)
  );

  console.log("Avvio backup Firebase Authentication...");
  const authenticationBackup = await exportAuthentication();

  fs.writeFileSync(
    path.join(rootFolder, "authentication.json"),
    JSON.stringify(authenticationBackup.users, null, 2)
  );

  const metadata = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    projectId: serviceAccount.project_id,
    firestoreCollections: firestoreBackup.collections,
    authenticationUsers: authenticationBackup.users.length,
    authenticationPasswordUsers: authenticationBackup.passwordUsers,
    authenticationPasswordHashes: authenticationBackup.passwordHashes,
    authenticationPasswordsRestorable:
      authenticationBackup.passwordUsers === authenticationBackup.passwordHashes,
  };

  fs.writeFileSync(
    path.join(rootFolder, "metadata.json"),
    JSON.stringify(metadata, null, 2)
  );

  cleanupOldBackups(backupsRoot);

  console.log("");
  console.log("Backup completato.");
  console.log(`Cartella: backups/${backupFolder}`);
  console.log(`Collection Firestore: ${firestoreBackup.collections.join(", ")}`);
  console.log(`Utenti Authentication: ${authenticationBackup.users.length}`);
  console.log(`Utenti password con hash: ${authenticationBackup.passwordHashes}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("BACKUP FALLITO");
    console.error(error);
    process.exit(1);
  });
