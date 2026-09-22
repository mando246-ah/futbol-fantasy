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
    getSeasonFixturesCollectionRef,
    pickCupWindow,
    setCompetitionState,
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
  const CUP_GLOBAL_RETRY_MS = 60 * 60 * 1000;
  const WORLD_CUP_KNOCKOUT_ROUND_COUNTS = {
    "round-of-32": 16,
    "round-of-16": 8,
    "quarter-final": 4,
    "semi-final": 2,
    "third-place": 1,
    final: 1,
  };

  function isWorldCupKnockoutRoom(room = {}) {
    const competitionKey = String(room?.competitionKey || "").toLowerCase();
    const competitionName = String(
      room?.competitionMeta?.name || room?.competition?.name || ""
    ).toLowerCase();
    const phase = String(
      room?.worldCupPhase ||
        room?.worldCup?.phase ||
        room?.worldCup?.requestedPhase ||
        ""
    ).toLowerCase();

    return (
      phase === "knockout" &&
      (
        competitionKey.includes("worldcup") ||
        competitionKey.includes("world-cup") ||
        (competitionName.includes("world cup") && !competitionName.includes("club world cup"))
      )
    );
  }

  function canonicalWorldCupKnockoutRoundKey(label = "") {
    const value = String(label || "").toLowerCase().trim();
    if (!value) return null;
    if (
      value.includes("club world cup") ||
      value.includes("group stage") ||
      /\bgroup\s+[a-z0-9]+\b/.test(value) ||
      value.includes("qualification") ||
      value.includes("qualifying")
    ) {
      return null;
    }

    const normalized = value
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ");

    if (normalized.includes("round of 32")) return "round-of-32";
    if (
      normalized.includes("16th finals") ||
      normalized.includes("16th final") ||
      normalized.includes("round of 16") ||
      normalized.includes("8th finals") ||
      normalized.includes("8th final") ||
      normalized.includes("eighth finals") ||
      normalized.includes("eighth final")
    ) {
      return "round-of-16";
    }
    if (
      normalized.includes("quarter-finals") ||
      normalized.includes("quarter-final") ||
      normalized.includes("quarter finals") ||
      normalized.includes("quarter final") ||
      normalized.includes("quarterfinal")
    ) {
      return "quarter-final";
    }
    if (
      normalized.includes("semi-finals") ||
      normalized.includes("semi-final") ||
      normalized.includes("semi finals") ||
      normalized.includes("semi final") ||
      normalized.includes("semifinal")
    ) {
      return "semi-final";
    }
    if (
      normalized.includes("third place") ||
      normalized.includes("3rd place")
    ) {
      return "third-place";
    }
    if (
      normalized === "final" ||
      normalized.startsWith("final ") ||
      normalized.endsWith(" final")
    ) {
      return "final";
    }

    return null;
  }

  function isWorldCupKnockoutRoundLabel(label = "") {
    return Boolean(canonicalWorldCupKnockoutRoundKey(label));
  }

  function worldCupKnockoutExpectedFixtureCount(roundKey = "") {
    return WORLD_CUP_KNOCKOUT_ROUND_COUNTS[String(roundKey || "")] || null;
  }

  function cupFixtureIdFromAny(value = {}) {
    return String(
      value?.fixtureId ||
        value?.id ||
        value?.fixture?.id ||
        ""
    ).trim();
  }

  function cupFixtureRoundLabel(value = {}) {
    return firstText(
      value?.roundLabel,
      value?.leagueRound,
      value?.round,
      value?.league?.round,
      value?.fixture?.round
    );
  }

  function getCupCurrentWindowRoundKey(cup = {}, applyResult = {}) {
    const labels = [
      cup?.currentWindowLabel,
      applyResult?.currentWindowLabel,
      applyResult?.roundLabel,
      ...(Array.isArray(cup?.currentWindowFixtures)
        ? cup.currentWindowFixtures.map(cupFixtureRoundLabel)
        : []),
      ...(Array.isArray(applyResult?.fixtureCoverage)
        ? applyResult.fixtureCoverage.map(cupFixtureRoundLabel)
        : []),
    ];

    const counts = new Map();
    for (const label of labels) {
      const key = canonicalWorldCupKnockoutRoundKey(label);
      if (!key) continue;
      counts.set(key, Number(counts.get(key) || 0) + 1);
    }

    return Array.from(counts.entries())
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0]?.[0] || null;
  }

  function getWorldCupKnockoutRoundCompleteness({
    room = {},
    cup = {},
    applyResult = {},
  } = {}) {
    if (!isWorldCupKnockoutRoom(room)) {
      return {
        isWorldCupKnockout: false,
        roundKey: null,
        expectedFixtureCount: null,
        discoveredFixtureCount: null,
        isComplete: true,
      };
    }

    const roundKey = getCupCurrentWindowRoundKey(cup, applyResult);
    const fixtureIds = new Set(
      [
        ...(Array.isArray(applyResult?.fixtureIds) ? applyResult.fixtureIds : []),
        ...(Array.isArray(cup?.currentWindowFixtureIds) ? cup.currentWindowFixtureIds : []),
      ]
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    );
    const discoveredFixtureCount = fixtureIds.size;
    const expectedFixtureCount = worldCupKnockoutExpectedFixtureCount(roundKey);
    const isRecognizedRound = Boolean(roundKey && expectedFixtureCount);

    return {
      isWorldCupKnockout: true,
      roundKey,
      expectedFixtureCount,
      discoveredFixtureCount,
      isRecognizedRound,
      isComplete:
        discoveredFixtureCount > 0 &&
        isRecognizedRound &&
        discoveredFixtureCount >= Number(expectedFixtureCount || 0),
    };
  }

  function cupGlobalWindowKeyForCurrentCup(roomId, cup = {}) {
    const fixtureIds = [...new Set(
      (Array.isArray(cup?.currentWindowFixtureIds) ? cup.currentWindowFixtureIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )];
    if (!fixtureIds.length) return null;

    const label = cup?.currentWindowLabel || "Cup Window";
    const labelKey = safeId(label) || "cup-window";
    const fixtureKey = fixtureIds.map(String).sort().join("_");
    return `cup-global-${labelKey}-${hashToUint32(`${roomId}:${fixtureKey}`)}`;
  }

  function buildCupWindowFixtureFromSummary({
    fixtureId,
    summary = {},
    fallback = {},
    label = null,
  } = {}) {
    const id = String(fixtureId || cupFixtureIdFromAny(summary) || cupFixtureIdFromAny(fallback));
    return {
      id,
      fixtureId: id,
      kickoffMs: firstNumber(summary?.kickoffMs, fallback?.kickoffMs) || null,
      round:
        cupFixtureRoundLabel(summary) ||
        cupFixtureRoundLabel(fallback) ||
        label ||
        null,
      roundLabel:
        summary?.roundLabel ||
        fallback?.roundLabel ||
        cupFixtureRoundLabel(summary) ||
        cupFixtureRoundLabel(fallback) ||
        label ||
        null,
      leagueRound:
        summary?.leagueRound ||
        fallback?.leagueRound ||
        cupFixtureRoundLabel(summary) ||
        cupFixtureRoundLabel(fallback) ||
        label ||
        null,
      statusShort: statusShortFromFixtureLike(summary) || statusShortFromFixtureLike(fallback) || null,
      statusLong: summary?.statusLong || fallback?.statusLong || null,
      elapsed: firstNumber(summary?.elapsed, fallback?.elapsed),
      extra: firstNumber(summary?.extra, fallback?.extra),
      isLive: firstDefined(summary?.isLive, fallback?.isLive) === true,
      isFinished: firstDefined(summary?.isFinished, fallback?.isFinished) === true,
      goalsHome: firstNumber(summary?.goalsHome, summary?.homeGoals, summary?.homeScore, fallback?.goalsHome, fallback?.homeGoals, fallback?.homeScore),
      goalsAway: firstNumber(summary?.goalsAway, summary?.awayGoals, summary?.awayScore, fallback?.goalsAway, fallback?.awayGoals, fallback?.awayScore),
      homeScore: firstNumber(summary?.goalsHome, summary?.homeGoals, summary?.homeScore, fallback?.goalsHome, fallback?.homeGoals, fallback?.homeScore),
      awayScore: firstNumber(summary?.goalsAway, summary?.awayGoals, summary?.awayScore, fallback?.goalsAway, fallback?.awayGoals, fallback?.awayScore),
      homeTeamId: firstDefined(summary?.homeTeamId, fallback?.homeTeamId),
      homeTeamName: summary?.homeTeamName || fallback?.homeTeamName || "",
      homeTeamLogo: summary?.homeTeamLogo || fallback?.homeTeamLogo || "",
      awayTeamId: firstDefined(summary?.awayTeamId, fallback?.awayTeamId),
      awayTeamName: summary?.awayTeamName || fallback?.awayTeamName || "",
      awayTeamLogo: summary?.awayTeamLogo || fallback?.awayTeamLogo || "",
    };
  }

  function isCupFinalWindowLabel(label = "") {
    const value = String(label || "").toLowerCase().trim();
    if (!value) return false;
    if (
      value.includes("semi") ||
      value.includes("quarter") ||
      value.includes("round of") ||
      value.includes("play-off") ||
      value.includes("playoff") ||
      value.includes("third place") ||
      value.includes("3rd place")
    ) {
      return false;
    }

    return value === "final" || value.startsWith("final ") || value.endsWith(" final");
  }

  function buildCupGlobalStandingsRowsFromTotals(totalsByUid = {}, rowSources = []) {
    const normalizedTotals = normalizeCupGlobalNumberMap(totalsByUid);
    const rowByUid = new Map();

    for (const source of Array.isArray(rowSources) ? rowSources : []) {
      for (const row of Array.isArray(source) ? source : []) {
        const uid = String(row?.userId || row?.uid || "").trim();
        if (!uid || rowByUid.has(uid)) continue;
        rowByUid.set(uid, row || {});
      }
    }

    return Object.entries(normalizedTotals)
      .map(([uid, total]) => {
        const previousRow = rowByUid.get(uid) || {};
        const displayName =
          previousRow.displayName ||
          previousRow.name ||
          uid;

        return {
          rank: 0,
          uid,
          userId: uid,
          name: displayName,
          displayName,
          teamName: previousRow.teamName || "",
          totalFantasyPoints: Number(total || 0),
        };
      })
      .sort((a, b) =>
        Number(b.totalFantasyPoints || 0) - Number(a.totalFantasyPoints || 0)
      )
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  function getCupGlobalCumulativeBaseForNextWindow(cup = {}) {
    if (cup?.globalBaseTotalsByUid && typeof cup.globalBaseTotalsByUid === "object") {
      return normalizeCupGlobalNumberMap(cup.globalBaseTotalsByUid);
    }

    if (cup?.cupTotalsByUid && typeof cup.cupTotalsByUid === "object") {
      return normalizeCupGlobalNumberMap(cup.cupTotalsByUid);
    }

    if (cup?.creditedTotalsByUid && typeof cup.creditedTotalsByUid === "object") {
      return normalizeCupGlobalNumberMap(cup.creditedTotalsByUid);
    }

    return {};
  }

  function buildCupGlobalNewWindowResetPayload({
    baseTotalsByUid = {},
    projectedStandingsRows = [],
  } = {}) {
    const normalizedBaseTotals = normalizeCupGlobalNumberMap(baseTotalsByUid);

    return {
      creditedTotalsByUid: normalizedBaseTotals,
      cupTotalsByUid: normalizedBaseTotals,
      globalBaseTotalsByUid: normalizedBaseTotals,
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

      projectedTotalsByUid: normalizedBaseTotals,
      projectedStandingsRows,
      standingsRows: projectedStandingsRows,
      leaderboard: projectedStandingsRows,
      rows: projectedStandingsRows,
      projectedIncludesLivePoints: false,
    };
  }

  async function armNextCupGlobalWindowFromCache({
    db,
    roomId,
    room = {},
    nowMs = Date.now(),
    afterMs = null,
    excludeFixtureIds = [],
  }) {
    const roomRef = db.doc(`rooms/${roomId}`);
    const seasonContext = deriveRoomSeasonContext(room);
    if (!seasonContext?.seasonKey) {
      throw new HttpsError("failed-precondition", "Could not resolve seasonKey for room.");
    }

    const cupRef = roomRef.collection("cup").doc("current");
    const cupSnap = await cupRef.get().catch(() => null);
    const existingCup = cupSnap?.exists ? (cupSnap.data() || {}) : {};
    const cumulativeBaseTotalsByUid =
      getCupGlobalCumulativeBaseForNextWindow(existingCup);
    const cumulativeStandingsRows = buildCupGlobalStandingsRowsFromTotals(
      cumulativeBaseTotalsByUid,
      [
        existingCup?.projectedStandingsRows,
        existingCup?.standingsRows,
        existingCup?.leaderboard,
        existingCup?.rows,
      ]
    );
    const newWindowResetPayload = buildCupGlobalNewWindowResetPayload({
      baseTotalsByUid: cumulativeBaseTotalsByUid,
      projectedStandingsRows: cumulativeStandingsRows,
    });

    const lowerBoundMs = Number(afterMs) > 0
      ? Number(afterMs) + 1
      : nowMs - CUP_GLOBAL_POST_MS;
    const summariesSnap = await getSeasonFixturesCollectionRef(db, seasonContext.seasonKey)
      .where("kickoffMs", ">=", lowerBoundMs)
      .orderBy("kickoffMs", "asc")
      .limit(500)
      .get();
    const roomLeague = String(room?.competition?.league || "").trim();
    const summaryById = new Map();
    let candidates = [];

    for (const summaryDoc of summariesSnap.docs) {
      const summary = summaryDoc.data() || {};
      const fixtureId = String(summary?.fixtureId || summaryDoc.id || "").trim();
      const kickoffMs = Number(summary?.kickoffMs || 0);
      const round = summary?.roundLabel || summary?.leagueRound || summary?.round || null;
      const summaryLeague = String(summary?.league || summary?.leagueId || "").trim();
      if (!fixtureId || !Number.isFinite(kickoffMs) || kickoffMs <= 0) continue;
      if (roomLeague && summaryLeague && roomLeague !== summaryLeague) continue;

      summaryById.set(fixtureId, summary);
      candidates.push({ id: fixtureId, kickoffMs, round });
    }

    if (isWorldCupKnockoutRoom(room)) {
      candidates = candidates.filter((candidate) =>
        isWorldCupKnockoutRoundLabel(candidate?.round)
      );
    }

    let nextWindow = pickCupWindow(candidates, {
      nowMs,
      gapHours: 36,
      afterMs,
      excludeFixtureIds,
    });

    if (isWorldCupKnockoutRoom(room) && candidates.length) {
      const exclude = new Set(
        (Array.isArray(excludeFixtureIds) ? excludeFixtureIds : [])
          .map(String)
          .filter(Boolean)
      );
      const afterNumber = Number(afterMs);
      const START_GRACE_MS = 3 * 60 * 60 * 1000;
      const eligibleKnockoutCandidates = candidates
        .map((candidate) => ({
          ...candidate,
          id: String(candidate?.id || ""),
          kickoffMs: Number(candidate?.kickoffMs || 0),
          roundKey: canonicalWorldCupKnockoutRoundKey(candidate?.round),
        }))
        .filter((candidate) => candidate.id)
        .filter((candidate) => candidate.roundKey)
        .filter((candidate) => Number.isFinite(candidate.kickoffMs) && candidate.kickoffMs > 0)
        .filter((candidate) => !exclude.has(String(candidate.id)))
        .filter((candidate) =>
          Number.isFinite(afterNumber) && afterNumber > 0
            ? Number(candidate.kickoffMs) > afterNumber
            : true
        )
        .sort((a, b) => Number(a.kickoffMs) - Number(b.kickoffMs));

      const seed =
        eligibleKnockoutCandidates.find(
          (candidate) => Number(candidate.kickoffMs) >= nowMs - START_GRACE_MS
        ) ||
        eligibleKnockoutCandidates[0] ||
        null;

      if (seed?.roundKey) {
        const picked = eligibleKnockoutCandidates
          .filter((candidate) => candidate.roundKey === seed.roundKey)
          .sort((a, b) => Number(a.kickoffMs) - Number(b.kickoffMs));
        const fixtureIds = picked.map((candidate) => String(candidate.id)).filter(Boolean);

        if (fixtureIds.length) {
          const minKo = Math.min(...picked.map((candidate) => Number(candidate.kickoffMs)));
          const maxKo = Math.max(...picked.map((candidate) => Number(candidate.kickoffMs)));
          nextWindow = {
            windowId: `${seed.round || seed.roundKey}:${minKo}-${maxKo}`,
            label: seed.round || seed.roundKey || "Cup",
            fixtureIds,
            fixtures: picked.map((candidate) => ({
              id: String(candidate.id),
              kickoffMs: Number(candidate.kickoffMs) || null,
              round: candidate.round || null,
            })),
            startAtMs: minKo,
            endAtMs: maxKo,
            canonicalRoundKey: seed.roundKey,
            expectedFixtureCount: worldCupKnockoutExpectedFixtureCount(seed.roundKey),
          };
        }
      }
    }

    if (!nextWindow?.fixtureIds?.length) {
      const nextPollAtMs = nowMs + CUP_GLOBAL_RETRY_MS;
      await cupRef.set(
        {
          ...newWindowResetPayload,
          roomId,
          status: "scheduled",
          source: "global-live-fixtures",
          currentWindowId: null,
          currentWindowLabel: "Waiting for next round",
          currentWindowFixtureIds: [],
          currentWindowFixtures: [],
          currentWindowStartAtMs: null,
          currentWindowEndAtMs: null,
          globalApplyStatus: "waiting-for-global-window",
          nextPollAtMs,
          updatedAtMs: nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      await setCompetitionState(
        roomRef,
        {
          phaseLabel: "Cup",
          weekStatus: "scheduled",
          currentLabel: "Waiting for next round",
          nextPollAtMs,
          nextCupPollAtMs: nextPollAtMs,
          nextKickoffMs: null,
          isDone: false,
        },
        { roomData: room, nowMs }
      );
      return null;
    }

    const currentWindowFixtures = nextWindow.fixtureIds.map((fixtureId) => {
      const summary = summaryById.get(String(fixtureId)) || {};
      return buildCupWindowFixtureFromSummary({
        fixtureId,
        summary,
        label: nextWindow.label || "Cup",
      });
    });
    const firstKickoffMs = Math.min(
      ...currentWindowFixtures
        .map((fixture) => Number(fixture?.kickoffMs || 0))
        .filter((kickoffMs) => Number.isFinite(kickoffMs) && kickoffMs > 0)
    );
    const nextPollAtMs = Number.isFinite(firstKickoffMs)
      ? Math.max(nowMs, firstKickoffMs - CUP_GLOBAL_ACTIVE_PRE_MS)
      : nowMs + CUP_GLOBAL_RETRY_MS;
    const cupPayload = {
      ...newWindowResetPayload,
      roomId,
      status: "scheduled",
      source: "global-live-fixtures",
      currentWindowId: nextWindow.windowId,
      currentWindowLabel: nextWindow.label || "Cup",
      currentWindowFixtureIds: nextWindow.fixtureIds.map(String),
      currentWindowFixtures,
      currentWindowStartAtMs: Number(nextWindow.startAtMs || 0) || null,
      currentWindowEndAtMs: Number(nextWindow.endAtMs || 0) || null,
      globalApplyStatus: "scheduled",
      currentWindowRoundKey: nextWindow.canonicalRoundKey || getCupCurrentWindowRoundKey({
        currentWindowLabel: nextWindow.label,
        currentWindowFixtures,
      }),
      expectedFixtureCount: nextWindow.expectedFixtureCount || null,
      discoveredFixtureCount: currentWindowFixtures.length,
      nextPollAtMs,
      updatedAtMs: nowMs,
      updatedAt: FieldValue.serverTimestamp(),
    };

    await cupRef.set(cupPayload, { merge: true });
    await setCompetitionState(
      roomRef,
      {
        phaseLabel: "Cup",
        weekStatus: "scheduled",
        currentLabel: nextWindow.label || "Cup",
        nextPollAtMs,
        nextCupPollAtMs: nextPollAtMs,
        nextKickoffMs: Number.isFinite(firstKickoffMs) ? firstKickoffMs : null,
        isDone: false,
      },
      { roomData: room, nowMs }
    );

    return {
      ...nextWindow,
      currentWindowFixtures,
      nextPollAtMs,
      nextKickoffMs: Number.isFinite(firstKickoffMs) ? firstKickoffMs : null,
      source: "global-live-fixtures",
    };
  }

  async function reconcileCupGlobalCurrentWindowFromCache({
    db,
    roomId,
    room = {},
    cup = null,
    nowMs = Date.now(),
  }) {
    if (!isWorldCupKnockoutRoom(room)) {
      return { applied: false, skippedReason: "not-world-cup-knockout" };
    }

    const roomRef = db.doc(`rooms/${roomId}`);
    const cupRef = roomRef.collection("cup").doc("current");
    let currentCup = cup && typeof cup === "object" ? cup : null;
    if (!currentCup) {
      const cupSnap = await cupRef.get();
      currentCup = cupSnap.exists ? (cupSnap.data() || {}) : {};
    }

    const existingFixtureIds = [...new Set(
      (Array.isArray(currentCup?.currentWindowFixtureIds)
        ? currentCup.currentWindowFixtureIds
        : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )];

    if (!existingFixtureIds.length) {
      return { applied: false, skippedReason: "no-current-window-fixtures", cup: currentCup };
    }

    const currentWindowKey = cupGlobalWindowKeyForCurrentCup(roomId, currentCup);
    const finalizedKeys = Array.isArray(currentCup?.finalizedGlobalWindowKeys)
      ? currentCup.finalizedGlobalWindowKeys.map((key) => String(key))
      : [];
    if (currentWindowKey && finalizedKeys.includes(currentWindowKey)) {
      return {
        applied: false,
        skippedReason: "current-window-already-finalized",
        cup: currentCup,
      };
    }

    const roundKey = getCupCurrentWindowRoundKey(currentCup);
    if (!roundKey) {
      return { applied: false, skippedReason: "missing-canonical-round-key", cup: currentCup };
    }

    const seasonContext = deriveRoomSeasonContext(room);
    if (!seasonContext?.seasonKey) {
      return { applied: false, skippedReason: "missing-season-key", cup: currentCup };
    }

    const existingFixturesById = new Map(
      (Array.isArray(currentCup?.currentWindowFixtures)
        ? currentCup.currentWindowFixtures
        : [])
        .map((fixture) => [cupFixtureIdFromAny(fixture), fixture || {}])
        .filter(([fixtureId]) => Boolean(fixtureId))
    );

    const kickoffValues = Array.from(existingFixturesById.values())
      .map((fixture) => firstNumber(fixture?.kickoffMs, fixture?.startAtMs))
      .filter((kickoffMs) => Number.isFinite(kickoffMs) && kickoffMs > 0);
    const storedStart = firstNumber(currentCup?.currentWindowStartAtMs);
    const storedEnd = firstNumber(currentCup?.currentWindowEndAtMs);
    const baseStart = storedStart || (kickoffValues.length ? Math.min(...kickoffValues) : nowMs);
    const baseEnd = storedEnd || (kickoffValues.length ? Math.max(...kickoffValues) : nowMs);
    const queryStartMs = Math.max(0, Number(baseStart || nowMs) - 14 * 24 * 60 * 60 * 1000);
    const queryEndMs = Number(baseEnd || nowMs) + 14 * 24 * 60 * 60 * 1000;
    const roomLeague = String(room?.competition?.league || "").trim();

    const summariesSnap = await getSeasonFixturesCollectionRef(db, seasonContext.seasonKey)
      .where("kickoffMs", ">=", queryStartMs)
      .orderBy("kickoffMs", "asc")
      .limit(500)
      .get();

    const summaryById = new Map();
    for (const summaryDoc of summariesSnap.docs) {
      const summary = summaryDoc.data() || {};
      const fixtureId = String(summary?.fixtureId || summaryDoc.id || "").trim();
      const kickoffMs = Number(summary?.kickoffMs || 0);
      const summaryLeague = String(summary?.league || summary?.leagueId || "").trim();
      const summaryRoundKey = canonicalWorldCupKnockoutRoundKey(cupFixtureRoundLabel(summary));
      if (!fixtureId || !Number.isFinite(kickoffMs) || kickoffMs <= 0) continue;
      if (kickoffMs > queryEndMs) continue;
      if (roomLeague && summaryLeague && roomLeague !== summaryLeague) continue;
      if (summaryRoundKey !== roundKey) continue;
      summaryById.set(fixtureId, summary);
    }

    const mergedFixtureIds = [...new Set([
      ...existingFixtureIds,
      ...Array.from(summaryById.keys()),
    ])].filter(Boolean);

    const label = currentCup?.currentWindowLabel || cupFixtureRoundLabel(currentCup) || roundKey || "Cup";
    const mergedFixtures = mergedFixtureIds
      .map((fixtureId) => {
        const summary = summaryById.get(String(fixtureId)) || {};
        const fallback = existingFixturesById.get(String(fixtureId)) || { fixtureId };
        return buildCupWindowFixtureFromSummary({
          fixtureId,
          summary,
          fallback,
          label,
        });
      })
      .sort((a, b) => Number(a?.kickoffMs || 0) - Number(b?.kickoffMs || 0));

    const kickoffMsList = mergedFixtures
      .map((fixture) => Number(fixture?.kickoffMs || 0))
      .filter((kickoffMs) => Number.isFinite(kickoffMs) && kickoffMs > 0)
      .sort((a, b) => a - b);
    const currentWindowStartAtMs = kickoffMsList[0] || currentCup?.currentWindowStartAtMs || null;
    const currentWindowEndAtMs =
      kickoffMsList[kickoffMsList.length - 1] || currentCup?.currentWindowEndAtMs || null;
    const expectedFixtureCount = worldCupKnockoutExpectedFixtureCount(roundKey);
    const discoveredFixtureCount = mergedFixtureIds.length;
    const existingIdsKey = existingFixtureIds.map(String).sort().join("|");
    const mergedIdsKey = mergedFixtureIds.map(String).sort().join("|");
    const shouldWrite =
      existingIdsKey !== mergedIdsKey ||
      Number(currentCup?.currentWindowStartAtMs || 0) !== Number(currentWindowStartAtMs || 0) ||
      Number(currentCup?.currentWindowEndAtMs || 0) !== Number(currentWindowEndAtMs || 0) ||
      currentCup?.currentWindowRoundKey !== roundKey ||
      Number(currentCup?.expectedFixtureCount || 0) !== Number(expectedFixtureCount || 0) ||
      Number(currentCup?.discoveredFixtureCount || 0) !== Number(discoveredFixtureCount || 0);

    const nextCup = {
      ...currentCup,
      currentWindowFixtureIds: mergedFixtureIds,
      currentWindowFixtures: mergedFixtures,
      currentWindowStartAtMs,
      currentWindowEndAtMs,
      currentWindowRoundKey: roundKey,
      expectedFixtureCount: expectedFixtureCount || null,
      discoveredFixtureCount,
    };

    if (!shouldWrite) {
      return {
        applied: false,
        skippedReason: "current-window-already-complete-for-cache",
        cup: nextCup,
        roundKey,
        expectedFixtureCount: expectedFixtureCount || null,
        discoveredFixtureCount,
      };
    }

    const update = {
      currentWindowFixtureIds: mergedFixtureIds,
      currentWindowFixtures: mergedFixtures,
      currentWindowStartAtMs,
      currentWindowEndAtMs,
      currentWindowRoundKey: roundKey,
      expectedFixtureCount: expectedFixtureCount || null,
      discoveredFixtureCount,
      lastRoundReconciledAtMs: nowMs,
      updatedAtMs: nowMs,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (expectedFixtureCount && discoveredFixtureCount < expectedFixtureCount) {
      update.globalApplyStatus = "waiting-for-complete-round";
    } else if (!expectedFixtureCount) {
      update.globalApplyStatus = "waiting-for-recognized-round";
    }

    await cupRef.set(update, { merge: true });

    return {
      applied: true,
      cup: nextCup,
      roundKey,
      expectedFixtureCount: expectedFixtureCount || null,
      discoveredFixtureCount,
      addedFixtureIds: mergedFixtureIds.filter((id) => !existingFixtureIds.includes(String(id))),
    };
  }

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

  function firstDefined(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  }

  function firstText(...values) {
    const value = firstDefined(...values);
    return value == null ? null : String(value).trim() || null;
  }

  function firstNumber(...values) {
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function statusShortFromFixtureLike(value = {}) {
    if (!value || typeof value !== "object") {
      return firstText(value);
    }

    return firstText(
      value.statusShort,
      value.short,
      value.status?.short,
      value.fixture?.status?.short,
      value.fixtureStatus,
      value.matchStatus,
      value.status
    );
  }

  function buildCupFixtureCoverageRow({
    fixtureId,
    live = null,
    summary = null,
    cupFixture = {},
    rawSample = {},
    cup = {},
  }) {
    const statusShort = firstText(
      statusShortFromFixtureLike(live),
      statusShortFromFixtureLike(summary),
      statusShortFromFixtureLike(cupFixture),
      statusShortFromFixtureLike(rawSample)
    );
    const statusLong = firstText(
      live?.statusLong,
      live?.long,
      summary?.statusLong,
      summary?.long,
      cupFixture?.statusLong,
      cupFixture?.fixture?.status?.long,
      rawSample?.statusLong
    );
    const kickoffMs = firstNumber(
      live?.kickoffMs,
      live?.kickoffAtMs,
      live?.startAtMs,
      summary?.kickoffMs,
      summary?.kickoffAtMs,
      summary?.startAtMs,
      cupFixture?.kickoffMs,
      cupFixture?.startAtMs,
      cupFixture?.fixture?.timestamp,
      rawSample?.kickoffMs,
      cup?.currentWindowStartAtMs
    );
    const normalizedKickoffMs =
      kickoffMs && kickoffMs < 100000000000 ? kickoffMs * 1000 : kickoffMs;
    const goalsHome = firstNumber(
      live?.goalsHome,
      live?.homeGoals,
      live?.homeScore,
      live?.goals?.home,
      summary?.goalsHome,
      summary?.homeGoals,
      summary?.homeScore,
      summary?.goals?.home,
      cupFixture?.goalsHome,
      cupFixture?.homeGoals,
      cupFixture?.homeScore,
      cupFixture?.goals?.home,
      rawSample?.goalsHome,
      rawSample?.homeGoals,
      rawSample?.homeScore
    );
    const goalsAway = firstNumber(
      live?.goalsAway,
      live?.awayGoals,
      live?.awayScore,
      live?.goals?.away,
      summary?.goalsAway,
      summary?.awayGoals,
      summary?.awayScore,
      summary?.goals?.away,
      cupFixture?.goalsAway,
      cupFixture?.awayGoals,
      cupFixture?.awayScore,
      cupFixture?.goals?.away,
      rawSample?.goalsAway,
      rawSample?.awayGoals,
      rawSample?.awayScore
    );
    const elapsed = firstNumber(
      live?.elapsed,
      summary?.elapsed,
      cupFixture?.elapsed,
      cupFixture?.fixture?.status?.elapsed,
      rawSample?.elapsed
    );
    const extra = firstNumber(
      live?.extra,
      summary?.extra,
      cupFixture?.extra,
      cupFixture?.fixture?.status?.extra,
      rawSample?.extra
    );
    const statusUpper = String(statusShort || "").trim().toUpperCase();
    const isLiveValue = firstDefined(live?.isLive, summary?.isLive, cupFixture?.isLive);
    const isFinishedValue = firstDefined(live?.isFinished, summary?.isFinished, cupFixture?.isFinished);
    const fantasyByPlayerId =
      live?.fantasyByPlayerId && typeof live.fantasyByPlayerId === "object"
        ? live.fantasyByPlayerId
        : {};
    const rawStatsByPlayerId =
      live?.rawStatsByPlayerId && typeof live.rawStatsByPlayerId === "object"
        ? live.rawStatsByPlayerId
        : {};

    return {
      fixtureId: String(fixtureId),
      hasLivePayload: Boolean(live),
      hasSummary: Boolean(summary),
      statusShort: statusShort || null,
      statusLong: statusLong || null,
      kickoffMs: normalizedKickoffMs || null,
      elapsed,
      extra,
      isLive:
        typeof isLiveValue === "boolean"
          ? isLiveValue
          : Boolean(statusUpper && isInPlay(statusUpper) && !isFinished(statusUpper)),
      isFinished:
        typeof isFinishedValue === "boolean"
          ? isFinishedValue
          : Boolean(statusUpper && isFinished(statusUpper)),
      goalsHome,
      goalsAway,
      homeScore: goalsHome,
      awayScore: goalsAway,
      homeTeamId: firstDefined(live?.homeTeamId, summary?.homeTeamId, cupFixture?.homeTeamId),
      awayTeamId: firstDefined(live?.awayTeamId, summary?.awayTeamId, cupFixture?.awayTeamId),
      homeTeamName: firstText(
        live?.homeTeamName,
        live?.homeTeam,
        summary?.homeTeamName,
        summary?.homeTeam,
        cupFixture?.homeTeamName,
        cupFixture?.homeTeam,
        cupFixture?.teams?.home?.name,
        rawSample?.homeTeamName
      ) || "",
      awayTeamName: firstText(
        live?.awayTeamName,
        live?.awayTeam,
        summary?.awayTeamName,
        summary?.awayTeam,
        cupFixture?.awayTeamName,
        cupFixture?.awayTeam,
        cupFixture?.teams?.away?.name,
        rawSample?.awayTeamName
      ) || "",
      homeTeamLogo: firstText(live?.homeTeamLogo, summary?.homeTeamLogo, cupFixture?.homeTeamLogo, cupFixture?.teams?.home?.logo, rawSample?.homeTeamLogo) || "",
      awayTeamLogo: firstText(live?.awayTeamLogo, summary?.awayTeamLogo, cupFixture?.awayTeamLogo, cupFixture?.teams?.away?.logo, rawSample?.awayTeamLogo) || "",
      fantasyPlayerCount: Object.keys(fantasyByPlayerId).length,
      rawStatsPlayerCount: Object.keys(rawStatsByPlayerId).length,
    };
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

  function isCoverageNonPlayable(coverage = {}) {
    return ["CANC", "PST", "TBD", "ABD", "AWD", "WO"].includes(
      coverageStatusShort(coverage)
    );
  }

  function isCoverageKickoffPassedUnfinished(coverage = {}, nowMs = Date.now()) {
    const kickoffMs = coverageKickoffMs(coverage);
    return (
      Number.isFinite(kickoffMs) &&
      kickoffMs <= nowMs &&
      !isFinished(coverageStatusShort(coverage)) &&
      !isCoverageNonPlayable(coverage)
    );
  }

  function isCoverageResolvingAfterKickoffTail(coverage = {}, nowMs = Date.now()) {
    const kickoffMs = coverageKickoffMs(coverage);
    return (
      isCoverageKickoffPassedUnfinished(coverage, nowMs) &&
      Number.isFinite(kickoffMs) &&
      nowMs > kickoffMs + CUP_GLOBAL_POST_MS
    );
  }

  function coverageNeedsLiveFixturePayload(coverage = {}, nowMs = Date.now()) {
    const kickoffMs = coverageKickoffMs(coverage);
    const short = coverageStatusShort(coverage);
    return (
      isInPlay(short) ||
      isFinished(short) ||
      (
        Number.isFinite(kickoffMs) &&
        kickoffMs <= nowMs &&
        !isCoverageNonPlayable(coverage)
      )
    );
  }

  function nextCupGlobalPollAtFromCoverage({
    fixtureCoverage = [],
    nowMs = Date.now(),
    statusValue = "",
    allFinished = false,
  } = {}) {
    const status = String(statusValue || "").toLowerCase();
    if (!allFinished && (status === "live" || status === "resolving")) {
      return nowMs + CUP_GLOBAL_ACTIVE_POLL_MS;
    }

    const nextKickoffMs = (Array.isArray(fixtureCoverage) ? fixtureCoverage : [])
      .map((coverage) => Number(coverage?.kickoffMs || 0))
      .filter((kickoffMs) => Number.isFinite(kickoffMs) && kickoffMs > nowMs)
      .sort((a, b) => a - b)[0] || null;

    if (!nextKickoffMs) {
      return allFinished ? null : nowMs + CUP_GLOBAL_RETRY_MS;
    }

    if (nowMs < nextKickoffMs - CUP_GLOBAL_ACTIVE_PRE_MS) {
      return nextKickoffMs - CUP_GLOBAL_ACTIVE_PRE_MS;
    }

    if (nowMs < nextKickoffMs) {
      return Math.min(nowMs + CUP_GLOBAL_PREGAME_POLL_MS, nextKickoffMs);
    }

    return nowMs + CUP_GLOBAL_ACTIVE_POLL_MS;
  }

  function normalizeCupGlobalNumberMap(map = {}) {
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

  function hasCupGlobalNumberValues(map = {}) {
    return Object.values(normalizeCupGlobalNumberMap(map)).some(
      (value) => Number(value || 0) !== 0
    );
  }

  function cupGlobalTotalsFromBreakdownMap(breakdownByUserId = {}) {
    const out = {};
    if (!breakdownByUserId || typeof breakdownByUserId !== "object") return out;

    for (const [uid, breakdown] of Object.entries(breakdownByUserId)) {
      const key = String(uid || "").trim();
      if (!key || !breakdown || typeof breakdown !== "object") continue;

      const explicitTotal = Number(breakdown.total);
      if (Number.isFinite(explicitTotal)) {
        out[key] = explicitTotal;
        continue;
      }

      const starterTotal = Array.isArray(breakdown.starters)
        ? breakdown.starters.reduce(
            (sum, player) => sum + Number(player?.points || 0),
            0
          )
        : Object.values(breakdown.perPlayer || {}).reduce((sum, player) => {
            if (player?.counted === false) return sum;
            return sum + Number(player?.points || 0);
          }, 0);

      out[key] = Number.isFinite(starterTotal) ? starterTotal : 0;
    }

    return out;
  }

  function subtractCupGlobalNumberMaps(base = {}, minus = {}) {
    const out = normalizeCupGlobalNumberMap(base);

    for (const [uid, value] of Object.entries(normalizeCupGlobalNumberMap(minus))) {
      out[uid] = Number(out[uid] || 0) - Number(value || 0);
    }

    return out;
  }

  function addCupGlobalNumberMaps(base = {}, add = {}) {
    const out = normalizeCupGlobalNumberMap(base);

    for (const [uid, value] of Object.entries(normalizeCupGlobalNumberMap(add))) {
      out[uid] = Number(out[uid] || 0) + Number(value || 0);
    }

    return out;
  }

  function getCupGlobalBaseTotalsForProjection(cup = {}, fixtureIds = []) {
    const replayBaselineTotalsByUid =
      cup?.replayTestMode === true &&
      cup?.replayBaselineTotalsByUid &&
      typeof cup.replayBaselineTotalsByUid === "object"
        ? normalizeCupGlobalNumberMap(cup.replayBaselineTotalsByUid)
        : null;
    if (replayBaselineTotalsByUid) {
      return {
        existingCupTotalsByUid: replayBaselineTotalsByUid,
        baseTotalsByUid: replayBaselineTotalsByUid,
        removedLegacyWindowPointsByUid: {},
        creditedCurrentWindowFixtureIds: [],
        legacyCurrentWindowCreditDetected: false,
        replayBaselineApplied: true,
      };
    }

    const storedGlobalBaseTotals =
      cup?.globalBaseTotalsByUid && typeof cup.globalBaseTotalsByUid === "object"
        ? normalizeCupGlobalNumberMap(cup.globalBaseTotalsByUid)
        : null;
    if (storedGlobalBaseTotals && Object.keys(storedGlobalBaseTotals).length) {
      return {
        existingCupTotalsByUid:
          cup?.cupTotalsByUid && typeof cup.cupTotalsByUid === "object"
            ? normalizeCupGlobalNumberMap(cup.cupTotalsByUid)
            : storedGlobalBaseTotals,
        baseTotalsByUid: storedGlobalBaseTotals,
        removedLegacyWindowPointsByUid:
          cup?.removedLegacyWindowPointsByUid &&
          typeof cup.removedLegacyWindowPointsByUid === "object"
            ? normalizeCupGlobalNumberMap(cup.removedLegacyWindowPointsByUid)
            : {},
        creditedCurrentWindowFixtureIds: Array.isArray(cup?.creditedCurrentWindowFixtureIds)
          ? cup.creditedCurrentWindowFixtureIds.map(String).filter(Boolean)
          : [],
        legacyCurrentWindowCreditDetected:
          cup?.globalBaseAdjustedForCurrentWindow === true,
        replayBaselineApplied: false,
      };
    }

    const existingCupTotalsByUid =
      cup?.cupTotalsByUid && typeof cup.cupTotalsByUid === "object"
        ? normalizeCupGlobalNumberMap(cup.cupTotalsByUid)
        : {};
    const currentFixtureIds = new Set(
      (Array.isArray(fixtureIds) ? fixtureIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    );
    const creditedFixtures =
      cup?.creditedFixtures && typeof cup.creditedFixtures === "object"
        ? cup.creditedFixtures
        : {};
    const creditedCurrentWindowFixtureIds = Array.from(currentFixtureIds).filter(
      (fixtureId) => Boolean(creditedFixtures[fixtureId])
    );
    const windowPointsByUid =
      cup?.windowPointsByUid && typeof cup.windowPointsByUid === "object"
        ? normalizeCupGlobalNumberMap(cup.windowPointsByUid)
        : {};
    const breakdownTotalsByUid = cupGlobalTotalsFromBreakdownMap(
      cup?.windowBreakdownByUserId ||
        cup?.breakdownByUserId ||
        {}
    );
    const removedLegacyWindowPointsByUid = hasCupGlobalNumberValues(windowPointsByUid)
      ? windowPointsByUid
      : creditedCurrentWindowFixtureIds.length
        ? breakdownTotalsByUid
        : {};
    const legacyCurrentWindowCreditDetected =
      creditedCurrentWindowFixtureIds.length > 0 ||
      hasCupGlobalNumberValues(windowPointsByUid) ||
      (
        cup?.windowBreakdownByUserId &&
        typeof cup.windowBreakdownByUserId === "object" &&
        Object.keys(cup.windowBreakdownByUserId).length > 0
      );
    const baseTotalsByUid =
      legacyCurrentWindowCreditDetected &&
      hasCupGlobalNumberValues(removedLegacyWindowPointsByUid)
        ? subtractCupGlobalNumberMaps(
            existingCupTotalsByUid,
            removedLegacyWindowPointsByUid
          )
        : { ...existingCupTotalsByUid };

    return {
      existingCupTotalsByUid,
      baseTotalsByUid,
      removedLegacyWindowPointsByUid,
      creditedCurrentWindowFixtureIds,
      legacyCurrentWindowCreditDetected,
      replayBaselineApplied: false,
    };
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
      const rawStatsByPlayerId =
        live?.rawStatsByPlayerId && typeof live.rawStatsByPlayerId === "object"
          ? live.rawStatsByPlayerId
          : {};
      const rawSample =
        Object.values(rawStatsByPlayerId).find((value) => value && typeof value === "object") || {};
  
      return buildCupFixtureCoverageRow({
        fixtureId,
        live,
        summary,
        cupFixture,
        rawSample,
        cup,
      });
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
          rawStats?.rawApiPosition ||
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
      const rawStatsByPlayerId =
        live?.rawStatsByPlayerId && typeof live.rawStatsByPlayerId === "object"
          ? live.rawStatsByPlayerId
          : {};
      const rawSample =
        Object.values(rawStatsByPlayerId).find((value) => value && typeof value === "object") || {};
  
      return buildCupFixtureCoverageRow({
        fixtureId,
        live,
        summary,
        cupFixture,
        rawSample,
        cup,
      });
    });
    const worldCupRoundCompleteness = getWorldCupKnockoutRoundCompleteness({
      room,
      cup,
      applyResult: {
        fixtureIds,
        fixtureCoverage,
      },
    });
    const missingLiveFixtureIdSet = new Set(
      (Array.isArray(missingFixtureIds) ? missingFixtureIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    );
    const missingRequiredFixtureIds = fixtureCoverage
      .filter((coverage) =>
        missingLiveFixtureIdSet.has(String(coverage.fixtureId)) &&
        coverageNeedsLiveFixturePayload(coverage, nowMs)
      )
      .map((coverage) => String(coverage.fixtureId))
      .filter(Boolean);
  
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
    const staleInPlayFixtureIds = fixtureCoverage
      .filter((coverage) => isCoverageStalePastPostTail(coverage, nowMs))
      .map((coverage) => String(coverage.fixtureId))
      .filter(Boolean);
    const hasStaleInPlayFixtures = staleInPlayFixtureIds.length > 0;
    const kickoffPassedUnfinishedFixtureIds = fixtureCoverage
      .filter((coverage) => isCoverageKickoffPassedUnfinished(coverage, nowMs))
      .map((coverage) => String(coverage.fixtureId))
      .filter(Boolean);
    const hasKickoffPassedUnfinishedFixtures =
      kickoffPassedUnfinishedFixtureIds.length > 0;
    const hasResolvingKickoffPassedFixtures = fixtureCoverage.some((coverage) =>
      isCoverageResolvingAfterKickoffTail(coverage, nowMs)
    );
    const allFinished = fixtureIds.length > 0 && fixtureCoverage.every((coverage) =>
      isFinished(coverage.statusShort)
    );
    const statusValue = allFinished
      ? "final"
      : hasStaleInPlayFixtures || hasResolvingKickoffPassedFixtures
        ? "resolving"
        : anyInPlay || hasKickoffPassedUnfinishedFixtures
          ? "live"
          : "idle";
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

      const skippedPayload = {
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
        currentWindowRoundKey: worldCupRoundCompleteness.roundKey || null,
        expectedFixtureCount: worldCupRoundCompleteness.expectedFixtureCount || null,
        discoveredFixtureCount: worldCupRoundCompleteness.discoveredFixtureCount || null,
        worldCupKnockoutRoundComplete: worldCupRoundCompleteness.isComplete,
        missingFixtureCount: missingRequiredFixtureIds.length,
        missingFullWindowFixtureCount: missingFixtureIds.length,
        statusValue,
        allFinished,
        anyInPlay,
        staleInPlayFixtureIds,
        hasStaleInPlayFixtures,
        kickoffPassedUnfinishedFixtureIds,
        hasKickoffPassedUnfinishedFixtures,
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
        missingRequiredFixtureIds,
        missingPlayerIdsByUid: {},
        updatedAtMs: nowMs,
      };
      if (realWriteRequested) {
        await cupRef.set(
          {
            roomId,
            status: "scheduled",
            source: "global-live-fixtures",
            globalApplyStatus: skippedReason,
            staleInPlayFixtureIds,
            hasStaleInPlayFixtures,
            kickoffPassedUnfinishedFixtureIds,
            hasKickoffPassedUnfinishedFixtures,
            fixtureStatusById: skippedPayload.fixtureStatusById,
            fixtureCoverage,
            currentWindowRoundKey: worldCupRoundCompleteness.roundKey || null,
            expectedFixtureCount: worldCupRoundCompleteness.expectedFixtureCount || null,
            discoveredFixtureCount: worldCupRoundCompleteness.discoveredFixtureCount || null,
            worldCupKnockoutRoundComplete: worldCupRoundCompleteness.isComplete,
            nextPollAtMs,
            updatedAtMs: nowMs,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      await roomRef.collection("globalShadowResults").doc("cup-apply-current-window").set(
        {
          ...skippedPayload,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );
      return skippedPayload;
    }

    if (realWriteRequested && missingRequiredFixtureIds.length > 0) {
      throw new HttpsError(
        "failed-precondition",
        "Cannot apply Cup global result while global fixture cache is missing active fixtures."
      );
    }
    let nextPollAtMs = nextCupGlobalPollAtFromCoverage({
      fixtureCoverage,
      nowMs,
      statusValue,
      allFinished,
    });
    if (
      worldCupRoundCompleteness.isWorldCupKnockout &&
      worldCupRoundCompleteness.isComplete === false &&
      allFinished
    ) {
      nextPollAtMs = nowMs + CUP_GLOBAL_PREGAME_POLL_MS;
    }
  
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
          rawStats?.rawApiPosition ||
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
  
    const cupGlobalBase = getCupGlobalBaseTotalsForProjection(cup, fixtureIds);
    const {
      existingCupTotalsByUid,
      baseTotalsByUid,
      removedLegacyWindowPointsByUid,
      creditedCurrentWindowFixtureIds,
      legacyCurrentWindowCreditDetected,
      replayBaselineApplied,
    } = cupGlobalBase;
    const projectedTotalsByUid = addCupGlobalNumberMaps(
      baseTotalsByUid,
      globalTotalsByUid
    );
  
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
      currentWindowRoundKey: worldCupRoundCompleteness.roundKey || null,
      expectedFixtureCount: worldCupRoundCompleteness.expectedFixtureCount || null,
      discoveredFixtureCount: worldCupRoundCompleteness.discoveredFixtureCount || null,
      worldCupKnockoutRoundComplete: worldCupRoundCompleteness.isComplete,
      missingFixtureCount: missingRequiredFixtureIds.length,
      missingFullWindowFixtureCount: missingFixtureIds.length,
      statusValue,
      allFinished,
      anyInPlay,
      staleInPlayFixtureIds,
      hasStaleInPlayFixtures,
      kickoffPassedUnfinishedFixtureIds,
      hasKickoffPassedUnfinishedFixtures,
      nextKickoffMs,
      nextPollAtMs,
      globalTotalsByUid,
      globalBenchTotalsByUid,
      globalBreakdownByUserId,
      existingCupTotalsByUid,
      baseTotalsByUid,
      removedLegacyWindowPointsByUid,
      creditedCurrentWindowFixtureIds,
      legacyCurrentWindowCreditDetected,
      replayBaselineApplied,
      projectedTotalsByUid,
      projectedStandingsRows,
      fixtureStatusById,
      fixtureCoverage,
      missingFixtureIds,
      missingRequiredFixtureIds,
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
        currentWindowRoundKey: worldCupRoundCompleteness.roundKey || null,
        expectedFixtureCount: worldCupRoundCompleteness.expectedFixtureCount || null,
        discoveredFixtureCount: worldCupRoundCompleteness.discoveredFixtureCount || null,
        worldCupKnockoutRoundComplete: worldCupRoundCompleteness.isComplete,
  
        globalCurrentWindowPointsByUid: globalTotalsByUid,
        globalCurrentWindowBenchPointsByUid: globalBenchTotalsByUid,
        globalCurrentWindowBreakdownByUserId: globalBreakdownByUserId,
        globalBaseTotalsByUid: baseTotalsByUid,
        globalBaseAdjustedForCurrentWindow: legacyCurrentWindowCreditDetected,
        creditedCurrentWindowFixtureIds,
        removedLegacyWindowPointsByUid,
  
        livePointsByUid: globalTotalsByUid,
        liveBenchPointsByUid: globalBenchTotalsByUid,
        liveBreakdownByUserId: globalBreakdownByUserId,
  
        projectedTotalsByUid,
        projectedStandingsRows,
        standingsRows: projectedStandingsRows,
        leaderboard: projectedStandingsRows,
        rows: projectedStandingsRows,
        projectedIncludesLivePoints,
        projectedUpdatedAtMs: nowMs,
  
        globalApplyStatus:
          worldCupRoundCompleteness.isWorldCupKnockout &&
          worldCupRoundCompleteness.isComplete === false &&
          allFinished
            ? (worldCupRoundCompleteness.isRecognizedRound
                ? "waiting-for-complete-round"
                : "waiting-for-recognized-round")
            : statusValue,
        missingFixtureIds,
        missingRequiredFixtureIds,
        missingFullWindowFixtureCount: missingFixtureIds.length,
        staleInPlayFixtureIds,
        hasStaleInPlayFixtures,
        kickoffPassedUnfinishedFixtureIds,
        hasKickoffPassedUnfinishedFixtures,
        globalApplyMode: "projection-only",
        globalApplyWarning: allFinished
          ? "Final window is finished; this projection did not write cupHistory or finalResults."
          : "",
  
        updatedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (legacyCurrentWindowCreditDetected) {
        Object.assign(cupUpdate, {
          windowPointsByUid: {},
          windowBenchPointsByUid: {},
          windowBreakdownByUserId: {},
          breakdownByUserId: {},
          creditedFixtures: {},
        });
      }
  
      await cupRef.set(cupUpdate, { merge: true });
  
      await roomRef.collection("standings").doc("current").set(
        {
          roomId,
          mode: "cup",
          source: "global-live-fixtures",
          projectionOnly: true,
          creditedTotalsByUid: baseTotalsByUid,
          globalBaseTotalsByUid: baseTotalsByUid,
          globalBaseAdjustedForCurrentWindow: legacyCurrentWindowCreditDetected,
          removedLegacyWindowPointsByUid,
          projectedTotalsByUid,
          livePointsByUid: globalTotalsByUid,
          includesLivePoints: projectedIncludesLivePoints,
          standings: projectedStandingsRows,
          projectedStandingsRows,
          leaderboard: projectedStandingsRows,
          rows: projectedStandingsRows,
          standingsRows: projectedStandingsRows,
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
    const fixtureIds = [...new Set(
      (Array.isArray(applyResult?.fixtureIds) ? applyResult.fixtureIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )];
  
    if (fixtureCount <= 0) {
      throw new HttpsError("failed-precondition", "Cup global finalization requires fixtures.");
    }
  
    if (missingFixtureCount !== 0) {
      throw new HttpsError("failed-precondition", "Cup global finalization requires no missing fixtures.");
    }

    const roundCompleteness = getWorldCupKnockoutRoundCompleteness({
      room,
      cup,
      applyResult,
    });
    if (
      roundCompleteness.isWorldCupKnockout &&
      roundCompleteness.isComplete === false
    ) {
      const waitingReason = roundCompleteness.isRecognizedRound
        ? "waiting-for-complete-round"
        : "waiting-for-recognized-round";
      throw new HttpsError(
        "failed-precondition",
        roundCompleteness.isRecognizedRound
          ? "Cup global finalization is waiting for the complete World Cup knockout round."
          : "Cup global finalization is waiting for a recognized World Cup knockout round label.",
        {
          reason: waitingReason,
          roundKey: roundCompleteness.roundKey || null,
          expectedFixtureCount: roundCompleteness.expectedFixtureCount || null,
          discoveredFixtureCount: roundCompleteness.discoveredFixtureCount || null,
        }
      );
    }

    if (
      applyResult?.hasStaleInPlayFixtures === true ||
      (Array.isArray(applyResult?.staleInPlayFixtureIds) &&
        applyResult.staleInPlayFixtureIds.length > 0)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Cup global finalization requires explicit FT, AET, or PEN status for every fixture."
      );
    }

    const coverageByFixtureId = new Map(
      (Array.isArray(applyResult?.fixtureCoverage) ? applyResult.fixtureCoverage : [])
        .map((coverage) => [String(coverage?.fixtureId || ""), coverage])
        .filter(([fixtureId]) => Boolean(fixtureId))
    );
    const hasOnlyExplicitFinishedStatuses =
      fixtureIds.length > 0 &&
      fixtureIds.every((fixtureId) =>
        isFinished(coverageByFixtureId.get(String(fixtureId))?.statusShort)
      );
    if (!hasOnlyExplicitFinishedStatuses) {
      throw new HttpsError(
        "failed-precondition",
        "Cup global finalization requires explicit FT, AET, or PEN status for every fixture."
      );
    }
  
    if (applyResult?.allFinished !== true || statusValue !== "final") {
      throw new HttpsError("failed-precondition", "Cup global finalization requires a final window.");
    }
  
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
    const cupGlobalBase = getCupGlobalBaseTotalsForProjection(cup, fixtureIds);
    const previousCupTotalsByUid = cupGlobalBase.baseTotalsByUid || {};
    const nextCupTotalsByUid = addCupGlobalNumberMaps(
      previousCupTotalsByUid,
      windowPointsByUid
    );
  
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
      fixtureCount,
      fixtures: Array.isArray(cup?.currentWindowFixtures) ? cup.currentWindowFixtures : [],
      fixtureCoverage: applyResult?.fixtureCoverage || [],
      fixtureStatusById: applyResult?.fixtureStatusById || {},
      windowPointsByUid,
      windowBenchPointsByUid,
      breakdownByUserId: windowBreakdownByUserId,
      previousCupTotalsByUid,
      originalCupTotalsByUid: cupGlobalBase.existingCupTotalsByUid || {},
      removedLegacyWindowPointsByUid:
        cupGlobalBase.removedLegacyWindowPointsByUid || {},
      creditedCurrentWindowFixtureIds:
        cupGlobalBase.creditedCurrentWindowFixtureIds || [],
      legacyCurrentWindowCreditDetected:
        cupGlobalBase.legacyCurrentWindowCreditDetected === true,
      cupTotalsByUid: nextCupTotalsByUid,
      cupTotalsAfterByUid: nextCupTotalsByUid,
      standingsRows,
      rows: standingsRows,
      top3,
      startAtMs: cup?.currentWindowStartAtMs || null,
      endAtMs: cup?.currentWindowEndAtMs || null,
      closedAtMs: nowMs,
      closedAt: FieldValue.serverTimestamp(),
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

    const roundCompleteness = getWorldCupKnockoutRoundCompleteness({
      room,
      cup,
      applyResult,
    });
    if (
      roundCompleteness.isWorldCupKnockout &&
      roundCompleteness.isComplete === false
    ) {
      const waitingReason = roundCompleteness.isRecognizedRound
        ? "waiting-for-complete-round"
        : "waiting-for-recognized-round";
      await db.doc(`rooms/${roomId}/cup/current`).set(
        {
          source: "global-live-fixtures",
          globalApplyStatus: waitingReason,
          currentWindowRoundKey: roundCompleteness.roundKey || null,
          expectedFixtureCount: roundCompleteness.expectedFixtureCount || null,
          discoveredFixtureCount: roundCompleteness.discoveredFixtureCount || null,
          worldCupKnockoutRoundComplete: false,
          nextPollAtMs: nowMs + CUP_GLOBAL_PREGAME_POLL_MS,
          updatedAtMs: nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      throw new HttpsError(
        "failed-precondition",
        roundCompleteness.isRecognizedRound
          ? "Cup global finalization is waiting for the complete World Cup knockout round."
          : "Cup global finalization is waiting for a recognized World Cup knockout round label.",
        {
          reason: waitingReason,
          roundKey: roundCompleteness.roundKey || null,
          expectedFixtureCount: roundCompleteness.expectedFixtureCount || null,
          discoveredFixtureCount: roundCompleteness.discoveredFixtureCount || null,
        }
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
        globalBaseTotalsByUid: payload.nextCupTotalsByUid,
        globalBaseAdjustedForCurrentWindow: false,
        removedLegacyWindowPointsByUid: {},
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
        creditedTotalsByUid: payload.nextCupTotalsByUid,
        cupTotalsByUid: payload.nextCupTotalsByUid,
        globalBaseTotalsByUid: payload.nextCupTotalsByUid,
        projectedTotalsByUid: payload.nextCupTotalsByUid,
        standings: payload.standingsRows,
        projectedStandingsRows: payload.standingsRows,
        leaderboard: payload.standingsRows,
        rows: payload.standingsRows,
        standingsRows: payload.standingsRows,
        includesLivePoints: false,
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
    armNextCupGlobalWindowFromCache,
    reconcileCupGlobalCurrentWindowFromCache,
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
