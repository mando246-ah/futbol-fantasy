"use strict";

const WORLD_CUP_COMPETITION_KEY = "worldcup";
const WORLD_CUP_COMPETITION_TYPE = "worldCup";
const WORLD_CUP_GROUP_PHASE = "group";
const WORLD_CUP_KNOCKOUT_PHASE = "knockout";
const WORLD_CUP_GROUP_ENGINE = "worldCupDaily";
const WORLD_CUP_KNOCKOUT_ENGINE = "cupEngine";

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function buildWorldCupSeasonKey(season) {
  const n = Number(season);
  if (Number.isFinite(n) && n > 0) return `${WORLD_CUP_COMPETITION_KEY}-${n}`;

  const raw = slugify(season);
  return raw ? `${WORLD_CUP_COMPETITION_KEY}-${raw}` : "";
}

function getWorldCupQualifiedTeamsDocPath(seasonKey) {
  return `globalData/main/seasons/${String(seasonKey || "").trim()}/qualifiedTeams/current`;
}

function isWorldCupCompetition(input = {}) {
  const key = slugify(input.competitionKey || input.key || "");
  const name = String(input.name || input.competitionName || "").toLowerCase();
  const combined = `${key} ${name}`;

  if (/\bclub\b/.test(combined)) return false;
  if (/\bqualif/.test(combined)) return false;

  if (
    key === WORLD_CUP_COMPETITION_KEY ||
    key === "world-cup" ||
    key === "fifa-world-cup"
  ) {
    return true;
  }

  return /\bworld cup\b/.test(name);
}

function detectWorldCupPhaseFromRoundLabel(roundLabel) {
  const s = String(roundLabel || "").toLowerCase().trim();

  if (
    /\bround of\b/.test(s) ||
    /\bknockout\b/.test(s) ||
    /\bquarter/.test(s) ||
    /\bsemi/.test(s) ||
    /\bfinals?\b/.test(s) ||
    /\bthird place\b/.test(s) ||
    /\b3rd place\b/.test(s) ||
    /\b1\/8\b/.test(s) ||
    /\b1\/4\b/.test(s) ||
    /\b1\/2\b/.test(s)
  ) {
    return WORLD_CUP_KNOCKOUT_PHASE;
  }

  // World Cup-specific default: if the next fixture is not clearly knockout,
  // treat it as group stage. Do not change the shared phase detector.
  return WORLD_CUP_GROUP_PHASE;
}

function buildWorldCupRoomMode({ roundLabel, season }) {
  const worldCupPhase = detectWorldCupPhaseFromRoundLabel(roundLabel);
  const engineType =
    worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE
      ? WORLD_CUP_KNOCKOUT_ENGINE
      : WORLD_CUP_GROUP_ENGINE;

  return {
    seasonKey: buildWorldCupSeasonKey(season),
    competitionKey: WORLD_CUP_COMPETITION_KEY,
    competitionType: WORLD_CUP_COMPETITION_TYPE,
    worldCupPhase,
    engineType,
  };
}

module.exports = {
  WORLD_CUP_COMPETITION_KEY,
  WORLD_CUP_COMPETITION_TYPE,
  WORLD_CUP_GROUP_PHASE,
  WORLD_CUP_KNOCKOUT_PHASE,
  WORLD_CUP_GROUP_ENGINE,
  WORLD_CUP_KNOCKOUT_ENGINE,
  buildWorldCupSeasonKey,
  buildWorldCupRoomMode,
  detectWorldCupPhaseFromRoundLabel,
  getWorldCupQualifiedTeamsDocPath,
  isWorldCupCompetition,
};
