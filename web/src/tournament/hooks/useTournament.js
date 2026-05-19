import { useEffect, useState } from "react";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { db, auth } from "../../firebase";
import { getStatsProvider } from "../services/statsProvider";
import { computeRoundResults } from "../logic/roundEngine";

/** ---------- helpers ---------- **/

function toPos(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "GK" || p === "GKP" || p.includes("KEEP")) return "GK";
  if (p === "DEF" || p.includes("BACK")) return "DEF";
  if (p === "MID" || p.includes("MID")) return "MID";
  if (p === "FWD" || p.includes("FORW") || p.includes("STRIK")) return "FWD";
  return "MID";
}

function normalizePlayer(raw) {
  if (!raw) return null;

  // raw can be object OR string id
  if (typeof raw === "string") {
    return { id: raw, name: "Unknown", position: "MID" };
  }

  const id = raw.id || raw.playerId || raw.pid || raw.apiPlayerId;

  if (!id) return null;

  return {
    id: String(id),
    name: raw.name || raw.fullName || raw.displayName || "Unknown",
    position: toPos(raw.position || raw.pos || raw.role),
  };
}

/**
 * Extract starters in a way that supports:
 * - starters: [ {id,name,position}, ... ]
 * - starters: [ "playerId1", "playerId2", ... ]
 * - startingXI / starting11
 * - lineup.starters / lineup.startingXI / lineup.starting11
 * - starterIds
 */
function extractStarterIdsOrInline(lineupData) {
  if (!lineupData) return { inline: [], ids: [] };

  const candidates = [
    lineupData.starters,
    lineupData.startingXI,
    lineupData.starting11,
    lineupData.startingIds,
    lineupData.starterIds,
    lineupData.lineup?.starters,
    lineupData.lineup?.startingXI,
    lineupData.lineup?.starting11,
    lineupData.currentLineup?.starters,
    lineupData.currentLineup?.startingXI,
    lineupData.currentLineup?.starting11,
    lineupData.benchXI,
    lineupData.benchPlayers,
    lineupData.benchPlayerIds,
    lineupData.lineup?.benchXI,
    lineupData.lineup?.benchPlayers,
    lineupData.lineup?.benchPlayerIds,
    lineupData.currentLineup?.benchXI,
    lineupData.currentLineup?.benchPlayers,
    lineupData.currentLineup?.benchPlayerIds,
  ];

  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue;

    // If it's a list of strings => ids
    if (typeof c[0] === "string") {
      return { inline: [], ids: c.map(String) };
    }

    // Otherwise treat as inline player objects
    const inline = c.map(normalizePlayer).filter(Boolean);
    if (inline.length) return { inline, ids: [] };
  }

  return { inline: [], ids: [] };
}

function extractBenchIdsOrInline(lineupData) {
  if (!lineupData) return { inline: [], ids: [] };

  const candidates = [
    lineupData.bench,
    lineupData.subs,
    lineupData.substitutes,
    lineupData.benchIds,
    lineupData.subIds,
    lineupData.lineup?.bench,
    lineupData.lineup?.subs,
    lineupData.currentLineup?.bench,
    lineupData.currentLineup?.subs,
  ];

  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue;

    if (typeof c[0] === "string" || typeof c[0] === "number") {
      return { inline: [], ids: c.map(String) };
    }

    const inline = c.map(normalizePlayer).filter(Boolean);
    if (inline.length) return { inline, ids: [] };
  }

  return { inline: [], ids: [] };
}

async function fetchRoomPicks(roomId) {
  const snap = await getDocs(collection(db, "rooms", roomId, "picks"));
  return snap.docs.map((d) => ({ _pickDocId: d.id, id: d.id, ...(d.data() || {}) }));
}

function inferOwnerUidFromPick(d) {
  const v =
    d?.ownerUid ?? d?.ownerId ?? d?.ownedBy ?? d?.managerUid ??
    d?.userId ?? d?.uid ?? d?.pickedByUid ?? d?.pickedBy ??
    d?.owner?.uid ?? d?.owner?.id;

  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.uid || v.id || null;
  return null;
}

async function fetchUserDoc(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

async function fetchTeamNameDoc(roomId, uid) {
  const snap = await getDoc(doc(db, "rooms", roomId, "teamNames", uid));
  return snap.exists() ? snap.data() : null;
}

async function fetchLineupDoc(roomId, uid) {
  const snap = await getDoc(doc(db, "rooms", roomId, "lineups", uid));
  return snap.exists() ? snap.data() : null;
}

async function fetchPlayersByIds(roomId, ids) {
  const unique = Array.from(new Set(ids));
  const map = new Map();

  await Promise.all(
    unique.map(async (id) => {
      const snap = await getDoc(doc(db, "rooms", roomId, "players", id));
      if (snap.exists()) {
        const d = snap.data();
        map.set(id, {
          id,
          name: d.name || d.fullName || d.displayName || "Unknown",
          position: toPos(d.position || d.pos || d.role),
          teamId: d.teamId || d.team?.id || null,
          teamName: d.teamName || d.clubName || d.team?.name || "",
          clubName: d.clubName || d.teamName || d.team?.name || "",
          teamLogo: d.teamLogo || d.team?.logo || "",
          nationality: d.nationality || d.country || d.playerCountry || "",
          country: d.country || d.nationality || d.playerCountry || "",
        });
      }
    })
  );

  return map;
}

/** ---------- hook ---------- **/

function hasCompleteOfficialResults(results) {
  if (!results || typeof results !== "object") return false;
  return Boolean(
    results.teamScoresByUserId &&
      (results.matchups || results.leaderboard || results.weekLeaderboard) &&
      results.breakdownByUserId
  );
}

async function fetchBasicMemberUser(roomId, uid) {
  const [profile, tnDoc] = await Promise.all([
    fetchUserDoc(uid).catch(() => null),
    fetchTeamNameDoc(roomId, uid).catch(() => null),
  ]);

  const displayName = (profile?.displayName || profile?.name || uid).trim();
  const teamName = (tnDoc?.teamName || profile?.teamName || "").trim();
  const name = teamName ? `${displayName} - ${teamName}` : displayName;
  const photoURL = (profile?.photoURL || profile?.avatarUrl || profile?.photoUrl || "").trim();

  return {
    userId: uid,
    uid,
    name,
    displayName,
    teamName,
    photoURL,
    starters: [],
    bench: [],
  };
}

function playerFromPick(p = {}) {
  const pid = String(p.playerId ?? p.pid ?? p.apiPlayerId ?? p.player?.id ?? "");
  if (!pid) return null;

  return {
    id: pid,
    name: p.playerName || p.name || p.player?.name || "Unknown",
    position: toPos(p.position || p.pos || p.role || p.player?.position),
    teamId: p.teamId || p.team?.id || null,
    teamName: p.teamName || p.clubName || p.club || p.team?.name || "",
    clubName: p.clubName || p.teamName || p.club || p.team?.name || "",
    teamLogo: p.teamLogo || p.team?.logo || "",
    nationality: p.nationality || p.country || p.playerCountry || "",
    country: p.country || p.nationality || p.playerCountry || "",
  };
}

export function useLineupsForUsers(roomId, userIds = [], options = {}) {
  const enabled = options.enabled ?? true;
  const idsKey = (Array.isArray(userIds) ? userIds : [])
    .map((uid) => String(uid || ""))
    .filter(Boolean)
    .sort()
    .join("|");
  const [state, setState] = useState({
    loading: false,
    error: null,
    usersById: {},
    lineupsByUid: {},
    picksMap: {},
    rosterByUid: {},
    loadingByUid: {},
  });

  useEffect(() => {
    let cancelled = false;
    const ids = idsKey.split("|").filter(Boolean);

    if (!roomId || !enabled || ids.length === 0) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: null,
        loadingByUid: {},
      }));
      return () => {
        cancelled = true;
      };
    }

    async function run() {
      const loadingByUid = Object.fromEntries(ids.map((uid) => [uid, true]));
      setState((prev) => ({
        ...prev,
        loading: true,
        error: null,
        loadingByUid: { ...prev.loadingByUid, ...loadingByUid },
      }));

      try {
        const drafts = await Promise.all(
          ids.map(async (uid) => {
            const [profile, tnDoc, lineup] = await Promise.all([
              fetchUserDoc(uid).catch(() => null),
              fetchTeamNameDoc(roomId, uid).catch(() => null),
              fetchLineupDoc(roomId, uid).catch(() => null),
            ]);

            const displayName = (profile?.displayName || profile?.name || uid).trim();
            const teamName = (tnDoc?.teamName || profile?.teamName || "").trim();
            const name = teamName ? `${displayName} - ${teamName}` : displayName;
            const photoURL = (profile?.photoURL || profile?.avatarUrl || profile?.photoUrl || "").trim();
            const { inline, ids: starterIds } = extractStarterIdsOrInline(lineup);
            const { inline: benchInline, ids: benchIds } = extractBenchIdsOrInline(lineup);

            return {
              uid,
              name,
              displayName,
              teamName,
              photoURL,
              lineup: lineup || {},
              startersInline: inline,
              starterIds,
              benchInline,
              benchIds,
            };
          })
        );

        const playerIds = [];
        for (const draft of drafts) {
          playerIds.push(...draft.starterIds, ...draft.benchIds);
        }

        const needsPickFallback = drafts.some(
          (draft) =>
            !draft.benchInline.length &&
            !draft.benchIds.length
        );
        const roomPicks = needsPickFallback ? await fetchRoomPicks(roomId) : [];
        const rosterByUid = {};
        const picksMap = {};

        for (const pick of roomPicks) {
          const uid = inferOwnerUidFromPick(pick);
          const player = playerFromPick(pick);
          if (!player?.id) continue;

          picksMap[player.id] = { ...pick, ...player, _resolvedPlayerId: player.id };
          if (pick.id) picksMap[pick.id] = { ...pick, ...player, _resolvedPlayerId: player.id };
          if (pick._pickDocId) picksMap[pick._pickDocId] = { ...pick, ...player, _resolvedPlayerId: player.id };

          if (!uid || !ids.includes(uid)) continue;
          if (!rosterByUid[uid]) rosterByUid[uid] = [];
          rosterByUid[uid].push(player);
          playerIds.push(player.id);
        }

        const playersById = await fetchPlayersByIds(roomId, playerIds);

        const usersById = {};
        const lineupsByUid = {};

        for (const draft of drafts) {
          const starters =
            draft.startersInline.length > 0
              ? draft.startersInline
              : draft.starterIds
                  .map((id) => playersById.get(String(id)) || picksMap[String(id)] || { id: String(id), name: "Unknown", position: "MID" })
                  .filter(Boolean);

          let bench =
            draft.benchInline.length > 0
              ? draft.benchInline
              : draft.benchIds
                  .map((id) => playersById.get(String(id)) || picksMap[String(id)] || { id: String(id), name: "Unknown", position: "MID" })
                  .filter(Boolean);

          const starterSet = new Set(starters.map((p) => String(p?.id || p?.playerId || "")));
          if (!bench.length) {
            bench = (rosterByUid[draft.uid] || []).filter(
              (p) => p?.id && !starterSet.has(String(p.id))
            );
          } else {
            bench = bench.filter((p) => p?.id && !starterSet.has(String(p.id)));
          }

          usersById[draft.uid] = {
            userId: draft.uid,
            uid: draft.uid,
            name: draft.name,
            displayName: draft.displayName,
            teamName: draft.teamName,
            photoURL: draft.photoURL,
            starters,
            bench,
          };
          lineupsByUid[draft.uid] = draft.lineup;
        }

        if (!cancelled) {
          setState((prev) => ({
            loading: false,
            error: null,
            usersById: { ...prev.usersById, ...usersById },
            lineupsByUid: { ...prev.lineupsByUid, ...lineupsByUid },
            picksMap: { ...prev.picksMap, ...picksMap },
            rosterByUid: { ...prev.rosterByUid, ...rosterByUid },
            loadingByUid: {
              ...prev.loadingByUid,
              ...Object.fromEntries(ids.map((uid) => [uid, false])),
            },
          }));
        }
      } catch (e) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: e,
            loadingByUid: {
              ...prev.loadingByUid,
              ...Object.fromEntries(ids.map((uid) => [uid, false])),
            },
          }));
        }
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [roomId, idsKey, enabled]);

  return state;
}

export function useTournament(roomId, options = {}) {
  const enableLocalFallback = options.enableLocalFallback ?? true;
  const lazyFallback = options.lazyFallback ?? false;
  const loadScope = options.loadScope || "full";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);

      try {
        const myUid = auth.currentUser?.uid;
        if (!myUid) throw new Error("Not signed in");

        // 1) Room doc (allowed: authed read)
        const roomSnap = await getDoc(doc(db, "rooms", roomId));
        if (!roomSnap.exists()) throw new Error(`Room ${roomId} not found`);
        const roomRaw = roomSnap.data() || {};

        // Step #3: prefer room.competitionState, fall back to legacy fields
        const competitionState = roomRaw.competitionState || {
          currentWeekIndex: roomRaw.currentWeekIndex ?? null,
          currentLabel: null,
          phaseLabel: null,
          weekStatus: null,
          isDone: false,
        };

        const room = { ...roomRaw, competitionState };
        const roundId = Number(room.currentRound ?? room.roundId ?? 1);

        // 2) Membership check (your membership model)
        const myMemberSnap = await getDoc(doc(db, "rooms", roomId, "members", myUid));
        if (!myMemberSnap.exists()) {
          throw new Error(
            "You are not registered as a room member (missing rooms/{roomId}/members/{uid}). " +
              "Join the room from the Draft/Join flow so the member doc is created."
          );
        }

        // 3) Load members
        const memSnap = await getDocs(collection(db, "rooms", roomId, "members"));
        const memberUids = memSnap.docs.map((d) => d.id).filter(Boolean);
        if (!memberUids.length) throw new Error("No room members found.");

        if (loadScope === "core") {
          const users = await Promise.all(
            memberUids.map((uid) => fetchBasicMemberUser(roomId, uid))
          );

          if (!cancelled) {
            setData({
              roomId,
              roundId,
              room,
              users,
              statsByPlayerIdByUserId: {},
              results: null,
            });
          }
          return;
        }

        // 4) Load picks + infer rosters (your pick model, ideally with playerId and ownerUid fields)
        const roomPicks = await fetchRoomPicks(roomId);

        const rosterByUid = new Map();
        const allPlayerIds = [];

        for (const p of roomPicks) {
          const uid = inferOwnerUidFromPick(p);
          const pid = String(p.playerId ?? p.pid ?? p.apiPlayerId ?? p.player?.id ?? "");
          if (!uid || !pid) continue;

          const playerObj = {
            id: pid,
            name: p.playerName || p.name || p.player?.name || "Unknown",
            position: toPos(p.position || p.pos || p.role || p.player?.position),
          };

          const arr = rosterByUid.get(uid) || [];
          arr.push(playerObj);
          rosterByUid.set(uid, arr);

          allPlayerIds.push(pid);
        }

        // 4) Load lineup docs + collect starter IDs that need resolving
        const usersDraft = await Promise.all(memberUids.map(async (uid) => {
          const [profile, tnDoc, lineup] = await Promise.all([
            fetchUserDoc(uid),
            fetchTeamNameDoc(roomId, uid),
            fetchLineupDoc(roomId, uid),
          ]);

          const displayName = (profile?.displayName || profile?.name || uid).trim();
          const teamName = (tnDoc?.teamName || profile?.teamName || "").trim();
          const name = teamName ? `${displayName} - ${teamName}` : displayName;
          const photoURL = (profile?.photoURL || profile?.avatarUrl || profile?.photoUrl || "").trim();

          const { inline, ids } = extractStarterIdsOrInline(lineup);
          const { inline: benchInline, ids: benchIds } = extractBenchIdsOrInline(lineup);

          if (ids.length) allPlayerIds.push(...ids);
          if (benchIds.length) allPlayerIds.push(...benchIds);

          return {
            userId: uid,
            name,
            displayName,
            teamName,
            photoURL,
            startersInline: inline,
            starterIds: ids,
            benchInline,
            benchIds,
          };
        }));

        // 5) Resolve starter IDs into player objects using rooms/{roomId}/players/{playerId}
        const playersById = await fetchPlayersByIds(roomId, allPlayerIds);

        const users = usersDraft.map((u) => {
        const starters =
          u.startersInline.length > 0
            ? u.startersInline
            : u.starterIds
                .map((id) => playersById.get(id) || { id, name: "Unknown", position: "MID" })
                .filter(Boolean);

        let bench =
          u.benchInline?.length > 0
            ? u.benchInline
            : (u.benchIds || [])
                .map((id) => playersById.get(id) || { id, name: "Unknown", position: "MID" })
                .filter(Boolean);

        if (!bench.length) {
          const roster = rosterByUid.get(u.userId) || [];
          const starterSet = new Set(starters.map((p) => String(p.id)));
          bench = roster.filter((p) => p?.id && !starterSet.has(String(p.id)));
        } else {
          const starterSet = new Set(starters.map((p) => String(p.id)));
          bench = bench.filter((p) => p?.id && !starterSet.has(String(p.id)));
        }

        return {
          userId: u.userId,
          name: u.name,
          displayName: u.displayName,
          teamName: u.teamName,
          photoURL: u.photoURL,
          starters,
          bench,
        };
      });

        const coreData = {
          roomId,
          roundId,
          room,
          users,
          statsByPlayerIdByUserId: {},
          results: null,
        };

        if (!enableLocalFallback) {
          if (!cancelled) setData(coreData);
          return;
        }

        // 6) Prefer OFFICIAL results before doing any local stat fallback work.
        let officialResults = null;
        const rrRef = doc(db, "rooms", roomId, "roundResults", String(roundId));
        const rrSnap = await getDoc(rrRef);
        if (rrSnap.exists()) officialResults = rrSnap.data();

        if (hasCompleteOfficialResults(officialResults)) {
          if (!cancelled) {
            setData({
              ...coreData,
              results: officialResults,
            });
          }
          return;
        }

        if (lazyFallback && !cancelled) {
          setData({
            ...coreData,
            results: officialResults || null,
          });
          setLoading(false);
        }

        // 7) Stats + LOCAL compute (Option A fallback)
        const provider = getStatsProvider();
        const statsEntries = await Promise.all(
          users.map(async (u) => [
            u.userId,
            await provider.getRoundStats({
              roomId,
              roundId,
              players: u.starters,
            }),
          ])
        );
        const statsByPlayerIdByUserId = Object.fromEntries(statsEntries);

        const localResults = computeRoundResults({
          roomId,
          roundId,
          users,
          statsByPlayerIdByUserId,
        });

        // If official is missing breakdown, fill it so per-player points still show
        const results = officialResults
          ? {
              ...localResults,
              ...officialResults,
              breakdownByUserId: officialResults.breakdownByUserId ?? localResults.breakdownByUserId,
              teamScoresByUserId: officialResults.teamScoresByUserId ?? localResults.teamScoresByUserId,
              matchups: officialResults.matchups ?? localResults.matchups,
              leaderboard: officialResults.leaderboard ?? localResults.leaderboard,
            }
          : localResults;

        if (!cancelled) {
          setData({
            ...coreData,
            statsByPlayerIdByUserId,
            results,
          });
        }
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (roomId) run();
    else {
      setLoading(false);
      setData(null);
    }

    return () => {
      cancelled = true;
    };
  }, [roomId, enableLocalFallback, lazyFallback, loadScope]);

  return { loading, error, data };
}

export function useTournamentCore(roomId) {
  return useTournament(roomId, { loadScope: "core", enableLocalFallback: false });
}
