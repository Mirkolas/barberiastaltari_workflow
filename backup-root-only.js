// Spark-friendly backup mode: keep the existing backup format, but do not
// recursively enumerate a subcollection for every Firestore document.
const { DocumentReference } = require("firebase-admin/firestore");

DocumentReference.prototype.listCollections = async function listCollectionsDisabled() {
  return [];
};

console.log("Modalita Spark: backup delle sole collection root; scansione subcollection disabilitata.");
require("./backup.js");
