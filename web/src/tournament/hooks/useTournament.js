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
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
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
        });
      }
    })
  );

  return map;
}

/** ---------- hook ---------- **/

export function useTournament(roomId) {
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
        const usersDraft = [];
        

        for (const uid of memberUids) {
          const [profile, tnDoc, lineup] = await Promise.all([
            fetchUserDoc(uid),
            fetchTeamNameDoc(roomId, uid),
            fetchLineupDoc(roomId, uid),
          ]);

          const displayName = (profile?.displayName || profile?.name || uid).trim();
          const teamName = (tnDoc?.teamName || profile?.teamName || "").trim();
          const name = teamName ? `${displayName} — ${teamName}` : displayName;
          const photoURL = (profile?.photoURL || profile?.avatarUrl || profile?.photoUrl || "").trim();

          const { inline, ids } = extractStarterIdsOrInline(lineup);
          const { inline: benchInline, ids: benchIds } = extractBenchIdsOrInline(lineup);

          if (ids.length) allPlayerIds.push(...ids);
          if (benchIds.length) allPlayerIds.push(...benchIds);

          usersDraft.push({
            userId: uid,
            name,
            displayName,
            teamName,
            photoURL,
            startersInline: inline,
            starterIds: ids,
            benchInline,
            benchIds,
          });
        }

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

        // 6) Stats + LOCAL compute (Option A fallback)
        const provider = getStatsProvider();
        const statsByPlayerIdByUserId = {};

        for (const u of users) {
          statsByPlayerIdByUserId[u.userId] = await provider.getRoundStats({
            roomId,
            roundId,
            players: u.starters,
          });
        }

        const localResults = computeRoundResults({
          roomId,
          roundId,
          users,
          statsByPlayerIdByUserId,
        });

        // 7) Prefer OFFICIAL results if they exist
        let officialResults = null;
        const rrRef = doc(db, "rooms", roomId, "roundResults", String(roundId));
        const rrSnap = await getDoc(rrRef);
        if (rrSnap.exists()) officialResults = rrSnap.data();

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
            roomId,
            roundId,
            room,
            users,
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
  }, [roomId]);

  return { loading, error, data };
}
