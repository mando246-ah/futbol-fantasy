"use strict";

const {
  getSeasonFixturesCollectionPath,
  getSeasonLiveFixturesCollectionPath,
} = require("./seasonMeta");

function normalizeFixtureId(fixtureId) {
  return String(fixtureId || "").trim();
}

function getSeasonFixturesCollectionRef(db, seasonKey) {
  return db.collection(getSeasonFixturesCollectionPath(seasonKey));
}

function getSeasonFixtureSummaryRef(db, seasonKey, fixtureId) {
  return getSeasonFixturesCollectionRef(db, seasonKey).doc(normalizeFixtureId(fixtureId));
}

function getSeasonLiveFixturesCollectionRef(db, seasonKey) {
  return db.collection(getSeasonLiveFixturesCollectionPath(seasonKey));
}

function getSeasonLiveFixtureRef(db, seasonKey, fixtureId) {
  return getSeasonLiveFixturesCollectionRef(db, seasonKey).doc(normalizeFixtureId(fixtureId));
}

async function readSeasonFixtureSummary({ db, seasonKey, fixtureId }) {
  if (!db || !seasonKey || !fixtureId) return null;

  const snap = await getSeasonFixtureSummaryRef(db, seasonKey, fixtureId).get();
  if (!snap.exists) return null;

  return {
    ...(snap.data() || {}),
    fixtureId: normalizeFixtureId(fixtureId),
  };
}

async function readSeasonLiveFixture({ db, seasonKey, fixtureId }) {
  if (!db || !seasonKey || !fixtureId) return null;

  const snap = await getSeasonLiveFixtureRef(db, seasonKey, fixtureId).get();
  if (!snap.exists) return null;

  return {
    ...(snap.data() || {}),
    fixtureId: normalizeFixtureId(fixtureId),
  };
}

async function writeSeasonFixtureSummary({ db, seasonKey, fixtureId, summary = {} }) {
  if (!db || !seasonKey || !fixtureId) return false;

  await getSeasonFixtureSummaryRef(db, seasonKey, fixtureId).set(
    {
      ...summary,
      fixtureId: normalizeFixtureId(fixtureId),
    },
    { merge: false }
  );

  return true;
}

async function writeSeasonLiveFixture({ db, seasonKey, fixtureId, payload = {} }) {
  if (!db || !seasonKey || !fixtureId) return false;

  await getSeasonLiveFixtureRef(db, seasonKey, fixtureId).set(
    {
      ...payload,
      fixtureId: normalizeFixtureId(fixtureId),
    },
    { merge: false }
  );

  return true;
}

function estimateDocBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value || {}), "utf8");
  } catch (_) {
    return 0;
  }
}

module.exports = {
  estimateDocBytes,
  getSeasonFixtureSummaryRef,
  getSeasonFixturesCollectionRef,
  getSeasonLiveFixtureRef,
  getSeasonLiveFixturesCollectionRef,
  readSeasonFixtureSummary,
  readSeasonLiveFixture,
  writeSeasonFixtureSummary,
  writeSeasonLiveFixture,
};
