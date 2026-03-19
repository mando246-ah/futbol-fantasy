"use strict";

/**
 * rooms/{roomId}/cup/current
 * rooms/{roomId}/cup/current/fixtures/{fixtureId}
 */

function cupCurrentRef(db, roomId) {
  return db.doc(`rooms/${roomId}/cup/current`);
}

function cupFixtureRef(db, roomId, fixtureId) {
  return db.doc(`rooms/${roomId}/cup/current/fixtures/${String(fixtureId)}`);
}

async function getCreditedMap(db, roomId, fixtureIds) {
  const out = {};
  const ids = Array.isArray(fixtureIds) ? fixtureIds.map(String) : [];

  // ONE read instead of N reads!
  const snap = await cupCurrentRef(db, roomId).get();
  const data = snap.exists ? snap.data() : {};
  const credited = data.creditedFixtures || {};

  for (const fid of ids) {
    out[fid] = !!credited[fid];
  }

  return out;
}

module.exports = {
  cupCurrentRef,
  cupFixtureRef,
  getCreditedMap,
};