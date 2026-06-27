"use strict";

const admin = require("firebase-admin");
const { scorePlayer } = require("../shared/scoringCore");
const {
  WORLD_CUP_GROUP_ENGINE,
  WORLD_CUP_GROUP_PHASE,
} = require("./worldCupMode");
const { loadWorldCupGlobalFixtureCache } = require("./worldCupGlobalCache");
const {
  WORLD_CUP_DAILY_LOCKS_FIELD,
  buildWorldCupDailyLockWindow,
  hasScoringAppearance,
} = require("./worldCupDailyLineupLocks");

const PRE_MS = 20 * 60 * 1000;
const PREGAME_POLL_MS = 5 * 60 * 1000;
const ACTIVE_POLL_MS = 60 * 1000;
const UNKNOWN_RECHECK_MS = 60 * 60 * 1000;
const POST_MS = 3 * 60 * 60 * 1000;
const FINAL_SETTLE_MS = 20 * 60 * 1000;
const GLOBAL_LIVE_STALE_MS = 2 * ACTIVE_POLL_MS;

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
  return [
    "1H",
    "HT",
    "2H",
    "ET",
    "BT",
    "P",
    "SUSP",
    "INT",
    "LIVE",
  ].includes(String(short || "").toUpperCase());
}

function isFinished(short) {
  return ["FT", "AET", "PEN"].includes(String(short || "").toUpperCase());
}

function hasFixtureStarted(short) {
  const s = String(short || "").trim().toUpperCase();
  if (!s) return false;
  if (["NS", "TBD"].includes(s) || isPostponedOrCancelled(s)) return false;
  return true;
}

function isNotStarted(short) {
  return ["", "NS", "TBD"].includes(String(short || "").trim().toUpperCase());
}

function isPostponedOrCancelled(short) {
  return ["PST", "CANC", "ABD", "AWD", "WO"].includes(
    String(short || "").trim().toUpperCase()
  );
}

function liveFixtureUpdatedAtMs(liveFixture = {}) {
  return toNumber(
    liveFixture?.updatedAtMs ??
      liveFixture?.statusUpdatedAtMs ??
      liveFixture?.fetchedAtMs ??
      liveFixture?.lastUpdatedAtMs,
    0
  );
}

function isGlobalLiveFixtureStale(liveFixture = {}, nowMs) {
  const updatedAtMs = liveFixtureUpdatedAtMs(liveFixture);
  return !updatedAtMs || nowMs - updatedAtMs > GLOBAL_LIVE_STALE_MS;
}

function kickoffMsFromFixture(fixture) {
  const raw =
    fixture?.kickoffMs ??
      fixture?.startAtMs ??
      fixture?.fixture?.timestamp ??
      fixture?.timestamp ??
      null;

  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    // API timestamps use seconds; app kickoff fields use milliseconds.
    return n < 100000000000 ? n * 1000 : n;
  }

  const parsed = Date.parse(
    fixture?.fixture?.date ||
      fixture?.date ||
      fixture?.kickoff ||
      fixture?.startAt ||
      ""
  );

  return Number.isFinite(parsed) ? parsed : NaN;
}

function fixtureIdFromFixture(fixture = {}) {
  return toId(
    fixture?.fixtureId ??
      fixture?.id ??
      fixture?.fixture?.id
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
    teamId: toId(input.teamId ?? input.apiTeamId ?? input.team?.id),
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
    teamId: toId(a.teamId || a.apiTeamId || b.teamId || b.apiTeamId),
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
          lineupData.currentLineup?.startingXI,
          lineupData.currentLineup?.starting11,
          lineupData.currentLineup?.starters,
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

function hasImportantPlayerMeta(player = {}) {
  return Boolean(
    player?.name &&
      player.name !== "Unknown" &&
      player?.position &&
      player?.teamId
  );
}

function rememberPlayerMeta(playersById, player) {
  if (!player?.id) return null;
  const playerId = toId(player.id);
  const merged = mergePlayerMeta(playersById.get(playerId), player);
  if (merged) playersById.set(playerId, merged);
  return merged;
}

function lineupEntryId(entry) {
  if (entry == null) return "";
  if (typeof entry === "string" || typeof entry === "number") {
    return toId(entry);
  }

  return toId(
    entry.id ??
      entry.playerId ??
      entry.pid ??
      entry.apiPlayerId ??
      entry.player?.id
  );
}

async function loadRoomLineupsByUid(db, roomId) {
  const lineupsSnap = await db
    .collection(`rooms/${roomId}/lineups`)
    .get()
    .catch(() => ({ docs: [] }));
  const lineupByUid = new Map();

  for (const doc of lineupsSnap.docs || []) {
    lineupByUid.set(doc.id, doc.data() || {});
  }

  return lineupByUid;
}

function collectSnapshotStarterIds(currentDay = {}) {
  const ids = new Set();
  const snapshots =
    currentDay?.starterSnapshotsByFixtureId &&
    typeof currentDay.starterSnapshotsByFixtureId === "object"
      ? currentDay.starterSnapshotsByFixtureId
      : {};

  for (const snapshot of Object.values(snapshots)) {
    for (const starters of Object.values(snapshot?.startersByUserId || {})) {
      for (const entry of Array.isArray(starters) ? starters : []) {
        const playerId = lineupEntryId(entry);
        if (playerId) ids.add(playerId);
      }
    }
  }

  return ids;
}

async function fetchNeededRoomPlayerDocs({
  db,
  roomId,
  playersById,
  neededPlayerIds,
}) {
  const ids = [...new Set(
    [...(neededPlayerIds || [])].map(toId).filter(Boolean)
  )].filter((playerId) => !hasImportantPlayerMeta(playersById.get(playerId)));
  const chunkSize = 300;
  let docsRead = 0;

  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    if (!chunk.length) continue;

    const snaps = await db.getAll(
      ...chunk.map((playerId) =>
        db.doc(`rooms/${roomId}/players/${playerId}`)
      )
    );

    for (const snap of snaps) {
      if (!snap.exists) continue;
      docsRead += 1;
      rememberPlayerMeta(
        playersById,
        normalizePlayerMeta(snap.data() || {}, snap.id)
      );
    }
  }

  return {
    requested: ids.length,
    docsRead,
  };
}

function hasUsableWorldCupLineup(lineup = {}) {
  return extractLineupList(lineup, "starters")
    .map(lineupEntryId)
    .filter(Boolean)
    .length > 0;
}

async function loadRoomUsersLineups({
  db,
  roomId,
  room,
  currentDay = null,
  lineupByUid: preloadedLineupByUid = null,
  ensureDefaultLineupsForRoom,
}) {
  const [membersSnap, teamNamesSnap] = await Promise.all([
    db.collection(`rooms/${roomId}/members`).get().catch(() => ({ docs: [] })),
    db.collection(`rooms/${roomId}/teamNames`).get().catch(() => ({ docs: [] })),
  ]);

  const lineupByUid =
    preloadedLineupByUid instanceof Map
      ? new Map(preloadedLineupByUid)
      : await loadRoomLineupsByUid(db, roomId);
  const playersById = new Map();
  const neededPlayerIds = collectSnapshotStarterIds(currentDay || {});
  const preloadedPicks = [];

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
  for (const [uid, lineup] of lineupByUid.entries()) {
    if (!membersByUid.has(uid)) {
      membersByUid.set(uid, {
        uid,
        displayName: "Manager",
        teamName: "Team",
      });
    }

    for (const entry of [
      ...extractLineupList(lineup, "starters"),
      ...extractLineupList(lineup, "bench"),
    ]) {
      const playerId = lineupEntryId(entry);
      if (!playerId) continue;
      neededPlayerIds.add(playerId);

      if (entry && typeof entry === "object") {
        rememberPlayerMeta(
          playersById,
          normalizePlayerMeta(entry, playerId)
        );
      }
    }
  }

  for (const uid of Array.isArray(room?.memberUids) ? room.memberUids : []) {
    const id = toId(uid);
    if (!id || membersByUid.has(id)) continue;
    membersByUid.set(id, { uid: id, displayName: "Manager", teamName: "Team" });
  }

  let memberUids = [...membersByUid.keys()];
  let missingLineupUids = memberUids.filter(
    (uid) => !hasUsableWorldCupLineup(lineupByUid.get(uid) || {})
  );
  let picksDocs = [];
  const shouldReadPicks =
    memberUids.length === 0 || missingLineupUids.length > 0;

  if (shouldReadPicks) {
    const picksSnap = await db
      .collection(`rooms/${roomId}/picks`)
      .get()
      .catch(() => ({ docs: [] }));
    picksDocs = picksSnap.docs || [];

    for (const doc of picksDocs) {
      const data = doc.data() || {};
      preloadedPicks.push({ id: doc.id, data });
      const uid = inferPickOwnerUid(data);
      const pid = inferPickPlayerId(data);
      if (!uid || !pid) continue;

      const pickMeta = normalizePlayerMeta(data, pid);
      if (pickMeta) {
        rememberPlayerMeta(playersById, pickMeta);
      }
      neededPlayerIds.add(pid);

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

    memberUids = [...membersByUid.keys()];
    missingLineupUids = memberUids.filter(
      (uid) => !hasUsableWorldCupLineup(lineupByUid.get(uid) || {})
    );
  }

  const playerDocFetch = await fetchNeededRoomPlayerDocs({
    db,
    roomId,
    playersById,
    neededPlayerIds,
  });
  const repairableMissingLineupUids = missingLineupUids.filter(
    (uid) => (rosterByUid.get(uid) || []).length > 0
  );

  if (
    ensureDefaultLineupsForRoom &&
    repairableMissingLineupUids.length
  ) {
    try {
      const ensured = await ensureDefaultLineupsForRoom(
        roomId,
        repairableMissingLineupUids,
        {
          preloadedPicks,
          preloadedLineupsByUid: lineupByUid,
          preloadedPlayersById: playersById,
        }
      );

      for (const [uid, lineup] of Object.entries(
        ensured?.initializedLineupsByUid || {}
      )) {
        lineupByUid.set(uid, lineup || {});
      }

      console.log("[worldCupGroupEngine] repaired missing default lineups", {
        roomId,
        missingLineupCount: repairableMissingLineupUids.length,
        writes: Number(ensured?.writes || 0),
      });
    } catch (e) {
      console.warn("[worldCupGroupEngine] ensureDefaultLineupsForRoom failed", {
        roomId,
        missingLineupCount: repairableMissingLineupUids.length,
        error: String(e?.message || e),
      });
    }
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
      lineup,
    });
  }

  return {
    users,
    playersById,
    lineupByUid,
    readCounts: {
      membersRead: membersSnap.docs?.length || 0,
      teamNamesRead: teamNamesSnap.docs?.length || 0,
      picksRead: picksDocs.length,
      picksSkipped: !shouldReadPicks,
      lineupDocsRead: preloadedLineupByUid instanceof Map
        ? preloadedLineupByUid.size
        : lineupByUid.size,
      playerDocsRequested: playerDocFetch.requested,
      playerDocsRead: playerDocFetch.docsRead,
    },
  };
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

function lineupPlayerIds(lineup = {}) {
  const values = extractLineupList(lineup, "starters");
  return uniqueIds(
    values.map((value) =>
      typeof value === "string" || typeof value === "number"
        ? value
        : value?.id ?? value?.playerId ?? value?.pid ?? value?.apiPlayerId ?? value?.player?.id
    )
  );
}

async function ensureWorldCupFixtureStarterSnapshots({
  db,
  roomId,
  currentDay,
  fixtureIds,
  fixturesById,
  nowMs,
  lineupByUid: preloadedLineupByUid = null,
}) {
  const existing =
    currentDay?.starterSnapshotsByFixtureId &&
    typeof currentDay.starterSnapshotsByFixtureId === "object"
      ? currentDay.starterSnapshotsByFixtureId
      : {};
  const dueFixtureIds = fixtureIds.filter((fixtureId) => {
    if (existing[fixtureId]) return false;
    const kickoffMs = kickoffMsFromFixture(fixturesById.get(fixtureId) || {});
    return Number.isFinite(kickoffMs) && nowMs >= kickoffMs;
  });

  if (!dueFixtureIds.length) return currentDay;

  const lineupByUid =
    preloadedLineupByUid instanceof Map
      ? preloadedLineupByUid
      : await loadRoomLineupsByUid(db, roomId);
  const startersByUserId = {};
  for (const [uid, lineup] of lineupByUid.entries()) {
    startersByUserId[uid] = lineupPlayerIds(lineup || {});
  }

  const nextSnapshots = { ...existing };
  for (const fixtureId of dueFixtureIds) {
    const fixture = fixturesById.get(fixtureId) || {};
    nextSnapshots[fixtureId] = {
      fixtureId,
      kickoffMs: kickoffMsFromFixture(fixture) || null,
      capturedAtMs: nowMs,
      startersByUserId,
    };
  }

  await db.doc(`rooms/${roomId}/days/${String(currentDay.dayIndex)}`).set(
    {
      starterSnapshotsByFixtureId: nextSnapshots,
      starterSnapshotsUpdatedAtMs: nowMs,
      starterSnapshotsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log("[worldCupGroupEngine] fixture starter snapshots created", {
    roomId,
    dayIndex: currentDay.dayIndex,
    fixtureIds: dueFixtureIds,
    lineupCount: Object.keys(startersByUserId).length,
  });

  return {
    ...currentDay,
    starterSnapshotsByFixtureId: nextSnapshots,
  };
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

function buildWorldCupFinalSettleDecision({
  currentDay,
  fixtureIds,
  fixturesById,
  statusByFixtureId,
  fixtureCoverage,
  proposedStatus,
  nowMs,
}) {
  const statusesByFixtureId = {};
  for (const fixtureId of fixtureIds) {
    const fixture = fixturesById.get(String(fixtureId)) || {};
    statusesByFixtureId[fixtureId] = String(
      statusByFixtureId[fixtureId] ||
        fixture.statusShort ||
        ""
    ).trim().toUpperCase();
  }

  const statuses = Object.values(statusesByFixtureId);
  const allFixturesExplicitFinal =
    statuses.length > 0 && statuses.every(isFinished);
  const hasActiveOrDelayedFixture = statuses.some(
    (status) =>
      !isFinished(status) &&
      (
        isInPlay(status) ||
        hasFixtureStarted(status)
      )
  );
  const previousFinalSeenAtMs = toNumber(
    currentDay?.allFixturesFinalSeenAtMs ||
      currentDay?.finalStatusFirstSeenAtMs,
    0
  );
  const allFixturesFinalSeenAtMs = allFixturesExplicitFinal
    ? previousFinalSeenAtMs || nowMs
    : null;
  const finalSettleUntilMs = allFixturesFinalSeenAtMs
    ? allFixturesFinalSeenAtMs + FINAL_SETTLE_MS
    : null;
  const finalSettleRemainingMs = finalSettleUntilMs
    ? Math.max(0, finalSettleUntilMs - nowMs)
    : null;
  const directStatsAfterFinalSeen =
    allFixturesExplicitFinal &&
    fixtureIds.every((fixtureId) => {
      const coverage = fixtureCoverage.find(
        (row) => String(row?.fixtureId) === String(fixtureId)
      );
      return (
        coverage?.usedDirectFallback === true &&
        toNumber(coverage?.statsFetchedAtMs, 0) >= allFixturesFinalSeenAtMs
      );
    });

  let writeStatusValue = proposedStatus;
  let reason = "world-cup-status-normal";

  if (allFixturesExplicitFinal) {
    if (finalSettleRemainingMs > 0) {
      writeStatusValue = "resolving";
      reason = "world-cup-final-settling";
    } else if (!directStatsAfterFinalSeen) {
      writeStatusValue = "resolving";
      reason = "world-cup-final-awaiting-fresh-stats";
    } else {
      writeStatusValue = "final";
      reason = "world-cup-final-settled";
    }
  } else if (hasActiveOrDelayedFixture && proposedStatus === "final") {
    writeStatusValue = "live";
    reason = "world-cup-final-cleared-active-status-returned";
  } else if (hasActiveOrDelayedFixture && proposedStatus !== "live") {
    writeStatusValue = "live";
    reason = "world-cup-active-or-delayed";
  }

  return {
    proposedStatus,
    writeStatusValue,
    reason,
    statusesByFixtureId,
    allFixturesExplicitFinal,
    hasActiveOrDelayedFixture,
    allFixturesFinalSeenAtMs,
    finalStatusFirstSeenAtMs: allFixturesFinalSeenAtMs,
    finalSettleMs: FINAL_SETTLE_MS,
    finalSettleUntilMs,
    finalSettleRemainingMs,
    directStatsAfterFinalSeen,
  };
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
  const rawFixtures = Array.isArray(fixtures) ? fixtures : [];
  const liveStatusFixtureIds = rawFixtures
    .map((fixture) => {
      const fixtureId = fixtureIdFromFixture(fixture);
      const statusShort = statusShortForFixture(fixture, statusByFixtureId);
      return {
        fixtureId,
        statusShort,
        kickoffMs: kickoffMsFromFixture(fixture),
      };
    })
    .filter(
      (row) =>
        row.fixtureId &&
        !isFinished(row.statusShort) &&
        hasFixtureStarted(row.statusShort)
    );

  if (liveStatusFixtureIds.length > 0) {
    const bestKickoffMs =
      liveStatusFixtureIds
        .map((row) => row.kickoffMs)
        .filter((ms) => Number.isFinite(ms) && ms > 0)
        .sort((a, b) => a - b)[0] || null;

    return {
      nextKickoffMs: bestKickoffMs,
      nextPollAtMs: nowMs + ACTIVE_POLL_MS,
      reason: "world-cup-live-status-force-1min-check",
    };
  }

  const rows = rawFixtures
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
      nowMs >= row.kickoffMs
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
  fixturesById,
  nowMs,
  globalPlayerStatsByFixtureId = {},
  forceDirectFixtureIds = [],
  directFallbackReasonByFixtureId = {},
  getFixturePlayersStatsMapCached,
  apiKey,
  timezone,
}) {
  const statsByFixtureId = new Map();
  const fixtureCoverage = [];
  const forceDirectSet = new Set(
    (Array.isArray(forceDirectFixtureIds) ? forceDirectFixtureIds : [])
      .map((value) => String(value))
      .filter(Boolean)
  );

  for (const fixtureId of fixtureIds) {
    const globalStats = globalPlayerStatsByFixtureId?.[fixtureId] || {};
    const hasGlobalStats = globalStats && typeof globalStats === "object" && Object.keys(globalStats).length > 0;
    const forceDirect = forceDirectSet.has(String(fixtureId));
    const statusShort = statusByFixtureId[fixtureId];
    const fixture = fixturesById?.get?.(String(fixtureId)) || {};
    const kickoffMs = kickoffMsFromFixture(fixture);
    const kickoffHasPassed =
      Number.isFinite(kickoffMs) && nowMs >= kickoffMs;
    const shouldTryStats =
      forceDirect || hasFixtureStarted(statusShort) || kickoffHasPassed;

    if (hasGlobalStats && !forceDirect) {
      statsByFixtureId.set(fixtureId, globalStats);
      fixtureCoverage.push({
        fixtureId,
        statusShort: statusShort || null,
        usedGlobalStats: true,
        usedDirectFallback: false,
        forcedDirectFallback: false,
        directFallbackReason: "",
        globalStatsAvailable: true,
        globalStatsIgnored: false,
        rawStatsPlayerCount: Object.keys(globalStats).length,
        kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : null,
        kickoffHasPassed,
        shouldTryStats,
        statsFetchedAtMs: null,
      });
      continue;
    }

    if (!shouldTryStats) {
      statsByFixtureId.set(fixtureId, {});
      fixtureCoverage.push({
        fixtureId,
        statusShort: statusShort || null,
        usedGlobalStats: false,
        usedDirectFallback: false,
        forcedDirectFallback: false,
        directFallbackReason: "",
        globalStatsAvailable: hasGlobalStats,
        globalStatsIgnored: false,
        rawStatsPlayerCount: 0,
        kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : null,
        kickoffHasPassed,
        shouldTryStats,
        statsFetchedAtMs: null,
      });
      continue;
    }

    const ttlMs =
      isInPlay(statusShort) || kickoffHasPassed
        ? ACTIVE_POLL_MS
        : 60 * 60 * 1000;
    const statsMap = await getFixturePlayersStatsMapCached({
      fixtureId,
      apiKey,
      ttlMs,
      timeZone: timezone,
      forceRefresh: forceDirect,
      source: "world-cup-group-engine",
    });

    const fallbackStats = statsMap || {};
    statsByFixtureId.set(fixtureId, fallbackStats);
    fixtureCoverage.push({
      fixtureId,
      statusShort: statusShort || null,
      usedGlobalStats: false,
      usedDirectFallback: true,
      forcedDirectFallback: forceDirect,
      directFallbackReason: directFallbackReasonByFixtureId?.[fixtureId] || "",
      globalStatsAvailable: hasGlobalStats,
      globalStatsIgnored: forceDirect && hasGlobalStats,
      rawStatsPlayerCount: Object.keys(fallbackStats).length,
      kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : null,
      kickoffHasPassed,
      shouldTryStats,
      statsFetchedAtMs: nowMs,
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

function buildWorldCupUserStarterPlan({
  user,
  fixtureIds,
  currentDay,
  fixturesById,
  playersById,
}) {
  const currentStarters = Array.isArray(user?.starters) ? user.starters : [];
  const currentRoster = [...currentStarters, ...(Array.isArray(user?.bench) ? user.bench : [])];
  const currentById = new Map(
    currentRoster
      .map((player) => [toId(player?.id || player?.playerId), player])
      .filter(([playerId]) => playerId)
  );
  const snapshots =
    currentDay?.starterSnapshotsByFixtureId &&
    typeof currentDay.starterSnapshotsByFixtureId === "object"
      ? currentDay.starterSnapshotsByFixtureId
      : {};
  const fixtureIdsByPlayerId = new Map();
  const starterIndexByFixturePlayer = new Map();
  const effectiveStarterIds = [];
  const seen = new Set();

  for (const fixtureId of fixtureIds) {
    const snapshotIds = snapshots?.[fixtureId]?.startersByUserId?.[user.uid];
    const fixture = fixturesById.get(fixtureId) || {};
    const fixtureTeamIds = new Set(
      [fixture?.homeTeamId, fixture?.awayTeamId].map(toId).filter(Boolean)
    );
    const starterIds = Array.isArray(snapshotIds)
      ? snapshotIds.map(toId).filter(Boolean)
      : currentStarters
          .filter((player) => {
            const playerId = toId(player?.id || player?.playerId);
            const meta = mergePlayerMeta(player, playersById.get(playerId)) || player || {};
            const teamId = toId(meta?.teamId || meta?.apiTeamId);
            return !fixtureTeamIds.size || !teamId || fixtureTeamIds.has(teamId);
          })
          .map((player) => toId(player?.id || player?.playerId))
          .filter(Boolean);

    starterIds.forEach((playerId, starterIndex) => {
      if (!seen.has(playerId)) {
        seen.add(playerId);
        effectiveStarterIds.push(playerId);
      }
      const playerFixtureIds = fixtureIdsByPlayerId.get(playerId) || [];
      playerFixtureIds.push(fixtureId);
      fixtureIdsByPlayerId.set(playerId, playerFixtureIds);
      starterIndexByFixturePlayer.set(`${fixtureId}:${playerId}`, starterIndex);
    });
  }

  const starters = effectiveStarterIds.map((playerId) => {
    const current = currentById.get(playerId) || {};
    const fromPool = playersById.get(playerId) || {};
    return (
      mergePlayerMeta(current, fromPool) ||
      mergePlayerMeta(fromPool, { id: playerId }) ||
      { id: playerId, playerId, name: "Unknown", position: "MID" }
    );
  });
  const roster = currentRoster.map((player) => {
    const playerId = toId(player?.id || player?.playerId);
    return mergePlayerMeta(player, playersById.get(playerId)) || player;
  });

  return {
    starters,
    roster,
    fixtureIdsByPlayerId,
    starterIndexByFixturePlayer,
  };
}

async function persistWorldCupDailyAppearanceLocks({
  db,
  roomId,
  users,
  lockCandidatesByUid,
  nowMs,
}) {
  let batch = db.batch();
  let writes = 0;
  let pendingOps = 0;

  const commitBatch = async () => {
    if (!pendingOps) return;
    const current = batch;
    batch = db.batch();
    pendingOps = 0;
    await current.commit();
  };

  for (const user of users || []) {
    const candidates = lockCandidatesByUid.get(user.uid) || [];
    if (!candidates.length) continue;

    const existingLocks =
      user?.lineup?.[WORLD_CUP_DAILY_LOCKS_FIELD] &&
      typeof user.lineup[WORLD_CUP_DAILY_LOCKS_FIELD] === "object"
        ? user.lineup[WORLD_CUP_DAILY_LOCKS_FIELD]
        : {};
    const nextLocks = { ...existingLocks };
    const createdLocks = [];

    for (const candidate of candidates) {
      const existing = existingLocks[candidate.playerId] || null;
      const existingUntilMs = Number(existing?.lockedUntilMs || 0);
      const sameFixture = String(existing?.fixtureId || "") === String(candidate.fixtureId || "");

      if (sameFixture && existingUntilMs >= candidate.lockedUntilMs) continue;
      if (existingUntilMs > candidate.lockedUntilMs) continue;

      nextLocks[candidate.playerId] = candidate;
      createdLocks.push(candidate);
    }

    if (!createdLocks.length) continue;

    batch.set(
      db.doc(`rooms/${roomId}/lineups/${user.uid}`),
      {
        [WORLD_CUP_DAILY_LOCKS_FIELD]: nextLocks,
        worldCupDailyLocksUpdatedAtMs: nowMs,
        worldCupDailyLocksUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    pendingOps += 1;
    writes += createdLocks.length;

    for (const lock of createdLocks) {
      console.log("[worldCupGroupEngine] appearance lock created", {
        roomId,
        uid: user.uid,
        playerId: lock.playerId,
        playerName: lock.playerName || "",
        fixtureId: lock.fixtureId,
        starterIndex: lock.starterIndex,
        lockedUntilMs: lock.lockedUntilMs,
      });
    }

    if (pendingOps >= 400) await commitBatch();
  }

  await commitBatch();
  return writes;
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

function worldCupBreakdownTotal(breakdown = {}) {
  const explicitTotal = Number(breakdown?.total);
  if (Number.isFinite(explicitTotal)) {
    return explicitTotal;
  }

  if (Array.isArray(breakdown?.starters)) {
    return breakdown.starters.reduce(
      (sum, player) => sum + toNumber(player?.points),
      0
    );
  }

  return Object.values(breakdown?.perPlayer || {}).reduce((sum, player) => {
    if (player?.counted === false) return sum;
    return sum + toNumber(player?.points);
  }, 0);
}

function worldCupDayScoresByUid(result = {}) {
  const scores = { ...(result?.teamScoresByUserId || {}) };

  for (const [uid, breakdown] of Object.entries(
    result?.breakdownByUserId || {}
  )) {
    const cleanUid = String(uid || "");
    if (!cleanUid) continue;

    const hasSavedScore =
      Object.prototype.hasOwnProperty.call(scores, cleanUid) &&
      Number.isFinite(Number(scores[cleanUid]));
    const breakdownScore = worldCupBreakdownTotal(breakdown);

    if (!hasSavedScore) {
      scores[cleanUid] = breakdownScore;
    }
  }

  return scores;
}

function worldCupDayResultHasScore(result = {}) {
  return Object.values(worldCupDayScoresByUid(result)).some(
    (value) => toNumber(value) !== 0
  );
}

function shouldIncludeWorldCupDayInStandings(result = {}) {
  const status = String(result?.status || "").toLowerCase();
  if (["final", "live", "resolving"].includes(status)) return true;
  return worldCupDayResultHasScore(result);
}

function normalizeWorldCupScoresByUid(scores = {}) {
  const normalized = {};

  for (const [uid, points] of Object.entries(scores || {})) {
    const cleanUid = String(uid || "");
    if (!cleanUid) continue;
    normalized[cleanUid] = toNumber(points);
  }

  return normalized;
}

function normalizeWorldCupDayTotalsByUid(dayTotalsByUid = {}) {
  const normalized = {};

  for (const [dayKey, scores] of Object.entries(dayTotalsByUid || {})) {
    const dayIndex = Number(dayKey);
    if (!Number.isFinite(dayIndex) || dayIndex <= 0) continue;
    if (!scores || typeof scores !== "object" || Array.isArray(scores)) continue;
    normalized[String(dayIndex)] = normalizeWorldCupScoresByUid(scores);
  }

  return normalized;
}

function sumWorldCupDayTotalsByUid(dayTotalsByUid = {}) {
  const totalsByUid = {};

  for (const scores of Object.values(dayTotalsByUid || {})) {
    for (const [uid, points] of Object.entries(scores || {})) {
      const cleanUid = String(uid || "");
      if (!cleanUid) continue;
      totalsByUid[cleanUid] =
        toNumber(totalsByUid[cleanUid]) + toNumber(points);
    }
  }

  return totalsByUid;
}

function buildWorldCupStandingsPayload({
  users,
  dayTotalsByUid,
  includesLivePoints,
  nowMs,
}) {
  const normalizedDayTotalsByUid =
    normalizeWorldCupDayTotalsByUid(dayTotalsByUid);
  const includedDayIndexes = Object.keys(normalizedDayTotalsByUid)
    .map(Number)
    .filter((dayIndex) => Number.isFinite(dayIndex) && dayIndex > 0)
    .sort((a, b) => a - b);
  const totalsByUid = sumWorldCupDayTotalsByUid(normalizedDayTotalsByUid);
  const leaderboard = rankLeaderboard(
    users.map((user) => ({
      uid: user.uid,
      userId: user.uid,
      displayName: user.displayName || "Manager",
      name: user.displayName || "Manager",
      teamName: user.teamName || user.displayName || "Team",
      totalFantasyPoints: toNumber(totalsByUid[user.uid]),
      totalPoints: toNumber(totalsByUid[user.uid]),
      daysPlayed: includedDayIndexes.length,
    }))
  );

  return {
    mode: WORLD_CUP_GROUP_ENGINE,
    worldCupPhase: WORLD_CUP_GROUP_PHASE,
    source: "world-cup-group-cumulative-standings",
    includesLivePoints: Boolean(includesLivePoints),
    includedDayIndexes,
    dayTotalsByUid: normalizedDayTotalsByUid,
    totalsByUid,
    leaderboard,
    standings: leaderboard,
    updatedAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function rebuildWorldCupDailyStandingsFromResults({
  db,
  roomId,
  users,
  nowMs,
}) {
  const resultsSnap = await db.collection(`rooms/${roomId}/dayResults`).get();
  const resultByDayIndex = new Map();

  for (const doc of resultsSnap.docs || []) {
    const result = doc.data() || {};
    const dayIndex = Number(result.dayIndex || doc.id);
    if (!Number.isFinite(dayIndex) || dayIndex <= 0) continue;
    resultByDayIndex.set(dayIndex, { ...result, dayIndex });
  }

  const includedResults = Array.from(resultByDayIndex.values())
    .filter(shouldIncludeWorldCupDayInStandings)
    .sort((a, b) => toNumber(a.dayIndex) - toNumber(b.dayIndex));

  const dayTotalsByUid = {};

  for (const result of includedResults) {
    const dayIndex = Number(result.dayIndex || 0);
    if (!dayIndex) continue;
    dayTotalsByUid[String(dayIndex)] = worldCupDayScoresByUid(result);
  }

  const finalDayCount = includedResults.filter(
    (result) => String(result?.status || "").toLowerCase() === "final"
  ).length;
  const payload = buildWorldCupStandingsPayload({
    users,
    dayTotalsByUid,
    includesLivePoints: includedResults.some((result) =>
      ["live", "resolving"].includes(
        String(result?.status || "").toLowerCase()
      )
    ),
    nowMs,
  });

  await db.doc(`rooms/${roomId}/standings/current`).set(payload);
  return {
    leaderboard: payload.leaderboard,
    finalDayCount,
    includedDayCount: payload.includedDayIndexes.length,
    includedDayIndexes: payload.includedDayIndexes,
    standingsUpdateMode: "full-scan-fallback",
  };
}

async function writeWorldCupDailyStandings({
  db,
  roomId,
  users,
  nowMs,
  currentDayResult,
}) {
  const dayIndex = Number(currentDayResult?.dayIndex || 0);
  if (!Number.isFinite(dayIndex) || dayIndex <= 0) {
    return rebuildWorldCupDailyStandingsFromResults({
      db,
      roomId,
      users,
      nowMs,
    });
  }

  const standingsRef = db.doc(`rooms/${roomId}/standings/current`);
  let needsFullScanFallback = false;
  const transactionResult = await db.runTransaction(async (transaction) => {
    const standingsSnap = await transaction.get(standingsRef);
    const existingStandings = standingsSnap.exists
      ? standingsSnap.data() || {}
      : {};
    const hasStoredDayTotals =
      existingStandings.dayTotalsByUid &&
      typeof existingStandings.dayTotalsByUid === "object" &&
      !Array.isArray(existingStandings.dayTotalsByUid);
    const hasLegacyCumulativeState =
      !hasStoredDayTotals &&
      (
        dayIndex > 1 ||
        Object.keys(existingStandings.totalsByUid || {}).length > 0 ||
        (Array.isArray(existingStandings.includedDayIndexes) &&
          existingStandings.includedDayIndexes.length > 0)
      );

    if (hasLegacyCumulativeState) {
      needsFullScanFallback = true;
      return null;
    }

    const nextDayTotalsByUid = hasStoredDayTotals
      ? normalizeWorldCupDayTotalsByUid(existingStandings.dayTotalsByUid)
      : {};
    const dayKey = String(dayIndex);

    if (shouldIncludeWorldCupDayInStandings(currentDayResult)) {
      // Replace this day atomically so retries and stat corrections cannot double count.
      nextDayTotalsByUid[dayKey] = normalizeWorldCupScoresByUid(
        worldCupDayScoresByUid(currentDayResult)
      );
    } else {
      delete nextDayTotalsByUid[dayKey];
    }

    const currentStatus = String(currentDayResult?.status || "").toLowerCase();
    const payload = buildWorldCupStandingsPayload({
      users,
      dayTotalsByUid: nextDayTotalsByUid,
      includesLivePoints: ["live", "resolving"].includes(currentStatus),
      nowMs,
    });

    transaction.set(standingsRef, payload);
    return {
      leaderboard: payload.leaderboard,
      finalDayCount: null,
      includedDayCount: payload.includedDayIndexes.length,
      includedDayIndexes: payload.includedDayIndexes,
      standingsUpdateMode: "incremental",
    };
  });

  if (needsFullScanFallback) {
    return rebuildWorldCupDailyStandingsFromResults({
      db,
      roomId,
      users,
      nowMs,
    });
  }

  return transactionResult;
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

function isWorldCupGroupEngineRoom(room = {}) {
  const engineType = String(room?.engineType || room?.worldCup?.engineType || "");
  const worldCupPhase = String(room?.worldCupPhase || room?.worldCup?.phase || "");
  const phaseLabel = String(
    room?.competitionState?.phaseLabel ||
      room?.["competitionState.phaseLabel"] ||
      room?.phaseLabel ||
      ""
  );

  return (
    engineType === WORLD_CUP_GROUP_ENGINE ||
    worldCupPhase === WORLD_CUP_GROUP_PHASE ||
    phaseLabel === "WorldCupGroup"
  );
}

function isWorldCupGroupRoomCompleted(room = {}) {
  const status = String(room?.status || "").toLowerCase();
  const seasonPhase = String(room?.seasonPhase || "").toUpperCase();
  const competitionState = room?.competitionState || {};
  const weekStatus = String(
    competitionState?.weekStatus || room?.["competitionState.weekStatus"] || ""
  ).toLowerCase();

  return (
    status === "completed" ||
    status === "complete" ||
    seasonPhase === "COMPLETE" ||
    weekStatus === "complete" ||
    weekStatus === "completed" ||
    competitionState?.isDone === true ||
    room?.worldCup?.completed === true
  );
}

function buildWorldCupScoreDiffs(oldScores = {}, newScores = {}) {
  const uids = new Set([
    ...Object.keys(oldScores || {}),
    ...Object.keys(newScores || {}),
  ]);
  const diffs = [];

  for (const uid of uids) {
    const oldPoints = toNumber(oldScores?.[uid]);
    const newPoints = toNumber(newScores?.[uid]);
    const delta = newPoints - oldPoints;

    if (delta === 0) continue;

    diffs.push({
      uid,
      oldPoints,
      newPoints,
      delta,
    });
  }

  return diffs.sort((a, b) => {
    const absDiff = Math.abs(b.delta) - Math.abs(a.delta);
    if (absDiff) return absDiff;
    return String(a.uid).localeCompare(String(b.uid));
  });
}

function summarizeWorldCupRepairDiffs(daySummaries = []) {
  const changedDays = daySummaries.filter((day) => day.changed);
  const changedRooms = new Set(
    changedDays.map((day) => day.roomId).filter(Boolean)
  );
  const userIds = new Set();
  let totalPointDelta = 0;
  let totalAbsPointDelta = 0;

  for (const day of changedDays) {
    for (const diff of day.scoreDiffs || []) {
      if (diff.uid) userIds.add(diff.uid);
      totalPointDelta += toNumber(diff.delta);
      totalAbsPointDelta += Math.abs(toNumber(diff.delta));
    }
  }

  return {
    changedRoomCount: changedRooms.size,
    changedDayCount: changedDays.length,
    changedUserCount: userIds.size,
    totalPointDelta,
    totalAbsPointDelta,
  };
}

function buildWorldCupRepairDayPatch({
  currentDay,
  fixtureIds,
  statusByFixtureId,
  writeStatusValue,
  dayStatusDecision,
  nowMs,
}) {
  return {
    status: writeStatusValue,
    fixtureStatusById: statusByFixtureId,
    allFixturesFinalSeenAtMs:
      dayStatusDecision.allFixturesFinalSeenAtMs ||
      admin.firestore.FieldValue.delete(),
    finalStatusFirstSeenAtMs:
      dayStatusDecision.finalStatusFirstSeenAtMs ||
      admin.firestore.FieldValue.delete(),
    finalSettleMs: dayStatusDecision.finalSettleMs || FINAL_SETTLE_MS,
    finalSettleUntilMs:
      dayStatusDecision.finalSettleUntilMs ||
      admin.firestore.FieldValue.delete(),
    finalSettleRemainingMs: dayStatusDecision.finalSettleRemainingMs || 0,
    finalStatsFreshAfterFinalSeen:
      Boolean(dayStatusDecision.directStatsAfterFinalSeen),
    dayStatusDecision,
    repairFixtureIds: fixtureIds,
    repairedAtMs: nowMs,
    updatedAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    label: currentDay.label || `Day ${currentDay.dayIndex}`,
  };
}

async function recomputeWorldCupGroupDayFromSavedFixtures({
  db,
  roomId,
  room = null,
  dayIndex,
  dayDoc = null,
  apiKey,
  nowMs = Date.now(),
  dryRun = true,
  statusOverrideByFixtureId = {},
  globalPlayerStatsOverrideByFixtureId = {},
  getFixtureStatusMap,
  getFixturePlayersStatsMapCached,
  setCompetitionState,
}) {
  if (!db) throw new Error("db is required");
  if (!roomId) throw new Error("roomId is required");
  if (!getFixtureStatusMap) throw new Error("getFixtureStatusMap is required");
  if (!getFixturePlayersStatsMapCached) {
    throw new Error("getFixturePlayersStatsMapCached is required");
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = room ? null : await roomRef.get();
  const roomData = room || (roomSnap?.exists ? roomSnap.data() || {} : null);
  if (!roomData) throw new Error(`Room not found: ${roomId}`);

  if (!isWorldCupGroupEngineRoom(roomData)) {
    return {
      ok: true,
      skipped: true,
      skippedReason: "not-world-cup-group-room",
      roomId,
      dayIndex: Number(dayIndex || 0) || null,
      changed: false,
    };
  }

  let currentDay = dayDoc || null;
  if (!currentDay) {
    const resolvedDayIndex = Number(dayIndex);
    if (!Number.isFinite(resolvedDayIndex) || resolvedDayIndex <= 0) {
      throw new Error("dayIndex is required when dayDoc is not supplied.");
    }

    const daySnap = await db
      .doc(`rooms/${roomId}/days/${String(resolvedDayIndex)}`)
      .get();
    if (!daySnap.exists) {
      return {
        ok: true,
        skipped: true,
        skippedReason: "day-not-found",
        roomId,
        dayIndex: resolvedDayIndex,
        changed: false,
      };
    }
    currentDay = { id: daySnap.id, ...(daySnap.data() || {}) };
  }

  const resolvedDayIndex = Number(currentDay.dayIndex || currentDay.id || dayIndex);
  const fixtureIds = dayFixtureIds(currentDay);
  if (!fixtureIds.length) {
    return {
      ok: true,
      skipped: true,
      skippedReason: "day-has-no-saved-fixture-ids",
      roomId,
      dayIndex: Number.isFinite(resolvedDayIndex) ? resolvedDayIndex : null,
      changed: false,
    };
  }

  const timezone = String(
    roomData?.competition?.timezone ||
      roomData?.worldCup?.timezone ||
      roomData?.competitionState?.timezone ||
      roomData?.timezone ||
      "America/Los_Angeles"
  );
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
  const statusByFixtureId = {
    ...(globalCache.statusByFixtureId || {}),
    ...(statusOverrideByFixtureId || {}),
  };
  const missingStatusFixtureIds = fixtureIds.filter(
    (fixtureId) => !statusByFixtureId[fixtureId]
  );

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

  const preloadedLineupByUid = await loadRoomLineupsByUid(db, roomId);
  const {
    users,
    playersById,
    readCounts,
  } = await loadRoomUsersLineups({
    db,
    roomId,
    room: roomData,
    currentDay,
    lineupByUid: preloadedLineupByUid,
    ensureDefaultLineupsForRoom: null,
  });

  const statusValue = computeDayWindowStatus({
    day: currentDay,
    fixtureIds,
    statusByFixtureId,
  });
  const hasStartedOrFinishedFixture = fixtureIds.some((fixtureId) => {
    const fixture = fixturesById.get(fixtureId) || {};
    const statusShort = statusByFixtureId[fixtureId] || fixture.statusShort || "";
    const kickoffMs = kickoffMsFromFixture(fixture);
    return (
      hasFixtureStarted(statusShort) ||
      (Number.isFinite(kickoffMs) && nowMs >= kickoffMs)
    );
  });
  const effectiveStatusValue =
    statusValue === "scheduled" && hasStartedOrFinishedFixture
      ? "live"
      : statusValue;
  const mergedGlobalStatsByFixtureId = {
    ...(globalCache.playerStatsByFixtureId || {}),
    ...(globalPlayerStatsOverrideByFixtureId || {}),
  };
  const allFixturesExplicitFinalForStats =
    fixtureIds.length > 0 &&
    fixtureIds.every((fixtureId) => isFinished(statusByFixtureId[fixtureId]));
  const forceDirectStatsFixtureIds = [];
  const directFallbackReasonByFixtureId = {};

  for (const fixtureId of fixtureIds) {
    const fixture = fixturesById.get(String(fixtureId)) || {};
    const statusShort = statusByFixtureId[fixtureId] || fixture.statusShort || "";
    const kickoffMs = kickoffMsFromFixture(fixture);
    const kickoffHasPassed =
      Number.isFinite(kickoffMs) && nowMs >= kickoffMs;
    const liveFixture = globalCache.liveFixturesById?.[fixtureId] || {};
    const activeOrResolving =
      hasFixtureStarted(statusShort) ||
      kickoffHasPassed ||
      allFixturesExplicitFinalForStats;
    const staleGlobalLivePayload =
      Boolean(useGlobalCache) &&
      activeOrResolving &&
      !mergedGlobalStatsByFixtureId?.[fixtureId] &&
      isGlobalLiveFixtureStale(liveFixture, nowMs);

    if (allFixturesExplicitFinalForStats && !mergedGlobalStatsByFixtureId?.[fixtureId]) {
      forceDirectStatsFixtureIds.push(fixtureId);
      directFallbackReasonByFixtureId[fixtureId] =
        "world-cup-repair-final-fresh-stats";
      continue;
    }

    if (staleGlobalLivePayload) {
      forceDirectStatsFixtureIds.push(fixtureId);
      directFallbackReasonByFixtureId[fixtureId] =
        "world-cup-repair-global-live-cache-stale";
    }
  }

  const {
    statsByFixtureId,
    fixtureCoverage: baseFixtureCoverage,
  } = await loadStatsForDay({
    fixtureIds,
    statusByFixtureId,
    fixturesById,
    nowMs,
    globalPlayerStatsByFixtureId: mergedGlobalStatsByFixtureId,
    forceDirectFixtureIds: forceDirectStatsFixtureIds,
    directFallbackReasonByFixtureId,
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
  const hasStatsFromCoverage = fixtureCoverage.some(
    (row) =>
      Number(row?.rawStatsPlayerCount || row?.statsPlayerCount || 0) > 0
  );
  const proposedWriteStatusValue =
    effectiveStatusValue === "scheduled" && hasStatsFromCoverage
      ? "live"
      : effectiveStatusValue;
  const finalSettleDecision = buildWorldCupFinalSettleDecision({
    currentDay,
    fixtureIds,
    fixturesById,
    statusByFixtureId,
    fixtureCoverage,
    proposedStatus: proposedWriteStatusValue,
    nowMs,
  });
  const existingDayStatus = String(currentDay?.status || "").toLowerCase();
  const writeStatusValue =
    existingDayStatus === "final" &&
    !finalSettleDecision.hasActiveOrDelayedFixture
      ? "final"
      : finalSettleDecision.writeStatusValue;
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
  const dayStatusDecision = {
    statusValue,
    effectiveStatusValue,
    proposedWriteStatusValue,
    writeStatusValue,
    reason: finalSettleDecision.reason,
    statusesByFixtureId: finalSettleDecision.statusesByFixtureId,
    allFixturesExplicitFinal: finalSettleDecision.allFixturesExplicitFinal,
    hasActiveOrDelayedFixture: finalSettleDecision.hasActiveOrDelayedFixture,
    allFixturesFinalSeenAtMs: finalSettleDecision.allFixturesFinalSeenAtMs,
    finalStatusFirstSeenAtMs: finalSettleDecision.finalStatusFirstSeenAtMs,
    finalSettleMs: finalSettleDecision.finalSettleMs,
    finalSettleUntilMs: finalSettleDecision.finalSettleUntilMs,
    finalSettleRemainingMs: finalSettleDecision.finalSettleRemainingMs,
    directStatsAfterFinalSeen: finalSettleDecision.directStatsAfterFinalSeen,
    forceDirectStatsFixtureIds,
    repairMode: true,
  };
  const teamScoresByUserId = {};
  const breakdownByUserId = {};
  const startersByUserId = {};
  const benchByUserId = {};
  const benchScoresByUserId = {};

  for (const user of users) {
    const starters = [];
    let starterTotal = 0;
    const starterPlan = buildWorldCupUserStarterPlan({
      user,
      fixtureIds,
      currentDay,
      fixturesById,
      playersById,
    });

    for (const player of starterPlan.starters) {
      const playerId = toId(player?.id || player?.playerId);
      const playerFixtureIds = starterPlan.fixtureIdsByPlayerId.get(playerId) || [];
      const result = buildPlayerEntriesForDay({
        player,
        fixtureIds: playerFixtureIds,
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
    const effectiveStarterIds = new Set(
      starterPlan.starters.map((player) => toId(player?.id || player?.playerId))
    );
    for (const player of starterPlan.roster.filter(
      (entry) => !effectiveStarterIds.has(toId(entry?.id || entry?.playerId))
    )) {
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
    dayIndex: Number(currentDay.dayIndex || resolvedDayIndex),
    label: currentDay.label || `Day ${currentDay.dayIndex || resolvedDayIndex}`,
    dateLabel: currentDay.dateLabel || "",
    startAtMs: currentDay.startAtMs || null,
    endAtMs: currentDay.endAtMs || null,
    fixtureIds,
    fixtures: Array.isArray(currentDay.fixtures) ? currentDay.fixtures : [],
    status: writeStatusValue,
    source: resultSource,
    globalCacheAttempted,
    globalCacheUsed: globalCacheAttempted,
    directFallbackUsed,
    globalCacheFullyUsed,
    missingGlobalSummaryFixtureIds: globalCache.missingSummaryFixtureIds || [],
    missingGlobalLiveFixtureIds: globalCache.missingLiveFixtureIds || [],
    teamScoresByUserId,
    benchScoresByUserId,
    breakdownByUserId,
    startersByUserId,
    benchByUserId,
    dailyLeaderboard,
    fixtureStatusById: statusByFixtureId,
    fixtureCoverage,
    dayStatusDecision,
    allFixturesFinalSeenAtMs: finalSettleDecision.allFixturesFinalSeenAtMs,
    finalStatusFirstSeenAtMs: finalSettleDecision.finalStatusFirstSeenAtMs,
    finalSettleMs: finalSettleDecision.finalSettleMs,
    finalSettleUntilMs: finalSettleDecision.finalSettleUntilMs,
    finalSettleRemainingMs: finalSettleDecision.finalSettleRemainingMs,
    finalStatsFreshAfterFinalSeen: finalSettleDecision.directStatsAfterFinalSeen,
    worldCupDailyLockWriteCount: 0,
    repairedByOwnerTool: true,
    repairedAtMs: nowMs,
    updatedAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const resultRef = db.doc(
    `rooms/${roomId}/dayResults/${String(dayResultPayload.dayIndex)}`
  );
  const oldResultSnap = await resultRef.get().catch(() => null);
  const oldResult = oldResultSnap?.exists ? oldResultSnap.data() || {} : {};
  const oldScoresByUserId = worldCupDayScoresByUid(oldResult);
  const newScoresByUserId = worldCupDayScoresByUid(dayResultPayload);
  const scoreDiffs = buildWorldCupScoreDiffs(oldScoresByUserId, newScoresByUserId);
  const changed = !oldResultSnap?.exists || scoreDiffs.length > 0;
  let standingsResult = null;
  let finalResultsUpdated = false;
  let top3 = null;

  if (!dryRun) {
    await resultRef.set(dayResultPayload, { merge: true });
    await db.doc(`rooms/${roomId}/days/${String(dayResultPayload.dayIndex)}`).set(
      buildWorldCupRepairDayPatch({
        currentDay,
        fixtureIds,
        statusByFixtureId,
        writeStatusValue,
        dayStatusDecision,
        nowMs,
      }),
      { merge: true }
    );

    standingsResult = await writeWorldCupDailyStandings({
      db,
      roomId,
      users,
      nowMs,
      currentDayResult: dayResultPayload,
    });

    if (isWorldCupGroupRoomCompleted(roomData)) {
      top3 = await completeWorldCupGroupRoom({
        db,
        roomId,
        roomRef,
        room: roomData,
        leaderboard: standingsResult?.leaderboard || [],
        nowMs,
        setCompetitionState,
      });
      finalResultsUpdated = true;
    }
  }

  return {
    ok: true,
    roomId,
    dayIndex: dayResultPayload.dayIndex,
    label: dayResultPayload.label,
    dryRun: Boolean(dryRun),
    changed,
    wouldWrite: Boolean(dryRun && changed),
    wroteResults: Boolean(!dryRun),
    finalResultsUpdated,
    top3,
    status: writeStatusValue,
    source: resultSource,
    fixtureCount: fixtureIds.length,
    userCount: users.length,
    scoreDiffs,
    oldScoresByUserId,
    newScoresByUserId,
    teamScoresByUserId,
    benchScoresByUserId,
    dailyLeaderboard,
    standingsUpdateMode: standingsResult?.standingsUpdateMode || null,
    standingsLeaderboard: standingsResult?.leaderboard || [],
    fixtureCoverage,
    readCounts,
  };
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

  const timezone = String(
    roomData?.competition?.timezone ||
      roomData?.worldCup?.timezone ||
      roomData?.competitionState?.timezone ||
      roomData?.timezone ||
      "America/Los_Angeles"
  );
  const days = await loadDailyWindows(db, roomId);
  if (!days.length) throw new Error(`World Cup group room has no day windows: ${roomId}`);

  let currentDay = selectCurrentDay(days, nowMs);
  if (!currentDay || String(currentDay.status || "").toLowerCase() === "final") {
    const { users } = await loadRoomUsersLineups({
      db,
      roomId,
      room: roomData,
      currentDay,
      ensureDefaultLineupsForRoom,
    });
    const {
      leaderboard,
      standingsUpdateMode,
    } = await rebuildWorldCupDailyStandingsFromResults({
      db,
      roomId,
      users,
      nowMs,
    });
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
      standingsUpdateMode,
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

  const shouldRefreshStatusesDirect = fixtureIds.some((fixtureId) => {
    const fixture = fixturesById.get(fixtureId) || {};
    const statusShort = statusByFixtureId[fixtureId] || fixture.statusShort || "";
    const kickoffMs = kickoffMsFromFixture(fixture);
    return (
      hasFixtureStarted(statusShort) ||
      isFinished(statusShort) ||
      String(currentDay?.status || "").toLowerCase() === "resolving" ||
      String(currentDay?.status || "").toLowerCase() === "live" ||
      (
        Number.isFinite(kickoffMs) &&
        nowMs >= kickoffMs - PRE_MS
      )
    );
  });
  let directStatusRefreshUsed = false;
  let directStatusRefreshReason = "";
  if (shouldRefreshStatusesDirect) {
  const directStatusByFixtureId = await getFixtureStatusMap({
    fixtureIds,
    timezone,
    apiKey,
  });
  Object.assign(statusByFixtureId, directStatusByFixtureId || {});
  directStatusRefreshUsed = true;
  directStatusRefreshReason = "world-cup-started-or-settling-status-cache-refresh";
}

  console.log("[runWorldCupGroupEngine] global cache status", {
    roomId,
    dayIndex: currentDay?.dayIndex || null,
    useGlobalCache,
    seasonKey,
    fixtureCount: fixtureIds.length,
    missingGlobalSummaryFixtureIds,
    missingGlobalLiveFixtureIds,
    directStatusRefreshUsed,
    directStatusRefreshReason,
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
  const hasStartedOrFinishedFixture = fixtureIds.some((fixtureId) => {
    const fixture = fixturesById.get(fixtureId) || {};
    const statusShort =
      statusByFixtureId[fixtureId] ||
      fixture.statusShort ||
      "";
    const kickoffMs = kickoffMsFromFixture(fixture);
    return (
      hasFixtureStarted(statusShort) ||
      (Number.isFinite(kickoffMs) && nowMs >= kickoffMs)
    );
  });
  const effectiveStatusValue =
    statusValue === "scheduled" && hasStartedOrFinishedFixture
      ? "live"
      : statusValue;

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
      pollReason: pollInfoForCurrentDay.reason,
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
      directStatusRefreshUsed,
      directStatusRefreshReason,
      fixtureCoverage,
      statusByFixtureId,
    };
  }

  const preloadedLineupByUid = await loadRoomLineupsByUid(db, roomId);
  const {
    users,
    playersById,
    lineupByUid,
  } = await loadRoomUsersLineups({
    db,
    roomId,
    room: roomData,
    currentDay,
    lineupByUid: preloadedLineupByUid,
    ensureDefaultLineupsForRoom,
  });

  currentDay = await ensureWorldCupFixtureStarterSnapshots({
    db,
    roomId,
    currentDay,
    fixtureIds,
    fixturesById,
    nowMs,
    lineupByUid,
  });

  const allFixturesExplicitFinalForStats =
    fixtureIds.length > 0 &&
    fixtureIds.every((fixtureId) => isFinished(statusByFixtureId[fixtureId]));
  const forceDirectStatsFixtureIds = [];
  const directFallbackReasonByFixtureId = {};
  for (const fixtureId of fixtureIds) {
    const fixture = fixturesById.get(String(fixtureId)) || {};
    const statusShort = statusByFixtureId[fixtureId] || fixture.statusShort || "";
    const kickoffMs = kickoffMsFromFixture(fixture);
    const kickoffHasPassed =
      Number.isFinite(kickoffMs) && nowMs >= kickoffMs;
    const liveFixture = globalCache.liveFixturesById?.[fixtureId] || {};
    const activeOrResolving =
      hasFixtureStarted(statusShort) ||
      kickoffHasPassed ||
      allFixturesExplicitFinalForStats;
    const staleGlobalLivePayload =
      Boolean(useGlobalCache) &&
      activeOrResolving &&
      isGlobalLiveFixtureStale(liveFixture, nowMs);

    if (allFixturesExplicitFinalForStats) {
      forceDirectStatsFixtureIds.push(fixtureId);
      directFallbackReasonByFixtureId[fixtureId] =
        "world-cup-final-settle-fresh-stats";
      continue;
    }

    if (staleGlobalLivePayload) {
      forceDirectStatsFixtureIds.push(fixtureId);
      directFallbackReasonByFixtureId[fixtureId] =
        "world-cup-global-live-cache-stale";
    }
  }

  const {
    statsByFixtureId,
    fixtureCoverage: baseFixtureCoverage,
  } = await loadStatsForDay({
    fixtureIds,
    statusByFixtureId,
    fixturesById,
    nowMs,
    globalPlayerStatsByFixtureId: globalCache.playerStatsByFixtureId || {},
    forceDirectFixtureIds: forceDirectStatsFixtureIds,
    directFallbackReasonByFixtureId,
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
  const hasStatsFromCoverage = fixtureCoverage.some(
    (row) =>
      Number(row?.rawStatsPlayerCount || row?.statsPlayerCount || 0) > 0
  );
  const proposedWriteStatusValue =
    effectiveStatusValue === "scheduled" && hasStatsFromCoverage
      ? "live"
      : effectiveStatusValue;
  const finalSettleDecision = buildWorldCupFinalSettleDecision({
    currentDay,
    fixtureIds,
    fixturesById,
    statusByFixtureId,
    fixtureCoverage,
    proposedStatus: proposedWriteStatusValue,
    nowMs,
  });
  const writeStatusValue = finalSettleDecision.writeStatusValue;
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
  const dayStatusDecision = {
    statusValue,
    effectiveStatusValue,
    proposedWriteStatusValue,
    writeStatusValue,
    reason: finalSettleDecision.reason,
    statusesByFixtureId: finalSettleDecision.statusesByFixtureId,
    allFixturesExplicitFinal: finalSettleDecision.allFixturesExplicitFinal,
    hasActiveOrDelayedFixture: finalSettleDecision.hasActiveOrDelayedFixture,
    allFixturesFinalSeenAtMs: finalSettleDecision.allFixturesFinalSeenAtMs,
    finalStatusFirstSeenAtMs: finalSettleDecision.finalStatusFirstSeenAtMs,
    finalSettleMs: finalSettleDecision.finalSettleMs,
    finalSettleUntilMs: finalSettleDecision.finalSettleUntilMs,
    finalSettleRemainingMs: finalSettleDecision.finalSettleRemainingMs,
    directStatsAfterFinalSeen: finalSettleDecision.directStatsAfterFinalSeen,
    forceDirectStatsFixtureIds,
    directStatusRefreshUsed,
    directStatusRefreshReason,
  };

  const teamScoresByUserId = {};
  const breakdownByUserId = {};
  const startersByUserId = {};
  const benchByUserId = {};
  const benchScoresByUserId = {};
  const lockCandidatesByUid = new Map();

  for (const user of users) {
    const starters = [];
    let starterTotal = 0;
    const starterPlan = buildWorldCupUserStarterPlan({
      user,
      fixtureIds,
      currentDay,
      fixturesById,
      playersById,
    });

    for (const player of starterPlan.starters) {
      const playerId = toId(player?.id || player?.playerId);
      const playerFixtureIds = starterPlan.fixtureIdsByPlayerId.get(playerId) || [];
      const result = buildPlayerEntriesForDay({
        player,
        fixtureIds: playerFixtureIds,
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

      for (const entry of result.entries) {
        if (!entry?.fixtureId || !hasScoringAppearance(entry.rawStats || entry.stats || {})) {
          continue;
        }

        const fixture = fixturesById.get(String(entry.fixtureId)) || entry.fixture || {};
        const matchMs = kickoffMsFromFixture(fixture);
        if (!Number.isFinite(matchMs)) continue;

        const entryPlayerId = toId(player?.id || player?.playerId || entry.playerId);
        if (!entryPlayerId) continue;
        const starterIndex = starterPlan.starterIndexByFixturePlayer.get(
          `${entry.fixtureId}:${entryPlayerId}`
        );
        if (!Number.isInteger(starterIndex)) continue;

        const lockWindow = buildWorldCupDailyLockWindow(matchMs, timezone);
        const candidates = lockCandidatesByUid.get(user.uid) || [];
        candidates.push({
          playerId: entryPlayerId,
          playerName: player?.name || entry.playerName || entry.name || "Unknown",
          fixtureId: String(entry.fixtureId),
          lockedAtMs: nowMs,
          lockedUntilMs: lockWindow.lockedUntilMs,
          matchDate: lockWindow.matchDate,
          timezone: lockWindow.timezone,
          starterIndex,
          reason: "appearance",
        });
        lockCandidatesByUid.set(user.uid, candidates);
      }
    }

    const bench = [];
    let benchTotal = 0;
    const effectiveStarterIds = new Set(
      starterPlan.starters.map((player) => toId(player?.id || player?.playerId))
    );
    for (const player of starterPlan.roster.filter(
      (entry) => !effectiveStarterIds.has(toId(entry?.id || entry?.playerId))
    )) {
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

  const worldCupDailyLockWriteCount = await persistWorldCupDailyAppearanceLocks({
    db,
    roomId,
    users,
    lockCandidatesByUid,
    nowMs,
  });

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
    status: writeStatusValue,
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
    dayStatusDecision,
    allFixturesFinalSeenAtMs: finalSettleDecision.allFixturesFinalSeenAtMs,
    finalStatusFirstSeenAtMs: finalSettleDecision.finalStatusFirstSeenAtMs,
    finalSettleMs: finalSettleDecision.finalSettleMs,
    finalSettleUntilMs: finalSettleDecision.finalSettleUntilMs,
    finalSettleRemainingMs: finalSettleDecision.finalSettleRemainingMs,
    finalStatsFreshAfterFinalSeen: finalSettleDecision.directStatsAfterFinalSeen,
    worldCupDailyLockWriteCount,
    updatedAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.doc(`rooms/${roomId}/dayResults/${String(currentDay.dayIndex)}`).set(
    dayResultPayload,
    { merge: true }
  );

  await db.doc(`rooms/${roomId}/days/${String(currentDay.dayIndex)}`).set(
    {
      status: writeStatusValue,
      fixtureStatusById: statusByFixtureId,
      allFixturesFinalSeenAtMs:
        finalSettleDecision.allFixturesFinalSeenAtMs ||
        admin.firestore.FieldValue.delete(),
      finalStatusFirstSeenAtMs:
        finalSettleDecision.finalStatusFirstSeenAtMs ||
        admin.firestore.FieldValue.delete(),
      finalSettleMs: finalSettleDecision.finalSettleMs,
      finalSettleUntilMs:
        finalSettleDecision.finalSettleUntilMs ||
        admin.firestore.FieldValue.delete(),
      finalSettleRemainingMs: finalSettleDecision.finalSettleRemainingMs,
      finalStatsFreshAfterFinalSeen: finalSettleDecision.directStatsAfterFinalSeen,
      dayStatusDecision,
      updatedAtMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const daysAfter = days.map((day) =>
    Number(day.dayIndex) === Number(currentDay.dayIndex)
      ? { ...day, status: writeStatusValue }
      : day
  );

  let standingsResult = await writeWorldCupDailyStandings({
    db,
    roomId,
    users,
    nowMs,
    currentDayResult: dayResultPayload,
  });
  const allDaysFinal =
    daysAfter.length > 0 &&
    daysAfter.every((day) => String(day.status || "").toLowerCase() === "final");

  if (allDaysFinal) {
    const expectedFinalDayIndexes = daysAfter
      .map((day) => Number(day?.dayIndex || 0))
      .filter((dayIndex) => Number.isFinite(dayIndex) && dayIndex > 0);
    const includedDayIndexSet = new Set(
      Array.isArray(standingsResult?.includedDayIndexes)
        ? standingsResult.includedDayIndexes.map(Number)
        : []
    );
    const standingsMissingFinalDays = expectedFinalDayIndexes.some(
      (dayIndex) => !includedDayIndexSet.has(dayIndex)
    );

    if (standingsMissingFinalDays) {
      standingsResult = await rebuildWorldCupDailyStandingsFromResults({
        db,
        roomId,
        users,
        nowMs,
      });
    }

    const leaderboard = standingsResult?.leaderboard || [];
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
      standingsUpdateMode: standingsResult?.standingsUpdateMode || "incremental",
      missingGlobalSummaryFixtureIds,
      missingGlobalLiveFixtureIds,
      directStatusRefreshUsed,
      directStatusRefreshReason,
      dayStatusDecision,
      allFixturesFinalSeenAtMs: finalSettleDecision.allFixturesFinalSeenAtMs,
      finalStatusFirstSeenAtMs: finalSettleDecision.finalStatusFirstSeenAtMs,
      finalSettleRemainingMs: finalSettleDecision.finalSettleRemainingMs,
      finalStatsFreshAfterFinalSeen: finalSettleDecision.directStatsAfterFinalSeen,
      fixtureCoverage,
      worldCupDailyLockWriteCount,
      dailyLeaderboard,
      breakdownByUserId,
      startersByUserId,
      benchByUserId,
    };
  }

  const leaderboard = standingsResult?.leaderboard || [];

  const nextDay =
    writeStatusValue === "final"
      ? daysAfter.find((day) => String(day.status || "").toLowerCase() !== "final")
      : currentDay;
  let pollInfo = computeNextPollFromFixtures(
    Array.isArray(nextDay?.fixtures) ? nextDay.fixtures : [],
    nowMs,
    writeStatusValue === "final" ? {} : statusByFixtureId
  );
  if (
    writeStatusValue === "resolving" &&
    finalSettleDecision.allFixturesExplicitFinal
  ) {
    pollInfo = {
      nextKickoffMs: null,
      nextPollAtMs: nowMs + ACTIVE_POLL_MS,
      reason: "world-cup-final-settle-1min-check",
    };
  }

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

  const pollReason = String(pollInfo?.reason || "");
  const isActivelyPollingLive =
    pollReason === "world-cup-day-live" ||
    pollReason === "world-cup-live-status-force-1min-check" ||
    pollReason === "world-cup-live-or-resolving-1min-check" ||
    pollReason === "world-cup-final-settle-1min-check";
  const weekStatus =
    writeStatusValue === "final"
      ? "scheduled"
      : writeStatusValue === "resolving"
        ? "resolving"
      : isActivelyPollingLive
        ? "live"
        : "scheduled";
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
    status: writeStatusValue,
    weekStatus,
    pollReason: pollInfo.reason,
    optimizedPolling: true,
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
    standingsUpdateMode: standingsResult?.standingsUpdateMode || "incremental",
    source: dayResultPayload.source,
    globalCacheAttempted: dayResultPayload.globalCacheAttempted,
    globalCacheUsed: dayResultPayload.globalCacheUsed,
    directFallbackUsed: dayResultPayload.directFallbackUsed,
    globalCacheFullyUsed: dayResultPayload.globalCacheFullyUsed,
    missingGlobalSummaryFixtureIds,
    missingGlobalLiveFixtureIds,
    directStatusRefreshUsed,
    directStatusRefreshReason,
    dayStatusDecision,
    allFixturesFinalSeenAtMs: finalSettleDecision.allFixturesFinalSeenAtMs,
    finalStatusFirstSeenAtMs: finalSettleDecision.finalStatusFirstSeenAtMs,
    finalSettleRemainingMs: finalSettleDecision.finalSettleRemainingMs,
    finalStatsFreshAfterFinalSeen: finalSettleDecision.directStatsAfterFinalSeen,
    forceDirectStatsFixtureIds,
    fixtureCoverage,
    statusByFixtureId,
    worldCupDailyLockWriteCount,
  };
}

module.exports = {
  runWorldCupGroupEngine,
  recomputeWorldCupGroupDayFromSavedFixtures,
  summarizeWorldCupRepairDiffs,
};
