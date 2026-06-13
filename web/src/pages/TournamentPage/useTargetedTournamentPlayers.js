import { useEffect, useMemo, useRef, useState } from "react";
import { doc, getDoc } from "firebase/firestore";

import { db } from "../../firebase";

function cleanId(value) {
  return String(value ?? "").trim();
}

function playerIdOf(value, fallbackId = "") {
  if (value == null) return cleanId(fallbackId);
  if (typeof value === "string" || typeof value === "number") {
    return cleanId(value);
  }

  return cleanId(
    value.playerId ??
      value.pid ??
      value.apiPlayerId ??
      value.player?.id ??
      value.player?.playerId ??
      value.id ??
      fallbackId
  );
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const normalized = text.toLowerCase();
    if (normalized === "unknown" || normalized === "unknown team") continue;
    return text;
  }
  return "";
}

function normalizeCandidate(value, fallbackId = "") {
  const source =
    value && typeof value === "object"
      ? value
      : { id: playerIdOf(value, fallbackId) };
  const id = playerIdOf(source, fallbackId);
  if (!id) return null;

  return {
    ...source,
    id,
    playerId: id,
    name: firstText(
      source.name,
      source.playerName,
      source.fullName,
      source.displayName,
      source.player?.name
    ),
    position: firstText(
      source.position,
      source.pos,
      source.role,
      source.player?.position
    ),
    teamName: firstText(
      source.teamName,
      source.clubName,
      source.club,
      source.team?.name
    ),
    teamLogo: firstText(source.teamLogo, source.team?.logo),
    nationality: firstText(
      source.nationality,
      source.country,
      source.playerCountry,
      source.player?.nationality
    ),
    country: firstText(
      source.country,
      source.nationality,
      source.playerCountry,
      source.player?.country
    ),
  };
}

function mergeCandidate(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  return {
    ...existing,
    ...incoming,
    id: incoming.id || existing.id,
    playerId: incoming.playerId || existing.playerId,
    name: firstText(existing.name, incoming.name),
    position: firstText(existing.position, incoming.position),
    teamName: firstText(existing.teamName, incoming.teamName),
    teamLogo: firstText(existing.teamLogo, incoming.teamLogo),
    nationality: firstText(existing.nationality, incoming.nationality),
    country: firstText(existing.country, incoming.country),
  };
}

function hasDisplayMetadata(player = {}) {
  return Boolean(
    firstText(player.name, player.playerName) &&
      firstText(player.position, player.pos, player.role) &&
      firstText(player.teamName, player.clubName, player.club, player.team?.name) &&
      firstText(player.nationality, player.country, player.playerCountry)
  );
}

function addCandidate(map, value, fallbackId = "", neededIds = null) {
  const candidate = normalizeCandidate(value, fallbackId);
  if (!candidate?.id) return;
  map.set(candidate.id, mergeCandidate(map.get(candidate.id), candidate));
  neededIds?.add(candidate.id);
}

function addPlayerList(map, value, neededIds = null) {
  if (!Array.isArray(value)) return;
  for (const entry of value) addCandidate(map, entry, "", neededIds);
}

function addRosterMap(map, value, neededIds) {
  if (!value || typeof value !== "object") return;
  for (const roster of Object.values(value)) {
    addPlayerList(map, roster, neededIds);
  }
}

function addPerPlayerMap(map, value, neededIds) {
  if (!value || typeof value !== "object") return;
  for (const [playerId, entry] of Object.entries(value)) {
    addCandidate(map, entry, playerId, neededIds);
  }
}

function addBreakdownByUserId(map, value, neededIds) {
  if (!value || typeof value !== "object") return;
  for (const breakdown of Object.values(value)) {
    if (!breakdown || typeof breakdown !== "object") continue;
    addPerPlayerMap(map, breakdown.perPlayer, neededIds);
    addPlayerList(map, breakdown.starters, neededIds);
    addPlayerList(map, breakdown.bench, neededIds);
  }
}

function addLineups(map, lineups, neededIds) {
  if (!lineups || typeof lineups !== "object") return;

  for (const lineup of Object.values(lineups)) {
    if (!lineup || typeof lineup !== "object") continue;
    const containers = [lineup, lineup.lineup, lineup.currentLineup].filter(Boolean);

    for (const container of containers) {
      addPlayerList(map, container.starters, neededIds);
      addPlayerList(map, container.startingXI, neededIds);
      addPlayerList(map, container.starting11, neededIds);
      addPlayerList(map, container.starterIds, neededIds);
      addPlayerList(map, container.startingIds, neededIds);
      addPlayerList(map, container.bench, neededIds);
      addPlayerList(map, container.subs, neededIds);
      addPlayerList(map, container.substitutes, neededIds);
      addPlayerList(map, container.benchIds, neededIds);
      addPlayerList(map, container.subIds, neededIds);
      addPlayerList(map, container.benchPlayerIds, neededIds);
    }
  }
}

function addResultDocument(map, result, neededIds) {
  if (!result || typeof result !== "object") return;

  addBreakdownByUserId(map, result.breakdownByUserId, neededIds);
  addBreakdownByUserId(map, result.liveBreakdownByUserId, neededIds);
  addRosterMap(map, result.startersByUserId, neededIds);
  addRosterMap(map, result.benchByUserId, neededIds);
  addPerPlayerMap(map, result.perPlayer, neededIds);
  addPlayerList(map, result.starters, neededIds);
  addPlayerList(map, result.bench, neededIds);

  for (const key of ["fixtures", "rows", "results", "days", "windows"]) {
    if (!Array.isArray(result[key])) continue;
    for (const child of result[key]) {
      addResultDocument(map, child, neededIds);
    }
  }
}

function buildCandidateMap({
  embeddedPlayers = [],
  picks = [],
  lineups = {},
  resultDocs = [],
}) {
  const candidates = new Map();
  const neededIds = new Set();

  addPlayerList(candidates, embeddedPlayers, neededIds);
  // Picks enrich the resolver, but only visible lineup/result IDs trigger reads.
  addPlayerList(candidates, picks);
  addLineups(candidates, lineups, neededIds);

  for (const result of resultDocs) {
    if (Array.isArray(result)) {
      for (const child of result) {
        addResultDocument(candidates, child, neededIds);
      }
    } else {
      addResultDocument(candidates, result, neededIds);
    }
  }

  return { candidates, neededIds };
}

export function useTargetedTournamentPlayers({
  roomId,
  embeddedPlayers = [],
  picks = [],
  lineups = {},
  resultDocs = [],
}) {
  const [playerDocs, setPlayerDocs] = useState([]);
  const fetchedIdsRef = useRef(new Set());

  const candidateState = useMemo(
    () =>
      buildCandidateMap({
        embeddedPlayers,
        picks,
        lineups,
        resultDocs,
      }),
    [embeddedPlayers, lineups, picks, resultDocs]
  );

  const missingIds = useMemo(
    () =>
      Array.from(candidateState.neededIds)
        .filter(
          (playerId) =>
            !hasDisplayMetadata(candidateState.candidates.get(playerId))
        )
        .sort(),
    [candidateState]
  );
  const missingIdsKey = missingIds.join("|");

  useEffect(() => {
    fetchedIdsRef.current = new Set();
    setPlayerDocs([]);
  }, [roomId]);

  useEffect(() => {
    if (!roomId || !missingIds.length) return undefined;

    const idsToFetch = missingIds.filter(
      (playerId) => !fetchedIdsRef.current.has(playerId)
    );
    if (!idsToFetch.length) return undefined;

    idsToFetch.forEach((playerId) => fetchedIdsRef.current.add(playerId));
    let cancelled = false;

    async function loadMissingPlayerDocs() {
      const loaded = [];
      const chunkSize = 25;

      for (let index = 0; index < idsToFetch.length; index += chunkSize) {
        const chunk = idsToFetch.slice(index, index + chunkSize);
        const snapshots = await Promise.all(
          chunk.map((playerId) =>
            getDoc(doc(db, "rooms", roomId, "players", playerId)).catch(
              () => null
            )
          )
        );

        if (cancelled) return;

        snapshots.forEach((snapshot, snapshotIndex) => {
          if (!snapshot?.exists()) return;
          loaded.push({
            id: snapshot.id || chunk[snapshotIndex],
            ...(snapshot.data() || {}),
          });
        });
      }

      if (cancelled || !loaded.length) return;
      setPlayerDocs((current) => {
        const byId = new Map(
          current.map((player) => [playerIdOf(player), player])
        );
        for (const player of loaded) {
          const id = playerIdOf(player);
          if (id) byId.set(id, player);
        }
        return Array.from(byId.values());
      });
    }

    loadMissingPlayerDocs();
    return () => {
      cancelled = true;
    };
  }, [missingIdsKey, roomId]);

  return playerDocs;
}
