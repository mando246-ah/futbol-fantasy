"use strict";

/**
 * Phase 1 foundation for global season data.
 *
 * Target Firestore layout:
 * - globalData/main/seasons/{seasonKey}
 * - globalData/main/seasons/{seasonKey}/players/{playerId}
 * - globalData/main/seasons/{seasonKey}/fixtures/{fixtureId}
 * - globalData/main/seasons/{seasonKey}/liveFixtures/{fixtureId}
 * - globalData/main/seasons/{seasonKey}/weeks/{weekKey}
 * - globalData/main/seasons/{seasonKey}/fixtureRooms/{fixtureId}
 *
 * This file is intentionally additive only.
 * Current room-level competition, polling, scoring, and UI flows continue
 * to use room.competition and room.competitionState exactly as before.
 */

const GLOBAL_SEASONS_ROOT = "globalData/main/seasons";

const COMPETITION_ALIASES = [
  { match: /world cup/i, key: "worldcup", type: "tournament" },
  { match: /club world cup/i, key: "clubworldcup", type: "tournament" },
  { match: /champions league/i, key: "championsleague", type: "tournament" },
  { match: /europa league/i, key: "europaleague", type: "tournament" },
  { match: /conference league/i, key: "conferenceleague", type: "tournament" },
  { match: /copa america/i, key: "copaamerica", type: "tournament" },
  { match: /nations league/i, key: "nationsleague", type: "tournament" },
  { match: /euro\b|european championship/i, key: "euro", type: "tournament" },
  { match: /bundesliga/i, key: "bundesliga", type: "league" },
  { match: /premier league/i, key: "premierleague", type: "league" },
  { match: /la liga/i, key: "laliga", type: "league" },
  { match: /serie a/i, key: "seriea", type: "league" },
  { match: /ligue 1/i, key: "ligue1", type: "league" },
];

function slugifySegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['".]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function compactSeasonRange(startYear, endYear) {
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) return "";
  const shortEnd = endYear % 100;
  return `${startYear}-${String(shortEnd).padStart(2, "0")}`;
}

function normalizeSeasonLabel({ season, seasonLabel, competitionType }) {
  const explicit = slugifySegment(seasonLabel);
  if (explicit) return explicit;

  const n = Number(season);
  if (Number.isFinite(n) && n > 0) {
    return competitionType === "league"
      ? compactSeasonRange(n, n + 1)
      : String(n);
  }

  const raw = String(season || "").trim();
  if (!raw) return "";

  const rangeMatch = raw.match(/^(\d{4})\s*[-/]\s*(\d{2,4})$/);
  if (rangeMatch) {
    const startYear = Number(rangeMatch[1]);
    let endYear = Number(rangeMatch[2]);
    if (endYear < 100) endYear += Math.floor(startYear / 100) * 100;
    return compactSeasonRange(startYear, endYear);
  }

  return slugifySegment(raw);
}

function inferCompetitionKey(input = {}) {
  const explicit = slugifySegment(
    input.competitionKey ||
      input.roomCompetitionKey ||
      input.slug ||
      input.code
  );
  if (explicit) return explicit;

  const name = String(
    input.competitionName ||
      input.name ||
      input.roomCompetitionName ||
      input.metaName ||
      ""
  ).trim();

  for (const alias of COMPETITION_ALIASES) {
    if (alias.match.test(name)) return alias.key;
  }

  const fromName = slugifySegment(name);
  if (fromName) return fromName;

  const leagueId = Number(input.league || input.leagueId);
  if (Number.isFinite(leagueId) && leagueId > 0) {
    return `league-${leagueId}`;
  }

  return "";
}

function inferCompetitionType(input = {}) {
  const explicit = slugifySegment(
    input.competitionType || input.roomCompetitionType || ""
  );
  if (["league", "tournament", "cup"].includes(explicit)) return explicit;

  const name = String(
    input.competitionName ||
      input.name ||
      input.roomCompetitionName ||
      input.metaName ||
      ""
  ).trim();

  for (const alias of COMPETITION_ALIASES) {
    if (alias.match.test(name)) return alias.type;
  }

  const phaseLabel = String(input.phaseLabel || "").trim().toLowerCase();
  if (phaseLabel === "cup") return "cup";

  return "league";
}

function buildSeasonKey(input = {}) {
  const explicit = slugifySegment(input.seasonKey || input.roomSeasonKey || "");
  if (explicit) return explicit;

  const competitionKey = inferCompetitionKey(input);
  const competitionType = inferCompetitionType(input);
  const seasonLabel = normalizeSeasonLabel({
    season: input.season,
    seasonLabel: input.seasonLabel || input.roomSeasonLabel,
    competitionType,
  });

  if (!competitionKey || !seasonLabel) return "";
  return `${competitionKey}-${seasonLabel}`;
}

function deriveSeasonContext(input = {}) {
  const competitionKey = inferCompetitionKey(input);
  const competitionType = inferCompetitionType({
    ...input,
    competitionKey,
  });
  const seasonKey = buildSeasonKey({
    ...input,
    competitionKey,
    competitionType,
  });

  return {
    seasonKey,
    competitionKey,
    competitionType,
  };
}

function getSeasonDocPath(seasonKey) {
  return `${GLOBAL_SEASONS_ROOT}/${String(seasonKey || "").trim()}`;
}

function getSeasonPlayersCollectionPath(seasonKey) {
  return `${getSeasonDocPath(seasonKey)}/players`;
}

function getSeasonFixturesCollectionPath(seasonKey) {
  return `${getSeasonDocPath(seasonKey)}/fixtures`;
}

function getSeasonLiveFixturesCollectionPath(seasonKey) {
  return `${getSeasonDocPath(seasonKey)}/liveFixtures`;
}

function getSeasonWeeksCollectionPath(seasonKey) {
  return `${getSeasonDocPath(seasonKey)}/weeks`;
}

function getSeasonFixtureRoomsCollectionPath(seasonKey) {
  return `${getSeasonDocPath(seasonKey)}/fixtureRooms`;
}

module.exports = {
  GLOBAL_SEASONS_ROOT,
  buildSeasonKey,
  deriveSeasonContext,
  inferCompetitionKey,
  inferCompetitionType,
  getSeasonDocPath,
  getSeasonPlayersCollectionPath,
  getSeasonFixturesCollectionPath,
  getSeasonLiveFixturesCollectionPath,
  getSeasonWeeksCollectionPath,
  getSeasonFixtureRoomsCollectionPath,
};
