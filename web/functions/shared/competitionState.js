"use strict";

const admin = require("firebase-admin");

const { FieldValue, FieldPath } = admin.firestore;

const COMPETITION_STATE_KEYS = [
  "phaseLabel",
  "currentLabel",
  "weekStatus",
  "nextPollAtMs",
  "nextCupPollAtMs",
  "nextKickoffMs",
  "updatedAtMs",
  "isDone",
  "lastCupPollAtMs",
];

const BAD_FLAT_COMPETITION_STATE_KEYS = [
  ...COMPETITION_STATE_KEYS.map((key) => `competitionState.${key}`),
  "competitionState.phaseLable",
];

function hasOwn(room = {}, key) {
  return Object.prototype.hasOwnProperty.call(room, key);
}

function getCompetitionState(room = {}) {
  const nested =
    room && typeof room.competitionState === "object" && room.competitionState
      ? room.competitionState
      : {};

  const out = { ...nested };

  for (const key of COMPETITION_STATE_KEYS) {
    const flatKey = `competitionState.${key}`;

    if (out[key] === undefined && hasOwn(room, flatKey)) {
      out[key] = room[flatKey];
    }
  }

  if (out.phaseLabel === undefined) {
    if (nested.phaseLable !== undefined) {
      out.phaseLabel = nested.phaseLable;
    } else if (room["competitionState.phaseLable"] !== undefined) {
      out.phaseLabel = room["competitionState.phaseLable"];
    }
  }

  return out;
}

async function setCompetitionState(roomRef, patch = {}, options = {}) {
  const nowMs = Number(options.nowMs || patch.updatedAtMs || Date.now());

  let prev = {};

  if (options.roomData) {
    prev = getCompetitionState(options.roomData);
  } else {
    const snap = await roomRef.get();
    prev = snap.exists ? getCompetitionState(snap.data() || {}) : {};
  }

  const next = {
    ...prev,
    ...patch,
    updatedAtMs: nowMs,
  };

  await roomRef.set(
    {
      competitionState: next,
    },
    { merge: true }
  );

  return next;
}

function hasBadFlatCompetitionStateFields(room = {}) {
  return BAD_FLAT_COMPETITION_STATE_KEYS.some((key) => hasOwn(room, key));
}

function buildCompetitionStateRepairData(room = {}, nowMs = Date.now()) {
  const nested =
    room && typeof room.competitionState === "object" && room.competitionState
      ? room.competitionState
      : {};

  const competitionState = {
    ...getCompetitionState(room),
    updatedAtMs: Number(nested.updatedAtMs || room["competitionState.updatedAtMs"] || nowMs),
  };

  const badFlatKeys = BAD_FLAT_COMPETITION_STATE_KEYS.filter((key) => hasOwn(room, key));

  return {
    competitionState,
    badFlatKeys,
  };
}

async function deleteBadFlatCompetitionStateFields(roomRef, badFlatKeys = []) {
  if (!badFlatKeys.length) return 0;

  const args = [];

  for (const key of badFlatKeys) {
    args.push(new FieldPath(key), FieldValue.delete());
  }

  await roomRef.update(...args);
  return badFlatKeys.length;
}

module.exports = {
  COMPETITION_STATE_KEYS,
  BAD_FLAT_COMPETITION_STATE_KEYS,
  getCompetitionState,
  setCompetitionState,
  hasBadFlatCompetitionStateFields,
  buildCompetitionStateRepairData,
  deleteBadFlatCompetitionStateFields,
};
