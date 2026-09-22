"use strict";

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const CONFIRM_TEXT = "RESET_CUP_GLOBAL_CURRENT_WINDOW_DISPLAY";

function normalizeNumberMap(map = {}) {
  const out = {};
  if (!map || typeof map !== "object") return out;

  for (const [uid, value] of Object.entries(map)) {
    const key = String(uid || "").trim();
    const n = Number(value || 0);
    if (!key || !Number.isFinite(n)) continue;
    out[key] = n;
  }

  return out;
}

function buildRowsFromTotals(totalsByUid = {}, rowSources = []) {
  const totals = normalizeNumberMap(totalsByUid);
  const rowByUid = new Map();

  for (const source of Array.isArray(rowSources) ? rowSources : []) {
    for (const row of Array.isArray(source) ? source : []) {
      const uid = String(row?.userId || row?.uid || "").trim();
      if (!uid || rowByUid.has(uid)) continue;
      rowByUid.set(uid, row || {});
    }
  }

  return Object.entries(totals)
    .map(([uid, total]) => {
      const previous = rowByUid.get(uid) || {};
      const displayName = previous.displayName || previous.name || uid;

      return {
        rank: 0,
        uid,
        userId: uid,
        name: displayName,
        displayName,
        teamName: previous.teamName || "",
        totalFantasyPoints: Number(total || 0),
      };
    })
    .sort(
      (a, b) =>
        Number(b.totalFantasyPoints || 0) -
        Number(a.totalFantasyPoints || 0)
    )
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }));
}

async function main() {
  const roomId = String(process.argv[2] || "").trim();
  const apply = process.argv.includes("--apply");
  const confirmArg = String(
    process.argv.find((arg) => arg.startsWith("--confirm=")) || ""
  ).replace("--confirm=", "");

  if (!roomId) {
    throw new Error("Usage: node tools/resetCupCurrentDisplay.js ROOM_ID --confirm=RESET_CUP_GLOBAL_CURRENT_WINDOW_DISPLAY --apply");
  }

  if (apply && confirmArg !== CONFIRM_TEXT) {
    throw new Error(`Missing confirm. Add --confirm=${CONFIRM_TEXT}`);
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const cupRef = db.doc(`rooms/${roomId}/cup/current`);
  const standingsRef = db.doc(`rooms/${roomId}/standings/current`);

  const [roomSnap, cupSnap, standingsSnap] = await Promise.all([
    roomRef.get(),
    cupRef.get(),
    standingsRef.get().catch(() => null),
  ]);

  if (!roomSnap.exists) throw new Error(`Room not found: ${roomId}`);
  if (!cupSnap.exists) throw new Error(`cup/current not found for: ${roomId}`);

  const room = roomSnap.data() || {};
  const cup = cupSnap.data() || {};
  const standings = standingsSnap?.exists ? standingsSnap.data() || {} : {};

  const phase =
    room.worldCupPhase ||
    room.worldCup?.phase ||
    room.worldCup?.requestedPhase ||
    "";

  const pipelineMode = room.globalPipeline?.mode || "";

  console.log("Room:", roomId);
  console.log("Current window:", cup.currentWindowLabel || cup.currentWindowId || "—");
  console.log("World Cup phase:", phase || "—");
  console.log("Global pipeline mode:", pipelineMode || "—");

  const baseTotals =
    Object.keys(normalizeNumberMap(cup.globalBaseTotalsByUid || {})).length
      ? normalizeNumberMap(cup.globalBaseTotalsByUid)
      : Object.keys(normalizeNumberMap(cup.cupTotalsByUid || {})).length
        ? normalizeNumberMap(cup.cupTotalsByUid)
        : Object.keys(normalizeNumberMap(cup.creditedTotalsByUid || {})).length
          ? normalizeNumberMap(cup.creditedTotalsByUid)
          : normalizeNumberMap(cup.projectedTotalsByUid || {});

  const rows = buildRowsFromTotals(baseTotals, [
    cup.projectedStandingsRows,
    cup.standingsRows,
    cup.leaderboard,
    cup.rows,
    standings.projectedStandingsRows,
    standings.standings,
    standings.leaderboard,
    standings.rows,
    standings.standingsRows,
  ]);

  console.log("Preserved cumulative totals:", baseTotals);
  console.log("New current-window points will be cleared to 0 maps.");
  console.log("Projected leaderboard rows:", rows);

  if (!apply) {
    console.log("");
    console.log("DRY RUN ONLY. Nothing was written.");
    console.log(`To apply, run again with --confirm=${CONFIRM_TEXT} --apply`);
    return;
  }

  const nowMs = Date.now();
  const backupRef = db
    .collection(`rooms/${roomId}/adminBackups`)
    .doc(`resetCupCurrentDisplay_${nowMs}`);

  const cupUpdate = {
    creditedTotalsByUid: baseTotals,
    cupTotalsByUid: baseTotals,
    globalBaseTotalsByUid: baseTotals,
    globalBaseAdjustedForCurrentWindow: false,
    removedLegacyWindowPointsByUid: {},

    windowPointsByUid: {},
    windowBenchPointsByUid: {},
    windowBreakdownByUserId: {},
    currentWindowBreakdownByUserId: {},
    breakdownByUserId: {},

    livePointsByUid: {},
    liveBenchPointsByUid: {},
    liveBreakdownByUserId: {},

    globalCurrentWindowPointsByUid: {},
    globalCurrentWindowBenchPointsByUid: {},
    globalCurrentWindowBreakdownByUserId: {},

    creditedFixtures: {},
    creditedCurrentWindowFixtureIds: [],

    projectedTotalsByUid: baseTotals,
    projectedStandingsRows: rows,
    standingsRows: rows,
    leaderboard: rows,
    rows,
    projectedIncludesLivePoints: false,

    resetCurrentWindowDisplayAtMs: nowMs,
    resetCurrentWindowDisplayAt: FieldValue.serverTimestamp(),
    updatedAtMs: nowMs,
    updatedAt: FieldValue.serverTimestamp(),
  };

  const standingsUpdate = {
    roomId,
    mode: "cup",
    source: "one-time-current-window-display-reset",
    projectionOnly: false,
    creditedTotalsByUid: baseTotals,
    globalBaseTotalsByUid: baseTotals,
    projectedTotalsByUid: baseTotals,
    standings: rows,
    projectedStandingsRows: rows,
    leaderboard: rows,
    rows,
    standingsRows: rows,
    resetCurrentWindowDisplayAtMs: nowMs,
    updatedAtMs: nowMs,
    updatedAt: FieldValue.serverTimestamp(),
  };

  await db.runTransaction(async (tx) => {
    tx.set(backupRef, {
      roomId,
      reason: "reset-cup-global-current-window-display",
      cupCurrentBefore: cup,
      standingsBefore: standings,
      createdAtMs: nowMs,
      createdAt: FieldValue.serverTimestamp(),
    });

    tx.set(cupRef, cupUpdate, { merge: true });
    tx.set(standingsRef, standingsUpdate, { merge: true });
  });

  console.log("");
  console.log("DONE.");
  console.log("Backup written to:", backupRef.path);
  console.log("Current-round display fields cleared.");
  console.log("Cumulative leaderboard preserved.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("FAILED:", error);
    process.exit(1);
  });