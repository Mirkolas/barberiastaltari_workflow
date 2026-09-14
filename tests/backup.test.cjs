const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const types = require('firebase-admin/firestore');

function runtime(name = 'backup.js', options = {}) {
  const writes = new Map(); const removed = [];
  const auth = { listUsers: async () => ({ users: options.users || [] }) };
  const db = { listCollections: async () => options.collections || [], doc: p => ({ path: p }) };
  const context = vm.createContext({
    Buffer, Uint8Array, Date, console: { log() {}, error() {} }, __dirname: '/isolated',
    process: { env: { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'demo-staltari-audit' }) } },
    require: name => {
      if (name === 'firebase-admin/app') return { initializeApp() {}, cert: () => ({}) };
      if (name === 'firebase-admin/firestore') return { ...types, getFirestore: () => db };
      if (name === 'firebase-admin/auth') return { getAuth: () => auth };
      if (name === 'fs') return { mkdirSync() {}, readdirSync: () => (options.folders || []).map(name => ({ name, isDirectory: () => true })),
        writeFileSync: (p, value) => writes.set(path.basename(p), JSON.parse(value)), rmSync: p => removed.push(path.basename(p)) };
      return require(name);
    }
  });
  const source = fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/\nmain\(\)[\s\S]*$/, '');
  vm.runInContext(source, context);
  return { context, writes, removed };
}
function collection(id, docs) {
  return { id, get: async () => ({ docs: docs.map(([id, data, children = []]) => ({ id, data: () => data, ref: { listCollections: async () => children } })) }) };
}
test('backup completo include subcollection e tipi Firestore', async () => {
  const child = collection('details', [['child', { count: 2 }]]);
  const root = collection('bookings', [['appointment', { when: new types.Timestamp(100, 234), bytes: Buffer.from('test'), point: new types.GeoPoint(1, 2) }, [child]]]);
  const { context, writes } = runtime('backup.js', { collections: [root] });
  await context.main();
  const doc = writes.get('firestore.json').bookings.appointment;
  assert.equal(doc.subcollections.details.child.data.count, 2);
  assert.deepEqual(doc.data.when, { __type: 'timestamp', seconds: 100, nanoseconds: 234 });
  assert.equal(doc.data.bytes.base64, Buffer.from('test').toString('base64'));
  assert.equal(writes.get('metadata.json').backupMode, 'full-recursive');
});
test('un account con password senza hash fa fallire il backup', async () => {
  const { context } = runtime('backup.js', { users: [{ uid: 'test', providerData: [{ providerId: 'password', uid: 'test' }], metadata: {} }] });
  await assert.rejects(context.exportAuthentication(), /mancano gli hash/);
});
test('retention mantiene quattro copie e ignora cartelle estranee', () => {
  const folders = [1, 2, 3, 4, 5, 6].map(day => `2026-09-0${day}T10-00-00Z`);
  const { context, removed } = runtime('backup.js', { folders: [...folders, 'manuale'] });
  context.cleanupOldBackups('/isolated/backups');
  assert.deepEqual(removed, folders.slice(0, 2));
});
if (fs.existsSync(path.join(__dirname, '../restore.js'))) {
  test('restore ricostruisce timestamp, bytes e coordinate', () => {
    const { context } = runtime('restore.js');
    assert.equal(context.deserializeValue({ __type: 'timestamp', seconds: 100, nanoseconds: 234 }).nanoseconds, 234);
    assert.equal(context.deserializeValue({ __type: 'bytes', base64: 'dGVzdA==' }).toString(), 'test');
    assert.equal(context.deserializeValue({ __type: 'geopoint', latitude: 1, longitude: 2 }).longitude, 2);
  });
}
