"use strict";

function createCupGlobalEngine(deps = {}) {
  const {
    FieldValue,
    HttpsError,
    scorePlayer,
    toPos,
    safeId,
    hashToUint32,
    getRoomPhaseLabel,
    deriveRoomSeasonContext,
    getGlobalPipelineMode,
    isGlobalLiveFixtureCacheEnabled,
    isGlobalRoomAggregatorEnabled,
    loadGlobalLiveFixturesForSeason,
    loadGlobalFixtureSummariesForSeason,
    patchGlobalLiveFixturesWithSummaries,
    buildAggregatedGlobalRawStatsByPlayerId,
    loadRoomUsersLineupsForGlobalAggregation,
    hasFixtureStarted,
    isInPlay,
    isFinished,
  } = deps;
  const CUP_GLOBAL_ACTIVE_PRE_MS = 20 * 60 * 1000;
  const CUP_GLOBAL_PREGAME_POLL_MS = 5 * 60 * 1000;
  const CUP_GLOBAL_ACTIVE_POLL_MS = 60 * 1000;
  const CUP_GLOBAL_POST_MS = 3 * 60 * 60 * 1000;

  function coverageStatusShort(coverage = {}) {
    return String(
      coverage?.statusShort ||
        coverage?.fixtureStatus ||
        coverage?.matchStatus ||
        ""
    ).trim().toUpperCase();
  }

  function coverageKickoffMs(coverage = {}) {
    const kickoffMs = Number(coverage?.kickoffMs || coverage?.startAtMs || 0);
    return Number.isFinite(kickoffMs) && kickoffMs > 0 ? kickoffMs : null;
  }

  function isCoverageInActiveWakeWindow(coverage = {}, nowMs = Date.now()) {
    const kickoffMs = coverageKickoffMs(coverage);
    return (
      Number.isFinite(kickoffMs) &&
      nowMs >= kickoffMs - CUP_GLOBAL_ACTIVE_PRE_MS &&
      nowMs <= kickoffMs + CUP_GLOBAL_POST_MS
    );
  }

  function isCoverageStalePastPostTail(coverage = {}, nowMs = Date.now()) {
    const kickoffMs = coverageKickoffMs(coverage);
    return (
      isInPlay(coverageStatusShort(coverage)) &&
      Number.isFinite(kickoffMs) &&
      nowMs > kickoffMs + CUP_GLOBAL_POST_MS
    );
  }

  async function loadLatestCupHistoryWindow({ db, roomId }) {
    let snap = await db
      .collection(`rooms/${roomId}/cupHistory`)
      .orderBy("endAtMs", "desc")
      .limit(1)
      .get()
      .catch(() => null);
  
    if (!snap || snap.empty) {
      snap = await db
        .collection(`rooms/${roomId}/cupHistory`)
        .orderBy("closedAtMs", "desc")
        .limit(1)
        .get()
        .catch(() => null);
    }
  
    if (!snap || snap.empty) return null;
  
    const doc = snap.docs[0];
    return {
      id: doc.id,
      ...(doc.data() || {}),
    };
  }
  
  async function computeGlobalCupShadowResults({ db, roomId, nowMs }) {
    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");
  
    const room = roomSnap.data() || {};
    if (getRoomPhaseLabel(room) !== "Cup") {
      throw new HttpsError("failed-precondition", "Room is not in Cup phase.");
    }
  
    const cupRef = roomRef.collection("cup").doc("current");
    const cupSnap = await cupRef.get();
    const cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
    const currentFixtureIds = [...new Set((Array.isArray(cup?.currentWindowFixtureIds) ? cup.currentWindowFixtureIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))];
  
    let shadowSource = "cup-current";
    let historyWindow = null;
    let fixtureIds = currentFixtureIds;
  
    if (!fixtureIds.length) {
      historyWindow = await loadLatestCupHistoryWindow({ db, roomId });
  
      const historyFixtureIds = Array.isArray(historyWindow?.fixtureIds)
        ? historyWindow.fixtureIds.map((id) => String(id || "").trim()).filter(Boolean)
        : [];
  
      if (historyFixtureIds.length) {
        fixtureIds = [...new Set(historyFixtureIds)];
        shadowSource = "cup-history-latest";
      }
    }
  
    const seasonContext = deriveRoomSeasonContext(room);
    if (!seasonContext?.seasonKey) {
      throw new HttpsError("failed-precondition", "Could not resolve seasonKey for room.");
    }
  
    const compareScope =
      shadowSource === "cup-history-latest" ? "latest-cup-history-window" : "current-cup-window";
  
    if (!fixtureIds.length) {
      const emptyPayload = {
        mode: "cup-shadow-aggregator",
        source: "global-live-fixtures",
        compareScope,
        shadowSource,
        historyId: historyWindow?.historyId || historyWindow?.id || null,
        historyLabel: historyWindow?.label || null,
        historyFixtureCount: Number(historyWindow?.fixtureCount || 0) || null,
        noFixtureIdsReason: "No current or historical Cup fixture IDs found for shadow comparison.",
        roomId,
        seasonKey: seasonContext.seasonKey,
        fixtureIds: [],
        fixtureCount: 0,
        missingFixtureCount: 0,
        userCount: 0,
        globalTotalsByUid: {},
        globalBreakdownByUserId: {},
        globalBenchTotalsByUid: {},
        legacyWindowPointsByUid: {},
        legacyLivePointsByUid: {},
        legacyCurrentWindowTotalsByUid: {},
        legacyCurrentWindowBreakdownByUserId: {},
        diffsByUid: {},
        maxAbsDiff: 0,
        fixtureCoverage: [],
        playerMismatches: [],
        statMismatches: [],
        missingFixtureIds: [],
        missingPlayerIdsByUid: {},
        updatedAtMs: nowMs,
      };
  
      await roomRef.collection("globalShadowResults").doc("cup-current").set(
        { ...emptyPayload, updatedAt: FieldValue.serverTimestamp() },
        { merge: false }
      );
  
      return emptyPayload;
    }
  
    const { liveFixturesById, missingFixtureIds } = await loadGlobalLiveFixturesForSeason({
      db,
      seasonKey: seasonContext.seasonKey,
      fixtureIds,
    });
    const fixtureSummariesById = await loadGlobalFixtureSummariesForSeason({
      db,
      seasonKey: seasonContext.seasonKey,
      fixtureIds,
    });
    const patchedLiveFixturesById = patchGlobalLiveFixturesWithSummaries(
      liveFixturesById,
      fixtureSummariesById
    );
    const cupFixtureMetaById = new Map(
      (Array.isArray(cup?.currentWindowFixtures) ? cup.currentWindowFixtures : [])
        .map((fixture) => [
          String(fixture?.fixtureId || fixture?.id || "").trim(),
          fixture || {},
        ])
        .filter(([fixtureId]) => Boolean(fixtureId))
    );
  
    const fixtureCoverage = fixtureIds.map((fixtureId) => {
      const live = patchedLiveFixturesById[String(fixtureId)] || null;
      const summary = fixtureSummariesById[String(fixtureId)] || null;
      const cupFixture = cupFixtureMetaById.get(String(fixtureId)) || {};
      const fantasyByPlayerId =
        live?.fantasyByPlayerId && typeof live.fantasyByPlayerId === "object"
          ? live.fantasyByPlayerId
          : {};
      const rawStatsByPlayerId =
        live?.rawStatsByPlayerId && typeof live.rawStatsByPlayerId === "object"
          ? live.rawStatsByPlayerId
          : {};
      const rawSample =
        Object.values(rawStatsByPlayerId).find((value) => value && typeof value === "object") || {};
  
      return {
        fixtureId: String(fixtureId),
        hasLivePayload: Boolean(live),
        hasSummary: Boolean(summary),
        statusShort:
          live?.statusShort ||
          summary?.short ||
          summary?.statusShort ||
          cupFixture?.statusShort ||
          cupFixture?.fixtureStatus ||
          cupFixture?.matchStatus ||
          rawSample?.statusShort ||
          rawSample?.fixtureStatus ||
          rawSample?.matchStatus ||
          null,
        statusLong: live?.statusLong || summary?.statusLong || cupFixture?.statusLong || rawSample?.statusLong || null,
        kickoffMs: Number(
          live?.kickoffMs ??
            summary?.kickoffMs ??
            cupFixture?.kickoffMs ??
            cupFixture?.startAtMs ??
            rawSample?.kickoffMs ??
            cup?.currentWindowStartAtMs ??
            0
        ) || null,
        fantasyPlayerCount: Object.keys(fantasyByPlayerId).length,
        rawStatsPlayerCount: Object.keys(rawStatsByPlayerId).length,
      };
    });
  
    const users = await loadRoomUsersLineupsForGlobalAggregation({ db, roomId });
    const globalRawStatsByPlayerId = buildAggregatedGlobalRawStatsByPlayerId(patchedLiveFixturesById);
    const playersById = new Map();
  
    for (const user of users) {
      for (const player of [...(user.starters || []), ...(user.bench || [])]) {
        const pid = String(player?.id ?? player?.playerId ?? player?.apiPlayerId ?? "").trim();
        if (!pid || playersById.has(pid)) continue;
        playersById.set(pid, {
          id: pid,
          name: player?.name || player?.playerName || player?.fullName || "Unknown",
          position: toPos(player?.position || player?.pos || player?.role || "MID"),
          teamName: player?.teamName || "",
          nationality: player?.nationality || "",
        });
      }
    }
  
    const globalTotalsByUid = {};
    const globalBreakdownByUserId = {};
    const globalBenchTotalsByUid = {};
    const missingPlayerIdsByUid = {};
  
    for (const user of users) {
      const uid = String(user.uid);
      const perPlayer = {};
      const startersOut = [];
      const benchOut = [];
      const missing = new Set();
      let starterTotal = 0;
      let benchTotal = 0;
  
      const consumePlayer = (player, counted) => {
        const pid = String(player?.id || "").trim();
        if (!pid) return;
  
        const aggregated = globalRawStatsByPlayerId[pid] || null;
        const rawStats = aggregated?.stats || null;
  
        // IMPORTANT:
        // Score global raw stats using the room/fantasy player position,
        // not API-Football's fixture position.
        const scorePosition = toPos(
          player?.position ||
          playersById.get(pid)?.position ||
          aggregated?.position ||
          rawStats?.position ||
          "MID"
        );
  
        const scored = rawStats
          ? scorePlayer(rawStats, scorePosition)
          : { points: 0, breakdown: {} };
  
        const entry = {
          id: pid,
          name: player?.name || "Unknown",
          position: scorePosition,
          teamName: rawStats?.teamName || aggregated?.teamName || player?.teamName || "",
          nationality: player?.nationality || "",
          opponentName: rawStats?.opponentName || aggregated?.opponentName || "",
          points: Number(scored?.points ?? scored?.total ?? 0),
          breakdown: scored?.breakdown || scored?.parts || scored?.pointsBreakdown || {},
          stats: rawStats || { teamName: player?.teamName || "" },
          counted,
        };
  
        perPlayer[pid] = entry;
  
        if (aggregated) {
          if (counted) starterTotal += entry.points;
          else benchTotal += entry.points;
        } else {
          missing.add(pid);
        }
  
        if (counted) startersOut.push(entry);
        else benchOut.push(entry);
      };
  
      for (const player of Array.isArray(user.starters) ? user.starters : []) {
        consumePlayer(player, true);
      }
  
      for (const player of Array.isArray(user.bench) ? user.bench : []) {
        consumePlayer(player, false);
      }
  
      globalTotalsByUid[uid] = starterTotal;
      globalBenchTotalsByUid[uid] = benchTotal;
      globalBreakdownByUserId[uid] = {
        uid,
        displayName: user.displayName || uid,
        total: starterTotal,
        benchTotal,
        starters: startersOut,
        bench: benchOut,
        perPlayer,
      };
      missingPlayerIdsByUid[uid] = Array.from(missing);
    }
  
    const legacyCupTotalsByUid =
      cup?.cupTotalsByUid && typeof cup.cupTotalsByUid === "object"
        ? cup.cupTotalsByUid
        : {};
  
    const legacyProjectedTotalsByUid =
      cup?.projectedTotalsByUid && typeof cup.projectedTotalsByUid === "object"
        ? cup.projectedTotalsByUid
        : {};
  
    const legacyWindowPointsByUid =
      shadowSource === "cup-history-latest"
        ? (historyWindow?.windowPointsByUid && typeof historyWindow.windowPointsByUid === "object"
            ? historyWindow.windowPointsByUid
            : {})
        : (cup?.windowPointsByUid && typeof cup.windowPointsByUid === "object"
            ? cup.windowPointsByUid
            : {});
  
    const legacyLivePointsByUid =
      shadowSource === "cup-history-latest"
        ? {}
        : (cup?.livePointsByUid && typeof cup.livePointsByUid === "object"
            ? cup.livePointsByUid
            : {});
  
    function mergeCupShadowPerPlayerEntry(prev = {}, next = {}) {
      return {
        id: next.id || prev.id || "",
        name: next.name || prev.name || "Unknown",
        position: next.position || prev.position || "MID",
        points: Number(prev.points || 0) + Number(next.points || 0),
        breakdown: { ...(prev.breakdown || {}), ...(next.breakdown || {}) },
        stats: { ...(prev.stats || {}), ...(next.stats || {}) },
        counted: next.counted ?? prev.counted ?? true,
      };
    }
  
    function mergeCupShadowBreakdownMaps(...maps) {
      const out = {};
  
      for (const map of maps) {
        if (!map || typeof map !== "object") continue;
  
        for (const [uid, incoming] of Object.entries(map)) {
          const prev = out[uid] || { total: 0, benchTotal: 0, perPlayer: {} };
          const mergedPerPlayer = { ...(prev.perPlayer || {}) };
  
          for (const [pid, entry] of Object.entries(incoming?.perPlayer || {})) {
            mergedPerPlayer[String(pid)] = mergeCupShadowPerPlayerEntry(
              mergedPerPlayer[String(pid)] || {},
              entry || {}
            );
          }
  
          out[uid] = {
            total: Number(prev.total || 0) + Number(incoming?.total || 0),
            benchTotal: Number(prev.benchTotal || 0) + Number(incoming?.benchTotal || 0),
            perPlayer: mergedPerPlayer,
          };
        }
      }
  
      return out;
    }
  
    function flattenCupShadowPerPlayer(legacyUserBreakdown = {}) {
      const out = {};
      const directCandidates = [
        legacyUserBreakdown?.perPlayer,
        legacyUserBreakdown?.partsByPlayerId,
        legacyUserBreakdown?.playersById,
      ];
  
      for (const candidate of directCandidates) {
        if (!candidate || typeof candidate !== "object") continue;
        for (const [playerId, value] of Object.entries(candidate)) {
          out[String(playerId)] = value || {};
        }
      }
  
      const addList = (list) => {
        for (const entry of Array.isArray(list) ? list : []) {
          const pid = String(entry?.id ?? entry?.playerId ?? entry?.apiPlayerId ?? "").trim();
          if (!pid || out[pid]) continue;
          out[pid] = entry || {};
        }
      };
  
      addList(legacyUserBreakdown?.starters);
      addList(legacyUserBreakdown?.bench);
  
      return out;
    }
  
    function hasCupShadowMeaningfulStats(value) {
      if (!value || typeof value !== "object") return false;
      return Object.entries(value).some(([key, val]) => {
        if (["teamName", "opponentName", "fixtureId", "fixtureIds"].includes(key)) return false;
        return val !== undefined && val !== null && val !== "" && val !== 0 && val !== false;
      });
    }
  
    const creditedBreakdownCandidates =
      shadowSource === "cup-history-latest"
        ? [historyWindow?.breakdownByUserId]
        : [
            cup?.windowBreakdownByUserId,
            cup?.currentWindowBreakdownByUserId,
            cup?.breakdownByUserId,
          ];
    const liveBreakdownForCompare =
      shadowSource === "cup-history-latest"
        ? {}
        : (cup?.liveBreakdownByUserId || {});
    const creditedCurrentWindowBreakdownByUserId =
      creditedBreakdownCandidates.find(
        (candidate) => candidate && typeof candidate === "object" && Object.keys(candidate).length
      ) || {};
    const legacyCurrentWindowBreakdownByUserId = mergeCupShadowBreakdownMaps(
      creditedCurrentWindowBreakdownByUserId,
      liveBreakdownForCompare
    );
  
    // Shadow comparison should be current window vs current window.
    // Global reads cup.currentWindowFixtureIds, so compare it against
    // legacy windowPointsByUid + livePointsByUid, not full Cup totals.
    const legacyCurrentWindowTotalsByUid = {};
    const legacyTotalUsedByUid = {};
    const legacyCompareSourceByUid = {};
    const diffsByUid = {};
  
    const allUids = new Set([
      ...Object.keys(globalTotalsByUid || {}),
      ...Object.keys(legacyWindowPointsByUid || {}),
      ...Object.keys(legacyLivePointsByUid || {}),
      ...Object.keys(legacyCurrentWindowBreakdownByUserId || {}),
    ]);
  
    for (const uid of allUids) {
      const legacyTotal =
        Number(legacyWindowPointsByUid[uid] || 0) +
        Number(legacyLivePointsByUid[uid] || 0);
  
      legacyCurrentWindowTotalsByUid[uid] = legacyTotal;
      legacyTotalUsedByUid[uid] = legacyTotal;
      legacyCompareSourceByUid[uid] =
        shadowSource === "cup-history-latest"
          ? "historyWindowPointsByUid"
          : "windowPointsByUid+livePointsByUid";
  
      diffsByUid[uid] = Number(globalTotalsByUid[uid] || 0) - legacyTotal;
    }
  
    const playerMismatches = [];
    const statMismatches = [];
  
    for (const uid of allUids) {
      const legacyPerPlayer = flattenCupShadowPerPlayer(
        legacyCurrentWindowBreakdownByUserId?.[uid] || {}
      );
      const globalPerPlayer =
        globalBreakdownByUserId?.[uid]?.perPlayer &&
        typeof globalBreakdownByUserId[uid].perPlayer === "object"
          ? globalBreakdownByUserId[uid].perPlayer
          : {};
      const playerIds = new Set([
        ...Object.keys(legacyPerPlayer),
        ...Object.keys(globalPerPlayer),
      ]);
  
      for (const playerId of playerIds) {
        const legacyEntry = legacyPerPlayer[playerId] || {};
        const globalEntry = globalPerPlayer[playerId] || {};
        const legacyPoints = Number(legacyEntry.points ?? legacyEntry.total ?? legacyEntry.fantasyPoints ?? 0);
        const globalPoints = Number(globalEntry.points ?? 0);
        const diff = globalPoints - legacyPoints;
        const legacyStats = legacyEntry.stats || {};
        const globalStats = globalEntry.stats || {};
        const legacyHasStats = hasCupShadowMeaningfulStats(legacyStats);
        const globalHasStats = hasCupShadowMeaningfulStats(globalStats);
  
        if (diff !== 0 || legacyHasStats !== globalHasStats) {
          playerMismatches.push({
            uid,
            playerId,
            name: globalEntry.name || legacyEntry.name || "Unknown",
            legacyPoints,
            globalPoints,
            diff,
            legacyBreakdown: legacyEntry.breakdown || {},
            globalBreakdown: globalEntry.breakdown || {},
            legacyStats,
            globalStats,
          });
        }
  
        if (legacyHasStats !== globalHasStats) {
          statMismatches.push({
            uid,
            playerId,
            name: globalEntry.name || legacyEntry.name || "Unknown",
            legacyHasStats,
            globalHasStats,
          });
        }
      }
    }
  
    const diffValues = Object.values(diffsByUid || {}).map((value) => Math.abs(Number(value || 0)));
    const maxAbsDiff = diffValues.length ? Math.max(...diffValues) : 0;
  
    const payload = {
      mode: "cup-shadow-aggregator",
      source: "global-live-fixtures",
      compareScope,
      shadowSource,
      historyId: historyWindow?.historyId || historyWindow?.id || null,
      historyLabel: historyWindow?.label || null,
      historyFixtureCount: Number(historyWindow?.fixtureCount || 0) || null,
      noFixtureIdsReason: fixtureIds.length
        ? null
        : "No current or historical Cup fixture IDs found for shadow comparison.",
  
      roomId,
      seasonKey: seasonContext.seasonKey,
      fixtureIds,
      fixtureCount: fixtureIds.length,
      missingFixtureCount: missingFixtureIds.length,
      userCount: users.length,
  
      globalTotalsByUid,
      globalBreakdownByUserId,
      globalBenchTotalsByUid,
  
      // Kept for debugging full Cup state
      legacyCupTotalsByUid,
      legacyProjectedTotalsByUid,
  
      // Used for the actual shadow diff
      legacyWindowPointsByUid,
      legacyLivePointsByUid,
      legacyCurrentWindowTotalsByUid,
      legacyCurrentWindowBreakdownByUserId,
  
      diffsByUid,
      maxAbsDiff,
      fixtureCoverage,
      playerMismatches,
      statMismatches,
      missingFixtureIds,
      missingPlayerIdsByUid,
  
      updatedAtMs: nowMs,
  
      legacyTotalUsedByUid,
      legacyCompareSourceByUid,
    };
  
    await roomRef.collection("globalShadowResults").doc("cup-current").set(
      {
        ...payload,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: false }
    );
  
    return payload;
  }
  
  function buildCupGlobalWriteRehearsalPayload(shadowResult = {}, nowMs = Date.now()) {
    const globalTotalsByUid =
      shadowResult?.globalTotalsByUid && typeof shadowResult.globalTotalsByUid === "object"
        ? shadowResult.globalTotalsByUid
        : {};
  
    const globalBreakdownByUserId =
      shadowResult?.globalBreakdownByUserId && typeof shadowResult.globalBreakdownByUserId === "object"
        ? shadowResult.globalBreakdownByUserId
        : {};
  
    const projectedStandingsRows = Object.entries(globalTotalsByUid)
      .map(([uid, total]) => {
        const breakdown = globalBreakdownByUserId[uid] || {};
        const name =
          breakdown.displayName ||
          breakdown.name ||
          uid;
  
        return {
          userId: uid,
          uid,
          name,
          totalFantasyPoints: Number(total || 0),
        };
      })
      .sort((a, b) => Number(b.totalFantasyPoints || 0) - Number(a.totalFantasyPoints || 0))
      .map((row, index) => ({
        ...row,
        rank: index + 1,
      }));
  
    return {
      roomId: shadowResult.roomId || "",
      seasonKey: shadowResult.seasonKey || "",
      source: "global-live-fixtures",
      mode: "cup-global-write-rehearsal",
  
      shadowSource: shadowResult.shadowSource || "",
      compareScope: shadowResult.compareScope || "",
      historyId: shadowResult.historyId || null,
      historyLabel: shadowResult.historyLabel || null,
      historyFixtureCount: shadowResult.historyFixtureCount || null,
  
      fixtureIds: shadowResult.fixtureIds || [],
      fixtureCount: Number(shadowResult.fixtureCount || 0),
      fixtureCoverage: shadowResult.fixtureCoverage || [],
  
      projectedWindowTotalsByUid: globalTotalsByUid,
      projectedBenchTotalsByUid: shadowResult.globalBenchTotalsByUid || {},
      projectedBreakdownByUserId: globalBreakdownByUserId,
      projectedStandingsRows,
  
      maxAbsDiff: Number(shadowResult.maxAbsDiff || 0),
      missingFixtureCount: Number(shadowResult.missingFixtureCount || 0),
      playerMismatchCount: Array.isArray(shadowResult.playerMismatches)
        ? shadowResult.playerMismatches.length
        : 0,
      statMismatchCount: Array.isArray(shadowResult.statMismatches)
        ? shadowResult.statMismatches.length
        : 0,
  
      builtAtMs: nowMs,
    };
  }
  
  async function computeCupCurrentWindowFromGlobalCache({
    db,
    roomId,
    nowMs = Date.now(),
    writeMode = "shadow",
    dryRun = true,
  }) {
    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");
  
    const room = roomSnap.data() || {};
    if (getRoomPhaseLabel(room) !== "Cup") {
      throw new HttpsError("failed-precondition", "Room is not in Cup phase.");
    }
  
    const cupRef = roomRef.collection("cup").doc("current");
    const cupSnap = await cupRef.get();
    const cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
    const fixtureIds = [...new Set((Array.isArray(cup?.currentWindowFixtureIds) ? cup.currentWindowFixtureIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))];
  
    if (!fixtureIds.length) {
      throw new HttpsError(
        "failed-precondition",
        "Cup global apply requires an active current Cup window. Completed cupHistory fallback is shadow/rehearsal only."
      );
    }
  
    const seasonContext = deriveRoomSeasonContext(room);
    if (!seasonContext?.seasonKey) {
      throw new HttpsError("failed-precondition", "Could not resolve seasonKey for room.");
    }
  
    const realWriteRequested = writeMode === "global" && dryRun === false;
    const pipelineMode = getGlobalPipelineMode(room);
    const liveFixtureCacheEnabled =
      isGlobalLiveFixtureCacheEnabled(room) ||
      pipelineMode === "global";
  
    if (realWriteRequested) {
      if (pipelineMode !== "global" || !isGlobalRoomAggregatorEnabled(room)) {
        throw new HttpsError(
          "failed-precondition",
          "Cup global apply requires globalPipeline.mode='global' and roomAggregator=true."
        );
      }
  
      if (!liveFixtureCacheEnabled) {
        throw new HttpsError(
          "failed-precondition",
          "Cup global apply requires global live fixture cache to be enabled."
        );
      }
    }
  
    const { liveFixturesById, missingFixtureIds } = await loadGlobalLiveFixturesForSeason({
      db,
      seasonKey: seasonContext.seasonKey,
      fixtureIds,
    });
    const fixtureSummariesById = await loadGlobalFixtureSummariesForSeason({
      db,
      seasonKey: seasonContext.seasonKey,
      fixtureIds,
    });
    const patchedLiveFixturesById = patchGlobalLiveFixturesWithSummaries(
      liveFixturesById,
      fixtureSummariesById
    );
    const cupFixtureMetaById = new Map(
      (Array.isArray(cup?.currentWindowFixtures) ? cup.currentWindowFixtures : [])
        .map((fixture) => [
          String(fixture?.fixtureId || fixture?.id || "").trim(),
          fixture || {},
        ])
        .filter(([fixtureId]) => Boolean(fixtureId))
    );
  
    const fixtureCoverage = fixtureIds.map((fixtureId) => {
      const live = patchedLiveFixturesById[String(fixtureId)] || null;
      const summary = fixtureSummariesById[String(fixtureId)] || null;
      const cupFixture = cupFixtureMetaById.get(String(fixtureId)) || {};
      const fantasyByPlayerId =
        live?.fantasyByPlayerId && typeof live.fantasyByPlayerId === "object"
          ? live.fantasyByPlayerId
          : {};
      const rawStatsByPlayerId =
        live?.rawStatsByPlayerId && typeof live.rawStatsByPlayerId === "object"
          ? live.rawStatsByPlayerId
          : {};
      const rawSample =
        Object.values(rawStatsByPlayerId).find((value) => value && typeof value === "object") || {};
      const statusShort =
        live?.statusShort ||
        summary?.short ||
        summary?.statusShort ||
        cupFixture?.statusShort ||
        cupFixture?.fixtureStatus ||
        cupFixture?.matchStatus ||
        rawSample?.statusShort ||
        rawSample?.fixtureStatus ||
        rawSample?.matchStatus ||
        null;
  
      return {
        fixtureId: String(fixtureId),
        hasLivePayload: Boolean(live),
        hasSummary: Boolean(summary),
        statusShort,
        statusLong: live?.statusLong || summary?.statusLong || rawSample?.statusLong || null,
        kickoffMs: Number(
          live?.kickoffMs ??
            summary?.kickoffMs ??
            cupFixture?.kickoffMs ??
            cupFixture?.startAtMs ??
            rawSample?.kickoffMs ??
            cup?.currentWindowStartAtMs ??
            0
        ) || null,
        fantasyPlayerCount: Object.keys(fantasyByPlayerId).length,
        rawStatsPlayerCount: Object.keys(rawStatsByPlayerId).length,
      };
    });
  
    const hasStartedFixture = fixtureCoverage.some((coverage) => {
      const kickoffMs = coverageKickoffMs(coverage);
      return (
        hasFixtureStarted(coverage.statusShort) ||
        (kickoffMs != null && Number.isFinite(kickoffMs) && kickoffMs <= nowMs)
      );
    });
    const anyInPlay = fixtureCoverage.some((coverage) =>
      isInPlay(coverage.statusShort) && !isCoverageStalePastPostTail(coverage, nowMs)
    );
    const allFinished = fixtureIds.length > 0 && fixtureCoverage.every((coverage) =>
      isFinished(coverage.statusShort) || isCoverageStalePastPostTail(coverage, nowMs)
    );
    const statusValue = allFinished ? "final" : anyInPlay ? "live" : "idle";
    const nextKickoffMs = fixtureCoverage
      .map((coverage) => Number(coverage.kickoffMs || 0))
      .filter((kickoffMs) => Number.isFinite(kickoffMs) && kickoffMs > nowMs)
      .sort((a, b) => a - b)[0] || null;
    const inActiveWakeWindow = fixtureCoverage.some((coverage) =>
      isCoverageInActiveWakeWindow(coverage, nowMs)
    );
  
    if (!hasStartedFixture && !allFinished) {
      let skippedReason = "cup-window-not-due";
      let nextPollAtMs = nowMs + 60 * 60 * 1000;

      if (nextKickoffMs) {
        if (nowMs < nextKickoffMs - CUP_GLOBAL_ACTIVE_PRE_MS) {
          nextPollAtMs = nextKickoffMs - CUP_GLOBAL_ACTIVE_PRE_MS;
        } else if (nowMs < nextKickoffMs) {
          nextPollAtMs = Math.min(nowMs + CUP_GLOBAL_PREGAME_POLL_MS, nextKickoffMs);
          skippedReason = "cup-window-pregame-5min-check";
        }
      }

      return {
        realWriteApplied: false,
        writeMode,
        dryRun,
        mode: "cup-global-current-window-apply",
        roomId,
        seasonKey: seasonContext.seasonKey,
        source: "global-live-fixtures",
        skippedReason,
        fixtureIds,
        fixtureCount: fixtureIds.length,
        missingFixtureCount: missingFixtureIds.length,
        statusValue,
        allFinished,
        anyInPlay,
        nextKickoffMs,
        nextPollAtMs,
        globalTotalsByUid: {},
        globalBenchTotalsByUid: {},
        globalBreakdownByUserId: {},
        projectedTotalsByUid: {},
        projectedStandingsRows: [],
        fixtureStatusById: Object.fromEntries(
          fixtureCoverage.map((coverage) => [String(coverage.fixtureId), coverage.statusShort || null])
        ),
        fixtureCoverage,
        missingFixtureIds,
        missingPlayerIdsByUid: {},
        updatedAtMs: nowMs,
      };
    }

    if (realWriteRequested && missingFixtureIds.length > 0) {
      throw new HttpsError(
        "failed-precondition",
        "Cannot apply Cup global result while global fixture cache is missing fixtures."
      );
    }
    const nextPollAtMs =
      !allFinished && hasStartedFixture
        ? nowMs + CUP_GLOBAL_ACTIVE_POLL_MS
        : null;
  
    const users = await loadRoomUsersLineupsForGlobalAggregation({ db, roomId });
    const globalRawStatsByPlayerId = buildAggregatedGlobalRawStatsByPlayerId(patchedLiveFixturesById);
    const playersById = new Map();
  
    for (const user of users) {
      for (const player of [...(user.starters || []), ...(user.bench || [])]) {
        const pid = String(player?.id ?? player?.playerId ?? player?.apiPlayerId ?? "").trim();
        if (!pid || playersById.has(pid)) continue;
        playersById.set(pid, {
          id: pid,
          name: player?.name || player?.playerName || player?.fullName || "Unknown",
          position: toPos(player?.position || player?.pos || player?.role || "MID"),
          teamName: player?.teamName || "",
          nationality: player?.nationality || "",
        });
      }
    }
  
    const globalTotalsByUid = {};
    const globalBreakdownByUserId = {};
    const globalBenchTotalsByUid = {};
    const missingPlayerIdsByUid = {};
  
    for (const user of users) {
      const uid = String(user.uid);
      const perPlayer = {};
      const startersOut = [];
      const benchOut = [];
      const missing = new Set();
      let starterTotal = 0;
      let benchTotal = 0;
  
      const consumePlayer = (player, counted) => {
        const pid = String(player?.id || "").trim();
        if (!pid) return;
  
        const aggregated = globalRawStatsByPlayerId[pid] || null;
        const rawStats = aggregated?.stats || null;
        const scorePosition = toPos(
          player?.position ||
          playersById.get(pid)?.position ||
          aggregated?.position ||
          rawStats?.position ||
          "MID"
        );
        const scored = rawStats
          ? scorePlayer(rawStats, scorePosition)
          : { points: 0, breakdown: {} };
        const entry = {
          id: pid,
          name: player?.name || "Unknown",
          position: scorePosition,
          teamName: rawStats?.teamName || aggregated?.teamName || player?.teamName || "",
          nationality: player?.nationality || "",
          opponentName: rawStats?.opponentName || aggregated?.opponentName || "",
          points: Number(scored?.points ?? scored?.total ?? 0),
          breakdown: scored?.breakdown || scored?.parts || scored?.pointsBreakdown || {},
          stats: rawStats || { teamName: player?.teamName || "" },
          counted,
        };
  
        perPlayer[pid] = entry;
  
        if (aggregated) {
          if (counted) starterTotal += entry.points;
          else benchTotal += entry.points;
        } else {
          missing.add(pid);
        }
  
        if (counted) startersOut.push(entry);
        else benchOut.push(entry);
      };
  
      for (const player of Array.isArray(user.starters) ? user.starters : []) {
        consumePlayer(player, true);
      }
  
      for (const player of Array.isArray(user.bench) ? user.bench : []) {
        consumePlayer(player, false);
      }
  
      globalTotalsByUid[uid] = starterTotal;
      globalBenchTotalsByUid[uid] = benchTotal;
      globalBreakdownByUserId[uid] = {
        uid,
        displayName: user.displayName || uid,
        teamName: user.teamName || "",
        total: starterTotal,
        benchTotal,
        starters: startersOut,
        bench: benchOut,
        perPlayer,
      };
      missingPlayerIdsByUid[uid] = Array.from(missing);
    }
  
    const fixtureStatusById = {};
    for (const coverage of fixtureCoverage) {
      fixtureStatusById[String(coverage.fixtureId)] = coverage.statusShort || null;
    }
  
    const replayBaselineTotalsByUid =
      cup?.replayTestMode === true &&
      cup?.replayBaselineTotalsByUid &&
      typeof cup.replayBaselineTotalsByUid === "object"
        ? cup.replayBaselineTotalsByUid
        : null;
    const existingCupTotalsByUid =
      replayBaselineTotalsByUid ||
      (cup?.cupTotalsByUid && typeof cup.cupTotalsByUid === "object"
        ? cup.cupTotalsByUid
        : {});
    const projectedTotalsByUid = { ...existingCupTotalsByUid };
  
    for (const [uid, total] of Object.entries(globalTotalsByUid)) {
      projectedTotalsByUid[uid] =
        Number(projectedTotalsByUid[uid] || 0) + Number(total || 0);
    }
  
    const displayNameByUid = new Map();
    for (const user of users) {
      displayNameByUid.set(String(user.uid), user.displayName || String(user.uid));
    }
  
    const projectedStandingsRows = Object.entries(projectedTotalsByUid)
      .map(([uid, total]) => {
        const breakdown = globalBreakdownByUserId[uid] || {};
        const name =
          breakdown.displayName ||
          displayNameByUid.get(uid) ||
          uid;
  
        return {
          userId: uid,
          uid,
          name,
          totalFantasyPoints: Number(total || 0),
        };
      })
      .sort((a, b) => Number(b.totalFantasyPoints || 0) - Number(a.totalFantasyPoints || 0))
      .map((row, index) => ({
        ...row,
        rank: index + 1,
      }));
  
    const auditPayload = {
      realWriteApplied: false,
      writeMode,
      dryRun,
      mode: "cup-global-current-window-apply",
      roomId,
      seasonKey: seasonContext.seasonKey,
      source: "global-live-fixtures",
      replayTestMode: cup?.replayTestMode === true,
      replaySource: cup?.replaySource || null,
      replayHistoryId: cup?.replayHistoryId || null,
      replayHistoryLabel: cup?.replayHistoryLabel || null,
      fixtureIds,
      fixtureCount: fixtureIds.length,
      missingFixtureCount: missingFixtureIds.length,
      statusValue,
      allFinished,
      anyInPlay,
      nextKickoffMs,
      nextPollAtMs,
      globalTotalsByUid,
      globalBenchTotalsByUid,
      globalBreakdownByUserId,
      projectedTotalsByUid,
      projectedStandingsRows,
      fixtureStatusById,
      fixtureCoverage,
      missingFixtureIds,
      missingPlayerIdsByUid,
      updatedAtMs: nowMs,
    };
  
    if (realWriteRequested) {
      const projectedIncludesLivePoints = Object.values(globalTotalsByUid || {})
        .some((v) => Number(v || 0) !== 0);
      const cupUpdate = {
        roomId,
        status: statusValue,
        source: "global-live-fixtures",
        currentWindowFixtureIds: fixtureIds,
        fixtureStatusById,
        fixtureCoverage,
  
        globalCurrentWindowPointsByUid: globalTotalsByUid,
        globalCurrentWindowBenchPointsByUid: globalBenchTotalsByUid,
        globalCurrentWindowBreakdownByUserId: globalBreakdownByUserId,
  
        livePointsByUid: globalTotalsByUid,
        liveBenchPointsByUid: globalBenchTotalsByUid,
        liveBreakdownByUserId: globalBreakdownByUserId,
  
        projectedTotalsByUid,
        projectedStandingsRows,
        projectedIncludesLivePoints,
        projectedUpdatedAtMs: nowMs,
  
        globalApplyStatus: statusValue,
        globalApplyMode: "projection-only",
        globalApplyWarning: allFinished
          ? "Final window is finished; this projection did not write cupHistory or finalResults."
          : "",
  
        updatedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      };
  
      await cupRef.set(cupUpdate, { merge: true });
  
      await roomRef.collection("standings").doc("current").set(
        {
          roomId,
          mode: "cup",
          source: "global-live-fixtures",
          projectionOnly: true,
          creditedTotalsByUid: existingCupTotalsByUid,
          projectedTotalsByUid,
          livePointsByUid: globalTotalsByUid,
          includesLivePoints: projectedIncludesLivePoints,
          standings: projectedStandingsRows,
          updatedAtMs: nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  
      auditPayload.realWriteApplied = true;
    }
  
    await roomRef.collection("globalShadowResults").doc("cup-apply-current-window").set(
      {
        ...auditPayload,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: false }
    );
  
    return auditPayload;
  }
  
  function buildCupGlobalFinalizationPayload({
    roomId,
    room = {},
    cup = {},
    applyResult = {},
    nowMs = Date.now(),
  }) {
    const fixtureCount = Number(applyResult?.fixtureCount || 0);
    const missingFixtureCount = Number(applyResult?.missingFixtureCount || 0);
    const statusValue = String(applyResult?.statusValue || "").toLowerCase();
  
    if (fixtureCount <= 0) {
      throw new HttpsError("failed-precondition", "Cup global finalization requires fixtures.");
    }
  
    if (missingFixtureCount !== 0) {
      throw new HttpsError("failed-precondition", "Cup global finalization requires no missing fixtures.");
    }
  
    if (applyResult?.allFinished !== true || statusValue !== "final") {
      throw new HttpsError("failed-precondition", "Cup global finalization requires a final window.");
    }
  
    const fixtureIds = [...new Set((Array.isArray(applyResult?.fixtureIds) ? applyResult.fixtureIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))];
    const fixtureKey = fixtureIds.map(String).sort().join("_");
    const windowLabel =
      cup?.currentWindowLabel ||
      cup?.replayHistoryLabel ||
      applyResult?.replayHistoryLabel ||
      "Cup Window";
    const labelKey = safeId(windowLabel) || "cup-window";
    const windowKey = `cup-global-${labelKey}-${hashToUint32(`${roomId}:${fixtureKey}`)}`;
    const historyDocId = `global-${windowKey}`;
    const windowPointsByUid =
      applyResult?.globalTotalsByUid && typeof applyResult.globalTotalsByUid === "object"
        ? applyResult.globalTotalsByUid
        : {};
    const windowBenchPointsByUid =
      applyResult?.globalBenchTotalsByUid && typeof applyResult.globalBenchTotalsByUid === "object"
        ? applyResult.globalBenchTotalsByUid
        : {};
    const windowBreakdownByUserId =
      applyResult?.globalBreakdownByUserId && typeof applyResult.globalBreakdownByUserId === "object"
        ? applyResult.globalBreakdownByUserId
        : {};
    const replayBaselineTotalsByUid =
      cup?.replayTestMode === true &&
      cup?.replayBaselineTotalsByUid &&
      typeof cup.replayBaselineTotalsByUid === "object"
        ? cup.replayBaselineTotalsByUid
        : null;
    const previousCupTotalsByUid =
      replayBaselineTotalsByUid ||
      (cup?.cupTotalsByUid && typeof cup.cupTotalsByUid === "object"
        ? cup.cupTotalsByUid
        : {});
    const nextCupTotalsByUid = {};
  
    for (const [uid, total] of Object.entries(previousCupTotalsByUid)) {
      nextCupTotalsByUid[String(uid)] = Number(total || 0);
    }
  
    for (const [uid, total] of Object.entries(windowPointsByUid)) {
      const key = String(uid);
      nextCupTotalsByUid[key] = Number(nextCupTotalsByUid[key] || 0) + Number(total || 0);
    }
  
    const standingsRows = Object.entries(nextCupTotalsByUid)
      .map(([uid, total]) => {
        const breakdown = windowBreakdownByUserId[uid] || {};
        const displayName =
          breakdown.displayName ||
          breakdown.name ||
          uid;
  
        return {
          rank: 0,
          uid,
          userId: uid,
          name: displayName,
          displayName,
          teamName: breakdown.teamName || "",
          totalFantasyPoints: Number(total || 0),
        };
      })
      .sort((a, b) => Number(b.totalFantasyPoints || 0) - Number(a.totalFantasyPoints || 0))
      .map((row, index) => ({
        ...row,
        rank: index + 1,
      }));
    const top3 = standingsRows.slice(0, 3);
    const historyPayload = {
      roomId,
      mode: "cup-global-finalized-window",
      source: "global-live-fixtures",
      windowKey,
      label: windowLabel,
      roundLabel: windowLabel || null,
      fixtureIds,
      fixtures: Array.isArray(cup?.currentWindowFixtures) ? cup.currentWindowFixtures : [],
      fixtureCoverage: applyResult?.fixtureCoverage || [],
      fixtureStatusById: applyResult?.fixtureStatusById || {},
      windowPointsByUid,
      windowBenchPointsByUid,
      breakdownByUserId: windowBreakdownByUserId,
      previousCupTotalsByUid,
      cupTotalsByUid: nextCupTotalsByUid,
      standingsRows,
      top3,
      startAtMs: cup?.currentWindowStartAtMs || null,
      endAtMs: cup?.currentWindowEndAtMs || null,
      finalizedAtMs: nowMs,
      finalizedAt: FieldValue.serverTimestamp(),
    };
  
    return {
      roomId,
      room,
      cup,
      windowKey,
      historyDocId,
      label: windowLabel,
      fixtureIds,
      fixtureCount,
      statusValue,
      allFinished: true,
      windowPointsByUid,
      windowBenchPointsByUid,
      windowBreakdownByUserId,
      previousCupTotalsByUid,
      nextCupTotalsByUid,
      standingsRows,
      top3,
      historyPayload,
    };
  }
  
  function isCupFinalWindowLabel(label = "") {
    const value = String(label || "").toLowerCase();
    return value.includes("final") && !value.includes("semi");
  }
  
  async function finalizeCupGlobalCurrentWindow({
    db,
    roomId,
    room = {},
    cup = {},
    applyResult = {},
    nowMs = Date.now(),
  }) {
    if (cup?.replayTestMode === true) {
      throw new HttpsError(
        "failed-precondition",
        "Real Cup global finalization is blocked in replayTestMode. Use rehearsal for replay testing."
      );
    }
  
    const payload = buildCupGlobalFinalizationPayload({
      roomId,
      room,
      cup,
      applyResult,
      nowMs,
    });
    const finalizedKeys = Array.isArray(cup?.finalizedGlobalWindowKeys)
      ? cup.finalizedGlobalWindowKeys.map((key) => String(key))
      : [];
  
    if (finalizedKeys.includes(payload.windowKey)) {
      throw new HttpsError("failed-precondition", "Cup global window already finalized.");
    }
  
    const historyPath = `rooms/${roomId}/cupHistory/${payload.historyDocId}`;
    const historyRef = db.doc(historyPath);
    const historySnap = await historyRef.get();
    if (historySnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Cup history doc already exists for this global window."
      );
    }
  
    const cupCurrentPath = `rooms/${roomId}/cup/current`;
    const standingsPath = `rooms/${roomId}/standings/current`;
    const finalResultsPath = `rooms/${roomId}/finalResults/current`;
    const wroteFinalResults = isCupFinalWindowLabel(payload.label);
  
    await historyRef.set(payload.historyPayload, { merge: false });
  
    await db.doc(cupCurrentPath).set(
      {
        status: "final",
        source: "global-live-fixtures",
        cupTotalsByUid: payload.nextCupTotalsByUid,
        windowPointsByUid: payload.windowPointsByUid,
        windowBenchPointsByUid: payload.windowBenchPointsByUid,
        windowBreakdownByUserId: payload.windowBreakdownByUserId,
        finalizedGlobalWindowKeys: FieldValue.arrayUnion(payload.windowKey),
        lastFinalizedGlobalWindowKey: payload.windowKey,
        globalFinalizedAtMs: nowMs,
        updatedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  
    await db.doc(standingsPath).set(
      {
        roomId,
        mode: "cup",
        source: "global-live-fixtures",
        projectionOnly: false,
        finalizedByGlobal: true,
        finalizedWindowKey: payload.windowKey,
        standings: payload.standingsRows,
        updatedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: false }
    );
  
    if (wroteFinalResults) {
      await db.doc(finalResultsPath).set(
        {
          roomId,
          source: "global-live-fixtures",
          finalizedByGlobal: true,
          championUserId: payload.top3[0]?.userId || null,
          top3: payload.top3,
          standingsSnapshot: payload.standingsRows,
          computedAtMs: nowMs,
          computedAt: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );
    }
  
    return {
      ...payload,
      finalizedUserCount: payload.standingsRows.length,
      wroteFinalResults,
      historyPath,
      cupCurrentPath,
      standingsPath,
      finalResultsPath: wroteFinalResults ? finalResultsPath : null,
    };
  }

  function isCupGlobalAutoApplyEnabled(room = {}) {
    return (
      getGlobalPipelineMode(room) === "global" &&
      isGlobalRoomAggregatorEnabled(room) === true &&
      (
        room?.globalPipeline?.cupGlobalAutoApply === true ||
        room?.globalPipeline?.cupAggregator === true ||
        room?.globalPipeline?.cupGlobalCurrentWindowApply === true
      )
    );
  }

  function isCupGlobalFinalizationEnabled(room = {}) {
    return (
      isCupGlobalAutoApplyEnabled(room) === true &&
      room?.globalPipeline?.cupGlobalFinalize === true
    );
  }
  
  return {
    loadLatestCupHistoryWindow,
    computeGlobalCupShadowResults,
    buildCupGlobalWriteRehearsalPayload,
    computeCupCurrentWindowFromGlobalCache,
    buildCupGlobalFinalizationPayload,
    finalizeCupGlobalCurrentWindow,
    isCupGlobalAutoApplyEnabled,
    isCupGlobalFinalizationEnabled,
  };
}

module.exports = {
  createCupGlobalEngine,
};
