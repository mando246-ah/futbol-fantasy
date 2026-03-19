"use strict";

const { scoreTeam } = require("../shared/scoringCore");
const { pickCupWindow } = require("./cupWindows");
const { cupCurrentRef, cupFixtureRef, getCreditedMap } = require("./cupLedger");

function isInPlay(short) {
  return ["1H", "HT", "2H", "ET", "BT", "P"].includes(short);
}
function isFinished(short) {
  return ["FT", "AET", "PEN"].includes(short);
}

function toPos(pos) {
  const p = String(pos || "").toUpperCase();
  if (p.includes("GOALKEEP") || p === "GK" || p === "GKP") return "GK";
  if (p.includes("DEFEND") || p.includes("BACK") || p === "DEF") return "DEF";
  if (p.includes("MID") || p === "MID") return "MID";
  if (p.includes("ATTACK") || p.includes("FORW") || p.includes("STRIK") || p === "FWD") return "FWD";
  if (p === "ATT") return "FWD";
  return "MID";
}

function normalizePlayer(raw, metaById) {
  if (!raw) return null;

  // id-only
  if (typeof raw === "string" || typeof raw === "number") {
    const id = String(raw);
    const m = metaById?.get(id) || null;
    return { id, name: m?.name || "Unknown", position: toPos(m?.position || "MID") };
  }

  const id = raw.id || raw.playerId || raw.pid || raw.apiPlayerId || raw?.player?.id || raw?.player?.playerId;
  if (!id) return null;

  const pid = String(id);
  const m = metaById?.get(pid) || null;

  return {
    id: pid,
    name: raw.name || raw.fullName || raw.displayName || raw?.player?.name || m?.name || "Unknown",
    position: toPos(raw.position || raw.pos || raw.role || raw?.player?.position || m?.position || "MID"),
  };
}

function extractList(lineupData, candidates, metaById) {
  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue;
    const out = c.map((x) => normalizePlayer(x, metaById)).filter(Boolean);
    if (out.length) return out;
  }
  return [];
}

function extractStarters(lineupData, metaById) {
  if (!lineupData) return [];
  return extractList(
    lineupData,
    [
      lineupData.startingXI,
      lineupData.starting11,
      lineupData.starters,
      lineupData.starterIds,
      lineupData.startingIds,
      lineupData.lineup?.startingXI,
      lineupData.lineup?.starting11,
      lineupData.lineup?.starters,
    ],
    metaById
  );
}

function extractBench(lineupData, metaById) {
  if (!lineupData) return [];
  return extractList(
    lineupData,
    [
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
    ],
    metaById
  );
}

/**
 * Discover candidate fixtures for windowing:
 * - live fixtures (live=all)
 * - upcoming fixtures (next=100)
 */
async function discoverFixtures({ apiFootballGet, apiKey, league, season, timezone }) {
  const out = [];

  // live
  try {
    const live = await apiFootballGet("fixtures", { live: "all", league, season }, apiKey);
    const list = Array.isArray(live?.response) ? live.response : [];
    for (const m of list) {
      const id = String(m?.fixture?.id || "");
      const kickoffMs = m?.fixture?.timestamp ? Number(m.fixture.timestamp) * 1000 : Date.parse(m?.fixture?.date);
      if (!id || !Number.isFinite(kickoffMs)) continue;
      out.push({ id, kickoffMs, round: m?.league?.round || null });
    }
  } catch (_) {}

  // upcoming
  const up = await apiFootballGet("fixtures", { league, season, next: 100, timezone }, apiKey);
  const list2 = Array.isArray(up?.response) ? up.response : [];
  for (const m of list2) {
    const id = String(m?.fixture?.id || "");
    const kickoffMs = m?.fixture?.timestamp ? Number(m.fixture.timestamp) * 1000 : Date.parse(m?.fixture?.date);
    if (!id || !Number.isFinite(kickoffMs)) continue;
    out.push({ id, kickoffMs, round: m?.league?.round || null });
  }

  return out;
}

/**
 * Main CUP engine (called from scheduler).
 * deps are passed from index.js to avoid moving huge helpers.
 */
async function runCupEngine({
  db,
  roomId,
  room,
  nowMs,
  apiKey,
  apiFootballGet,
  getFixtureStatusMap,
  getFixturePlayersStatsMapCached,
}) {
  if (!room) {
    const snap = await db.doc(`rooms/${roomId}`).get();
    room = snap.exists ? (snap.data() || {}) : {};
  }

  const cupRef = cupCurrentRef(db, roomId);
  await cupRef.set(
    { status: "IDLE", updatedAtMs: nowMs, lastPollAtMs: nowMs },
    { merge: true }
  );

  try {
  const competition = room.competition;
  if (!competition?.league || !competition?.season) return;

  const league = competition.league;
  const season = competition.season;
  const timezone = competition.timezone || "America/Los_Angeles";

  // Stop work if room is done
  const isDone = Boolean(room?.competitionState?.isDone);
  if (isDone) return;

  const cupSnap = await cupRef.get();
  let cup = cupSnap.exists ? (cupSnap.data() || {}) : null;

  if (!cup) {
    cup = {
      status: "IDLE",
      completed: false,
      cupTotalsByUid: {},
      windowPointsByUid: {},
      currentWindowId: null,
      currentWindowLabel: null,
      currentWindowFixtureIds: [],
      updatedAtMs: nowMs,
    };
    await cupRef.set(cup, { merge: true });
  }

  if (cup.completed || cup.status === "FINAL") return;

  // 1) Ensure we have an active window
  let currentIds = Array.isArray(cup.currentWindowFixtureIds) ? cup.currentWindowFixtureIds.map(String) : [];
  if (!currentIds.length) {
    const candidates = await discoverFixtures({ apiFootballGet, apiKey, league, season, timezone });
    const window = pickCupWindow(candidates, { nowMs, gapHours: 12 });

    if (!window || !window.fixtureIds.length) {
      // no fixtures found -> mark completed (safe only if truly none upcoming)
      await cupRef.set({ status: "IDLE", updatedAtMs: nowMs }, { merge: true });
      await db.doc(`rooms/${roomId}`).set(
        { "competitionState.weekStatus": "idle", "competitionState.updatedAtMs": nowMs },
        { merge: true }
      );
      return;
    }

    currentIds = window.fixtureIds;

    await cupRef.set(
      {
        status: "scheduled",
        currentWindowId: window.windowId,
        currentWindowLabel: window.label,
        currentWindowFixtureIds: currentIds,
        windowPointsByUid: {}, // reset at new window
        updatedAtMs: nowMs,
      },
      { merge: true }
    );

    // Update room state so UI has a label
    await db.doc(`rooms/${roomId}`).set(
      {
        "competitionState.currentLabel": window.label || "Cup",
        "competitionState.weekStatus": "scheduled",
        "competitionState.updatedAtMs": nowMs,
      },
      { merge: true }
    );
  }

  // 2) Status lookup (also refreshes apiCache fixtureStatus docs used by players stats)
  const shortById = await getFixtureStatusMap({ fixtureIds: currentIds, timezone, apiKey });

  const anyLive = currentIds.some((fid) => isInPlay(shortById[fid]));
  const anyFin = currentIds.some((fid) => isFinished(shortById[fid]));
  const allFin = currentIds.every((fid) => isFinished(shortById[fid]));
  const creditedMap = cup.creditedFixtures || {};
  const allFinAndCredited = currentIds.every((fid) => isFinished(shortById[fid]) && creditedMap[fid]);

  const needsResolving = anyFin && !allFinAndCredited;

  if (!anyLive && !needsResolving) {
    // Nothing is playing, and nothing needs to be scored. 
    // Update the room status for the UI, then BAIL OUT before the heavy DB reads!
    const roomWeekStatus = anyFin ? "resolving" : "scheduled";
    await db.doc(`rooms/${roomId}`).set(
      { competitionState: { weekStatus: roomWeekStatus, updatedAtMs: nowMs } },
      { merge: true }
    );
    return;
  }

  // 3) Preload members
  const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
  const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean);
  if (!memberUids.length) return;

  // 4) Preload picks once (small)
  const picksSnap = await db.collection(`rooms/${roomId}/picks`).get();
  const pickRefByPid = new Map();
  const metaByPid = new Map();
  picksSnap.forEach((doc) => {
    const d = doc.data() || {};
    const pid = String(d.playerId ?? d.pid ?? d.apiPlayerId ?? d.player?.id ?? "");
    if (!pid) return;
    pickRefByPid.set(pid, doc.ref);

    const name = d.playerName || d.name || d.player?.name || "Unknown";
    const position = d.position || d.pos || d.role || d.player?.position || "MID";
    metaByPid.set(pid, { name, position });
  });

  // 5) Load lineups once (small)
  const lineupByUid = {};
  await Promise.all(
    memberUids.map(async (uid) => {
      const snap = await db.doc(`rooms/${roomId}/lineups/${uid}`).get();
      lineupByUid[uid] = snap.exists ? (snap.data() || {}) : null;
    })
  );


  for (const fixtureId of currentIds) {
    const short = shortById[fixtureId] || null;
    if (!isFinished(short)) continue;
    if (creditedMap[fixtureId]) continue;

    // get stats (cached). Use a longer TTL since fixture is finished.
    const statsMap = await getFixturePlayersStatsMapCached({
      fixtureId,
      apiKey,
      ttlMs: 60 * 60 * 1000,
      timeZone: timezone,
    });

    // Score users (starters count, bench does NOT count but we still store lastDelta for UI)
    const pointsByUid = {};
    const pointsByPlayerId = {};
    const pickUpdates = [];

    for (const uid of memberUids) {
      const lineup = lineupByUid[uid];

      const starters = extractStarters(lineup, metaByPid);
      const bench = extractBench(lineup, metaByPid);

      const starterScored = scoreTeam(starters, statsMap, toPos);
      const benchScored = scoreTeam(bench, statsMap, toPos);

      pointsByUid[uid] = Number(starterScored.total || 0);

      // per-player deltas for UI + ledger
      for (const [pid, obj] of Object.entries(starterScored.perPlayer || {})) {
        const p = String(pid);
        pointsByPlayerId[p] = { points: obj.points, counted: true };
        const ref = pickRefByPid.get(p);
        if (ref) {
          pickUpdates.push({ ref, data: { lastFixtureId: String(fixtureId), lastDelta: obj.points, lastDeltaAtMs: nowMs, lastCounted: true } });
        }
      }
      for (const [pid, obj] of Object.entries(benchScored.perPlayer || {})) {
        const p = String(pid);
        // only write if they actually have minutes or a stats entry; scoreTeam already returns 0 if no minutes,
        // but keeping it is fine for UI.
        pointsByPlayerId[p] = { points: obj.points, counted: false };
        const ref = pickRefByPid.get(p);
        if (ref) {
          pickUpdates.push({ ref, data: { lastFixtureId: String(fixtureId), lastDelta: obj.points, lastDeltaAtMs: nowMs, lastCounted: false } });
        }
      }
    }

    const fixturePayload = {
      fixtureId: String(fixtureId),
      creditedAtMs: nowMs,
      windowId: cup.currentWindowId || null,
      windowLabel: cup.currentWindowLabel || null,
      roundLabel: cup.currentWindowLabel || null,
      pointsByUid,
      pointsByPlayerId,
    };

    // Transaction: ensure "credit once" and update totals
    // Transaction: ensure "credit once" and update totals
    await db.runTransaction(async (tx) => {
      const curCupSnap = await tx.get(cupRef);
      const cur = curCupSnap.exists ? (curCupSnap.data() || {}) : {};

      // Use the map to check if credited, saving a read on the subcollection doc!
      if (cur.creditedFixtures && cur.creditedFixtures[fixtureId]) return;

      const totals = { ...(cur.cupTotalsByUid || {}) };
      const windowPts = { ...(cur.windowPointsByUid || {}) };

      for (const [uid, pts] of Object.entries(pointsByUid)) {
        const add = Number(pts || 0);
        totals[uid] = Number(totals[uid] || 0) + add;
        windowPts[uid] = Number(windowPts[uid] || 0) + add;
      }

      const fxRef = cupFixtureRef(db, roomId, fixtureId);
      tx.set(fxRef, fixturePayload, { merge: false }); // keep for audit/UI
      
      tx.set(
        cupRef,
        {
          status: "resolving",
          cupTotalsByUid: totals,
          windowPointsByUid: windowPts,
          lastCreditedFixtureId: String(fixtureId),
          lastCreditedAtMs: nowMs,
          updatedAtMs: nowMs,
          [`creditedFixtures.${fixtureId}`]: true
        },
        { merge: true }
      );
    });

    // Batch update picks lastDelta fields (UI convenience)
    if (pickUpdates.length) {
      const batch = db.batch();
      for (const u of pickUpdates) {
        batch.set(u.ref, u.data, { merge: true });
      }
      await batch.commit();
    }
  }

  // 7) Close window if all fixtures finished AND credited
  const creditedMap2 = await getCreditedMap(db, roomId, currentIds);
  const allCredited = currentIds.every((fid) => creditedMap2[fid]);

  if (allFin && allCredited) {
    // Clear window, reset points, AND wipe the credited map for the next round
    await cupRef.set(
      {
        status: "IDLE",
        currentWindowId: null,
        currentWindowLabel: null,
        currentWindowFixtureIds: [],
        windowPointsByUid: {},
        creditedFixtures: {}, 
        lastWindowClosedAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      { merge: true }
    );

    // If there are no future fixtures, mark FINAL+COMPLETED
    const next = await apiFootballGet("fixtures", { league, season, next: 1, timezone }, apiKey);
    const nextList = Array.isArray(next?.response) ? next.response : [];
    if (!nextList.length) {
      await cupRef.set({ status: "FINAL", completed: true, completedAtMs: nowMs }, { merge: true });

      await db.doc(`rooms/${roomId}`).set(
        {
          "competitionState.currentLabel": "Final",
          "competitionState.weekStatus": "final",
          "competitionState.isDone": true, // COMPLETED (draft over)
          "competitionState.updatedAtMs": nowMs,
        },
        { merge: true }
      );
    } else {
      // Not completed yet; go idle until next window is discovered
      await db.doc(`rooms/${roomId}`).set(
        { "competitionState.weekStatus": "idle", "competitionState.updatedAtMs": nowMs },
        { merge: true }
      );
    }
  } else {
    // Keep cup doc status fresh
    const statusToSave = anyFin ? "resolving" : "scheduled";
    await cupRef.set({ status: statusToSave, updatedAtMs: nowMs }, { merge: true });
  }


    } catch (e) {
    console.error("[runCupEngine]", roomId, e);
    await cupRef.set(
      {
        status: "ERROR",
        lastError: String(e?.message || e),
        lastErrorAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      { merge: true }
    );
  }
}

module.exports = { runCupEngine };