"use strict";

const { getSeasonPlayersCollectionPath } = require("./seasonMeta");

/**
 * Phase 2 global player-pool helpers.
 *
 * These helpers are intentionally compatibility-first:
 * - global season players live at globalData/seasons/{seasonKey}/players/{playerId}
 * - room players still live at rooms/{roomId}/players/{playerId}
 * - rooms can copy from the global pool when it exists
 * - rooms can safely fall back to their existing room-local player seeding
 */

function getSeasonPlayersCollectionRef(db, seasonKey) {
  return db.collection(getSeasonPlayersCollectionPath(seasonKey));
}

function getRoomPlayersCollectionRef(db, roomId) {
  return db.collection(`rooms/${roomId}/players`);
}

function normalizePlayerPoolDoc(player = {}) {
  const id = String(player?.id ?? player?.playerId ?? player?.pid ?? "").trim();
  if (!id) return null;

  return {
    ...player,
    id,
  };
}

async function writePlayersToCollection(ref, players = []) {
  const normalized = players
    .map((player) => normalizePlayerPoolDoc(player))
    .filter(Boolean);

  if (!normalized.length) return 0;

  let batch = ref.firestore.batch();
  let ops = 0;
  let written = 0;

  const commitBatch = async () => {
    if (ops === 0) return;
    const current = batch;
    batch = ref.firestore.batch();
    ops = 0;
    await current.commit();
  };

  for (const player of normalized) {
    batch.set(ref.doc(player.id), player, { merge: true });
    ops += 1;
    written += 1;

    if (ops >= 450) {
      await commitBatch();
    }
  }

  await commitBatch();
  return written;
}

async function deleteCollectionDocs(ref) {
  const snap = await ref.get();
  if (snap.empty) return 0;

  let batch = ref.firestore.batch();
  let ops = 0;
  let deleted = 0;

  const commitBatch = async () => {
    if (ops === 0) return;
    const current = batch;
    batch = ref.firestore.batch();
    ops = 0;
    await current.commit();
  };

  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    ops += 1;
    deleted += 1;

    if (ops >= 450) {
      await commitBatch();
    }
  }

  await commitBatch();
  return deleted;
}

async function loadSeasonPlayerPool({ db, seasonKey }) {
  if (!seasonKey) return [];

  const snap = await getSeasonPlayersCollectionRef(db, seasonKey).get();
  return snap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      ...data,
      id: String(data?.id ?? doc.id),
    };
  });
}

async function bootstrapSeasonPlayerPool({ db, seasonKey, players = [] }) {
  if (!seasonKey) return 0;
  return writePlayersToCollection(getSeasonPlayersCollectionRef(db, seasonKey), players);
}

async function copyPlayersToRoom({ db, roomId, players = [] }) {
  if (!roomId) return 0;
  return writePlayersToCollection(getRoomPlayersCollectionRef(db, roomId), players);
}

async function replacePlayersInRoom({ db, roomId, players = [] }) {
  if (!roomId) return 0;

  const ref = getRoomPlayersCollectionRef(db, roomId);
  await deleteCollectionDocs(ref);
  return writePlayersToCollection(ref, players);
}

async function copySeasonPlayerPoolToRoom({ db, roomId, seasonKey, players = null }) {
  const sourcePlayers = Array.isArray(players)
    ? players
    : await loadSeasonPlayerPool({ db, seasonKey });

  if (!sourcePlayers.length) return 0;
  return copyPlayersToRoom({ db, roomId, players: sourcePlayers });
}

module.exports = {
  bootstrapSeasonPlayerPool,
  copyPlayersToRoom,
  copySeasonPlayerPoolToRoom,
  loadSeasonPlayerPool,
  replacePlayersInRoom,
};
