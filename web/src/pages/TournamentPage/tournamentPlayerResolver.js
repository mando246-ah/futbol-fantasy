function cleanString(value) {
  return String(value ?? "").trim();
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (!text) continue;
    if (text.toLowerCase() === "unknown") continue;
    if (text.toLowerCase() === "unknown team") continue;
    return text;
  }
  return "";
}

function entryObject(entry) {
  return entry && typeof entry === "object" ? entry : {};
}

function entryId(entry) {
  const obj = entryObject(entry);
  return cleanString(
    obj.id ??
      obj.playerId ??
      obj.pid ??
      obj.apiPlayerId ??
      obj.player?.id ??
      obj.player?.playerId ??
      entry
  );
}

function ownerUidOf(pick = {}) {
  return cleanString(
    pick.ownerUid ??
      pick.ownerId ??
      pick.ownedBy ??
      pick.managerUid ??
      pick.userId ??
      pick.uid ??
      pick.pickedByUid ??
      pick.pickedBy ??
      pick.owner?.uid ??
      pick.owner?.id
  );
}

function normalizePosition(value) {
  const raw = cleanString(value).toUpperCase();
  if (["G", "GK", "GOALKEEPER"].includes(raw)) return "GK";
  if (["D", "DEF", "DEFENDER"].includes(raw)) return "DEF";
  if (["M", "MID", "MIDFIELDER"].includes(raw)) return "MID";
  if (["A", "ATT", "FWD", "FW", "FORWARD", "STRIKER"].includes(raw)) return "ATT";
  return raw || "MID";
}

function normalizePlayer(input, fallbackId = "") {
  const obj = entryObject(input);
  const player = entryObject(obj.player);
  const team = entryObject(obj.team);
  const id = entryId(obj) || cleanString(fallbackId);
  if (!id) return null;

  return {
    ...obj,
    id,
    playerId: id,
    _docId: cleanString(obj._docId ?? obj.id),
    _sourcePlayerId: cleanString(obj.playerId ?? obj.pid ?? obj.apiPlayerId ?? player.id ?? player.playerId),
    name: firstText(
      obj.name,
      obj.playerName,
      obj.fullName,
      obj.displayName,
      player.name,
      player.playerName
    ) || "Unknown",
    playerName: firstText(obj.playerName, obj.name, player.name) || "Unknown",
    position: normalizePosition(obj.position || obj.pos || obj.role || player.position || player.pos),
    teamName: firstText(obj.teamName, team.name, obj.clubName, obj.club, obj.team),
    teamLogo: firstText(obj.teamLogo, team.logo, obj.logo),
    nationality: firstText(
      obj.nationality,
      obj.country,
      obj.countryName,
      obj.playerCountry,
      obj.countryCode,
      player.nationality,
      player.country
    ),
    country: firstText(
      obj.country,
      obj.nationality,
      obj.countryName,
      obj.playerCountry,
      obj.countryCode,
      player.country,
      player.nationality
    ),
  };
}

function addPlayerToMap(map, player) {
  if (!player?.id) return;
  const aliases = Array.from(
    new Set(
      [player.id, player.playerId, player.pid, player.apiPlayerId, player._docId, player._sourcePlayerId]
        .map((value) => cleanString(value))
        .filter(Boolean)
    )
  );
  const existing = aliases.map((alias) => map.get(alias)).find(Boolean);
  const merged = {
    ...(existing || {}),
    ...player,
    name: firstText(existing?.name, player.name) || player.name || existing?.name || "Unknown",
    teamName: firstText(existing?.teamName, player.teamName) || player.teamName || existing?.teamName || "",
    nationality: firstText(existing?.nationality, player.nationality) || player.nationality || existing?.nationality || "",
    country: firstText(existing?.country, player.country) || player.country || existing?.country || "",
  };

  for (const alias of aliases) {
    map.set(alias, merged);
  }
}

function valuesFromMaybeCollection(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return Array.from(value.values());
  if (typeof value === "object") {
    return Object.entries(value).map(([key, item]) => {
      if (item && typeof item === "object") {
        return { id: item.id ?? item.playerId ?? key, ...item };
      }
      return item;
    });
  }
  return [];
}

export function buildTournamentPlayerResolver({
  players = [],
  picks = [],
  lineups = {},
} = {}) {
  const playersById = new Map();
  const pickDocToPlayer = new Map();
  const rosterByUid = new Map();

  for (const rawPlayer of valuesFromMaybeCollection(players)) {
    const player = normalizePlayer(rawPlayer);
    addPlayerToMap(playersById, player);
  }

  for (const rawPick of valuesFromMaybeCollection(picks)) {
    const pick = entryObject(rawPick);
    const player = normalizePlayer({
      ...pick,
      id:
        pick.playerId ??
        pick.pid ??
        pick.apiPlayerId ??
        pick.player?.id ??
        pick.player?.playerId ??
        pick.id,
    });

    if (!player?.id) continue;

    addPlayerToMap(playersById, player);
    pickDocToPlayer.set(String(player.id), player);
    if (pick.id) pickDocToPlayer.set(String(pick.id), player);
    if (pick._pickDocId) pickDocToPlayer.set(String(pick._pickDocId), player);

    const ownerUid = ownerUidOf(pick);
    if (ownerUid) {
      const roster = rosterByUid.get(ownerUid) || [];
      roster.push(player);
      rosterByUid.set(ownerUid, roster);
    }
  }

  for (const [uid, lineup] of Object.entries(lineups || {})) {
    const lineupObj = entryObject(lineup);
    const inlinePlayers = [
      ...(Array.isArray(lineupObj.starters) ? lineupObj.starters : []),
      ...(Array.isArray(lineupObj.startingXI) ? lineupObj.startingXI : []),
      ...(Array.isArray(lineupObj.starting11) ? lineupObj.starting11 : []),
      ...(Array.isArray(lineupObj.bench) ? lineupObj.bench : []),
      ...(Array.isArray(lineupObj.subs) ? lineupObj.subs : []),
      ...(Array.isArray(lineupObj.substitutes) ? lineupObj.substitutes : []),
    ].filter((entry) => entry && typeof entry === "object");

    for (const rawPlayer of inlinePlayers) {
      const player = normalizePlayer(rawPlayer);
      if (!player?.id) continue;
      addPlayerToMap(playersById, player);
      const roster = rosterByUid.get(String(uid)) || [];
      roster.push(player);
      rosterByUid.set(String(uid), roster);
    }
  }

  function resolvePlayer(entry, fallbackUid = "") {
    const obj = entryObject(entry);
    const rawId = entryId(entry);
    const fromPick = pickDocToPlayer.get(rawId) || null;
    const pid = cleanString(fromPick?.id || fromPick?.playerId || rawId);
    const known = playersById.get(pid) || fromPick || null;
    const resolvedId = cleanString(known?.id || known?.playerId || pid);
    const existingStats = obj.stats || obj.rawStats || {};

    const resolved = {
      ...obj,
      id: resolvedId,
      playerId: resolvedId,
      name: firstText(known?.name, known?.playerName, obj.name, obj.playerName, obj.fullName, obj.displayName) || "Unknown",
      playerName: firstText(known?.playerName, known?.name, obj.playerName, obj.name) || "Unknown",
      position: normalizePosition(known?.position || obj.position || obj.pos || obj.role),
      teamName: firstText(
        existingStats.teamName,
        existingStats.realTeamName,
        existingStats.clubName,
        known?.teamName,
        known?.team?.name,
        obj.teamName,
        obj.team?.name,
        obj.clubName,
        obj.club
      ),
      teamLogo: firstText(known?.teamLogo, known?.team?.logo, obj.teamLogo, obj.team?.logo),
      nationality: firstText(known?.nationality, known?.country, obj.nationality, obj.country, obj.countryName, obj.countryCode),
      country: firstText(known?.country, known?.nationality, obj.country, obj.nationality, obj.countryName, obj.countryCode),
    };

    const ownerUid = cleanString(fallbackUid || ownerUidOf(obj));
    if (ownerUid && resolved.id) {
      const roster = rosterByUid.get(ownerUid) || [];
      if (!roster.some((player) => String(player.id) === String(resolved.id))) {
        roster.push(resolved);
        rosterByUid.set(ownerUid, roster);
      }
    }

    return resolved;
  }

  function resolveList(list, fallbackUid = "") {
    if (!Array.isArray(list)) return [];
    return list.map((entry) => resolvePlayer(entry, fallbackUid)).filter((player) => player?.id);
  }

  function getRosterForUid(uid) {
    return resolveList(rosterByUid.get(String(uid || "")) || [], uid);
  }

  return {
    playersById,
    pickDocToPlayer,
    rosterByUid,
    resolvePlayer,
    resolveList,
    getRosterForUid,
  };
}
