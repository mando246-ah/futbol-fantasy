"use strict";

const admin = require("firebase-admin");
const { scorePlayer } = require("../shared/scoringCore");
const {
  WORLD_CUP_GROUP_ENGINE,
  WORLD_CUP_GROUP_PHASE,
} = require("./worldCupMode");
const { loadWorldCupGlobalFixtureCache } = require("./worldCupGlobalCache");

const PRE_MS = 20 * 60 * 1000;
const PREGAME_POLL_MS = 5 * 60 * 1000;
const ACTIVE_POLL_MS = 60 * 1000;
const UNKNOWN_RECHECK_MS = 60 * 60 * 1000;
const POST_MS = 3 * 60 * 60 * 1000;

function toPos(pos) {
  const s = String(pos || "").toUpperCase();
  if (s.startsWith("G")) return "GK";
  if (s.startsWith("D")) return "DEF";
  if (s.startsWith("M")) return "MID";
  if (s.startsWith("F") || s.startsWith("A")) return "FWD";
  return "MID";
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toId(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value);
}

function isInPlay(short) {
  return ["1H", "HT", "2H", "ET", "BT", "P"].includes(String(short || "").toUpperCase());
}

function isFinished(short) {
  return ["FT", "AET", "PEN"].includes(String(short || "").toUpperCase());
}

function hasFixtureStarted(short) {
  const s = String(short || "").trim().toUpperCase();
  if (!s) return false;
  if (["NS", "TBD", "PST", "CANC"].includes(s)) return false;
  return true;
}

function isNotStarted(short) {
  return ["", "NS", "TBD"].includes(String(short || "").trim().toUpperCase());
}

function kickoffMsFromFixture(fixture) {
  return toNumber(
    fixture?.kickoffMs ??
      fixture?.startAtMs ??
      (fixture?.fixture?.timestamp ? Number(fixture.fixture.timestamp) * 1000 : NaN),
    NaN
  );
}

function uniqueIds(values) {
  const out = [];
  const seen = new Set();

  for (const value of values || []) {
    const id = toId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

function inferPickOwnerUid(d = {}) {
  const v =
    d.ownerUid ??
    d.ownerId ??
    d.ownedBy ??
    d.managerUid ??
    d.userId ??
    d.uid ??
    d.pickedByUid ??
    d.pickedBy ??
    d.owner?.uid ??
    d.owner?.id;

  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.uid || v.id || null;
  return String(v);
}

function inferPickPlayerId(d = {}) {
  const v =
    d.playerId ??
    d.pid ??
    d.apiPlayerId ??
    d.id ??
    d.player?.id ??
    d.player?.playerId;

  return v === undefined || v === null ? null : String(v);
}

function pickOrder(d = {}) {
  const ms = d.createdAt?.toMillis?.() ?? 0;
  const n =
    d.pickIndex ??
    d.overallPick ??
    d.pickNumber ??
    d.pickNo ??
    d.index ??
    d.turn ??
    d.createdAtMs ??
    ms;
  const num = Number(n);
  return Number.isFinite(num) ? num : ms;
}

function normalizePlayerMeta(input = {}, fallbackId = "") {
  const id = toId(input.id ?? input.playerId ?? input.pid ?? input.apiPlayerId ?? input.player?.id ?? fallbackId);
  if (!id) return null;

  return {
    id,
    playerId: id,
    name:
      input.name ||
      input.playerName ||
      input.fullName ||
      input.player?.name ||
      "Unknown",
    position: toPos(input.position || input.pos || input.role || input.player?.position),
    teamId: toId(input.teamId ?? input.team?.id),
    teamName: input.teamName || input.team?.name || "",
    teamLogo: input.teamLogo || input.team?.logo || "",
    nationality: input.nationality || input.country || input.player?.nationality || "",
  };
}

function mergePlayerMeta(base, extra) {
  const a = base || {};
  const b = extra || {};
  const id = toId(a.id || a.playerId || b.id || b.playerId);
  if (!id) return null;

  return {
    id,
    playerId: id,
    name:
      (a.name && a.name !== "Unknown" ? a.name : null) ||
      a.playerName ||
      b.name ||
      b.playerName ||
      "Unknown",
    position: toPos(a.position || b.position),
    teamId: toId(a.teamId || b.teamId),
    teamName: a.teamName || b.teamName || "",
    teamLogo: a.teamLogo || b.teamLogo || "",
    nationality: a.nationality || b.nationality || "",
  };
}

function extractLineupList(lineupData, kind) {
  if (!lineupData) return [];

  const candidates =
    kind === "bench"
      ? [
          lineupData.bench,
          lineupData.subs,
          lineupData.substitutes,
          lineupData.benchIds,
          lineupData.subIds,
          lineupData.benchPlayers,
          lineupData.benchPlayerIds,
          lineupData.lineup?.bench,
          lineupData.lineup?.subs,
          lineupData.currentLineup?.bench,
          lineupData.currentLineup?.subs,
        ]
      : [
          lineupData.startingXI,
          lineupData.starting11,
          lineupData.starters,
          lineupData.starterIds,
          lineupData.startingIds,
          lineupData.lineup?.startingXI,
          lineupData.lineup?.starting11,
          lineupData.lineup?.starters,
        ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }

  return [];
}

function resolveLineupPlayers(values, playersById) {
  const out = [];
  const seen = new Set();

  for (const value of values || []) {
    const inline = typeof value === "object" && value !== null ? value : {};
    const id = toId(
      typeof value === "string" || typeof value === "number"
        ? value
        : inline.id ?? inline.playerId ?? inline.pid ?? inline.apiPlayerId ?? inline.player?.id
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const fromPool = playersById.get(id) || {};
    const inlineMeta = Object.keys(inline).length ? normalizePlayerMeta(inline, id) : null;
    const normalized = mergePlayerMeta(inlineMeta, fromPool) ||
      mergePlayerMeta(fromPool, { id });

    out.push(normalized || { id, playerId: id, name: "Unknown", position: "MID" });
  }

  return out;
}

function buildFallbackLineup(roster = [], playersById) {
  const sorted = [...roster].sort((a, b) => a.order - b.order);
  const starters = [];
  const seen = new Set();

  const gk = sorted.find((row) => toPos(playersById.get(row.pid)?.position || row.position) === "GK");
  if (gk?.pid) {
    starters.push(gk.pid);
    seen.add(gk.pid);
  }

  for (const row of sorted) {
    if (starters.length >= 11) break;
    if (!row.pid || seen.has(row.pid)) continue;
    starters.push(row.pid);
    seen.add(row.pid);
  }

  const bench = sorted.map((row) => row.pid).filter((pid) => pid && !seen.has(pid));
  return {
    starters: resolveLineupPlayers(starters, playersById),
    bench: resolveLineupPlayers(bench, playersById),
  };
}

async function loadRoomUsersLineups({ db, roomId, room, ensureDefaultLineupsForRoom }) {
  const [membersSnap, teamNamesSnap, playersSnap, picksSnap] = await Promise.all([
    db.collection(`rooms/${roomId}/members`).get().catch(() => ({ docs: [] })),
    db.collection(`rooms/${roomId}/teamNames`).get().catch(() => ({ docs: [] })),
    db.collection(`rooms/${roomId}/players`).get().catch(() => ({ docs: [] })),
    db.collection(`rooms/${roomId}/picks`).get().catch(() => ({ docs: [] })),
  ]);

  const playersById = new Map();
  for (const doc of playersSnap.docs || []) {
    const normalized = normalizePlayerMeta(doc.data() || {}, doc.id);
    if (normalized) playersById.set(normalized.id, normalized);
  }

  const membersByUid = new Map();
  for (const doc of membersSnap.docs || []) {
    const data = doc.data() || {};
    const uid = toId(data.uid || data.userId || doc.id);
    if (!uid) continue;
    membersByUid.set(uid, {
      uid,
      displayName: data.displayName || data.name || data.email || "Manager",
      teamName: data.teamName || data.clubName || data.displayName || "Team",
    });
  }

  const teamNamesByUid = new Map();
  for (const doc of teamNamesSnap.docs || []) {
    const data = doc.data() || {};
    teamNamesByUid.set(doc.id, data.teamName || data.name || data.displayName || "");
  }

  const rosterByUid = new Map();
  for (const doc of picksSnap.docs || []) {
    const data = doc.data() || {};
    const uid = inferPickOwnerUid(data);
    const pid = inferPickPlayerId(data);
    if (!uid || !pid) continue;

    const pickMeta = normalizePlayerMeta(data, pid);
    if (pickMeta) {
      playersById.set(pid, mergePlayerMeta(playersById.get(pid), pickMeta));
    }

    const roster = rosterByUid.get(uid) || [];
    roster.push({
      pid,
      order: pickOrder(data),
      position: pickMeta?.position || playersById.get(pid)?.position || "MID",
    });
    rosterByUid.set(uid, roster);

    if (!membersByUid.has(uid)) {
      membersByUid.set(uid, {
        uid,
        displayName: data.displayName || data.managerName || "Manager",
        teamName: data.teamName || data.managerTeamName || "Team",
      });
    }
  }

  for (const uid of Array.isArray(room?.memberUids) ? room.memberUids : []) {
    const id = toId(uid);
    if (!id || membersByUid.has(id)) continue;
    membersByUid.set(id, { uid: id, displayName: "Manager", teamName: "Team" });
  }

  const memberUids = [...membersByUid.keys()];
  if (ensureDefaultLineupsForRoom && memberUids.length) {
    await ensureDefaultLineupsForRoom(roomId, memberUids).catch((e) => {
      console.warn("[worldCupGroupEngine] ensureDefaultLineupsForRoom failed", {
        roomId,
        error: String(e?.message || e),
      });
    });
  }

  const lineupsSnap = await db.collection(`rooms/${roomId}/lineups`).get().catch(() => ({ docs: [] }));
  const lineupByUid = new Map();
  for (const doc of lineupsSnap.docs || []) {
    lineupByUid.set(doc.id, doc.data() || {});
  }

  const users = [];
  for (const uid of memberUids) {
    const member = membersByUid.get(uid) || { uid };
    const lineup = lineupByUid.get(uid) || {};
    const fallback = buildFallbackLineup(rosterByUid.get(uid) || [], playersById);

    const starters =
      resolveLineupPlayers(extractLineupList(lineup, "starters"), playersById) ||
      [];
    const bench =
      resolveLineupPlayers(extractLineupList(lineup, "bench"), playersById) ||
      [];

    users.push({
      uid,
      displayName: member.displayName || "Manager",
      teamName: teamNamesByUid.get(uid) || member.teamName || member.displayName || "Team",
      starters: starters.length ? starters : fallback.starters,
      bench: bench.length ? bench : fallback.bench,
    });
  }

  return { users, playersById };
}

function dayFixtureIds(day = {}) {
  const ids = [
    ...(Array.isArray(day.fixtureIds) ? day.fixtureIds : []),
    ...(Array.isArray(day.fixtures) ? day.fixtures.map((f) => f.fixtureId || f.id) : []),
  ];
  return uniqueIds(ids);
}

function dayFixtureById(day = {}) {
  const map = new Map();
  for (const fixture of Array.isArray(day.fixtures) ? day.fixtures : []) {
    const id = toId(fixture.fixtureId || fixture.id);
    if (id) map.set(id, fixture);
  }
  return map;
}

function computeDayWindowStatus({ day, fixtureIds, statusByFixtureId }) {
  const fixturesById = dayFixtureById(day);
  const statuses = fixtureIds.map((id) =>
    String(statusByFixtureId[id] || fixturesById.get(id)?.statusShort || "").toUpperCase()
  );

  const anyInPlay = statuses.some(isInPlay);
  const allFinished = statuses.length > 0 && statuses.every(isFinished);
  const allNotStarted = statuses.length > 0 && statuses.every(isNotStarted);

  if (anyInPlay) {
    return "live";
  }

  if (allFinished) {
    return "final";
  }

  if (allNotStarted) {
    return "scheduled";
  }

  return "scheduled";
}

function statusShortForFixture(fixture = {}, statusByFixtureId = {}) {
  const id = fixtureIdFromFixture(fixture);
  return String(
    statusByFixtureId[id] ||
      fixture?.statusShort ||
      fixture?.fixtureStatus ||
      fixture?.matchStatus ||
      fixture?.status?.short ||
      fixture?.fixture?.status?.short ||
      ""
  ).trim().toUpperCase();
}

function computeNextPollFromFixtures(fixtures = [], nowMs, statusByFixtureId = {}) {
  const rows = (Array.isArray(fixtures) ? fixtures : [])
    .map((fixture) => {
      const kickoffMs = kickoffMsFromFixture(fixture);
      const statusShort = statusShortForFixture(fixture, statusByFixtureId);
      const final = isFinished(statusShort);
      return {
        fixture,
        fixtureId: fixtureIdFromFixture(fixture),
        kickoffMs,
        statusShort,
        final,
      };
    })
    .filter((row) => Number.isFinite(row.kickoffMs));

  const activeRow = rows.find((row) =>
    !row.final &&
    (
      hasFixtureStarted(row.statusShort) ||
      (nowMs >= row.kickoffMs && nowMs <= row.kickoffMs + POST_MS)
    )
  );

  if (activeRow) {
    return {
      nextKickoffMs: activeRow.kickoffMs,
      nextPollAtMs: nowMs + ACTIVE_POLL_MS,
      reason: "world-cup-live-or-resolving-1min-check",
    };
  }

  const nextKickoffMs = rows
    .filter((row) => !row.final && row.kickoffMs > nowMs)
    .map((row) => row.kickoffMs)
    .sort((a, b) => a - b)[0] || null;

  if (!nextKickoffMs) {
    return {
      nextKickoffMs: null,
      nextPollAtMs: nowMs + UNKNOWN_RECHECK_MS,
      reason: "world-cup-no-known-kickoff",
    };
  }

  if (nowMs < nextKickoffMs - PRE_MS) {
    return {
      nextKickoffMs,
      nextPollAtMs: nextKickoffMs - PRE_MS,
      reason: "world-cup-sleep-until-pregame-window",
    };
  }

  if (nowMs < nextKickoffMs) {
    return {
      nextKickoffMs,
      nextPollAtMs: Math.min(nowMs + PREGAME_POLL_MS, nextKickoffMs),
      reason: "world-cup-pregame-5min-check",
    };
  }

  return {
    nextKickoffMs,
    nextPollAtMs: nowMs + ACTIVE_POLL_MS,
    reason: "world-cup-live-or-resolving-1min-check",
  };
}

function selectCurrentDay(days, nowMs) {
  const sorted = [...(days || [])].sort((a, b) => Number(a.dayIndex) - Number(b.dayIndex));
  if (!sorted.length) return null;

  return (
    sorted.find((day) => String(day.status || "").toLowerCase() !== "final") ||
    sorted[sorted.length - 1]
  );
}

async function loadDailyWindows(db, roomId) {
  const snap = await db.collection(`rooms/${roomId}/days`).get();
  return (snap.docs || [])
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .sort((a, b) => Number(a.dayIndex) - Number(b.dayIndex));
}

async function loadStatsForDay({
  fixtureIds,
  statusByFixtureId,
  globalPlayerStatsByFixtureId = {},
  getFixturePlayersStatsMapCached,
  apiKey,
  timezone,
}) {
  const statsByFixtureId = new Map();
  const fixtureCoverage = [];

  for (const fixtureId of fixtureIds) {
    const globalStats = globalPlayerStatsByFixtureId?.[fixtureId] || {};
    const hasGlobalStats = globalStats && typeof globalStats === "object" && Object.keys(globalStats).length > 0;
    const statusShort = statusByFixtureId[fixtureId];

    if (hasGlobalStats) {
      statsByFixtureId.set(fixtureId, globalStats);
      fixtureCoverage.push({
        fixtureId,
        statusShort: statusShort || null,
        usedGlobalStats: true,
        usedDirectFallback: false,
        rawStatsPlayerCount: Object.keys(globalStats).length,
      });
      continue;
    }

    if (!hasFixtureStarted(statusShort)) {
      statsByFixtureId.set(fixtureId, {});
      fixtureCoverage.push({
        fixtureId,
        statusShort: statusShort || null,
        usedGlobalStats: false,
        usedDirectFallback: false,
        rawStatsPlayerCount: 0,
      });
      continue;
    }

    const ttlMs = isInPlay(statusShort) ? ACTIVE_POLL_MS : 60 * 60 * 1000;
    const statsMap = await getFixturePlayersStatsMapCached({
      fixtureId,
      apiKey,
      ttlMs,
      timeZone: timezone,
    });

    const fallbackStats = statsMap || {};
    statsByFixtureId.set(fixtureId, fallbackStats);
    fixtureCoverage.push({
      fixtureId,
      statusShort: statusShort || null,
      usedGlobalStats: false,
      usedDirectFallback: true,
      rawStatsPlayerCount: Object.keys(fallbackStats).length,
    });
  }

  return { statsByFixtureId, fixtureCoverage };
}

function buildPlayerEntriesForDay({
  player,
  fixtureIds,
  statsByFixtureId,
  fixturesById,
  playersById,
}) {
  const pid = toId(player?.id || player?.playerId);
  const meta = mergePlayerMeta(player, playersById.get(pid)) || player || {};
  const entries = [];
  let total = 0;

  for (const fixtureId of fixtureIds) {
    const rawStats = statsByFixtureId.get(fixtureId)?.[pid];
    if (!rawStats) continue;

    const position = toPos(meta.position || rawStats.position || "MID");
    const scored = scorePlayer(rawStats, position);
    const points = toNumber(scored?.points, 0);
    total += points;

    entries.push({
      playerId: pid,
      playerName: meta.name || rawStats.name || "Unknown",
      name: meta.name || rawStats.name || "Unknown",
      position,
      teamName: rawStats.teamName || meta.teamName || "",
      opponentName: rawStats.opponentName || "",
      fixtureId,
      points,
      breakdown: scored?.breakdown || {},
      stats: rawStats,
      rawStats,
      fixture: fixturesById.get(fixtureId) || null,
    });
  }

  if (!entries.length) {
    entries.push({
      playerId: pid,
      playerName: meta.name || "Unknown",
      name: meta.name || "Unknown",
      position: toPos(meta.position || "MID"),
      teamName: meta.teamName || "",
      opponentName: "",
      fixtureId: null,
      points: 0,
      breakdown: {},
      stats: {},
      rawStats: {},
      fixture: null,
    });
  }

  return { total, entries };
}

function rankLeaderboard(rows) {
  return [...rows]
    .sort((a, b) => {
      const diff = toNumber(b.totalFantasyPoints ?? b.points) - toNumber(a.totalFantasyPoints ?? a.points);
      if (diff) return diff;
      return String(a.displayName || a.uid).localeCompare(String(b.displayName || b.uid));
    })
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

async function writeWorldCupDailyStandings({ db, roomId, users, nowMs }) {
  const resultsSnap = await db.collection(`rooms/${roomId}/dayResults`).get();
  const finalResults = (resultsSnap.docs || [])
    .map((doc) => doc.data() || {})
    .filter((result) => String(result.status || "").toLowerCase() === "final");

  const totalsByUid = {};
  for (const result of finalResults) {
    const scores = result.teamScoresByUserId || {};
    for (const [uid, points] of Object.entries(scores)) {
      totalsByUid[uid] = toNumber(totalsByUid[uid]) + toNumber(points);
    }
  }

  const finalDayCount = finalResults.length;
  const leaderboard = rankLeaderboard(
    users.map((user) => ({
      uid: user.uid,
      userId: user.uid,
      displayName: user.displayName || "Manager",
      teamName: user.teamName || user.displayName || "Team",
      totalFantasyPoints: toNumber(totalsByUid[user.uid]),
      daysPlayed: finalDayCount,
    }))
  );

  const payload = {
    mode: WORLD_CUP_GROUP_ENGINE,
    worldCupPhase: WORLD_CUP_GROUP_PHASE,
    leaderboard,
    standings: leaderboard,
    updatedAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.doc(`rooms/${roomId}/standings/current`).set(payload, { merge: true });
  return { leaderboard, finalDayCount };
}

async function writeCompetitionState({ roomRef, room, patch, nowMs, setCompetitionState }) {
  if (setCompetitionState) {
    return setCompetitionState(roomRef, patch, { roomData: room, nowMs });
  }

  const prev =
    room && typeof room.competitionState === "object" && room.competitionState
      ? room.competitionState
      : {};

  await roomRef.set(
    {
      competitionState: {
        ...prev,
        ...patch,
        updatedAtMs: nowMs,
      },
    },
    { merge: true }
  );

  return { ...prev, ...patch, updatedAtMs: nowMs };
}

async function completeWorldCupGroupRoom({
  db,
  roomId,
  roomRef,
  room,
  leaderboard,
  nowMs,
  setCompetitionState,
}) {
  const top3 = leaderboard.slice(0, 3).map((row, index) => ({
    rank: index + 1,
    uid: row.uid || row.userId,
    userId: row.uid || row.userId,
    name: row.name || row.displayName || "Manager",
    displayName: row.displayName || "Manager",
    teamName: row.teamName || row.displayName || "Team",
    totalFantasyPoints: toNumber(row.totalFantasyPoints),
  }));
  const championUserId = top3[0]?.userId || top3[0]?.uid || null;

  await db.doc(`rooms/${roomId}/finalResults/current`).set(
    {
      roomId,
      mode: WORLD_CUP_GROUP_ENGINE,
      worldCupPhase: WORLD_CUP_GROUP_PHASE,
      title: "World Cup Group Stage Top 3",
      championUserId,
      top3,
      standingsSnapshot: leaderboard,
      computedAtMs: nowMs,
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAtMs: nowMs,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await roomRef.set(
    {
      status: "completed",
      seasonPhase: "COMPLETE",
      completedAtMs: nowMs,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      worldCup: {
        ...(room.worldCup || {}),
        completed: true,
        completedAtMs: nowMs,
        finalTop3: top3,
      },
    },
    { merge: true }
  );

  await writeCompetitionState({
    roomRef,
    room,
    patch: {
      phaseLabel: "WorldCupGroup",
      currentLabel: "Complete",
      weekStatus: "complete",
      isDone: true,
      nextPollAtMs: null,
      nextKickoffMs: null,
    },
    nowMs,
    setCompetitionState,
  });

  return top3;
}

async function runWorldCupGroupEngine({
  db,
  roomId,
  room = null,
  apiKey,
  nowMs = Date.now(),
  getFixtureStatusMap,
  getFixturePlayersStatsMapCached,
  setCompetitionState,
  ensureDefaultLineupsForRoom,
}) {
  if (!db) throw new Error("db is required");
  if (!roomId) throw new Error("roomId is required");
  if (!getFixtureStatusMap) throw new Error("getFixtureStatusMap is required");
  if (!getFixturePlayersStatsMapCached) throw new Error("getFixturePlayersStatsMapCached is required");

  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = room ? null : await roomRef.get();
  const roomData = room || (roomSnap?.exists ? roomSnap.data() || {} : null);
  if (!roomData) throw new Error(`Room not found: ${roomId}`);

  const engineType = String(roomData.engineType || roomData.worldCup?.engineType || "");
  const worldCupPhase = String(roomData.worldCupPhase || roomData.worldCup?.phase || "");
  if (engineType !== WORLD_CUP_GROUP_ENGINE || worldCupPhase !== WORLD_CUP_GROUP_PHASE) {
    return {
      ok: true,
      skipped: true,
      reason: "not-world-cup-group-room",
      roomId,
    };
  }

  const timezone = String(roomData?.competition?.timezone || roomData?.timezone || "America/Los_Angeles");
  const days = await loadDailyWindows(db, roomId);
  if (!days.length) throw new Error(`World Cup group room has no day windows: ${roomId}`);

  const currentDay = selectCurrentDay(days, nowMs);
  if (!currentDay || String(currentDay.status || "").toLowerCase() === "final") {
    const { users } = await loadRoomUsersLineups({
      db,
      roomId,
      room: roomData,
      ensureDefaultLineupsForRoom,
    });
    const { leaderboard } = await writeWorldCupDailyStandings({ db, roomId, users, nowMs });
    const top3 = await completeWorldCupGroupRoom({
      db,
      roomId,
      roomRef,
      room: roomData,
      leaderboard,
      nowMs,
      setCompetitionState,
    });

    return {
      ok: true,
      roomId,
      status: "complete",
      weekStatus: "complete",
      isDone: true,
      top3,
    };
  }

  const fixtureIds = dayFixtureIds(currentDay);
  const fixturesById = dayFixtureById(currentDay);
  const seasonKey = roomData?.seasonKey || roomData?.worldCup?.seasonKey || "";
  const pipelineMode = String(roomData?.globalPipeline?.mode || "").toLowerCase();
  const useGlobalCache =
    pipelineMode === "global" ||
    pipelineMode === "shadow" ||
    roomData?.globalPipeline?.liveFixtureCache === true ||
    roomData?.globalPipeline?.liveFixtureCache?.enabled === true ||
    roomData?.globalPipeline?.features?.liveFixtureCache === true;
  const globalCache = useGlobalCache && seasonKey
    ? await loadWorldCupGlobalFixtureCache({ db, seasonKey, fixtureIds })
    : {
        fixtureSummariesById: {},
        liveFixturesById: {},
        statusByFixtureId: {},
        playerStatsByFixtureId: {},
        missingSummaryFixtureIds: fixtureIds,
        missingLiveFixtureIds: fixtureIds,
      };
  const missingGlobalSummaryFixtureIds = globalCache.missingSummaryFixtureIds || [];
  const missingGlobalLiveFixtureIds = globalCache.missingLiveFixtureIds || [];
  const statusByFixtureId = { ...(globalCache.statusByFixtureId || {}) };
  const missingStatusFixtureIds = fixtureIds.filter((fixtureId) => !statusByFixtureId[fixtureId]);

  if (missingStatusFixtureIds.length) {
    const fallbackStatusByFixtureId = await getFixtureStatusMap({
      fixtureIds: missingStatusFixtureIds,
      timezone,
      apiKey,
    });
    Object.assign(statusByFixtureId, fallbackStatusByFixtureId || {});
  }

  for (const fixtureId of fixtureIds) {
    if (!statusByFixtureId[fixtureId] && fixturesById.get(fixtureId)?.statusShort) {
      statusByFixtureId[fixtureId] = fixturesById.get(fixtureId).statusShort;
    }
  }

  console.log("[runWorldCupGroupEngine] global cache status", {
    roomId,
    dayIndex: currentDay?.dayIndex || null,
    useGlobalCache,
    seasonKey,
    fixtureCount: fixtureIds.length,
    missingGlobalSummaryFixtureIds,
    missingGlobalLiveFixtureIds,
  });

  const statusValue = computeDayWindowStatus({
    day: currentDay,
    fixtureIds,
    statusByFixtureId,
  });
  const pollInfoForCurrentDay = computeNextPollFromFixtures(
    Array.isArray(currentDay?.fixtures) ? currentDay.fixtures : [],
    nowMs,
    statusByFixtureId
  );
  const hasStartedOrFinishedFixture = fixtureIds.some((fixtureId) =>
    hasFixtureStarted(statusByFixtureId[fixtureId] || fixturesById.get(fixtureId)?.statusShort || "")
  );

  if (statusValue === "scheduled" && !hasStartedOrFinishedFixture) {
    const fixtureCoverage = fixtureIds.map((fixtureId) => {
      const fixture = fixturesById.get(fixtureId) || {};
      const statusShort = statusByFixtureId[fixtureId] || fixture.statusShort || null;
      return {
        fixtureId,
        statusShort,
        kickoffMs: kickoffMsFromFixture(fixture) || null,
        usedGlobalStats: false,
        usedDirectFallback: false,
        skippedReason: "world-cup-day-pregame-status-only",
      };
    });

    await db.doc(`rooms/${roomId}/days/${String(currentDay.dayIndex)}`).set(
      {
        status: statusValue,
        fixtureStatusById: statusByFixtureId,
        updatedAtMs: nowMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await roomRef.set(
      {
        worldCup: {
          ...(roomData.worldCup || {}),
          currentDayIndex: Number(currentDay.dayIndex),
          currentDayLabel: currentDay.label || null,
          currentDayStartAtMs: currentDay.startAtMs || null,
          currentDayEndAtMs: currentDay.endAtMs || null,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await writeCompetitionState({
      roomRef,
      room: roomData,
      patch: {
        phaseLabel: "WorldCupGroup",
        currentLabel: currentDay.label || null,
        weekStatus: "scheduled",
        isDone: false,
        nextPollAtMs: pollInfoForCurrentDay.nextPollAtMs,
        nextKickoffMs: pollInfoForCurrentDay.nextKickoffMs,
      },
      nowMs,
      setCompetitionState,
    });

    return {
      ok: true,
      roomId,
      dayIndex: Number(currentDay.dayIndex),
      label: currentDay.label || `Day ${currentDay.dayIndex}`,
      status: "scheduled",
      weekStatus: "scheduled",
      skippedReason: pollInfoForCurrentDay.reason,
      nextPollAtMs: pollInfoForCurrentDay.nextPollAtMs,
      nextKickoffMs: pollInfoForCurrentDay.nextKickoffMs,
      fixtureCount: fixtureIds.length,
      userCount: 0,
      source: useGlobalCache ? "world-cup-global-live-fixtures" : "world-cup-direct-api",
      globalCacheAttempted: Boolean(useGlobalCache),
      globalCacheUsed: Boolean(useGlobalCache),
      directFallbackUsed: false,
      globalCacheFullyUsed: false,
      missingGlobalSummaryFixtureIds,
      missingGlobalLiveFixtureIds,
      fixtureCoverage,
    };
  }

  const {
    statsByFixtureId,
    fixtureCoverage: baseFixtureCoverage,
  } = await loadStatsForDay({
    fixtureIds,
    statusByFixtureId,
    globalPlayerStatsByFixtureId: globalCache.playerStatsByFixtureId || {},
    getFixturePlayersStatsMapCached,
    apiKey,
    timezone,
  });
  const fixtureCoverage = baseFixtureCoverage.map((coverage) => {
    const fixtureId = String(coverage.fixtureId);
    return {
      ...coverage,
      hasGlobalSummary: Boolean(globalCache.fixtureSummariesById?.[fixtureId]),
      hasGlobalLivePayload: Boolean(globalCache.liveFixturesById?.[fixtureId]),
    };
  });
  const directFallbackUsed = fixtureCoverage.some((row) => row.usedDirectFallback);
  const globalCacheAttempted = Boolean(useGlobalCache);
  const globalCacheFullyUsed =
    globalCacheAttempted &&
    fixtureCoverage.length > 0 &&
    fixtureCoverage.every((row) => row.usedGlobalStats || !row.usedDirectFallback);
  const resultSource = directFallbackUsed
    ? "world-cup-mixed-global-direct-fallback"
    : useGlobalCache
      ? "world-cup-global-live-fixtures"
      : "world-cup-direct-api";

  const { users, playersById } = await loadRoomUsersLineups({
    db,
    roomId,
    room: roomData,
    ensureDefaultLineupsForRoom,
  });

  const teamScoresByUserId = {};
  const breakdownByUserId = {};
  const startersByUserId = {};
  const benchByUserId = {};
  const benchScoresByUserId = {};

  for (const user of users) {
    const starters = [];
    let starterTotal = 0;

    for (const player of user.starters || []) {
      const result = buildPlayerEntriesForDay({
        player,
        fixtureIds,
        statsByFixtureId,
        fixturesById,
        playersById,
      });
      starterTotal += result.total;
      starters.push(
        ...result.entries.map((entry) => ({
          ...entry,
          id: toId(entry.id || entry.playerId),
          counted: true,
        }))
      );
    }

    const bench = [];
    let benchTotal = 0;
    for (const player of user.bench || []) {
      const result = buildPlayerEntriesForDay({
        player,
        fixtureIds,
        statsByFixtureId,
        fixturesById,
        playersById,
      });
      benchTotal += result.total;
      bench.push(
        ...result.entries.map((entry) => ({
          ...entry,
          id: toId(entry.id || entry.playerId),
          counted: false,
        }))
      );
    }

    const perPlayer = {};
    for (const entry of [...starters, ...bench]) {
      const playerId = toId(entry.id || entry.playerId);
      if (!playerId) continue;
      perPlayer[playerId] = entry;
    }

    teamScoresByUserId[user.uid] = starterTotal;
    benchScoresByUserId[user.uid] = benchTotal;
    startersByUserId[user.uid] = starters;
    benchByUserId[user.uid] = bench;
    breakdownByUserId[user.uid] = {
      uid: user.uid,
      userId: user.uid,
      displayName: user.displayName || "Manager",
      teamName: user.teamName || "",
      total: starterTotal,
      benchTotal,
      perPlayer,
      starters,
      bench,
    };
  }

  const dailyLeaderboard = rankLeaderboard(
    users.map((user) => ({
      uid: user.uid,
      userId: user.uid,
      displayName: user.displayName || "Manager",
      teamName: user.teamName || user.displayName || "Team",
      points: toNumber(teamScoresByUserId[user.uid]),
    }))
  );

  const dayResultPayload = {
    roomId,
    dayIndex: Number(currentDay.dayIndex),
    label: currentDay.label || `Day ${currentDay.dayIndex}`,
    dateLabel: currentDay.dateLabel || "",
    startAtMs: currentDay.startAtMs || null,
    endAtMs: currentDay.endAtMs || null,
    fixtureIds,
    fixtures: Array.isArray(currentDay.fixtures) ? currentDay.fixtures : [],
    status: statusValue,
    source: resultSource,
    globalCacheAttempted,
    globalCacheUsed: globalCacheAttempted,
    directFallbackUsed,
    globalCacheFullyUsed,
    missingGlobalSummaryFixtureIds,
    missingGlobalLiveFixtureIds,
    teamScoresByUserId,
    benchScoresByUserId,
    breakdownByUserId,
    startersByUserId,
    benchByUserId,
    dailyLeaderboard,
    fixtureStatusById: statusByFixtureId,
    fixtureCoverage,
    updatedAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.doc(`rooms/${roomId}/dayResults/${String(currentDay.dayIndex)}`).set(
    dayResultPayload,
    { merge: true }
  );

  await db.doc(`rooms/${roomId}/days/${String(currentDay.dayIndex)}`).set(
    {
      status: statusValue,
      fixtureStatusById: statusByFixtureId,
      updatedAtMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const daysAfter = days.map((day) =>
    Number(day.dayIndex) === Number(currentDay.dayIndex)
      ? { ...day, status: statusValue }
      : day
  );

  const { leaderboard } = await writeWorldCupDailyStandings({ db, roomId, users, nowMs });
  const allDaysFinal =
    daysAfter.length > 0 &&
    daysAfter.every((day) => String(day.status || "").toLowerCase() === "final");

  if (allDaysFinal) {
    const top3 = await completeWorldCupGroupRoom({
      db,
      roomId,
      roomRef,
      room: roomData,
      leaderboard,
      nowMs,
      setCompetitionState,
    });

    return {
      ok: true,
      roomId,
      dayIndex: Number(currentDay.dayIndex),
      status: "complete",
      weekStatus: "complete",
      isDone: true,
      top3,
      source: dayResultPayload.source,
      globalCacheAttempted: dayResultPayload.globalCacheAttempted,
      globalCacheUsed: dayResultPayload.globalCacheUsed,
      directFallbackUsed: dayResultPayload.directFallbackUsed,
      globalCacheFullyUsed: dayResultPayload.globalCacheFullyUsed,
      missingGlobalSummaryFixtureIds,
      missingGlobalLiveFixtureIds,
      fixtureCoverage,
      dailyLeaderboard,
      breakdownByUserId,
      startersByUserId,
      benchByUserId,
    };
  }

  const nextDay =
    statusValue === "final"
      ? daysAfter.find((day) => String(day.status || "").toLowerCase() !== "final")
      : currentDay;
  const pollInfo =
    statusValue === "live"
      ? {
          nextKickoffMs: null,
          nextPollAtMs: nowMs + ACTIVE_POLL_MS,
          reason: "world-cup-day-live",
        }
      : computeNextPollFromFixtures(
          Array.isArray(nextDay?.fixtures) ? nextDay.fixtures : [],
          nowMs,
          statusValue === "final" ? {} : statusByFixtureId
        );

  await roomRef.set(
    {
      worldCup: {
        ...(roomData.worldCup || {}),
        currentDayIndex: Number(nextDay?.dayIndex || currentDay.dayIndex),
        currentDayLabel: nextDay?.label || currentDay.label || null,
        currentDayStartAtMs: nextDay?.startAtMs || currentDay.startAtMs || null,
        currentDayEndAtMs: nextDay?.endAtMs || currentDay.endAtMs || null,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const weekStatus = statusValue === "final" ? "scheduled" : statusValue;
  await writeCompetitionState({
    roomRef,
    room: roomData,
    patch: {
      phaseLabel: "WorldCupGroup",
      currentLabel: nextDay?.label || currentDay.label || null,
      weekStatus,
      isDone: false,
      nextPollAtMs: pollInfo.nextPollAtMs,
      nextKickoffMs: pollInfo.nextKickoffMs,
    },
    nowMs,
    setCompetitionState,
  });

  return {
    ok: true,
    roomId,
    dayIndex: Number(currentDay.dayIndex),
    label: currentDay.label || `Day ${currentDay.dayIndex}`,
    status: statusValue,
    weekStatus,
    nextPollAtMs: pollInfo.nextPollAtMs,
    nextKickoffMs: pollInfo.nextKickoffMs,
    fixtureCount: fixtureIds.length,
    userCount: users.length,
    teamScoresByUserId,
    benchScoresByUserId,
    breakdownByUserId,
    startersByUserId,
    benchByUserId,
    dailyLeaderboard,
    standingsLeaderboard: leaderboard,
    source: dayResultPayload.source,
    globalCacheAttempted: dayResultPayload.globalCacheAttempted,
    globalCacheUsed: dayResultPayload.globalCacheUsed,
    directFallbackUsed: dayResultPayload.directFallbackUsed,
    globalCacheFullyUsed: dayResultPayload.globalCacheFullyUsed,
    missingGlobalSummaryFixtureIds,
    missingGlobalLiveFixtureIds,
    fixtureCoverage,
  };
}

module.exports = {
  runWorldCupGroupEngine,
};
