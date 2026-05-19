"use strict";

const WORLD_CUP_GLOBAL_PLAYER_POOL_MIN = 300;

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
  collectWorldCupTeamsFromDailyWindows,
  normalizeWorldCupSquadPosition,
  fetchWorldCupTeamPlayerPool,
};
