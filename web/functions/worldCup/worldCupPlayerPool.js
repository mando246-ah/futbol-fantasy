"use strict";

const admin = require("firebase-admin");
const {
  bootstrapSeasonPlayerPool,
  loadSeasonPlayerPool,
} = require("../shared/seasonPlayerPool");

const WORLD_CUP_GLOBAL_PLAYER_POOL_MIN = 300;
const WORLD_CUP_GLOBAL_PLAYER_POOL_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const WORLD_CUP_GLOBAL_PLAYER_POOL_BUILD_LOCK_MS = 5 * 60 * 1000;

function toId(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value);
}

function normalizeWorldCupSquadPosition(position) {
  const raw = String(position || "").trim().toUpperCase();
  if (["G", "GK", "GOALKEEPER"].includes(raw)) return "GK";
  if (["D", "DEF", "DEFENDER"].includes(raw)) return "DEF";
  if (["M", "MID", "MIDFIELDER"].includes(raw)) return "MID";
  if (["A", "ATT", "ATTACKER", "F", "FWD", "FW", "FORWARD", "STRIKER"].includes(raw)) return "FWD";
  return "MID";
}

function teamNameFromMeta(teamMeta, teamId) {
  return teamMeta instanceof Map ? teamMeta.get(String(teamId))?.name || "" : "";
}

function teamLogoFromMeta(teamMeta, teamId) {
  return teamMeta instanceof Map ? teamMeta.get(String(teamId))?.logo || "" : "";
}

function teamMetaName(teamMeta, teamId) {
  return teamNameFromMeta(teamMeta, teamId) || String(teamId || "");
}

function addTeam(teamMeta, team) {
  const id = toId(team?.id);
  if (!id) return;

  const prev = teamMeta.get(id) || {};
  teamMeta.set(id, {
    id,
    name: team?.name || prev.name || "",
    logo: team?.logo || prev.logo || "",
  });
}

function collectWorldCupTeamsFromDailyWindows(windows = []) {
  const teamMeta = new Map();

  for (const window of Array.isArray(windows) ? windows : []) {
    for (const fixture of Array.isArray(window?.fixtures) ? window.fixtures : []) {
      addTeam(teamMeta, {
        id: fixture?.homeTeamId,
        name: fixture?.homeTeam || fixture?.homeTeamName,
        logo: fixture?.homeTeamLogo,
      });
      addTeam(teamMeta, {
        id: fixture?.awayTeamId,
        name: fixture?.awayTeam || fixture?.awayTeamName,
        logo: fixture?.awayTeamLogo,
      });
    }
  }

  const teams = Array.from(teamMeta.values()).sort((a, b) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id))
  );

  return {
    teamIds: teams.map((team) => String(team.id)).filter(Boolean),
    teams,
    teamMeta,
  };
}

function collectWorldCupQualifiedTeams(qualifiedTeams = null) {
  const teamMeta = new Map();

  for (const team of Array.isArray(qualifiedTeams?.teams) ? qualifiedTeams.teams : []) {
    addTeam(teamMeta, team);
  }

  for (const teamId of Array.isArray(qualifiedTeams?.teamIds) ? qualifiedTeams.teamIds : []) {
    addTeam(teamMeta, { id: teamId });
  }

  const teams = Array.from(teamMeta.values()).sort((a, b) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id))
  );

  return {
    teamIds: teams.map((team) => String(team.id)).filter(Boolean),
    teams,
    teamMeta,
  };
}

function worldCupPoolPlayerId(player = {}) {
  return String(
    player?.id ??
      player?.playerId ??
      player?.apiPlayerId ??
      player?.pid ??
      player?.player?.id ??
      ""
  ).trim();
}

function buildWorldCupPoolRefreshReason({
  forceRefresh,
  lastApiRefreshAtMs,
  beforeCount,
  nowMs,
}) {
  if (forceRefresh) return "forced";
  if (beforeCount < WORLD_CUP_GLOBAL_PLAYER_POOL_MIN) return "below-minimum";
  if (!lastApiRefreshAtMs) return "missing-last-api-refresh";
  if (nowMs - lastApiRefreshAtMs > WORLD_CUP_GLOBAL_PLAYER_POOL_STALE_MS) {
    return "older-than-7-days";
  }
  return "fresh";
}

function createWorldCupPoolRefreshError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function ensureFreshWorldCupGlobalPlayerPool({
  db,
  apiFootballGet,
  apiKey,
  seasonKey,
  season,
  dailyWindows = [],
  qualifiedTeams = null,
  worldCupPhase = "group",
  maxPlayers = 5000,
  maxPagesPerTeam = 10,
  forceRefresh = false,
  dryRun = false,
  nowMs = Date.now(),
  loadDailyWindows = null,
}) {
  const cleanSeasonKey = String(seasonKey || "").trim();
  if (!cleanSeasonKey) {
    throw createWorldCupPoolRefreshError(
      "failed-precondition",
      "World Cup seasonKey is required."
    );
  }

  const metaRef = db.doc(
    `globalData/main/seasons/${cleanSeasonKey}/meta/playerPool`
  );
  const [existingPlayers, metaSnap] = await Promise.all([
    loadSeasonPlayerPool({ db, seasonKey: cleanSeasonKey }),
    metaRef.get(),
  ]);
  const beforeCount = existingPlayers.length;
  const initialMeta = metaSnap.exists ? metaSnap.data() || {} : {};
  const initialLastApiRefreshAtMs = Number(initialMeta.lastApiRefreshAtMs || 0);
  const wasStale =
    beforeCount < WORLD_CUP_GLOBAL_PLAYER_POOL_MIN ||
    !initialLastApiRefreshAtMs ||
    nowMs - initialLastApiRefreshAtMs >
      WORLD_CUP_GLOBAL_PLAYER_POOL_STALE_MS;
  const refreshReason = buildWorldCupPoolRefreshReason({
    forceRefresh,
    lastApiRefreshAtMs: initialLastApiRefreshAtMs,
    beforeCount,
    nowMs,
  });

  const baseResult = {
    players: existingPlayers,
    beforeCount,
    afterCount: beforeCount,
    addedCount: 0,
    refreshed: false,
    wasStale,
    lastApiRefreshAtMs: initialLastApiRefreshAtMs || null,
    latestFetchedCount: 0,
    teamCount: 0,
    teamFetchSummary: [],
    warnings: [],
    errors: [],
    source: "global-season-player-pool",
    refreshReason,
    globalWrittenCount: 0,
    missingPlayers: [],
    teamIds: [],
    teams: [],
    allTeamsProcessed: true,
    processedTeamCount: 0,
    expectedTeamCount: 0,
    hitCap: false,
    skippedTeamIdsDueToGlobalCap: [],
    pagesFetched: 0,
    missingFetchTeamIds: [],
    missingFetchTeamNames: [],
  };

  if (!forceRefresh && !wasStale) return baseResult;

  let lockResult = { acquired: false, reuseExisting: false };

  if (!dryRun) {
    lockResult = await db.runTransaction(async (transaction) => {
      const currentMetaSnap = await transaction.get(metaRef);
      const currentMeta = currentMetaSnap.exists
        ? currentMetaSnap.data() || {}
        : {};
      const buildingAtMs = Number(currentMeta.buildingAtMs || 0);
      const lockIsActive =
        currentMeta.status === "building" &&
        buildingAtMs > 0 &&
        nowMs - buildingAtMs <
          WORLD_CUP_GLOBAL_PLAYER_POOL_BUILD_LOCK_MS;

      if (lockIsActive) {
        if (beforeCount >= WORLD_CUP_GLOBAL_PLAYER_POOL_MIN) {
          return { acquired: false, reuseExisting: true };
        }
        throw createWorldCupPoolRefreshError(
          "aborted",
          "World Cup global player pool refresh is already building. Retry shortly."
        );
      }

      const currentLastApiRefreshAtMs = Number(
        currentMeta.lastApiRefreshAtMs || 0
      );
      const becameFresh =
        !forceRefresh &&
        beforeCount >= WORLD_CUP_GLOBAL_PLAYER_POOL_MIN &&
        currentLastApiRefreshAtMs > 0 &&
        nowMs - currentLastApiRefreshAtMs <=
          WORLD_CUP_GLOBAL_PLAYER_POOL_STALE_MS;

      if (becameFresh) {
        return { acquired: false, reuseExisting: true };
      }

      transaction.set(
        metaRef,
        {
          status: "building",
          buildingAtMs: nowMs,
          updatedAtMs: nowMs,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          staleMs: WORLD_CUP_GLOBAL_PLAYER_POOL_STALE_MS,
          refreshReason,
        },
        { merge: true }
      );

      return { acquired: true, reuseExisting: false };
    });
  }

  if (lockResult.reuseExisting) {
    const reusablePlayers = await loadSeasonPlayerPool({
      db,
      seasonKey: cleanSeasonKey,
    });
    return {
      ...baseResult,
      players: reusablePlayers,
      afterCount: reusablePlayers.length,
      warnings: [
        "World Cup global pool refresh already building or just completed; reused existing pool.",
      ],
      source: "global-season-player-pool-building-reuse",
    };
  }

  try {
    let resolvedDailyWindows = Array.isArray(dailyWindows)
      ? dailyWindows
      : [];
    const discoveryWarnings = [];

    if (!resolvedDailyWindows.length && typeof loadDailyWindows === "function") {
      try {
        resolvedDailyWindows = await loadDailyWindows();
      } catch (error) {
        if (!Array.isArray(qualifiedTeams?.teamIds) || !qualifiedTeams.teamIds.length) {
          throw error;
        }
        discoveryWarnings.push(
          "World Cup daily-window team discovery failed; used qualified teams instead."
        );
      }
    }

    let collected = collectWorldCupTeamsFromDailyWindows(resolvedDailyWindows);
    if (!collected.teamIds.length) {
      collected = collectWorldCupQualifiedTeams(qualifiedTeams);
    }

    if (!collected.teamIds.length) {
      throw createWorldCupPoolRefreshError(
        "failed-precondition",
        `Could not discover World Cup teams for ${worldCupPhase || "room"} player pool refresh.`
      );
    }

    const fetchResult = await fetchWorldCupTeamPlayerPool({
      apiFootballGet,
      apiKey,
      season,
      teamIds: collected.teamIds,
      teamMeta: collected.teamMeta,
      maxPlayers,
      maxPagesPerTeam,
    });
    const fetchedPlayers = Array.isArray(fetchResult.players)
      ? fetchResult.players
      : [];
    const existingIds = new Set(
      existingPlayers.map(worldCupPoolPlayerId).filter(Boolean)
    );
    const missingPlayers = fetchedPlayers.filter((player) => {
      const playerId = worldCupPoolPlayerId(player);
      return playerId && !existingIds.has(playerId);
    });
    const mergedPlayersById = new Map();

    for (const player of existingPlayers) {
      const playerId = worldCupPoolPlayerId(player);
      if (playerId) mergedPlayersById.set(playerId, player);
    }
    for (const player of fetchedPlayers) {
      const playerId = worldCupPoolPlayerId(player);
      if (playerId) mergedPlayersById.set(playerId, player);
    }

    const warnings = [...discoveryWarnings];
    if (fetchResult.allTeamsProcessed === false) {
      warnings.push("World Cup API refresh did not process every discovered team.");
    }
    if (fetchResult.hitCap === true) {
      warnings.push(`World Cup API refresh reached the ${maxPlayers}-player cap.`);
    }
    if ((fetchResult.emptyTeamIds || []).length) {
      warnings.push(
        `${fetchResult.emptyTeamIds.length} World Cup teams returned no player rows.`
      );
    }

    const refreshIsComplete =
      fetchedPlayers.length >= WORLD_CUP_GLOBAL_PLAYER_POOL_MIN &&
      fetchResult.allTeamsProcessed !== false &&
      fetchResult.hitCap !== true;
    const projectedAfterCount = mergedPlayersById.size;

    if (dryRun) {
      return {
        ...baseResult,
        players: Array.from(mergedPlayersById.values()),
        afterCount: projectedAfterCount,
        latestFetchedCount: fetchedPlayers.length,
        teamCount: collected.teamIds.length,
        teamFetchSummary: fetchResult.teamFetchSummary || [],
        warnings,
        source: "api-football-world-cup-dry-run",
        missingPlayers,
        teamIds: collected.teamIds,
        teams: collected.teams,
        allTeamsProcessed: fetchResult.allTeamsProcessed === true,
        processedTeamCount: Number(fetchResult.processedTeamCount || 0),
        expectedTeamCount: Number(fetchResult.expectedTeamCount || 0),
        hitCap: Boolean(fetchResult.hitCap),
        skippedTeamIdsDueToGlobalCap:
          fetchResult.skippedTeamIdsDueToGlobalCap || [],
        pagesFetched: Number(fetchResult.pagesFetched || 0),
        missingFetchTeamIds: fetchResult.missingFetchTeamIds || [],
        missingFetchTeamNames: fetchResult.missingFetchTeamNames || [],
      };
    }

    const globalWrittenCount = await bootstrapSeasonPlayerPool({
      db,
      seasonKey: cleanSeasonKey,
      players: fetchedPlayers,
    });
    const completedAtMs = Date.now();
    const metadataPatch = {
      playerCount: projectedAfterCount,
      latestFetchedCount: fetchedPlayers.length,
      globalWrittenCount,
      updatedAtMs: completedAtMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: refreshIsComplete ? "ready" : "warning",
      source: "api-football-world-cup-team-player-pool",
      staleMs: WORLD_CUP_GLOBAL_PLAYER_POOL_STALE_MS,
      refreshReason,
      teamCount: collected.teamIds.length,
      teamFetchSummary: fetchResult.teamFetchSummary || [],
      warnings,
      errors: [],
      buildingAtMs: admin.firestore.FieldValue.delete(),
    };

    if (refreshIsComplete) {
      metadataPatch.lastApiRefreshAtMs = completedAtMs;
      metadataPatch.lastApiRefreshAt =
        admin.firestore.FieldValue.serverTimestamp();
    }

    await metaRef.set(metadataPatch, { merge: true });

    return {
      ...baseResult,
      players: Array.from(mergedPlayersById.values()),
      afterCount: projectedAfterCount,
      addedCount: missingPlayers.length,
      refreshed: true,
      lastApiRefreshAtMs: refreshIsComplete
        ? completedAtMs
        : initialLastApiRefreshAtMs || null,
      latestFetchedCount: fetchedPlayers.length,
      teamCount: collected.teamIds.length,
      teamFetchSummary: fetchResult.teamFetchSummary || [],
      warnings,
      source: "global-season-player-pool-refreshed",
      globalWrittenCount,
      missingPlayers,
      teamIds: collected.teamIds,
      teams: collected.teams,
      allTeamsProcessed: fetchResult.allTeamsProcessed === true,
      processedTeamCount: Number(fetchResult.processedTeamCount || 0),
      expectedTeamCount: Number(fetchResult.expectedTeamCount || 0),
      hitCap: Boolean(fetchResult.hitCap),
      skippedTeamIdsDueToGlobalCap:
        fetchResult.skippedTeamIdsDueToGlobalCap || [],
      pagesFetched: Number(fetchResult.pagesFetched || 0),
      missingFetchTeamIds: fetchResult.missingFetchTeamIds || [],
      missingFetchTeamNames: fetchResult.missingFetchTeamNames || [],
    };
  } catch (error) {
    if (!dryRun && lockResult.acquired) {
      await metaRef.set(
        {
          status: "error",
          buildingAtMs: admin.firestore.FieldValue.delete(),
          updatedAtMs: Date.now(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          staleMs: WORLD_CUP_GLOBAL_PLAYER_POOL_STALE_MS,
          refreshReason,
          errors: [String(error?.message || error)],
        },
        { merge: true }
      );
    }
    throw error;
  }
}

function normalizeTeamSeasonPlayer({ item, teamId, teamMeta, season }) {
  const player = item?.player || {};
  const playerId = toId(player.id);
  if (!playerId) return null;

  const stats = Array.isArray(item?.statistics)
    ? item.statistics.find((row) => String(row?.team?.id || "") === String(teamId)) || item.statistics[0] || {}
    : {};
  const teamName = stats?.team?.name || teamNameFromMeta(teamMeta, teamId);
  const teamLogo = stats?.team?.logo || teamLogoFromMeta(teamMeta, teamId);
  const fullName = `${player.firstname || ""} ${player.lastname || ""}`.trim();

  return {
    id: playerId,
    playerId,
    name: fullName || player.name || "Unknown",
    position: normalizeWorldCupSquadPosition(stats?.games?.position || stats?.games?.pos || player.position),
    teamId: String(teamId),
    teamName,
    teamLogo,
    nationality: player.nationality || "",
    provider: "api-football",
    source: "players-team-season",
    season: String(season),
  };
}

function normalizeSquadPlayer({ player, teamId, teamMeta, season }) {
  const playerId = toId(player?.id);
  if (!playerId) return null;

  return {
    id: playerId,
    playerId,
    name: player?.name || "Unknown",
    position: normalizeWorldCupSquadPosition(player?.position),
    teamId: String(teamId),
    teamName: teamNameFromMeta(teamMeta, teamId),
    teamLogo: teamLogoFromMeta(teamMeta, teamId),
    nationality: teamNameFromMeta(teamMeta, teamId),
    provider: "api-football",
    source: "players-squads-fallback",
    season: String(season),
  };
}

async function fetchSquadFallbackForTeam({ apiFootballGet, apiKey, teamId, teamMeta, season }) {
  const res = await apiFootballGet("players/squads", { team: teamId }, apiKey);
  const rows = Array.isArray(res?.response) ? res.response : [];
  const players = [];

  for (const row of rows) {
    if (row?.team) {
      addTeam(teamMeta, {
        id: row.team.id || teamId,
        name: row.team.name,
        logo: row.team.logo,
      });
    }

    for (const player of Array.isArray(row?.players) ? row.players : []) {
      const normalized = normalizeSquadPlayer({ player, teamId, teamMeta, season });
      if (normalized) players.push(normalized);
    }
  }

  return players;
}

async function fetchWorldCupTeamPlayerPool({
  apiFootballGet,
  apiKey,
  season,
  teamIds = [],
  teamMeta = new Map(),
  maxPlayers = 5000,
  maxPagesPerTeam = 10,
}) {
  const uniqueTeamIds = Array.from(new Set((teamIds || []).map(toId).filter(Boolean)));
  const byPlayerId = new Map();
  const teamFetchSummary = [];
  const usedSquadFallbackTeamIds = [];
  const emptyTeamIds = [];
  const skippedTeamIdsDueToGlobalCap = [];
  let pagesFetched = 0;

  const addPlayer = (player) => {
    if (!player?.id || byPlayerId.has(String(player.id))) return false;
    if (byPlayerId.size >= maxPlayers) return false;
    byPlayerId.set(String(player.id), player);
    return true;
  };

  for (const teamId of uniqueTeamIds) {
    const beforeCount = byPlayerId.size;
    let hitGlobalCapAtTeam = byPlayerId.size >= maxPlayers;

    if (hitGlobalCapAtTeam) {
      skippedTeamIdsDueToGlobalCap.push(teamId);
      teamFetchSummary.push({
        teamId,
        teamName: teamNameFromMeta(teamMeta, teamId),
        playerCount: 0,
        source: "skipped-global-cap",
        pagesFetched: 0,
        hitGlobalCapAtTeam: true,
      });
      continue;
    }

    let page = 1;
    let totalPages = 1;
    let teamSeasonCount = 0;
    let pagesForTeam = 0;

    while (page <= totalPages && page <= maxPagesPerTeam && byPlayerId.size < maxPlayers) {
      const res = await apiFootballGet("players", { team: teamId, season, page }, apiKey);
      totalPages = Number(res?.paging?.total ?? 1) || 1;
      pagesFetched += 1;
      pagesForTeam += 1;

      for (const item of Array.isArray(res?.response) ? res.response : []) {
        const normalized = normalizeTeamSeasonPlayer({ item, teamId, teamMeta, season });
        if (!normalized) continue;
        teamSeasonCount += 1;
        addPlayer(normalized);
        if (byPlayerId.size >= maxPlayers) {
          hitGlobalCapAtTeam = true;
          break;
        }
      }

      page += 1;
    }

    let source = "players-team-season";

    if (teamSeasonCount === 0 && byPlayerId.size < maxPlayers) {
      const squadPlayers = await fetchSquadFallbackForTeam({
        apiFootballGet,
        apiKey,
        teamId,
        teamMeta,
        season,
      });
      for (const player of squadPlayers) {
        addPlayer(player);
        if (byPlayerId.size >= maxPlayers) {
          hitGlobalCapAtTeam = true;
          break;
        }
      }
      if (squadPlayers.length) {
        source = "players-squads-fallback";
        usedSquadFallbackTeamIds.push(teamId);
      } else {
        source = "empty";
        emptyTeamIds.push(teamId);
      }
    }

    teamFetchSummary.push({
      teamId,
      teamName: teamNameFromMeta(teamMeta, teamId),
      playerCount: byPlayerId.size - beforeCount,
      source,
      pagesFetched: pagesForTeam,
      hitGlobalCapAtTeam,
    });
  }

  const players = Array.from(byPlayerId.values());
  const summarizedTeamIds = new Set(teamFetchSummary.map((row) => String(row.teamId)));
  const missingFetchTeamIds = uniqueTeamIds.filter((teamId) => !summarizedTeamIds.has(String(teamId)));

  return {
    players,
    written: players.length,
    pagesFetched,
    teamFetchSummary,
    teamIds: uniqueTeamIds,
    teamCount: uniqueTeamIds.length,
    processedTeamCount: teamFetchSummary.length,
    expectedTeamCount: uniqueTeamIds.length,
    allTeamsProcessed: teamFetchSummary.length === uniqueTeamIds.length,
    missingFetchTeamIds,
    missingFetchTeamNames: missingFetchTeamIds.map((teamId) => teamMetaName(teamMeta, teamId)),
    skippedTeamIdsDueToGlobalCap,
    usedSquadFallbackTeamIds,
    emptyTeamIds,
    hitCap: players.length >= maxPlayers,
    maxPlayers,
  };
}

module.exports = {
  WORLD_CUP_GLOBAL_PLAYER_POOL_MIN,
  WORLD_CUP_GLOBAL_PLAYER_POOL_STALE_MS,
  collectWorldCupTeamsFromDailyWindows,
  ensureFreshWorldCupGlobalPlayerPool,
  normalizeWorldCupSquadPosition,
  fetchWorldCupTeamPlayerPool,
};
