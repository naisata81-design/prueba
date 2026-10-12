'use strict';
/* Conexión a MongoDB Atlas. La cadena de conexión SOLO vive en la variable de entorno MONGODB_URI. */
const { MongoClient } = require('mongodb');
let client = null;
let db = null;

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Falta la variable de entorno MONGODB_URI');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  db = client.db(process.env.MONGODB_DB || 'ac-control');
  await Promise.all([
    db.collection('accounts').createIndex({ email: 1 }, { unique: true }),
    db.collection('branches').createIndex({ accountId: 1 }),
    db.collection('routines').createIndex({ accountId: 1 }),
    db.collection('devices').createIndex({ accountId: 1 }),
  ]);
}

module.exports = { connect, col: (name) => db.collection(name), close: () => client && client.close() };
