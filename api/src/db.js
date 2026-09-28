"use strict";

/**
 * SentryAI Ingestion API — Data store
 * ------------------------------------
 * MVP note: this uses flat JSON files on disk instead of MongoDB, so the
 * whole stack runs with zero external services and zero network access.
 * Every function here is written against a small, MongoDB-shaped
 * interface (find/insert/update by id) so swapping in a real MongoDB
 * driver later means changing this file only — nothing in server.js or
 * policyEngine.js needs to change.
 *
 * Concurrency note: file writes are serialised behind a simple in-process
 * write queue per collection, which is safe for a single-process MVP but
 * is NOT safe for multiple API instances writing the same file — that is
 * exactly the kind of constraint the production MongoDB migration removes.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");

function collectionPath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function ensureStore(name) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = collectionPath(name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, "[]", "utf8");
}

function readAll(name) {
  ensureStore(name);
  const raw = fs.readFileSync(collectionPath(name), "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Corrupt file shouldn't crash the whole API — fail safe to empty.
    console.error(`[db] failed to parse ${name}.json, resetting to []`, err.message);
    return [];
  }
}

function writeToDisk(name, docs) {
  ensureStore(name);
  return new Promise((resolve, reject) => {
    const tmpFile = collectionPath(name) + ".tmp";
    fs.writeFile(tmpFile, JSON.stringify(docs, null, 2), "utf8", (err) => {
      if (err) return reject(err);
      fs.rename(tmpFile, collectionPath(name), (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

function newId() {
  return crypto.randomUUID();
}

/**
 * Serialise every mutating operation (read-modify-write) per collection
 * behind a single promise chain. This is the piece that matters: queuing
 * only the *write* step (an earlier version of this file did that) still
 * lets two concurrent inserts both `readAll()` the same stale array
 * before either write lands, so the second write silently clobbers the
 * first insert. Queuing the whole read+modify+write closure fixes that.
 */
const collectionQueues = new Map();

function enqueue(name, operation) {
  const prior = collectionQueues.get(name) || Promise.resolve();
  const next = prior.catch(() => {}).then(operation);
  collectionQueues.set(name, next);
  return next;
}

function insert(name, doc) {
  return enqueue(name, async () => {
    const docs = readAll(name);
    const withId = { _id: newId(), createdAt: new Date().toISOString(), ...doc };
    docs.push(withId);
    await writeToDisk(name, docs);
    return withId;
  });
}

function replace(name, docs) {
  return enqueue(name, async () => {
    const nextDocs = Array.isArray(docs) ? docs : [];
    await writeToDisk(name, nextDocs);
    return nextDocs;
  });
}

function find(name, predicate = () => true) {
  return readAll(name).filter(predicate);
}

function findOne(name, predicate) {
  return readAll(name).find(predicate) || null;
}

function updateOne(name, predicate, updates) {
  return enqueue(name, async () => {
    const docs = readAll(name);
    const idx = docs.findIndex(predicate);
    if (idx === -1) return null;
    docs[idx] = { ...docs[idx], ...updates, updatedAt: new Date().toISOString() };
    await writeToDisk(name, docs);
    return docs[idx];
  });
}

module.exports = { insert, replace, find, findOne, updateOne, newId };
