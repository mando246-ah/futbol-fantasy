// src/pages/TournamentPage/WorldCupTournamentPage.jsx
import { useEffect, useMemo, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { doc, onSnapshot, collection, query, orderBy, limit, getDocs } from "firebase/firestore";

import { useLineupsForUsers, useTournament } from "../../tournament/hooks/useTournament";
import { scorePlayerFromCore, toCorePos } from "../../tournament/logic/scoringCoreClient";
import { auth, db } from "../../firebase";
import { buildTournamentPlayerResolver } from "./tournamentPlayerResolver";
import { useTargetedTournamentPlayers } from "./useTargetedTournamentPlayers";

import "./TournamentPage.css";
import "./WorldCupTournamentPage.css";
import { Avatar, AvatarImage, AvatarFallback } from "../../components/ui/avatar";
import FlagIcon from "../../components/FlagIcon";
import FinalResultsCard from "../../components/ui/FinalResultsCard";

const SCORING_DISPLAY = [
  { label: "Appearance", detail: "+1 (any minutes)" },
  { label: "Played 60+ mins", detail: "+1 (60+ minutes)" },

  { label: "Goals", detail: "FWD: +4 • MID: +5 • DEF/GK: +6" },
  { label: "Assists", detail: "+3" },

  { label: "Clean Sheet (60+ mins)", detail: "DEF/GK: +4 • MID: +1 • FWD: +0" },
  { label: "Saves (GK)", detail: "+1 per 2 saves" },
  { label: "Goals Conceded", detail: "-1 per 2 conceded (DEF/GK)" },

  { label: "Yellow Card", detail: "-1" },
  { label: "Red Card", detail: "-3" },

  { label: "Rating 8.5+", detail: "+3" },

  { label: "Penalties Saved (GK)", detail: "+5" },
  { label: "Penalties Missed", detail: "-2" },
  { label: "Penalties Committed", detail: "-1" },

  { label: "Passing Total", detail: "GK: 30 • DEF/MID: 25 • FWD: 20 = +1" },

  { label: "Tackles", detail: "+1 per 2" },
  { label: "Duels Won", detail: "+1 per 4" },
  { label: "Dribbles Success", detail: "+1 per 2" },

  { label: "Fouls Committed", detail: "-1 per 2" },
  { label: "Offsides", detail: "-1 per 3" },

  { label: "Shots on Target", detail: "+1 each" },
];

const WORLD_CUP_UI_RESET_BEFORE_NEXT_DAY_MS = 60 * 60 * 1000;

const WORLD_CUP_FLAG_MARQUEE = [
  "United States",
  "Mexico",
  "Canada",
  "Brazil",
  "Argentina",
  "Uruguay",
  "Colombia",
  "Ecuador",
  "France",
  "Spain",
  "Portugal",
  "Germany",
  "Italy",
  "Netherlands",
  "Belgium",
  "Croatia",
  "England",
  "Japan",
  "South Korea",
  "Australia",
  "Morocco",
  "Nigeria",
  "Senegal",
  "Ghana",
  "Tunisia",
  "Saudi Arabia",
  "Qatar",
  "Iran",
  "Costa Rica",
  "Panama",
  "Paraguay",
  "Chile",
];

const STAT_LABELS = {
  // Core
  base: "Appearance",
  appearance: "Appearance",
  sixtyPlus: "Played 60+ mins",
  goals: "Goals",
  assists: "Assists",
  cleanSheet: "Clean sheet (60+ mins)",
  saves: "Saves",
  goalsConceded: "Goals conceded",
  yellow: "Yellow card",
  red: "Red card",
  ownGoals: "Own goal",

  // Penalties
  pensSaved: "Penalty saved",
  pensMissed: "Penalty missed",
  pensCommitted: "Penalty committed",

  // Passing
  passesCompleted: "Passes completed",

  // Advanced
  tackles: "Tackles",
  duelsWon: "Duels won",
  dribblesSuccess: "Dribbles (successful)",
  foulsCommitted: "Fouls committed",
  offsides: "Offsides",
  shotsOnTarget: "Shots on target",
  rating: "Rating",
  rating85: "Rating 8.5+",

  minutes: "Minutes played",
  pensScored: "Penalty scored",
  dribbles: "Dribbles",
  duels: "Duels",
  shotsOn: "Shots on target",
  kickoffMs: "Kickoff",
  kickoffAtMs: "Kickoff",
};

function prettyStatLabel(key) {
  if (!key) return "";
  if (STAT_LABELS[key]) return STAT_LABELS[key];

  // fallback: camelCase / snake_case -> Title Case
  const s = String(key)
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();

  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- Helpers ---
function initials(s) {
  const t = String(s || "").trim();
  if (!t) return "U";
  const parts = t.split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase()).join("") || "U";
}

function fmtDT(v) {
  if (!v) return "—";
  const LOCALE = "en-US";
  const OPTS = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true };
  const ms = Number(v);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(LOCALE, OPTS);
}

const DISPLAY_POS_ORDER = { ATT: 0, MID: 1, DEF: 2, GK: 3 };

function normalizeDisplayPos(pos) {
  const p = String(pos || "").toUpperCase().trim();
  if (["ATT", "ATK", "FWD", "FW", "ST", "CF", "LW", "RW"].includes(p)) return "ATT";
  if (["MID", "CM", "CDM", "CAM", "LM", "RM"].includes(p)) return "MID";
  if (["DEF", "CB", "LB", "RB", "LWB", "RWB"].includes(p)) return "DEF";
  if (["GK", "G"].includes(p)) return "GK";
  return p;
}

function sortPlayersForDisplay(list = []) {
  return [...list].sort((a, b) => {
    const aRank = DISPLAY_POS_ORDER[normalizeDisplayPos(a.position)] ?? 99;
    const bRank = DISPLAY_POS_ORDER[normalizeDisplayPos(b.position)] ?? 99;
    if (aRank !== bRank) return aRank - bRank;
    return (a.name || "").localeCompare(b.name || "");
  });
}

function hasBreakdownMap(breakdown) {
  return !!(breakdown && Object.keys(breakdown).length > 0);
}

function sumDisplayedPoints(list = []) {
  return (list || []).reduce((sum, p) => sum + Number(p?.points || 0), 0);
}

function mainPointsClass(points) {
  const n = Number(points);
  if (Number.isFinite(n) && n > 0) return "tpPtsPositive";
  if (Number.isFinite(n) && n < 0) return "tpPtsNegative";
  return "tpPtsZero";
}

function sortCupLeaderboardRows(rows = []) {
  return [...rows].sort((a, b) => {
    const aFantasy = Number(a.totalFantasyPoints ?? a.totalPoints ?? 0);
    const bFantasy = Number(b.totalFantasyPoints ?? b.totalPoints ?? 0);
    if (bFantasy !== aFantasy) return bFantasy - aFantasy;

    const aTable = Number(a.tablePoints ?? 0);
    const bTable = Number(b.tablePoints ?? 0);
    if (bTable !== aTable) return bTable - aTable;

    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function buildWorldCupLiveLeaderboardFromResult(
  dayResult = {},
  managersByUid = {}
) {
  if (!dayResult || typeof dayResult !== "object") return [];

  const rowsByUid = new Map();

  for (const [uid, manager] of Object.entries(managersByUid || {})) {
    const cleanUid = String(uid || "");
    if (!cleanUid) continue;
    rowsByUid.set(cleanUid, {
      uid: cleanUid,
      userId: cleanUid,
      displayName: manager?.displayName || manager?.name || "Manager",
      name: manager?.name || manager?.displayName || "Manager",
      teamName: manager?.teamName || "",
      totalFantasyPoints: 0,
      totalPoints: 0,
      points: 0,
    });
  }

  for (const row of Array.isArray(dayResult.dailyLeaderboard)
    ? dayResult.dailyLeaderboard
    : []) {
    const uid = String(row?.uid || row?.userId || "");
    if (!uid) continue;
    const manager = managersByUid?.[uid] || {};
    const points = Number(
      row?.points ??
        row?.totalFantasyPoints ??
        dayResult.teamScoresByUserId?.[uid] ??
        0
    );

    rowsByUid.set(uid, {
      ...(rowsByUid.get(uid) || {}),
      ...row,
      uid,
      userId: uid,
      displayName:
        row?.displayName ||
        row?.name ||
        manager?.displayName ||
        manager?.name ||
        "Manager",
      name:
        row?.name ||
        row?.displayName ||
        manager?.name ||
        manager?.displayName ||
        "Manager",
      teamName: row?.teamName || manager?.teamName || "",
      totalFantasyPoints: points,
      totalPoints: points,
      points,
    });
  }

  for (const [uid, rawPoints] of Object.entries(
    dayResult.teamScoresByUserId || {}
  )) {
    const cleanUid = String(uid || "");
    if (!cleanUid) continue;
    const manager = managersByUid?.[cleanUid] || {};
    const points = Number(rawPoints || 0);
    const existing = rowsByUid.get(cleanUid) || {};

    rowsByUid.set(cleanUid, {
      ...existing,
      uid: cleanUid,
      userId: cleanUid,
      displayName:
        existing.displayName ||
        manager?.displayName ||
        manager?.name ||
        "Manager",
      name:
        existing.name ||
        manager?.name ||
        manager?.displayName ||
        "Manager",
      teamName: existing.teamName || manager?.teamName || "",
      totalFantasyPoints: points,
      totalPoints: points,
      points,
    });
  }

  return [...rowsByUid.values()]
    .sort((a, b) => {
      const pointDiff = Number(b.points || 0) - Number(a.points || 0);
      if (pointDiff !== 0) return pointDiff;
      return String(a.displayName || a.name || "").localeCompare(
        String(b.displayName || b.name || "")
      );
    })
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }));
}

function buildWorldCupLiveLeaderboardFromBreakdowns(
  breakdownByUserId = {},
  managersByUid = {}
) {
  if (!breakdownByUserId || typeof breakdownByUserId !== "object") return [];

  return Object.entries(breakdownByUserId)
    .map(([uid, breakdown]) => {
      const manager = managersByUid?.[uid] || {};
      const starterTotal = Number(
        breakdown?.total ??
          (Array.isArray(breakdown?.starters)
            ? breakdown.starters.reduce(
                (sum, player) => sum + Number(player?.points || 0),
                0
              )
            : 0)
      );

      return {
        uid,
        userId: uid,
        displayName:
          breakdown?.displayName ||
          manager?.displayName ||
          manager?.name ||
          "Manager",
        name:
          breakdown?.displayName ||
          manager?.name ||
          manager?.displayName ||
          "Manager",
        teamName: breakdown?.teamName || manager?.teamName || "",
        totalFantasyPoints: starterTotal,
        totalPoints: starterTotal,
        points: starterTotal,
      };
    })
    .sort((a, b) => {
      const diff =
        Number(b.totalPoints || 0) - Number(a.totalPoints || 0);
      if (diff) return diff;
      return String(a.displayName || a.name || "").localeCompare(
        String(b.displayName || b.name || "")
      );
    })
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }));
}

function sumNumberMaps(base = {}, add = {}) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(add || {})) {
    const uid = String(key || "");
    if (!uid) continue;
    out[uid] = Number(out[uid] || 0) + Number(value || 0);
  }
  return out;
}

function buildFixtureTotalsByUid(fixtures = [], fixtureIds = null) {
  const out = {};
  const filterIds = fixtureIds
    ? new Set(Array.from(fixtureIds).map((id) => String(id)).filter(Boolean))
    : null;

  for (const fx of fixtures || []) {
    const fixtureId = String(fx?.fixtureId || fx?.id || "");
    if (filterIds && !filterIds.has(fixtureId)) continue;

    for (const [uid, pts] of Object.entries(fx?.pointsByUid || {})) {
      const key = String(uid || "");
      if (!key) continue;
      out[key] = Number(out[key] || 0) + Number(pts || 0);
    }
  }

  return out;
}

function sortCupHistoryRows(rows = []) {
  return [...rows]
    .sort((a, b) => {
      const aTotal = Number(a?.totalAfter || 0);
      const bTotal = Number(b?.totalAfter || 0);
      if (bTotal !== aTotal) return bTotal - aTotal;

      const aRound = Number(a?.roundPoints || 0);
      const bRound = Number(b?.roundPoints || 0);
      if (bRound !== aRound) return bRound - aRound;

      return String(a?.name || "").localeCompare(String(b?.name || ""));
    })
    .map((row, idx) => ({ ...row, rank: idx + 1 }));
}

function normalizeCupHistoryRounds(rounds = [], userById = {}) {
  const asc = [...(rounds || [])].sort(
    (a, b) =>
      Number(a?.closedAtMs || a?.endAtMs || a?.startAtMs || 0) -
      Number(b?.closedAtMs || b?.endAtMs || b?.startAtMs || 0)
  );

  const cumulativeByUid = {};
  const normalizedAsc = asc.map((round) => {
    const rowMap = new Map();
    for (const row of Array.isArray(round?.rows) ? round.rows : []) {
      const uid = String(row?.userId || row?.uid || "");
      if (!uid) continue;
      rowMap.set(uid, row);
    }

    const uids = new Set([
      ...Array.from(rowMap.keys()),
      ...Object.keys(round?.windowPointsByUid || {}).map(String),
      ...Object.keys(round?.cupTotalsAfterByUid || {}).map(String),
    ]);

    const rowsForRound = Array.from(uids).map((uid) => {
      const rawRow = rowMap.get(uid) || {};
      const roundPoints = Number(
        rawRow?.roundPoints ?? round?.windowPointsByUid?.[uid] ?? 0
      );

      cumulativeByUid[uid] = Number(cumulativeByUid[uid] || 0) + roundPoints;

      return {
        ...rawRow,
        userId: uid,
        uid,
        name:
          rawRow?.name ||
          userById?.[uid]?.name ||
          userById?.[uid]?.displayName ||
          "Unknown",
        roundPoints,
        totalAfter: cumulativeByUid[uid],
      };
    });

    return {
      ...round,
      cupTotalsAfterByUid: { ...cumulativeByUid },
      rows: sortCupHistoryRows(rowsForRound),
    };
  });

  return normalizedAsc.sort(
    (a, b) =>
      Number(b?.closedAtMs || b?.endAtMs || b?.startAtMs || 0) -
      Number(a?.closedAtMs || a?.endAtMs || a?.startAtMs || 0)
  );
}

function normalizeWorldCupEntry(entry = {}, counted = true) {
  const id = String(entry?.playerId || entry?.id || entry?.pid || "");
  if (!id) return null;

  return {
    id,
    playerId: id,
    name: entry?.playerName || entry?.name || "Unknown",
    position: entry?.position || "MID",
    points: Number(entry?.points || 0),
    counted,
    stats: entry?.stats || entry?.rawStats || null,
    rawStats: entry?.rawStats || entry?.stats || null,
    breakdown: entry?.breakdown || null,
    teamName: entry?.teamName || "",
    opponentName: entry?.opponentName || "",
    country: entry?.country || entry?.nationality || "",
    clubName: entry?.clubName || entry?.teamName || "",
    fixtureId: entry?.fixtureId || null,
  };
}

function entriesToPerPlayer(entries = [], counted = true) {
  const perPlayer = {};

  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = normalizeWorldCupEntry(raw, counted);
    if (!entry?.id) continue;

    const prev = perPlayer[entry.id] || {
      ...entry,
      points: 0,
      stats: {},
      rawStats: {},
      breakdown: {},
    };

    const mergedBreakdown = { ...(prev.breakdown || {}) };
    for (const [key, value] of Object.entries(entry.breakdown || {})) {
      mergedBreakdown[key] = Number(mergedBreakdown[key] || 0) + Number(value || 0);
    }

    perPlayer[entry.id] = {
      ...prev,
      ...entry,
      points: Number(prev.points || 0) + Number(entry.points || 0),
      stats: { ...(prev.stats || {}), ...(entry.stats || {}) },
      rawStats: { ...(prev.rawStats || {}), ...(entry.rawStats || {}) },
      breakdown: mergedBreakdown,
    };
  }

  return perPlayer;
}

function normalizeWorldCupDayResults(days = [], userById = {}) {
  const asc = [...(days || [])].sort(
    (a, b) => Number(a?.dayIndex || 0) - Number(b?.dayIndex || 0)
  );

  const cumulativeByUid = {};

  const normalizedAsc = asc.map((day) => {
    const dayIndex = Number(day?.dayIndex || 0);
    const breakdownByUserId = {};
    const benchByUserId = {};
    const rowsByUid = new Map();

    for (const [uid, entries] of Object.entries(day?.breakdownByUserId || {})) {
      const userId = String(uid || "");
      if (!userId) continue;

      if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        const starters = Array.isArray(entries.starters)
          ? entries.starters.map((entry) => normalizeWorldCupEntry(entry, true)).filter(Boolean)
          : Object.values(entries.perPlayer || {})
              .filter((entry) => entry?.counted !== false)
              .map((entry) => normalizeWorldCupEntry(entry, true))
              .filter(Boolean);
        const bench = Array.isArray(entries.bench)
          ? entries.bench.map((entry) => normalizeWorldCupEntry(entry, false)).filter(Boolean)
          : Object.values(entries.perPlayer || {})
              .filter((entry) => entry?.counted === false)
              .map((entry) => normalizeWorldCupEntry(entry, false))
              .filter(Boolean);
        const perPlayer = {
          ...entriesToPerPlayer(starters, true),
          ...entriesToPerPlayer(bench, false),
        };
        const total = Number(
          entries.total ??
            starters.reduce((sum, entry) => sum + Number(entry?.points || 0), 0)
        );
        const benchTotal = Number(
          entries.benchTotal ??
            bench.reduce((sum, entry) => sum + Number(entry?.points || 0), 0)
        );

        breakdownByUserId[userId] = {
          ...entries,
          total,
          benchTotal,
          perPlayer,
          starters,
          bench,
        };
        benchByUserId[userId] = bench;
        continue;
      }

      const perPlayer = entriesToPerPlayer(entries, true);
      const total = Object.values(perPlayer).reduce(
        (sum, entry) => sum + Number(entry?.points || 0),
        0
      );
      breakdownByUserId[userId] = { total, benchTotal: 0, perPlayer };
    }

    for (const [uid, entries] of Object.entries(day?.benchByUserId || {})) {
      const userId = String(uid || "");
      if (!userId) continue;
      const benchEntries = (Array.isArray(entries) ? entries : [])
        .map((entry) => normalizeWorldCupEntry(entry, false))
        .filter(Boolean);
      const benchTotal = benchEntries.reduce(
        (sum, entry) => sum + Number(entry?.points || 0),
        0
      );
      benchByUserId[userId] = benchEntries;
      breakdownByUserId[userId] = {
        ...(breakdownByUserId[userId] || { total: 0, perPlayer: {} }),
        benchTotal,
      };
    }

    for (const row of Array.isArray(day?.dailyLeaderboard) ? day.dailyLeaderboard : []) {
      const uid = String(row?.userId || row?.uid || "");
      if (!uid) continue;
      rowsByUid.set(uid, row);
    }

    for (const [uid, points] of Object.entries(day?.teamScoresByUserId || {})) {
      if (!rowsByUid.has(uid)) rowsByUid.set(uid, { uid, points });
    }

    for (const uid of Object.keys(userById || {})) {
      if (!rowsByUid.has(uid)) rowsByUid.set(uid, { uid, points: 0 });
    }

    const rows = Array.from(rowsByUid.entries()).map(([uid, row]) => {
      const dayPoints = Number(row?.points ?? day?.teamScoresByUserId?.[uid] ?? 0);
      cumulativeByUid[uid] = Number(cumulativeByUid[uid] || 0) + dayPoints;

      return {
        ...row,
        userId: uid,
        uid,
        name:
          row?.name ||
          row?.displayName ||
          userById?.[uid]?.name ||
          userById?.[uid]?.displayName ||
          "Unknown",
        roundPoints: dayPoints,
        totalAfter: cumulativeByUid[uid],
      };
    });

    return {
      ...day,
      id: day?.id || `day-${dayIndex}`,
      label: day?.label || `Day ${dayIndex}`,
      dateLabel: day?.dateLabel || "",
      startAtMs: day?.startAtMs || day?.fixtures?.[0]?.kickoffMs || null,
      endAtMs: day?.endAtMs || day?.fixtures?.[day?.fixtures?.length - 1]?.kickoffMs || null,
      breakdownByUserId,
      benchByUserId,
      rows: sortCupHistoryRows(rows),
      isWorldCupDailyResult: true,
    };
  });

  return normalizedAsc.sort(
    (a, b) => Number(b?.dayIndex || 0) - Number(a?.dayIndex || 0)
  );
}

function dayIndexOf(day = {}) {
  const direct = Number(day?.dayIndex);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const fromId = Number(String(day?.id || "").replace(/^day-/, ""));
  return Number.isFinite(fromId) && fromId > 0 ? fromId : null;
}

function statusLowerOf(value) {
  return String(value || "").trim().toLowerCase();
}

function getDayStartMs(day = {}, room = {}) {
  return (
    Number(day?.firstKickoffMs) ||
    Number(day?.startAtMs) ||
    Number(room?.worldCup?.currentDayStartAtMs) ||
    null
  );
}

function getWorldCupDisplayDayContext({
  days = [],
  dayResultsByIndex = {},
  room = {},
  competitionState = {},
  nowMs = Date.now(),
}) {
  const sortedDays = [...(Array.isArray(days) ? days : [])]
    .map((day) => ({ ...day, dayIndex: dayIndexOf(day) }))
    .filter((day) => Number.isFinite(Number(day.dayIndex)))
    .sort((a, b) => Number(a.dayIndex) - Number(b.dayIndex));

  const resultRows = Object.values(dayResultsByIndex || {})
    .filter(Boolean)
    .map((day) => ({ ...day, dayIndex: dayIndexOf(day) }))
    .filter((day) => Number.isFinite(Number(day.dayIndex)));

  const finalResults = resultRows
    .filter((day) => statusLowerOf(day.status) === "final")
    .sort((a, b) => Number(a.dayIndex) - Number(b.dayIndex));

  const latestFinalResult = finalResults[finalResults.length - 1] || null;
  const latestFinalDayIndex = latestFinalResult ? Number(latestFinalResult.dayIndex) : null;
  const finalDayIndexes = new Set(finalResults.map((day) => String(day.dayIndex)));

  const nextDay = sortedDays.find((day) => {
    const idx = String(day.dayIndex);
    return statusLowerOf(day.status) !== "final" && !finalDayIndexes.has(idx);
  }) || null;
  const nextDayIndex = nextDay ? Number(nextDay.dayIndex) : null;
  const nextDayStartAtMs = nextDay
    ? getDayStartMs(nextDay, room) || Number(competitionState?.nextKickoffMs) || null
    : null;
  const resetAtMs = nextDayStartAtMs
    ? nextDayStartAtMs - WORLD_CUP_UI_RESET_BEFORE_NEXT_DAY_MS
    : null;

  if (latestFinalResult && nextDay) {
    const showingPreviousFinalUntilReset = Boolean(resetAtMs && nowMs < resetAtMs);

    if (showingPreviousFinalUntilReset) {
      return {
        displayDayIndex: latestFinalDayIndex,
        displayDay: sortedDays.find((day) => Number(day.dayIndex) === latestFinalDayIndex) || latestFinalResult,
        displayDayResult: latestFinalResult,
        latestFinalDayIndex,
        nextDayIndex,
        nextDayStartAtMs,
        resetAtMs,
        showingPreviousFinalUntilReset: true,
        shouldShowZeroCurrentDay: false,
      };
    }

    const nextResult = dayResultsByIndex?.[nextDayIndex] || null;
    const nextStatus = statusLowerOf(nextResult?.status);
    return {
      displayDayIndex: nextDayIndex,
      displayDay: nextDay,
      displayDayResult: nextResult,
      latestFinalDayIndex,
      nextDayIndex,
      nextDayStartAtMs,
      resetAtMs,
      showingPreviousFinalUntilReset: false,
      shouldShowZeroCurrentDay:
        !nextResult ||
        ((nextStatus === "scheduled" || nextStatus === "idle") &&
          !worldCupResultHasStats(nextResult) &&
          !worldCupResultHasInPlayFixture(nextResult)),
    };
  }

  if (latestFinalResult && !nextDay) {
    return {
      displayDayIndex: latestFinalDayIndex,
      displayDay: sortedDays.find((day) => Number(day.dayIndex) === latestFinalDayIndex) || latestFinalResult,
      displayDayResult: latestFinalResult,
      latestFinalDayIndex,
      nextDayIndex: null,
      nextDayStartAtMs: null,
      resetAtMs: null,
      showingPreviousFinalUntilReset: false,
      shouldShowZeroCurrentDay: false,
    };
  }

  const currentDayIndex = Number(room?.worldCup?.currentDayIndex);
  const activeDay =
    (Number.isFinite(currentDayIndex) &&
      sortedDays.find((day) => Number(day.dayIndex) === currentDayIndex)) ||
    nextDay ||
    sortedDays[0] ||
    null;
  const activeDayIndex = activeDay ? Number(activeDay.dayIndex) : null;
  const activeResult = activeDayIndex ? dayResultsByIndex?.[activeDayIndex] || null : null;
  const activeStatus = statusLowerOf(activeResult?.status);

  return {
    displayDayIndex: activeDayIndex,
    displayDay: activeDay,
    displayDayResult: activeResult,
    latestFinalDayIndex: null,
    nextDayIndex: activeDayIndex,
    nextDayStartAtMs: activeDay ? getDayStartMs(activeDay, room) : null,
    resetAtMs: null,
    showingPreviousFinalUntilReset: false,
    shouldShowZeroCurrentDay:
      !activeResult ||
      ((activeStatus === "scheduled" || activeStatus === "idle") &&
        !worldCupResultHasStats(activeResult) &&
        !worldCupResultHasInPlayFixture(activeResult)),
  };
}

function buildEmptyWorldCupDayResult({ day, members = [] }) {
  const dayIndex = dayIndexOf(day);
  const teamScoresByUserId = {};
  const benchScoresByUserId = {};
  const breakdownByUserId = {};
  const startersByUserId = {};
  const benchByUserId = {};

  const zeroPlayer = (player = {}, counted = true) => {
    const id = String(player?.id || player?.playerId || player?.pid || "").trim();
    return {
      ...player,
      id,
      playerId: id,
      points: 0,
      counted,
      stats: {},
      rawStats: {},
      breakdown: {},
    };
  };

  const rows = (Array.isArray(members) ? members : []).map((member, index) => {
    const uid = String(member?.userId || member?.uid || "").trim();
    if (!uid) return null;

    const starters = (Array.isArray(member?.starters) ? member.starters : [])
      .map((player) => zeroPlayer(player, true))
      .filter((player) => player.id);
    const bench = (Array.isArray(member?.bench) ? member.bench : [])
      .map((player) => zeroPlayer(player, false))
      .filter((player) => player.id);

    const perPlayer = {};
    for (const player of [...starters, ...bench]) {
      if (player.id) perPlayer[player.id] = player;
    }

    teamScoresByUserId[uid] = 0;
    benchScoresByUserId[uid] = 0;
    startersByUserId[uid] = starters;
    benchByUserId[uid] = bench;
    breakdownByUserId[uid] = {
      uid,
      userId: uid,
      displayName: member?.displayName || member?.name || "Manager",
      teamName: member?.teamName || "",
      total: 0,
      benchTotal: 0,
      perPlayer,
      starters,
      bench,
    };

    return {
      rank: index + 1,
      uid,
      userId: uid,
      name: member?.name || member?.displayName || "Manager",
      displayName: member?.displayName || member?.name || "Manager",
      teamName: member?.teamName || "",
      points: 0,
      roundPoints: 0,
      totalAfter: 0,
    };
  }).filter(Boolean);

  return {
    id: dayIndex ? `day-${dayIndex}` : "day-current",
    dayIndex,
    label: day?.label || (dayIndex ? `Day ${dayIndex}` : "Current Day"),
    dateLabel: day?.dateLabel || "",
    startAtMs: day?.startAtMs || null,
    endAtMs: day?.endAtMs || null,
    fixtureIds: Array.isArray(day?.fixtureIds) ? day.fixtureIds : [],
    fixtures: Array.isArray(day?.fixtures) ? day.fixtures : [],
    status: "scheduled",
    teamScoresByUserId,
    benchScoresByUserId,
    breakdownByUserId,
    startersByUserId,
    benchByUserId,
    dailyLeaderboard: rows,
    rows,
    isWorldCupDailyResult: true,
  };
}

function firstText(...values) {
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

const LIVE_STATUS_CODES = new Set(["1H", "HT", "2H", "ET", "BT", "P"]);
const FINAL_STATUS_CODES = new Set(["FT", "AET", "PEN"]);

function isLiveStatusCode(value) {
  return LIVE_STATUS_CODES.has(String(value || "").trim().toUpperCase());
}

function isFinalStatusCode(value) {
  return FINAL_STATUS_CODES.has(String(value || "").trim().toUpperCase());
}

function worldCupResultHasInPlayFixture(dayResult = {}) {
  if (dayResult?.anyInPlay === true) return true;

  const fixtureStatuses = [
    ...Object.values(dayResult?.fixtureStatusById || {}),
    ...(Array.isArray(dayResult?.fixtureCoverage)
      ? dayResult.fixtureCoverage.map((fixture) =>
          fixture?.statusShort ||
          fixture?.fixtureStatus ||
          fixture?.matchStatus ||
          ""
        )
      : []),
  ];

  return fixtureStatuses.some(isLiveStatusCode);
}

function worldCupResultHasStats(dayResult = {}) {
  if (!dayResult || typeof dayResult !== "object") return false;

  if (
    Object.values(dayResult?.teamScoresByUserId || {}).some(
      (value) => Number(value || 0) !== 0
    )
  ) {
    return true;
  }

  if (
    Array.isArray(dayResult?.fixtureCoverage) &&
    dayResult.fixtureCoverage.some(
      (row) =>
        Number(row?.rawStatsPlayerCount || row?.statsPlayerCount || 0) > 0
    )
  ) {
    return true;
  }

  for (const userBreakdown of Object.values(
    dayResult?.breakdownByUserId || {}
  )) {
    const perPlayer = userBreakdown?.perPlayer || {};
    for (const entry of Object.values(perPlayer)) {
      const stats = entry?.stats || entry?.rawStats || {};
      const breakdown = entry?.breakdown || {};
      if (stats && Object.keys(stats).length > 0) return true;
      if (breakdown && Object.keys(breakdown).length > 0) return true;
      if (Number(entry?.points || 0) !== 0) return true;
    }
  }

  return false;
}

function getWorldCupGroupDisplayStatus(dayResult = null, room = {}) {
  const resultStatus = String(dayResult?.status || "").trim().toLowerCase();
  const resultWeekStatus = String(dayResult?.weekStatus || "").trim().toLowerCase();

  if (resultStatus === "live") return "live";
  if (resultStatus === "resolving") return "resolving";
  if (worldCupResultHasInPlayFixture(dayResult || {})) return "live";
  if (["final", "complete", "completed"].includes(resultStatus)) return "final";
  if (resultStatus) return resultStatus;
  if (resultWeekStatus === "live") return "live";
  if (resultWeekStatus === "resolving") return "resolving";
  if (["final", "complete", "completed"].includes(resultWeekStatus)) return "final";
  if (resultWeekStatus) return resultWeekStatus;

  return String(
    room?.worldCup?.weekStatus ||
    room?.worldCup?.status ||
    room?.competitionState?.weekStatus ||
    room?.["competitionState.weekStatus"] ||
    room?.status ||
    "scheduled"
  ).trim().toLowerCase();
}

function isPlayerLiveFromStats(stats = {}) {
  const status =
    stats?.statusShort ||
    stats?.fixtureStatus ||
    stats?.matchStatus ||
    "";

  if (isFinalStatusCode(status)) return false;

  return Boolean(stats?.isLive) || isLiveStatusCode(status);
}

function statsFromEntry(entry = {}) {
  return entry?.stats || entry?.rawStats || {};
}

function getPlayerCountry(player = {}, entry = null) {
  return firstText(
    player?.country,
    player?.nationality,
    player?.playerCountry,
    player?.birthCountry,
    entry?.country,
    entry?.nationality,
    entry?.playerCountry
  );
}

function getPlayerClub(player = {}, entry = null) {
  const stats = statsFromEntry(entry || {});
  return firstText(
    stats?.teamName,
    stats?.realTeamName,
    stats?.clubName,

    entry?.teamName,
    entry?.realTeamName,
    entry?.clubName,
    entry?.club,

    player?.clubName,
    player?.club,
    player?.teamName,
    player?.team?.name,
    "Unknown Team"
  );
}

function getDisplayTeamName(player = {}, entry = null, stats = null) {
  const liveStats = stats || statsFromEntry(entry || {});
  return firstText(
    liveStats?.teamName,
    liveStats?.realTeamName,
    liveStats?.clubName,
    entry?.teamName,
    entry?.realTeamName,
    entry?.clubName,
    player?.teamName,
    player?.clubName,
    player?.club,
    "Unknown Team"
  );
}

function getDisplayOpponentName(player = {}, entry = null, stats = null) {
  const liveStats = stats || statsFromEntry(entry || {});
  return firstText(
    liveStats?.opponentName,
    liveStats?.opponentTeamName,
    entry?.opponentName,
    player?.opponentName,
    "Opponent"
  );
}

function PlayerIdentity({ name, country, club }) {
  return (
    <div className="tpPlayerInfo">
      <span className="tpName">{name}</span>

      {(country || club) && (
        <div className="tpPlayerSubline">
          {country ? (
            <span className="tpPlayerSubItem">
              <FlagIcon country={country} size={14} title={country} />
              <span>{country}</span>
            </span>
          ) : null}
          • {club ? (
            <span className="tpPlayerSubItem tpPlayerClub">{club}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function extractIds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => (typeof x === 'string' ? x : (x.id || x.playerId || x.pid))).filter(Boolean);
}

function UserChip({ user }) {
  const displayName = user?.displayName || user?.name || user?.userId || "Unknown";
  const teamName = user?.teamName || "";
  const photoURL = user?.photoURL || "";

  return (
    <div className="tpUserChip">
      <Avatar className="tpAvatar">
        <AvatarImage src={photoURL || undefined} alt={displayName} />
        <AvatarFallback>{initials(displayName)}</AvatarFallback>
      </Avatar>

      <div className="tpUserText">
        <div className="tpUserName">{displayName}</div>
        {teamName ? <div className="tpUserTeam">{teamName}</div> : null}
      </div>
    </div>
  );
}

const LIVE_TIMER_STATUSES = new Set(["1H", "2H", "ET"]);
const HOLD_TIMER_STATUSES = new Set(["HT", "BT", "P"]);
const FINISHED_TIMER_STATUSES = new Set(["FT", "AET", "PEN"]);
const MAX_DISPLAY_EXTRA_MINUTES = 30;

function timerStatusOf(stats = {}) {
  return String(
    stats?.statusShort ||
    stats?.fixtureStatus ||
    stats?.matchStatus ||
    stats?.fixture?.status?.short ||
    ""
  ).toUpperCase();
}

function formatClockSeconds(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function liveTimerKickoffMs(stats = {}) {
  const raw =
    stats?.kickoffMs ??
    stats?.kickoffAtMs ??
    stats?.startAtMs ??
    stats?.fixture?.timestamp ??
    stats?.timestamp ??
    null;
  const numeric = Number(raw);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(
    stats?.fixture?.date ||
      stats?.date ||
      stats?.kickoff ||
      stats?.startAt ||
      ""
  );
  return Number.isFinite(parsed) ? parsed : null;
}

function getLiveTimerDisplay(stats, nowMs, localElapsedBaseMs = null) {
  const status = timerStatusOf(stats);

  if (!status || status === "NS" || status === "TBD") return null;

  if (FINISHED_TIMER_STATUSES.has(status)) {
    return { main: status, extra: "", kind: "final" };
  }

  if (status === "HT") {
    const apiExtra = Number(
      stats?.extra ??
      stats?.stoppageTime ??
      stats?.fixture?.status?.extra ??
      0
    );
    const extra =
      Number.isFinite(apiExtra) &&
      apiExtra > 0 &&
      apiExtra <= MAX_DISPLAY_EXTRA_MINUTES
        ? `+${Math.floor(apiExtra)}`
        : "";
    return { main: "HT 45:00", extra, kind: "hold" };
  }

  if (status === "BT") {
    return { main: "ET 90:00", extra: "", kind: "hold" };
  }

  if (status === "P") {
    return { main: "PENS", extra: "", kind: "hold" };
  }

  const apiElapsed = Number(
    stats?.elapsed ??
    stats?.timerElapsed ??
    stats?.matchElapsed ??
    stats?.fixture?.status?.elapsed
  );
  const apiExtra = Number(
    stats?.extra ??
    stats?.stoppageTime ??
    stats?.fixture?.status?.extra ??
    0
  );
  const kickoffMs = liveTimerKickoffMs(stats);
  const hasApiElapsed = Number.isFinite(apiElapsed) && apiElapsed > 0;

  let seconds = null;

  if (hasApiElapsed) {
    const baseMs = Number(localElapsedBaseMs || 0);
    const localSeconds =
      Number.isFinite(baseMs) && baseMs > 0 && nowMs > baseMs
        ? Math.floor((nowMs - baseMs) / 1000)
        : 0;

    // API-Football elapsed can lag by about a minute. Animate locally, but
    // never let the display drift multiple minutes ahead of the API minute.
    const cappedLocalSeconds = LIVE_TIMER_STATUSES.has(status)
      ? Math.min(Math.max(0, localSeconds), 90)
      : 0;

    seconds = Math.floor(apiElapsed * 60) + cappedLocalSeconds;
  } else if (
    LIVE_TIMER_STATUSES.has(status) &&
    Number.isFinite(kickoffMs) &&
    kickoffMs > 0 &&
    nowMs >= kickoffMs
  ) {
    const wallClockSeconds = Math.max(
      0,
      Math.floor((nowMs - kickoffMs) / 1000)
    );

    if (status === "1H") {
      seconds = Math.min(wallClockSeconds, 45 * 60);
    } else if (status === "2H") {
      seconds = Math.min(
        90 * 60,
        Math.max(45 * 60, wallClockSeconds - 15 * 60)
      );
    } else if (status === "ET") {
      seconds = Math.min(
        120 * 60,
        Math.max(90 * 60, wallClockSeconds - 20 * 60)
      );
    }
  }

  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  let capSeconds = null;
  if (status === "1H") capSeconds = 45 * 60;
  if (status === "2H") capSeconds = 90 * 60;
  if (status === "ET") capSeconds = 120 * 60;

  let extra = "";

  if (capSeconds && seconds > capSeconds) {
    const computedExtra = Math.min(
      MAX_DISPLAY_EXTRA_MINUTES,
      Math.ceil((seconds - capSeconds) / 60)
    );
    const safeApiExtra =
      Number.isFinite(apiExtra) && apiExtra > 0 && apiExtra <= MAX_DISPLAY_EXTRA_MINUTES
        ? Math.floor(apiExtra)
        : 0;

    extra = `+${Math.max(computedExtra, safeApiExtra)}`;
    seconds = capSeconds;
  } else if (Number.isFinite(apiExtra) && apiExtra > 0 && apiExtra <= MAX_DISPLAY_EXTRA_MINUTES) {
    extra = `+${Math.floor(apiExtra)}`;
  }

  return {
    main: formatClockSeconds(seconds),
    extra,
    kind: "live",
    totalSeconds: seconds,
  };
}

function PlayerStatsCard({ stats, breakdown, teamName, opponentName }) {
  const hasStats = stats && Object.keys(stats).length > 0;
  const hasBD = breakdown && Object.keys(breakdown).length > 0;

  const [timerNowMs, setTimerNowMs] = useState(Date.now());
  const timerLocalBaseRef = useRef({
    key: "",
    baseMs: Date.now(),
    lastDisplayedSeconds: 0,
  });
  const timerStatus = timerStatusOf(stats);
  const timerApiElapsed = Number(
    stats?.elapsed ??
    stats?.timerElapsed ??
    stats?.matchElapsed ??
    stats?.fixture?.status?.elapsed
  );
  const timerApiExtra = Number(
    stats?.extra ??
    stats?.stoppageTime ??
    stats?.fixture?.status?.extra ??
    0
  );
  const timerKey = [
    timerStatus,
    Number.isFinite(timerApiElapsed) ? timerApiElapsed : "",
    Number.isFinite(timerApiExtra) ? timerApiExtra : "",
  ].join(":");

  useEffect(() => {
    if (!LIVE_TIMER_STATUSES.has(timerStatus)) return;

    const apiBaseSeconds =
      Number.isFinite(timerApiElapsed) && timerApiElapsed > 0
        ? Math.floor(timerApiElapsed * 60)
        : 0;

    if (timerLocalBaseRef.current.key !== timerKey) {
      const previousDisplayed = Number(
        timerLocalBaseRef.current.lastDisplayedSeconds || 0
      );
      const carrySeconds = Math.max(
        0,
        Math.min(90, previousDisplayed - apiBaseSeconds)
      );

      timerLocalBaseRef.current = {
        key: timerKey,
        baseMs: Date.now() - carrySeconds * 1000,
        lastDisplayedSeconds: Math.max(apiBaseSeconds, previousDisplayed),
      };
    }
  }, [timerStatus, timerKey, timerApiElapsed]);

  useEffect(() => {
    if (!LIVE_TIMER_STATUSES.has(timerStatus)) return undefined;

    setTimerNowMs(Date.now());

    const id = window.setInterval(() => {
      setTimerNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(id);
  }, [timerStatus, timerKey]);
  
  const homeTeamName = firstText(stats?.homeTeamName, stats?.homeName);
  const awayTeamName = firstText(stats?.awayTeamName, stats?.awayName);
  const showHomeAwayHeader = Boolean(homeTeamName && awayTeamName);
  const headerTeamName = showHomeAwayHeader
    ? homeTeamName
    : firstText(stats?.teamName, stats?.realTeamName, stats?.clubName, teamName, "Unknown Team");
  const headerOpponentName = showHomeAwayHeader
    ? awayTeamName
    : firstText(stats?.opponentName, stats?.opponentTeamName, opponentName, "Opponent");
  const showMatchHeader = Boolean(headerTeamName || headerOpponentName);

  // ✅ 2. Look for the game score in the raw stats
  // (Adjust these names if your API uses 'homeScore' or 'goalsFor' instead)
  const tScore = showHomeAwayHeader
    ? (stats?.goalsHome ?? stats?.homeGoals ?? stats?.homeScore ?? null)
    : (stats?.teamScore ?? stats?.teamGoals ?? null);
  const oScore = showHomeAwayHeader
    ? (stats?.goalsAway ?? stats?.awayGoals ?? stats?.awayScore ?? null)
    : (stats?.opponentScore ?? stats?.opponentGoals ?? null);
  const hasScore = tScore !== null && oScore !== null;

  const timerDisplay = getLiveTimerDisplay(
    stats,
    timerNowMs,
    timerLocalBaseRef.current.key === timerKey
      ? timerLocalBaseRef.current.baseMs
      : timerNowMs
  );

  useEffect(() => {
    if (!timerDisplay?.totalSeconds) return;
    timerLocalBaseRef.current.lastDisplayedSeconds =
      timerDisplay.totalSeconds;
  }, [timerDisplay?.totalSeconds]);
  const isLiveStatus =
    Boolean(stats?.isLive) ||
    LIVE_TIMER_STATUSES.has(timerStatus) ||
    HOLD_TIMER_STATUSES.has(timerStatus);
  const minutes = Number(stats?.minutes ?? stats?.minutesPlayed ?? 0);
  const showLiveNoAppearanceNote = isLiveStatus && minutes === 0;

  const dividerLabel =
    timerDisplay?.main ||
    (isLiveStatus ? "LIVE" : hasScore ? "FINAL SCORE" : "VS");

  if (!hasStats && !hasBD) {
    return (
      <div className="tpStatsCard">
        <div className="tpStatsGrid">
          <div className="tpStatsCol" style={{ gridColumn: "1 / -1" }}>
            <span className="tpStatsHead" style={{ textTransform: "uppercase" }}>No stats yet</span>
            <div className="tpStatRow">
              <span>Waiting for next games</span>
              <span>—</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const STAT_ORDER = [
    "position",
    "rating",
    "minutes",
    "goals",
    "assists",
    "shotsOnTarget",
    "passesCompleted",
    "tackles",
    "duelsWon",
    "dribblesSuccess",
    "saves",
    "goalsConceded",
    "cleanSheet",
    "yellow",
    "red",
    "foulsCommitted",
    "offsides",
    "sixtyPlus",
    "appearance",
    "kickoffMs",
    "kickoffAtMs",
  ];

  const sortedRawKeys = Object.keys(stats || {}).sort((a, b) => {
    const indexA = STAT_ORDER.indexOf(a);
    const indexB = STAT_ORDER.indexOf(b);
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return a.localeCompare(b);
  });
  const displayRawKeys = showLiveNoAppearanceNote && !sortedRawKeys.includes("minutes")
    ? ["minutes", ...sortedRawKeys]
    : sortedRawKeys;

  const sortedBreakdownKeys = Object.keys(breakdown || {}).sort((a, b) => {
    const indexA = STAT_ORDER.indexOf(a);
    const indexB = STAT_ORDER.indexOf(b);
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return a.localeCompare(b);
  });

  const validBreakdownKeys = sortedBreakdownKeys.filter((k) => {
    const v = breakdown[k];
    return v != null && v !== 0 && v !== "0";
  });

  function formatStatValue(key, value) {
    if (key === "kickoffMs" || key === "kickoffAtMs") {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) return "—";

      return new Date(ms).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    }

    return String(value);
  }

  return (
    <div className="tpStatsCard">
      {showMatchHeader && (
        <div className="tpCardHeader">
          <div className="tpMatchHeaderTeam tpMatchHeaderTeamTop">
            <span className="tpMatchHeaderName">{headerTeamName}</span>
            {hasScore && <span className="tpMatchHeaderScore">{tScore}</span>}
          </div>

          {headerOpponentName && (
            <>
              <div className={`tpMatchHeaderDivider ${timerDisplay?.kind ? `tpMatchHeaderDivider-${timerDisplay.kind}` : ""}`}>
                <span>{dividerLabel}</span>
                {timerDisplay?.extra ? (
                  <span className="tpMatchTimerExtra">{timerDisplay.extra}</span>
                ) : null}
              </div>

              <div className="tpMatchHeaderTeam">
                <span className="tpMatchHeaderName">{headerOpponentName}</span>
                {hasScore && <span className="tpMatchHeaderScore">{oScore}</span>}
              </div>
            </>
          )}
        </div>
      )}

      {showLiveNoAppearanceNote && (
        <div className="tpStatsNote">
          Team is live, but this player has not appeared yet.
        </div>
      )}

      <div className="tpStatsGrid">
        <div className="tpStatsCol">
          <span className="tpStatsHead">Raw Stats</span>
          {displayRawKeys.map((k) => {
            const v = k === "minutes" ? minutes : stats[k];
            if (k !== "minutes" && (v == null || v === false || v === 0 || v === "0")) return null;
            if (k === "minutes" && !showLiveNoAppearanceNote && (v == null || v === false || v === 0 || v === "0")) return null;
            
            // 4. Hide the score keys from the list below so they don't randomly show up twice!
            if (
              k === "isLive" ||
              k === "teamId" ||
              k === "fixtureId" ||
              k === "fixtureStatus" ||
              k === "matchStatus" ||
              k === "statusShort" ||
              k === "statusLong" ||
              k === "elapsed" ||
              k === "extra" ||
              k === "statusUpdatedAtMs" ||
              k === "timerUpdatedAtMs" ||
              k === "teamScore" ||
              k === "opponentScore" ||
              k === "teamGoals" ||
              k === "opponentGoals" ||
              k === "goalsHome" ||
              k === "goalsAway" ||
              k === "homeTeamId" ||
              k === "awayTeamId" ||
              k === "homeTeamName" ||
              k === "awayTeamName" ||
              k === "homeTeamLogo" ||
              k === "awayTeamLogo"
            ) return null;

            return (
              <div key={k} className="tpStatRow">
                <span>{prettyStatLabel(k)}</span>
                <span>{formatStatValue(k, v)}</span>
              </div>
            );
          })}
        </div>

        <div className="tpStatsCol">
          <span className="tpStatsHead">Points</span>
          {validBreakdownKeys.map((k) => {
            const v = breakdown[k];
            return (
              <div key={k} className="tpStatRow">
                <span>{prettyStatLabel(k)}</span>
                <span className={v > 0 ? "tpPos" : "tpNeg"}>
                  {v > 0 ? "+" : ""}{v}
                </span>
              </div>
            );
          })}
          {validBreakdownKeys.length === 0 && (
            <div className="tpStatRow"><span>Appearance</span><span>0</span></div>
          )}
        </div>
      </div>
    </div>
  );
}

function parseCupWindowId(windowId) {
  const s = String(windowId || "");
  const colon = s.lastIndexOf(":");
  if (colon < 0) return null;

  const range = s.slice(colon + 1); // "min-max"
  const dash = range.indexOf("-");
  if (dash < 0) return null;

  const startAtMs = Number(range.slice(0, dash));
  const endAtMs = Number(range.slice(dash + 1));

  if (!Number.isFinite(startAtMs) || !Number.isFinite(endAtMs)) return null;
  return { startAtMs, endAtMs };
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

export default function WorldCupTournamentPage() {
  const { roomId } = useParams();
  const { loading, error, data } = useTournament(roomId, { loadScope: "core", enableLocalFallback: false });
  const [liveRoomDoc, setLiveRoomDoc] = useState(null);
  const room = useMemo(() => {
    const initialRoom = data?.room || {};
    if (!liveRoomDoc) return initialRoom;

    return {
      ...initialRoom,
      ...liveRoomDoc,
      competitionState: {
        ...(initialRoom?.competitionState || {}),
        ...(liveRoomDoc?.competitionState || {}),
      },
      worldCup: {
        ...(initialRoom?.worldCup || {}),
        ...(liveRoomDoc?.worldCup || {}),
      },
    };
  }, [data?.room, liveRoomDoc]);
  const competitionState = room?.competitionState || {};
  const engineType = String(room?.engineType || room?.worldCup?.engineType || "").trim();
  const competitionType = String(room?.competitionType || "").trim();
  const worldCupPhase = String(room?.worldCupPhase || room?.worldCup?.phase || "").trim();
  const competitionKey = String(room?.competitionKey || "").toLowerCase();
  const competitionMetaType = String(room?.competitionMeta?.type || "").toLowerCase();
  const competitionMetaName = String(room?.competitionMeta?.name || room?.competition?.name || "").toLowerCase();
  const isWorldCupRoom = Boolean(
    room?.worldCup ||
    room?.worldCupPhase ||
    competitionMetaType.includes("world cup") ||
    competitionMetaName.includes("world cup") ||
    competitionKey.includes("worldcup") ||
    competitionKey.includes("world-cup")
  );
  const isWorldCupGroupRoom =
    engineType === "worldCupDaily" ||
    (competitionType === "worldCup" && worldCupPhase === "group") ||
    room?.competitionState?.phaseLabel === "WorldCupGroup";
  const isWorldCupKnockoutRoom =
    isWorldCupRoom &&
    !isWorldCupGroupRoom &&
    (
      worldCupPhase.toLowerCase() === "knockout" ||
      String(room?.worldCup?.phase || "").toLowerCase() === "knockout" ||
      engineType === "cupEngine" ||
      room?.competitionState?.phaseLabel === "Cup"
    );
  const worldCupPageTitle = isWorldCupGroupRoom
    ? "World Cup Group Stage"
    : isWorldCupKnockoutRoom
      ? "World Cup Knockouts"
      : "World Cup Tournament";
  const worldCupWindowLabel = isWorldCupGroupRoom ? "Group Stage Games" : "Next Games";
  const worldCupCurrentLabel = isWorldCupGroupRoom ? "Current Day" : "Current Round";
  const worldCupHistoryTitle = isWorldCupGroupRoom ? "Daily Results" : "Knockout Results";
  const worldCupLeaderboardTitle = isWorldCupGroupRoom
    ? "Group Stage Leaderboard"
    : "Knockout Leaderboard";
  const marqueeFlags = [...WORLD_CUP_FLAG_MARQUEE, ...WORLD_CUP_FLAG_MARQUEE];
  const [myUid, setMyUid] = useState(auth.currentUser?.uid || null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  

  // Cup-specific State
  const [cupDoc, setCupDoc] = useState(null);
  const [cupFixtureDocs, setCupFixtureDocs] = useState([]);
  const [standingsDoc, setStandingsDoc] = useState(null);
  const [finalResultsDoc, setFinalResultsDoc] = useState(null);
  //History 
  const [historyEnabled, setHistoryEnabled] = useState(false);
  const [historyRounds, setHistoryRounds] = useState([]);
  const [dayResults, setDayResults] = useState([]);
  const [roomPickDocs, setRoomPickDocs] = useState([]);
  const [currentDayDoc, setCurrentDayDoc] = useState(null);
  const [currentDayResultDoc, setCurrentDayResultDoc] = useState(null);
  const [liveWorldCupDayResult, setLiveWorldCupDayResult] = useState(null);
  const [worldCupDayDocs, setWorldCupDayDocs] = useState([]);
  const [worldCupDisplayDayResultDocs, setWorldCupDisplayDayResultDocs] = useState([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [openHistoryBreakdownKey, setOpenHistoryBreakdownKey] = useState(null);
  
  // Accordion State
  const [expandedPlayerId, setExpandedPlayerId] = useState(null);
  const [expandedOtherUser, setExpandedOtherUser] = useState(null);
  const [showScoring, setShowScoring] = useState(false);
  const scoringRef = useRef(null);

  const activeWorldCupDayIndex = useMemo(() => {
    const candidates = [
      currentDayDoc?.dayIndex,
      room?.worldCup?.currentDayIndex,
      room?.currentDayIndex,
      room?.competitionState?.currentDayIndex,
      1,
    ];

    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }

    return 1;
  }, [
    currentDayDoc?.dayIndex,
    room?.worldCup?.currentDayIndex,
    room?.currentDayIndex,
    room?.competitionState?.currentDayIndex,
  ]);

  useEffect(() => {
    if (!roomId) {
      setLiveRoomDoc(null);
      return undefined;
    }

    return onSnapshot(
      doc(db, "rooms", roomId),
      (snap) => {
        setLiveRoomDoc(
          snap.exists()
            ? {
                id: snap.id,
                ...(snap.data() || {}),
              }
            : null
        );
      },
      (listenerError) => {
        console.error(
          "[WorldCupTournamentPage] room listener failed",
          listenerError
        );
      }
    );
  }, [roomId]);


  useEffect(() => {
    if (!roomId) return;

    return onSnapshot(
      doc(db, "rooms", roomId, "finalResults", "current"),
      (snap) => setFinalResultsDoc(snap.exists() ? snap.data() : null),
      () => setFinalResultsDoc(null)
    );
  }, [roomId]);

  useEffect(() => {
    if (!showScoring) return;

    const onDown = (e) => {
        if (!scoringRef.current) return;
        if (!scoringRef.current.contains(e.target)) setShowScoring(false);
    };

    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    }, [showScoring]);

  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => setMyUid(u?.uid || null));
    return unsub;
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!roomId) {
      setRoomPickDocs([]);
      return () => {
        cancelled = true;
      };
    }

    async function loadRoomPickMetadata() {
      try {
        const picksSnap = await getDocs(
          collection(db, "rooms", roomId, "picks")
        ).catch(() => null);

        if (cancelled) return;

        setRoomPickDocs(
          picksSnap?.docs?.map((d) => ({ id: d.id, _pickDocId: d.id, ...(d.data() || {}) })) || []
        );
      } catch {
        if (!cancelled) {
          setRoomPickDocs([]);
        }
      }
    }

    loadRoomPickMetadata();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Listen to Cup, Lineups, and Picks
  useEffect(() => {
    if (!roomId) return;

    let unsubCup = () => {};
    let unsubCupFixtures = () => {};
    let unsubHistory = () => {};

    if (isWorldCupGroupRoom) {
      setCupDoc(null);
      setCupFixtureDocs([]);
      setHistoryRounds([]);
    } else {
      unsubCup = onSnapshot(
        doc(db, "rooms", roomId, "cup", "current"),
        (snap) => setCupDoc(snap.exists() ? snap.data() : null)
      );

      unsubCupFixtures = onSnapshot(
        collection(db, "rooms", roomId, "cup", "current", "fixtures"),
        (snap) => {
          const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
          setCupFixtureDocs(rows);
        },
        () => setCupFixtureDocs([])
      );

      if (historyEnabled) {
        const historyQ = query(
          collection(db, "rooms", roomId, "cupHistory"),
          orderBy("closedAtMs", "desc")
        );

        unsubHistory = onSnapshot(historyQ, (snap) => {
          const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          setHistoryRounds(rows);

          setSelectedHistoryId((prev) => {
            if (prev && rows.some((r) => r.id === prev)) return prev;
            return "";
          });
        });
      } else {
        setHistoryRounds([]);
        setSelectedHistoryId("");
      }
    }

    const unsubStandings = onSnapshot(
      doc(db, "rooms", roomId, "standings", "current"),
      (snap) => setStandingsDoc(snap.exists() ? snap.data() : null),
      () => setStandingsDoc(null)
    );

    return () => {
      unsubCup();
      unsubCupFixtures();
      unsubStandings();
      unsubHistory();
    };
  }, [roomId, isWorldCupGroupRoom, historyEnabled]);

  useEffect(() => {
    if (!roomId || !isWorldCupGroupRoom || !historyEnabled) {
      setDayResults([]);
      return undefined;
    }

    const dayResultsQ = query(
      collection(db, "rooms", roomId, "dayResults"),
      orderBy("dayIndex", "desc")
    );

    return onSnapshot(
      dayResultsQ,
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
        setDayResults(rows);

        setSelectedHistoryId((prev) => {
          if (prev && rows.some((r) => r.id === prev || `day-${r.dayIndex}` === prev)) return prev;
          return "";
        });
      },
      () => setDayResults([])
    );
  }, [roomId, isWorldCupGroupRoom, historyEnabled]);

  useEffect(() => {
    if (!roomId || !isWorldCupGroupRoom) {
      setWorldCupDayDocs([]);
      setWorldCupDisplayDayResultDocs([]);
      return undefined;
    }

    const daysQ = query(
      collection(db, "rooms", roomId, "days"),
      orderBy("dayIndex", "asc")
    );
    const dayResultsQ = query(
      collection(db, "rooms", roomId, "dayResults"),
      orderBy("dayIndex", "asc")
    );

    const unsubDays = onSnapshot(
      daysQ,
      (snap) => {
        setWorldCupDayDocs(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
        );
      },
      () => setWorldCupDayDocs([])
    );

    const unsubResults = onSnapshot(
      dayResultsQ,
      (snap) => {
        setWorldCupDisplayDayResultDocs(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
        );
      },
      () => setWorldCupDisplayDayResultDocs([])
    );

    return () => {
      unsubDays();
      unsubResults();
    };
  }, [roomId, isWorldCupGroupRoom]);

  useEffect(() => {
    if (!roomId || !isWorldCupGroupRoom) {
      setCurrentDayDoc(null);
      setCurrentDayResultDoc(null);
      return undefined;
    }

    const currentDayIndex = Number(room?.worldCup?.currentDayIndex);
    let unsubDay = () => {};
    let unsubDayResult = () => {};

    if (Number.isFinite(currentDayIndex) && currentDayIndex > 0) {
      const dayId = String(currentDayIndex);
      unsubDay = onSnapshot(
        doc(db, "rooms", roomId, "days", dayId),
        (snap) => setCurrentDayDoc(snap.exists() ? { id: snap.id, ...(snap.data() || {}) } : null),
        () => setCurrentDayDoc(null)
      );
      unsubDayResult = onSnapshot(
        doc(db, "rooms", roomId, "dayResults", dayId),
        (snap) => setCurrentDayResultDoc(snap.exists() ? { id: snap.id, ...(snap.data() || {}) } : null),
        () => setCurrentDayResultDoc(null)
      );
    } else {
      const latestDayResultQ = query(
        collection(db, "rooms", roomId, "dayResults"),
        orderBy("dayIndex", "desc"),
        limit(1)
      );
      unsubDayResult = onSnapshot(
        latestDayResultQ,
        (snap) => setCurrentDayResultDoc(snap.docs[0] ? { id: snap.docs[0].id, ...(snap.docs[0].data() || {}) } : null),
        () => setCurrentDayResultDoc(null)
      );
    }

    return () => {
      unsubDay();
      unsubDayResult();
    };
  }, [roomId, isWorldCupGroupRoom, room?.worldCup?.currentDayIndex]);

  useEffect(() => {
    if (!roomId || !isWorldCupGroupRoom || !activeWorldCupDayIndex) {
      setLiveWorldCupDayResult(null);
      return undefined;
    }

    const ref = doc(
      db,
      "rooms",
      roomId,
      "dayResults",
      String(activeWorldCupDayIndex)
    );

    return onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setLiveWorldCupDayResult(null);
          return;
        }

        setLiveWorldCupDayResult({
          id: snap.id,
          ...(snap.data() || {}),
        });
      },
      (listenerError) => {
        console.warn(
          "[WorldCupTournamentPage] live day result listener failed",
          {
            roomId,
            activeWorldCupDayIndex,
            message: listenerError?.message || String(listenerError),
          }
        );
        setLiveWorldCupDayResult(null);
      }
    );
  }, [roomId, isWorldCupGroupRoom, activeWorldCupDayIndex]);

  useEffect(() => {
    setOpenHistoryBreakdownKey(null);
  }, [historyEnabled, selectedHistoryId]);

  const stagedCupLineupUserIds = Array.from(
    new Set([myUid, expandedOtherUser].filter(Boolean).map(String))
  );
  const stagedLineups = useLineupsForUsers(roomId, stagedCupLineupUserIds, {
    enabled: Boolean(roomId && !loading),
  });
  const stagedUsersById = stagedLineups.usersById || {};
  const users = [
    ...(data?.users || []).map((u) => ({
      ...u,
      ...(stagedUsersById[String(u.userId)] || {}),
    })),
    ...Object.values(stagedUsersById).filter(
      (u) => !(data?.users || []).some((base) => String(base.userId) === String(u.userId))
    ),
  ];
  const lineups = stagedLineups.lineupsByUid || {};
  const picksMap = stagedLineups.picksMap || {};
  const rosterByUid = stagedLineups.rosterByUid || {};
  const userById = Object.fromEntries(users.map((u) => [u.userId, u]));
  const resolverPicks = useMemo(
    () => [...roomPickDocs, ...Object.values(picksMap || {})],
    [picksMap, roomPickDocs]
  );
  const embeddedRosterPlayers = useMemo(() => {
    const players = [];
    const addPlayer = (player) => {
      if (!player || typeof player !== "object") return;
      players.push(player);
    };

    for (const user of users) {
      (Array.isArray(user?.starters) ? user.starters : []).forEach(addPlayer);
      (Array.isArray(user?.bench) ? user.bench : []).forEach(addPlayer);
    }

    for (const roster of Object.values(rosterByUid || {})) {
      (Array.isArray(roster) ? roster : []).forEach(addPlayer);
    }

    return players;
  }, [users, rosterByUid]);
  const targetedResultDocs = useMemo(
    () => [
      cupDoc,
      cupFixtureDocs,
      historyEnabled ? historyRounds : [],
      dayResults,
      currentDayDoc,
      currentDayResultDoc,
      liveWorldCupDayResult,
      worldCupDisplayDayResultDocs,
      finalResultsDoc,
    ],
    [
      cupDoc,
      cupFixtureDocs,
      currentDayDoc,
      currentDayResultDoc,
      liveWorldCupDayResult,
      dayResults,
      finalResultsDoc,
      historyEnabled,
      historyRounds,
      worldCupDisplayDayResultDocs,
    ]
  );
  const targetedPlayerDocs = useTargetedTournamentPlayers({
    roomId,
    embeddedPlayers: embeddedRosterPlayers,
    picks: resolverPicks,
    lineups,
    resultDocs: targetedResultDocs,
  });
  const resolverPlayerInputs = useMemo(
    () => ({
      players: [...targetedPlayerDocs, ...embeddedRosterPlayers],
      picks: resolverPicks,
    }),
    [embeddedRosterPlayers, resolverPicks, targetedPlayerDocs]
  );
  const playerResolver = useMemo(
    () => buildTournamentPlayerResolver({
      players: resolverPlayerInputs.players,
      picks: resolverPlayerInputs.picks,
      lineups,
    }),
    [resolverPlayerInputs, lineups]
  );

  if (!roomId) return null;
  if (loading) {
    return (
      <div className="tpPage">
        <div className="tpCenter"><div className="loader"><div className="loader_cube loader_cube--color" /><div className="loader_cube loader_cube--glowing" /></div></div>
      </div>
    );
  }
  if (error) {
    return <div className="tpPage"><div className="tpWrap"><p className="tpText">Error: {String(error.message || error)}</p></div></div>;
  }

  const isHost = room?.hostUid === myUid;
  const normalizedLiveWorldCupDayResult =
    isWorldCupGroupRoom && liveWorldCupDayResult
      ? normalizeWorldCupDayResults([liveWorldCupDayResult], userById)[0] ||
        liveWorldCupDayResult
      : null;
  const normalizedCurrentDayResult =
    isWorldCupGroupRoom && (liveWorldCupDayResult || currentDayResultDoc)
      ? normalizedLiveWorldCupDayResult ||
        normalizeWorldCupDayResults([currentDayResultDoc], userById)[0] ||
        null
      : null;
  const normalizedWorldCupDisplayDayResults = isWorldCupGroupRoom
    ? normalizeWorldCupDayResults(
        [
          ...worldCupDisplayDayResultDocs,
          ...(currentDayResultDoc ? [currentDayResultDoc] : []),
          ...(liveWorldCupDayResult ? [liveWorldCupDayResult] : []),
        ],
        userById
      )
    : [];
  const worldCupDayResultsByIndex = normalizedWorldCupDisplayDayResults.reduce((acc, day) => {
    const idx = dayIndexOf(day);
    if (idx) acc[idx] = day;
    return acc;
  }, {});
  const worldCupDaysForDisplay = (() => {
    if (!isWorldCupGroupRoom) return [];

    const byIndex = new Map();
    for (const day of [...worldCupDayDocs, ...(currentDayDoc ? [currentDayDoc] : [])]) {
      const idx = dayIndexOf(day);
      if (!idx) continue;
      byIndex.set(idx, { ...day, dayIndex: idx });
    }

    return Array.from(byIndex.values()).sort(
      (a, b) => Number(a.dayIndex) - Number(b.dayIndex)
    );
  })();
  const worldCupDisplayContext = isWorldCupGroupRoom
    ? getWorldCupDisplayDayContext({
        days: worldCupDaysForDisplay,
        dayResultsByIndex: worldCupDayResultsByIndex,
        room,
        competitionState: room?.competitionState || {},
        nowMs,
      })
    : null;
  const emptyWorldCupDisplayDayResult =
    isWorldCupGroupRoom && worldCupDisplayContext?.displayDay
      ? buildEmptyWorldCupDayResult({
          day: worldCupDisplayContext.displayDay,
          members: users,
        })
      : null;
  const worldCupDisplayDayResult =
    isWorldCupGroupRoom && worldCupDisplayContext?.shouldShowZeroCurrentDay
      ? emptyWorldCupDisplayDayResult
      : worldCupDisplayContext?.displayDayResult || normalizedCurrentDayResult || null;
  const displayHistoryRounds = historyEnabled
    ? (isWorldCupGroupRoom
        ? normalizeWorldCupDayResults(dayResults, userById)
        : normalizeCupHistoryRounds(historyRounds, userById))
    : [];
  const latestCompletedHistoryTotalsByUid =
    displayHistoryRounds[0]?.cupTotalsAfterByUid || {};

  const competitionName = room?.competitionMeta?.name || room?.competition?.name || "";
  const competitionSeason = room?.competition?.season || room?.competitionMeta?.season || "";
  const competitionLabel = [competitionSeason, competitionName].filter(Boolean).join(" ");
  
    // Cup Data
    
    

    

    //Status 
    const latestDayResult = isWorldCupGroupRoom
      ? normalizedLiveWorldCupDayResult ||
        worldCupDisplayDayResult ||
        normalizedCurrentDayResult ||
        displayHistoryRounds[0] ||
        null
      : null;
    const currentWorldCupDayIndex = Number(room?.worldCup?.currentDayIndex);
    const currentDayResult =
      isWorldCupGroupRoom
        ? normalizedLiveWorldCupDayResult ||
          worldCupDisplayDayResult ||
          (Number.isFinite(currentWorldCupDayIndex)
            ? normalizedCurrentDayResult ||
              displayHistoryRounds.find(
                (day) => Number(day?.dayIndex) === currentWorldCupDayIndex
              ) || null
            : null)
        : null;
    const activeWorldCupResult = isWorldCupGroupRoom
      ? normalizedLiveWorldCupDayResult ||
        currentDayResult ||
        latestDayResult ||
        null
      : currentDayResult || latestDayResult || null;
    const activeDayResult = isWorldCupGroupRoom
      ? (activeWorldCupResult &&
          (String(
            activeWorldCupResult?.status ||
              activeWorldCupResult?.weekStatus ||
              ""
          )
            .trim()
            .toLowerCase() === "live" ||
            String(
              activeWorldCupResult?.status ||
                activeWorldCupResult?.weekStatus ||
                ""
            )
              .trim()
              .toLowerCase() === "resolving" ||
            worldCupResultHasInPlayFixture(activeWorldCupResult))
          ? activeWorldCupResult
          : normalizedWorldCupDisplayDayResults.find((dayResult) => {
          const resultStatus = String(
            dayResult?.status || dayResult?.weekStatus || ""
          ).trim().toLowerCase();

          return (
            resultStatus === "live" ||
            resultStatus === "resolving" ||
            worldCupResultHasInPlayFixture(dayResult)
          );
            })) || null
      : null;

    const statusRaw =
      isWorldCupGroupRoom
          ? getWorldCupGroupDisplayStatus(
            activeDayResult ||
              activeWorldCupResult ||
              normalizedCurrentDayResult ||
              currentDayResult ||
              latestDayResult,
            room
          )
        : (
            cupDoc?.status ||
            room?.competitionState?.weekStatus ||
            room?.["competitionState.weekStatus"] ||
            "scheduled"
          );
    

    const statusLowerRaw = String(statusRaw).toLowerCase();

    const statusLower = statusLowerRaw;

    const isLive = statusLower === "live";
    const isResolving = statusLower === "resolving";

    const roomWeekStatus = String(
      room?.competitionState?.weekStatus ||
        room?.["competitionState.weekStatus"] ||
        ""
    )
      .trim()
      .toLowerCase();

    const derivedDisplayStatus = String(statusRaw || "")
      .trim()
      .toLowerCase();

    const pollWeekStatus =
      derivedDisplayStatus === "live" ||
      derivedDisplayStatus === "resolving"
        ? derivedDisplayStatus
        : roomWeekStatus || derivedDisplayStatus || "idle";

    const headerUpdateStatus = isWorldCupGroupRoom
      ? pollWeekStatus === "live"
        ? "live"
        : pollWeekStatus === "resolving"
          ? "resolving"
          : ["complete", "completed", "final"].includes(pollWeekStatus)
            ? "complete"
            : pollWeekStatus === "scheduled"
              ? "scheduled"
              : pollWeekStatus || "idle"
      : statusLower;
    const headerIsLive = headerUpdateStatus === "live";
    const headerStatusClass =
      headerUpdateStatus === "live"
        ? "live"
        : headerUpdateStatus === "resolving"
          ? "resolving"
          : headerUpdateStatus === "error"
            ? "error"
            : headerUpdateStatus === "scheduled"
              ? "scheduled"
              : "idle";
    const headerStatusLabel =
      headerUpdateStatus === "live"
        ? "LIVE UPDATING"
        : headerUpdateStatus === "scheduled"
          ? "SCHEDULED"
          : headerUpdateStatus === "complete"
            ? "COMPLETE"
            : headerUpdateStatus === "resolving"
              ? "RESOLVING"
              : headerUpdateStatus === "error"
                ? "ERROR"
                : "IDLE";

    // --- Live-style header timing (match TournamentPage feel) ---
    const lastUpdateMs = Number(
      (
        isWorldCupGroupRoom
          ? latestDayResult?.updatedAtMs || standingsDoc?.updatedAtMs
          : cupDoc?.updatedAtMs ||
            standingsDoc?.updatedAtMs ||
            displayHistoryRounds[0]?.updatedAtMs ||
            displayHistoryRounds[0]?.closedAtMs
      ) || 0
    ) || null;
    const pollNextAtMs = Number(
      room?.competitionState?.nextPollAtMs ||
        room?.["competitionState.nextPollAtMs"] ||
        0
    );
    const pollNextKickoffMs = Number(
      room?.competitionState?.nextKickoffMs ||
        room?.["competitionState.nextKickoffMs"] ||
        0
    );
    const hasPollNextAtMs =
      Number.isFinite(pollNextAtMs) && pollNextAtMs > 0;
    const ageSec = lastUpdateMs
      ? Math.max(0, Math.floor((nowMs - lastUpdateMs) / 1000))
      : null;
    const nextUpdateInSec = hasPollNextAtMs
      ? Math.max(0, Math.ceil((pollNextAtMs - nowMs) / 1000))
      : lastUpdateMs
        ? Math.max(0, 60 - (ageSec % 60))
        : null;
    const lastUpdateLabel = lastUpdateMs ? fmtDT(lastUpdateMs) : "—";
    const status = String(statusRaw).toUpperCase();
    const worldCupDisplayDay = worldCupDisplayContext?.displayDay || currentDayDoc || null;
    const worldCupDisplayNotice =
      isWorldCupGroupRoom && worldCupDisplayContext?.showingPreviousFinalUntilReset
        ? `Showing final ${latestDayResult?.label || `Day ${worldCupDisplayContext.latestFinalDayIndex}`} stats until next day reset at ${fmtDT(worldCupDisplayContext.resetAtMs)}.`
        : isWorldCupGroupRoom && worldCupDisplayContext?.shouldShowZeroCurrentDay
          ? `${worldCupDisplayDay?.label || `Day ${worldCupDisplayContext?.displayDayIndex || ""}`} stats reset. Live updates start when matches begin.`
          : "";
    const currentWindowLabel = isWorldCupGroupRoom
      ? worldCupDisplayDay?.label ||
        latestDayResult?.label ||
        room?.competitionState?.currentLabel ||
        room?.worldCup?.currentDayLabel ||
        "Waiting for next day"
      : cupDoc?.currentWindowLabel || "Waiting for next round";
    const isFinal = status === "FINAL" || cupDoc?.completed || (isWorldCupGroupRoom && room?.competitionState?.isDone);
    
    const livePoints = cupDoc?.livePointsByUid || {};
    const fixtureLedgerTotalsByUid = buildFixtureTotalsByUid(cupFixtureDocs);
    const creditedTotalsByUid =
      Object.keys(fixtureLedgerTotalsByUid).length > 0
        ? fixtureLedgerTotalsByUid
        : Object.keys(latestCompletedHistoryTotalsByUid).length > 0
        ? latestCompletedHistoryTotalsByUid
        : (cupDoc?.creditedTotalsByUid || cupDoc?.cupTotalsByUid || {});
    const projectedTotalsByUid = sumNumberMaps(creditedTotalsByUid, livePoints);
    const standingsIncludeLive =
      Boolean(standingsDoc?.includesLivePoints) ||
      Boolean(cupDoc?.projectedIncludesLivePoints);
    const standingsSourceIsCup =
      String(standingsDoc?.source || "").toLowerCase() === "cup";
    const shouldProjectLive =
      !isFinal &&
      !standingsIncludeLive &&
      Object.values(livePoints).some((v) => Number(v || 0) !== 0);
    const leaderboardByUid = {};
    const standingsRows = isWorldCupGroupRoom
      ? (Array.isArray(standingsDoc?.leaderboard)
          ? standingsDoc.leaderboard
          : Array.isArray(standingsDoc?.standings)
          ? standingsDoc.standings
          : [])
      : (Array.isArray(standingsDoc?.standings) ? standingsDoc.standings : []);
    const standingsByUid = Object.fromEntries(
      standingsRows
        .map((row) => {
          const uid = String(row?.userId || row?.uid || "");
          return uid ? [uid, row] : null;
        })
        .filter(Boolean)
    );
    const leaderboardIds = new Set([
      ...users.map((u) => String(u.userId || "")).filter(Boolean),
      ...Object.keys(standingsByUid),
      ...(isWorldCupGroupRoom ? [] : Object.keys(creditedTotalsByUid || {}).map(String)),
      ...(isWorldCupGroupRoom ? [] : Object.keys(projectedTotalsByUid || {}).map(String)),
    ]);

    leaderboardIds.forEach((uid) => {
      const standingRow = standingsByUid[uid] || null;
      if (isWorldCupGroupRoom) {
        const totalPoints = Number(standingRow?.totalFantasyPoints ?? 0);
        leaderboardByUid[uid] = {
          userId: uid,
          uid,
          name:
            standingRow?.name ||
            standingRow?.displayName ||
            userById?.[uid]?.name ||
            userById?.[uid]?.displayName ||
            "Unknown",
          totalFantasyPoints: totalPoints,
          totalPoints,
        };
        return;
      }

      const hasCreditedTotal = Object.prototype.hasOwnProperty.call(
        creditedTotalsByUid || {},
        uid
      );
      const hasProjectedTotal = Object.prototype.hasOwnProperty.call(
        projectedTotalsByUid || {},
        uid
      );

      const fallbackCredited = standingsSourceIsCup
        ? Number(
            standingRow?.creditedFantasyPoints ??
              standingRow?.totalFantasyPoints ??
              0
          )
        : 0;
      const fallbackProjected = standingsSourceIsCup
        ? Number(
            standingRow?.projectedFantasyPoints ??
              standingRow?.totalFantasyPoints ??
              fallbackCredited
          )
        : fallbackCredited;

      const creditedTotal = hasCreditedTotal
        ? Number(creditedTotalsByUid?.[uid] || 0)
        : fallbackCredited;
      const projectedTotal = hasProjectedTotal
        ? Number(projectedTotalsByUid?.[uid] || 0)
        : fallbackProjected;
      const baseTotal = standingsIncludeLive ? projectedTotal : creditedTotal;

      leaderboardByUid[uid] = {
        userId: uid,
        uid,
        name:
          standingRow?.name ||
          userById?.[uid]?.name ||
          userById?.[uid]?.displayName ||
          "Unknown",
        tablePoints: baseTotal,
        totalFantasyPoints: baseTotal,
      };
    });

    const leaderboard = sortCupLeaderboardRows(
      Object.values(leaderboardByUid).map((row) => {
        if (isWorldCupGroupRoom) {
          const totalPoints = Number(row.totalFantasyPoints || row.totalPoints || 0);
          return {
            ...row,
            totalFantasyPoints: totalPoints,
            totalPoints,
          };
        }

        const live = shouldProjectLive ? Number(livePoints[row.userId] || 0) : 0;
        const totalPoints = Number(row.totalFantasyPoints || 0) + live;
        return {
          ...row,
          tablePoints: totalPoints,
          totalFantasyPoints: totalPoints,
          totalPoints,
        };
      })
    );
    const baseDisplayLeaderboard = leaderboard;

  const showFinalPodium = Boolean(finalResultsDoc) && (isFinal || isWorldCupGroupRoom);

  // Resolve Rosters Helper
  function firstNonEmptyArray(...candidates) {
    for (const arr of candidates) {
      if (Array.isArray(arr) && arr.length) return arr;
    }
    return [];
  }

  function getLineupIds(lineup, type) {
    if (!lineup) return [];

    const source =
      type === "starters"
        ? firstNonEmptyArray(
            lineup.starters,
            lineup.startingXI,
            lineup.starting11,
            lineup.starterIds,
            lineup.startingIds,
            lineup.lineup?.startingXI,
            lineup.lineup?.starting11,
            lineup.lineup?.starters
          )
        : firstNonEmptyArray(
            lineup.bench,
            lineup.subs,
            lineup.substitutes,
            lineup.benchIds,
            lineup.subIds,
            lineup.benchPlayers,
            lineup.benchPlayerIds,
            lineup.lineup?.bench,
            lineup.lineup?.subs,
            lineup.currentLineup?.bench,
            lineup.currentLineup?.subs
          );

    return extractIds(source);
  }

  function isUnknownPlayerText(value) {
    const text = String(value || "").trim().toLowerCase();
    return !text || text === "unknown" || text === "unknown team";
  }

  function resolveTournamentRosterPlayer(rawEntry, uid) {
    const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
    const resolved = playerResolver.resolvePlayer(rawEntry, uid);
    const name = isUnknownPlayerText(entry.name || entry.playerName)
      ? resolved.name
      : firstText(entry.name, entry.playerName, resolved.name, "Unknown");
    const teamName = isUnknownPlayerText(entry.teamName)
      ? resolved.teamName
      : firstText(entry.teamName, resolved.teamName, "");
    const country = firstText(resolved.country, resolved.nationality, entry.country, entry.nationality, "");
    const out = {
      ...resolved,
      ...entry,
      id: resolved.id || entry.id || entry.playerId || "",
      playerId: resolved.playerId || resolved.id || entry.playerId || entry.id || "",
      name: name || "Unknown",
      playerName: name || "Unknown",
      position: resolved.position || entry.position || entry.pos || "MID",
      teamName,
      teamLogo: resolved.teamLogo || entry.teamLogo || entry.team?.logo || "",
      country,
      nationality: firstText(resolved.nationality, country, entry.nationality, entry.country, ""),
      clubName: firstText(resolved.clubName, teamName, entry.clubName, entry.club, ""),
      points: entry.points ?? entry.total ?? resolved.points ?? 0,
      stats: entry.stats || entry.rawStats || resolved.stats || resolved.rawStats || null,
      rawStats: entry.rawStats || entry.stats || resolved.rawStats || resolved.stats || null,
      breakdown: entry.breakdown || entry.parts || resolved.breakdown || resolved.parts || null,
      parts: entry.parts || resolved.parts || null,
    };

    if (import.meta.env.DEV && isUnknownPlayerText(out.name)) {
      console.warn("[TournamentPlayerResolver] unresolved player", {
        roomId,
        rawEntry,
        resolved: out,
      });
    }

    return out;
  }

  const selectedHistory =
    selectedHistoryId
      ? displayHistoryRounds.find((r) => r.id === selectedHistoryId) || null
      : null;

  const selectedHistoryRows = Array.isArray(selectedHistory?.rows)
    ? selectedHistory.rows
    : [];

  const selectedHistoryLabel = selectedHistory?.label || "—";
  const selectedHistoryRange =
    selectedHistory?.startAtMs && selectedHistory?.endAtMs
      ? `${fmtDT(selectedHistory.startAtMs)} → ${fmtDT(selectedHistory.endAtMs)}`
      : "—";

  function historyPlayerIdOf(player = {}, fallbackId = "") {
    return String(
      player?.playerId ||
        player?.id ||
        player?.pid ||
        player?.apiPlayerId ||
        fallbackId ||
        ""
    ).trim();
  }

  function historyPlayerNameOf(player = {}, entry = null) {
    return (
      entry?.name ||
      entry?.playerName ||
      player?.name ||
      player?.playerName ||
      player?.fullName ||
      "Player"
    );
  }

  function historyPlayerPosOf(player = {}, entry = null) {
    return normalizeDisplayPos(entry?.position || entry?.pos || player?.position || player?.pos || "");
  }

  function normalizeHistoryParts(entry = {}) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.breakdown && typeof entry.breakdown === "object") return entry.breakdown;
    if (entry.parts && typeof entry.parts === "object") return entry.parts;
    if (entry.stats && typeof entry.stats === "object") return entry.stats;
    return null;
  }

  function normalizeHistoryPlayerEntry(player = {}, entry = null, counted = true, fallbackId = "") {
    const p = player && typeof player === "object" ? player : {};
    const e = entry && typeof entry === "object" ? entry : {};
    const id = historyPlayerIdOf(p, fallbackId) || historyPlayerIdOf(e, fallbackId);
    if (!id) return null;

    return {
      id,
      playerId: id,
      name: historyPlayerNameOf(p, e),
      position: historyPlayerPosOf(p, e),
      points: Number(e?.points ?? e?.total ?? p?.points ?? p?.pts ?? p?.total ?? 0),
      counted: e?.counted ?? p?.counted ?? counted,
      stats: e?.stats || p?.stats || e?.rawStats || p?.rawStats || null,
      rawStats: e?.rawStats || p?.rawStats || e?.stats || p?.stats || null,
      breakdown: e?.breakdown || p?.breakdown || e?.parts || p?.parts || null,
      parts: e?.parts || p?.parts || null,
      teamName: e?.teamName || p?.teamName || p?.clubName || p?.club || "",
      opponentName: e?.opponentName || p?.opponentName || "",
      country: e?.country || e?.nationality || p?.country || p?.nationality || "",
      clubName: e?.clubName || p?.clubName || p?.club || e?.teamName || p?.teamName || "",
    };
  }

  function normalizeHistoryPerPlayerMap(source, counted = true) {
    if (!source) return {};

    if (Array.isArray(source)) {
      return source.reduce((acc, entry) => {
        const normalized = normalizeHistoryPlayerEntry(entry, entry, counted);
        if (normalized?.id) acc[normalized.id] = normalized;
        return acc;
      }, {});
    }

    if (source?.perPlayer && typeof source.perPlayer === "object") {
      return normalizeHistoryPerPlayerMap(source.perPlayer, counted);
    }

    if (typeof source !== "object") return {};

    const direct = normalizeHistoryPlayerEntry(source, source, counted);
    if (direct?.id) return { [direct.id]: direct };

    const skipKeys = new Set([
      "total",
      "benchTotal",
      "points",
      "roundPoints",
      "dayPoints",
      "totalAfter",
      "rank",
    ]);

    return Object.entries(source).reduce((acc, [key, value]) => {
      if (skipKeys.has(key)) return acc;
      if (!value || typeof value !== "object") return acc;
      const normalized = normalizeHistoryPlayerEntry(value, value, counted, key);
      if (normalized?.id) acc[normalized.id] = normalized;
      return acc;
    }, {});
  }

  function getHistoryBreakdownForUser(uid) {
    const uidKey = String(uid || "");
    if (!selectedHistory || !uidKey) {
      return { starters: [], bench: [], perPlayer: {} };
    }

    const user = userById?.[uidKey] || {};
    const rawUserBreakdown = selectedHistory?.breakdownByUserId?.[uidKey] || null;
    const rawStarters = selectedHistory?.startersByUserId?.[uidKey] || null;
    const rawBench = selectedHistory?.benchByUserId?.[uidKey] || null;
    const perPlayer = normalizeHistoryPerPlayerMap(rawUserBreakdown, true);
    const benchPerPlayer = normalizeHistoryPerPlayerMap(rawBench, false);

    const explicitStarters = Array.isArray(rawStarters)
      ? rawStarters
      : Object.values(normalizeHistoryPerPlayerMap(rawStarters, true));
    const explicitBench = Array.isArray(rawBench)
      ? rawBench
      : Object.values(benchPerPlayer);

    let fallbackStarters = firstNonEmptyArray(user?.starters);
    if (!fallbackStarters.length) fallbackStarters = getResolvedRoster(uidKey, "starters") || [];

    let fallbackBench = firstNonEmptyArray(user?.bench);
    if (!fallbackBench.length) fallbackBench = getResolvedRoster(uidKey, "bench") || [];

    const perPlayerStarters = Object.values(perPlayer).filter((entry) => entry?.counted !== false);
    const perPlayerBench = Object.values(perPlayer).filter((entry) => entry?.counted === false);

    const starterSource = firstNonEmptyArray(explicitStarters, perPlayerStarters, fallbackStarters);
    const benchSource = firstNonEmptyArray(explicitBench, Object.values(benchPerPlayer), perPlayerBench, fallbackBench);

    const starters = starterSource
      .map((player) => {
        const id = historyPlayerIdOf(player);
        return normalizeHistoryPlayerEntry(player, perPlayer[id], true, id);
      })
      .filter(Boolean);

    const bench = benchSource
      .map((player) => {
        const id = historyPlayerIdOf(player);
        return normalizeHistoryPlayerEntry(player, benchPerPlayer[id] || perPlayer[id], false, id);
      })
      .filter(Boolean);

    return { starters, bench, perPlayer };
  }

  function mergeStatObjects(a = {}, b = {}) {
    const out = { ...(a || {}) };

    const NON_ADDITIVE_NUMBER_KEYS = new Set([
      "kickoffMs",
      "kickoffAtMs",
      "statusUpdatedAtMs",
      "updatedAtMs",
      "elapsed",
      "extra",
      "teamScore",
      "opponentScore",
      "teamGoals",
      "opponentGoals",
      "rating",
    ]);

    for (const [k, v] of Object.entries(b || {})) {
      if (typeof v === "number") {
        if (NON_ADDITIVE_NUMBER_KEYS.has(k)) {
          out[k] = out[k] ?? v;
        } else {
          out[k] = Number(out[k] || 0) + v;
        }
      } else if (typeof v === "boolean") {
        out[k] = Boolean(out[k]) || v;
      } else if ((out[k] === undefined || out[k] === null || out[k] === "") && v != null) {
        out[k] = v;
      }
    }

    return out;
  }

  function mergeNumberMaps(a = {}, b = {}) {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[k] = Number(out[k] || 0) + n;
    }
    return out;
  }

  function mergePerPlayerEntry(prev = {}, next = {}) {
    return {
      id: next.id || prev.id || "",
      name: next.name || prev.name || "Unknown",
      position: next.position || prev.position || "MID",
      points: Number(prev.points || 0) + Number(next.points || 0),
      counted: next.counted ?? prev.counted ?? true,
      stats: mergeStatObjects(prev.stats || {}, next.stats || {}),
      breakdown: mergeNumberMaps(prev.breakdown || {}, next.breakdown || {}),
      teamName: next.teamName || prev.teamName || "",
      opponentName: next.opponentName || prev.opponentName || "",
      country: next.country || prev.country || "",
      clubName: next.clubName || prev.clubName || "",
    };
  }

  function mergeBreakdownMaps(base = {}, live = {}) {
    const out = { ...(base || {}) };

    for (const [uid, incoming] of Object.entries(live || {})) {
      const prev = out[uid] || { total: 0, benchTotal: 0, perPlayer: {} };

      const mergedPerPlayer = { ...(prev.perPlayer || {}) };
      for (const [pid, entry] of Object.entries(incoming?.perPlayer || {})) {
        mergedPerPlayer[pid] = mergePerPlayerEntry(mergedPerPlayer[pid], entry);
      }

      out[uid] = {
        total: Number(prev.total || 0) + Number(incoming?.total || 0),
        benchTotal: Number(prev.benchTotal || 0) + Number(incoming?.benchTotal || 0),
        perPlayer: mergedPerPlayer,
      };
    }

    return out;
  }

  function aggregateFixtureBreakdowns(fixtures = []) {
    let agg = {};
    for (const fx of fixtures || []) {
      agg = mergeBreakdownMaps(agg, fx?.breakdownByUserId || {});
    }
    return agg;
  }

  const parsedWindow = parseCupWindowId(cupDoc?.currentWindowId);

  const winStartMs =
    (isWorldCupGroupRoom
      ? worldCupDisplayDay?.startAtMs ||
        currentDayResult?.startAtMs ||
        latestDayResult?.startAtMs ||
        room?.worldCup?.currentDayStartAtMs ||
        currentDayDoc?.startAtMs ||
        room?.worldCup?.firstWindowStartAtMs
      : cupDoc?.currentWindowStartAtMs ??
        cupDoc?.startAtMs ??
        parsedWindow?.startAtMs) ??
    null;

  const winEndMs =
    (isWorldCupGroupRoom
      ? worldCupDisplayDay?.endAtMs ||
        currentDayResult?.endAtMs ||
        latestDayResult?.endAtMs ||
        room?.worldCup?.currentDayEndAtMs ||
        currentDayDoc?.endAtMs ||
        room?.worldCup?.lastWindowEndAtMs
      : cupDoc?.currentWindowEndAtMs ??
        cupDoc?.endAtMs ??
        parsedWindow?.endAtMs) ??
    null;

  const currentBreakdownByUserId = mergeBreakdownMaps(
    isWorldCupGroupRoom
      ? (activeWorldCupResult?.breakdownByUserId || {})
      : (cupDoc?.breakdownByUserId || {}),
    isWorldCupGroupRoom ? {} : (cupDoc?.liveBreakdownByUserId || {})
  );

  const latestHistory = displayHistoryRounds[0] || null;
  const autoHidePreviousRoundAtMs = Number(winStartMs || 0) ? Number(winStartMs) - (60 * 60 * 1000) : null;
  const shouldAutoShowLatestHistory =
    !selectedHistory &&
    !isFinal &&
    !isLive &&
    !isResolving &&
    !!latestHistory &&
    (autoHidePreviousRoundAtMs == null || nowMs < autoHidePreviousRoundAtMs);

  const activeHistory = selectedHistory || (shouldAutoShowLatestHistory ? latestHistory : null);
  const activeHistoryFixtureIds = new Set(
    Array.isArray(activeHistory?.fixtureIds)
      ? activeHistory.fixtureIds.map((id) => String(id)).filter(Boolean)
      : []
  );
  const activeFixtureDocs = activeHistory
    ? cupFixtureDocs.filter((fx) => {
        const fixtureId = String(fx?.fixtureId || fx?.id || "");
        if (activeHistoryFixtureIds.size > 0) return activeHistoryFixtureIds.has(fixtureId);
        if (activeHistory?.windowId && fx?.windowId) return String(fx.windowId) === String(activeHistory.windowId);
        return false;
      })
    : [];
  const currentWindowFixtureIds = new Set(
    Array.isArray(cupDoc?.currentWindowFixtureIds)
      ? cupDoc.currentWindowFixtureIds.map((id) => String(id)).filter(Boolean)
      : []
  );
  const currentWindowFixtureDocs = cupFixtureDocs.filter((fx) => {
    const fixtureId = String(fx?.fixtureId || fx?.id || "");
    return currentWindowFixtureIds.has(fixtureId);
  });
  const activeHistoryBreakdownByUserId =
    isWorldCupGroupRoom
      ? (activeHistory?.breakdownByUserId || {})
      : activeFixtureDocs.length > 0
      ? aggregateFixtureBreakdowns(activeFixtureDocs)
      : (activeHistory?.breakdownByUserId || {});
  const activeBreakdownByUserId = activeHistory ? activeHistoryBreakdownByUserId : currentBreakdownByUserId;
  const worldCupBreakdownLeaderboard =
    isWorldCupGroupRoom && !activeHistory
      ? buildWorldCupLiveLeaderboardFromBreakdowns(
          activeBreakdownByUserId,
          userById
        )
      : [];
  const hasWorldCupBreakdownLeaderboardScores =
    worldCupBreakdownLeaderboard.some(
      (row) =>
        Number(
          row.totalPoints ??
            row.totalFantasyPoints ??
            row.points ??
            0
        ) !== 0
    );
  const hasWorldCupCumulativeStandings =
    isWorldCupGroupRoom &&
    !activeHistory &&
    baseDisplayLeaderboard.length > 0 &&
    (
      String(standingsDoc?.source || "") ===
        "world-cup-group-cumulative-standings" ||
      Array.isArray(standingsDoc?.includedDayIndexes)
    );
  const displayLeaderboard =
    hasWorldCupCumulativeStandings
      ? baseDisplayLeaderboard
      : isWorldCupGroupRoom && hasWorldCupBreakdownLeaderboardScores
        ? worldCupBreakdownLeaderboard
        : baseDisplayLeaderboard;

  const isAutoShowingLatestHistory = !selectedHistory && activeHistory === latestHistory && shouldAutoShowLatestHistory;
  const latestFixtureEntryByPlayerId = (() => {
    const out = {};
    const sourceFixtureDocs = activeHistory ? activeFixtureDocs : currentWindowFixtureDocs;
    const sorted = [...sourceFixtureDocs].sort(
      (a, b) => Number(b?.creditedAtMs || 0) - Number(a?.creditedAtMs || 0)
    );

    for (const fx of sorted) {
      for (const userBreakdown of Object.values(fx?.breakdownByUserId || {})) {
        for (const [pid, entry] of Object.entries(userBreakdown?.perPlayer || {})) {
          const key = String(pid || entry?.id || "");
          if (!key || out[key]) continue;
          out[key] = entry;
        }
      }
    }

    return out;
  })();

  function withDerivedScoring(player) {
    const stats = player?.stats && typeof player.stats === "object" ? player.stats : null;
    const breakdown = hasBreakdownMap(player?.breakdown) ? player.breakdown : null;
    const existingPoints = Number(player?.points ?? NaN);

    if (
      isWorldCupGroupRoom &&
      Number.isFinite(existingPoints) &&
      existingPoints !== 0
    ) {
      return {
        ...player,
        points: existingPoints,
        breakdown,
      };
    }

    if (!stats) {
      return {
        ...player,
        points: Number.isFinite(existingPoints) ? existingPoints : 0,
        breakdown,
      };
    }

    const scored = scorePlayerFromCore(
      stats,
      toCorePos(player?.position || stats?.position || stats?.pos || stats?.role)
    );
    const derivedPoints = Number(scored?.points || 0);
    const derivedBreakdown = hasBreakdownMap(scored?.breakdown) ? scored.breakdown : null;
    const shouldKeepExistingPoints =
      breakdown &&
      Number.isFinite(existingPoints) &&
      (existingPoints !== 0 || derivedPoints === 0);

    return {
      ...player,
      position: player?.position || stats?.position || stats?.pos || stats?.role || "MID",
      points: shouldKeepExistingPoints ? existingPoints : derivedPoints,
      breakdown: breakdown || derivedBreakdown,
    };
  }

  function withDerivedLiveState(player, uid, pid) {
    const liveEntry = !activeHistory
      ? cupDoc?.liveBreakdownByUserId?.[uid]?.perPlayer?.[String(pid)]
      : null;
    const isPlayerLive = isPlayerLiveFromStats(player?.stats) || Boolean(liveEntry);
    const nextStats = player?.stats
      ? { ...player.stats, isLive: isPlayerLive }
      : (isPlayerLive ? { isLive: true } : null);

    return {
      ...player,
      stats: nextStats,
    };
  }

  function compactId(value) {
    return String(value ?? "").trim();
  }

  function playerAliasIds(...values) {
    const ids = [];

    for (const value of values) {
      if (value == null) continue;

      if (typeof value === "string" || typeof value === "number") {
        ids.push(compactId(value));
        continue;
      }

      if (typeof value === "object") {
        ids.push(
          compactId(value.id),
          compactId(value.playerId),
          compactId(value.pid),
          compactId(value.apiPlayerId),
          compactId(value._docId),
          compactId(value._pickDocId),
          compactId(value._sourcePlayerId),
          compactId(value.player?.id),
          compactId(value.player?.playerId)
        );
      }
    }

    return Array.from(new Set(ids.filter(Boolean)));
  }

  function findPerPlayerEntry(perPlayer = {}, ...sources) {
    if (!perPlayer || typeof perPlayer !== "object") return null;

    const aliases = playerAliasIds(...sources);

    for (const id of aliases) {
      if (perPlayer[id]) return perPlayer[id];
    }

    for (const [key, entry] of Object.entries(perPlayer)) {
      const entryAliases = playerAliasIds(entry, key);
      if (entryAliases.some((id) => aliases.includes(id))) {
        return entry;
      }
    }

    return null;
  }

  function normalizeLookupName(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function findPerPlayerEntryAcrossBreakdowns(
    breakdownByUserId = {},
    ...sources
  ) {
    if (!breakdownByUserId || typeof breakdownByUserId !== "object") {
      return null;
    }

    const aliases = playerAliasIds(...sources);
    const names = sources
      .flatMap((source) => {
        if (!source || typeof source !== "object") return [];
        return [
          source.name,
          source.playerName,
          source.fullName,
          source.displayName,
          source.player?.name,
        ];
      })
      .map(normalizeLookupName)
      .filter(Boolean);

    for (const breakdown of Object.values(breakdownByUserId)) {
      const perPlayer = breakdown?.perPlayer || {};
      const direct = findPerPlayerEntry(perPlayer, ...sources);
      if (direct) return direct;

      for (const [key, entry] of Object.entries(perPlayer)) {
        const entryAliases = playerAliasIds(entry, key);
        if (entryAliases.some((id) => aliases.includes(id))) return entry;

        const entryNames = [
          entry?.name,
          entry?.playerName,
          entry?.fullName,
          entry?.displayName,
        ]
          .map(normalizeLookupName)
          .filter(Boolean);

        if (
          names.length &&
          entryNames.some((entryName) => names.includes(entryName))
        ) {
          return entry;
        }
      }
    }

    return null;
  }

  function patchEntryWithFixtureStatus(entry = {}, dayResult = {}) {
    if (!entry || typeof entry !== "object") return entry;

    const fixtureId = compactId(
      entry.fixtureId ||
        entry.stats?.fixtureId ||
        entry.rawStats?.fixtureId
    );
    const statusShort = compactId(
      fixtureId ? dayResult?.fixtureStatusById?.[fixtureId] : ""
    ).toUpperCase();

    if (!statusShort) return entry;

    const isLiveNow =
      isLiveStatusCode(statusShort) && !isFinalStatusCode(statusShort);

    return {
      ...entry,
      statusShort,
      fixtureStatus: statusShort,
      matchStatus: statusShort,
      stats: {
        ...(entry.stats || entry.rawStats || {}),
        statusShort,
        fixtureStatus: statusShort,
        matchStatus: statusShort,
        isLive: isLiveNow,
      },
      rawStats: {
        ...(entry.rawStats || entry.stats || {}),
        statusShort,
        fixtureStatus: statusShort,
        matchStatus: statusShort,
        isLive: isLiveNow,
      },
    };
  }

  function buildHistoryRoster(uid, type) {
    if (!activeHistory) return null;

    const perPlayer = activeBreakdownByUserId?.[uid]?.perPlayer || {};

    const explicit =
      type === "starters"
        ? activeHistory?.startersByUserId?.[uid]
        : activeHistory?.benchByUserId?.[uid];

    if (Array.isArray(explicit) && explicit.length) {
      const normalized = explicit
        .map((p) => {
          const pid = String(p?.id || p?.playerId || p?.pid || "");
          let entry = findPerPlayerEntry(perPlayer, pid, p);

          if (!entry && isWorldCupGroupRoom) {
            entry = findPerPlayerEntryAcrossBreakdowns(
              activeBreakdownByUserId,
              pid,
              p
            );
          }

          if (entry && isWorldCupGroupRoom) {
            entry = patchEntryWithFixtureStatus(
              entry,
              activeWorldCupResult || {}
            );
          }

          return resolveTournamentRosterPlayer({
            id: pid,
            name: entry?.name || p?.name || p?.playerName || "Unknown",
            position: entry?.position || p?.position || p?.pos || "MID",
            points: Number(entry?.points ?? p?.points ?? 0),
            counted: entry?.counted ?? (type === "starters"),
            stats: entry?.stats || p?.stats || p?.rawStats || null,
            breakdown: entry?.breakdown || p?.breakdown || null,
            teamName: entry?.teamName || p?.teamName || "",
            opponentName: entry?.opponentName || p?.opponentName || "",
            country: entry?.country || p?.country || p?.nationality || p?.playerCountry || "",
            clubName: entry?.clubName || p?.clubName || p?.club || p?.teamName || entry?.teamName || "",
          }, uid);
        })
        .filter((p) => p.id);

      if (normalized.length) {
        return normalized.map((player) =>
          withDerivedLiveState(withDerivedScoring(player), uid, player.id)
        );
      }
    }

    const derived = Object.values(perPlayer)
      .filter((entry) => Boolean(entry) && Boolean(entry.id))
      .filter((entry) => (type === "starters" ? entry.counted !== false : entry.counted === false))
      .map((entry) => resolveTournamentRosterPlayer({
        id: String(entry.id),
        name: entry.name || "Unknown",
        position: entry.position || "MID",
        points: Number(entry.points || 0),
        counted: entry.counted !== false,
        stats: entry.stats || null,
        breakdown: entry.breakdown || null,
        teamName: entry.teamName || "",
        opponentName: entry.opponentName || "",
        country: entry.country || "",
        clubName: entry.clubName || entry.teamName || "",
      }, uid));

    return derived.length
      ? derived.map((player) =>
          withDerivedLiveState(withDerivedScoring(player), uid, player.id)
        )
      : null;
  }


  function getResolvedRoster(uid, type) {
    const historyRoster = buildHistoryRoster(uid, type);
    if (historyRoster) return historyRoster;

    const lineup = lineups[uid] || {};
    let ids = getLineupIds(lineup, type);
      ids = ids
    .map((rawId) => {
      const row = picksMap[String(rawId)] || null;
      const resolved = playerResolver.resolvePlayer(row || rawId, uid);
      return String(resolved?.id || row?._resolvedPlayerId || rawId);
    })
    .filter(Boolean);

    // prevent duplicates after remapping
    ids = Array.from(new Set(ids));

    const cupUserBreakdown = activeBreakdownByUserId?.[uid] || {};
    const perPlayer = cupUserBreakdown?.perPlayer || {};

    if ((!ids || ids.length === 0) && Array.isArray(userById?.[uid]?.[type]) && userById[uid][type].length) {
      return userById[uid][type].map((player) => {
        const resolved = resolveTournamentRosterPlayer(player, uid);
        return withDerivedLiveState(withDerivedScoring(resolved), uid, resolved.id || resolved.playerId);
      });
    }

    // Fallback: derive bench from roster picks if lineup doc doesn't store bench
    if (type === "bench" && (!ids || ids.length === 0)) {
      const starterIds = new Set(getLineupIds(lineup, "starters").map(String));
      const roster = playerResolver.getRosterForUid(uid).length
        ? playerResolver.getRosterForUid(uid)
        : (rosterByUid[uid] || []);
      ids = roster
        .map((p) => String(p?.id || p?.playerId || ""))
        .filter((pid) => pid && !starterIds.has(pid));
    }

    return ids.map((pid) => {
      const pick = picksMap[pid] || {};
      const rosterMeta =
        (rosterByUid[uid] || []).find((p) =>
          playerAliasIds(p).includes(String(pid))
        ) || {};
      const resolvedPreview = playerResolver.resolvePlayer(
        pick && Object.keys(pick).length ? pick : pid,
        uid
      );

      let entry = findPerPlayerEntry(
        perPlayer,
        pid,
        pick,
        rosterMeta,
        resolvedPreview
      );
      if (!entry && isWorldCupGroupRoom) {
        entry = findPerPlayerEntryAcrossBreakdowns(
          activeBreakdownByUserId,
          pid,
          pick,
          rosterMeta,
          resolvedPreview
        );
      }
      if (entry && isWorldCupGroupRoom) {
        entry = patchEntryWithFixtureStatus(
          entry,
          activeWorldCupResult || {}
        );
      }

      let fixtureFallback =
        findPerPlayerEntry(
          latestFixtureEntryByPlayerId,
          pid,
          pick,
          rosterMeta,
          resolvedPreview
        ) || null;
      if (!fixtureFallback && isWorldCupGroupRoom) {
        fixtureFallback = findPerPlayerEntryAcrossBreakdowns(
          activeBreakdownByUserId,
          pid,
          pick,
          rosterMeta,
          resolvedPreview
        );
      }
      if (fixtureFallback && isWorldCupGroupRoom) {
        fixtureFallback = patchEntryWithFixtureStatus(
          fixtureFallback,
          activeWorldCupResult || {}
        );
      }


      const entryPoints = Number(entry?.points ?? NaN);
      const entryHasStats = !!(entry?.stats && Object.keys(entry.stats).length > 0);
      const entryHasBreakdown = !!(entry?.breakdown && Object.keys(entry.breakdown).length > 0);
      const entryHasContent =
        entryHasStats ||
        entryHasBreakdown ||
        (Number.isFinite(entryPoints) && entryPoints !== 0);

      const resolved = resolveTournamentRosterPlayer({
        id: pid,
        name:
          entry?.name ||
          fixtureFallback?.name ||
          pick.playerName ||
          pick.name ||
          rosterMeta.name ||
          "Unknown",
        position:
          entry?.position ||
          fixtureFallback?.position ||
          pick.position ||
          pick.pos ||
          rosterMeta.position ||
          "MID",
        points:
          entryHasContent
            ? entryPoints
            : Number(fixtureFallback?.points ?? pick.lastDelta ?? 0),
        counted: entry?.counted ?? fixtureFallback?.counted ?? (pick.lastCounted !== false),
        stats:
          entryHasStats
            ? entry.stats
            : (fixtureFallback?.stats || pick.lastStats || pick.stats || null),
        breakdown:
          entryHasBreakdown
            ? entry.breakdown
            : (fixtureFallback?.breakdown || pick.lastBreakdown || pick.breakdown || null),
        teamName:
          entry?.teamName ||
          fixtureFallback?.teamName ||
          pick.lastRealTeamName ||
          pick.teamName ||
          rosterMeta.teamName ||
          "",
        opponentName:
          entry?.opponentName ||
          fixtureFallback?.opponentName ||
          pick.lastOpponentName ||
          pick.opponentName ||
          "",
        country:
          fixtureFallback?.country ||
          pick.country ||
          pick.nationality ||
          pick.playerCountry ||
          rosterMeta.country ||
          "",
        clubName:
          fixtureFallback?.clubName ||
          pick.clubName ||
          pick.club ||
          pick.teamName ||
          pick.team?.name ||
          rosterMeta.clubName ||
          entry?.teamName ||
          "",
      }, uid);

      return withDerivedLiveState(withDerivedScoring(resolved), uid, resolved.id || pid);
    });
  }

  const myStarters = sortPlayersForDisplay(getResolvedRoster(myUid, 'starters'));
  const myBench = sortPlayersForDisplay(getResolvedRoster(myUid, 'bench'));
  const myRoundTotal = sumDisplayedPoints(myStarters);
  const myBenchTotal = sumDisplayedPoints(myBench);
  const otherUsers = users.filter(u => u.userId !== myUid);
  const isLineupLoading = (uid) => Boolean(stagedLineups.loadingByUid?.[String(uid || "")]);

    const roomNextLabel =
        room?.competitionState?.currentLabel ||
        room?.["competitionState.currentLabel"] ||
        null;

    const nextGameLabel = roomNextLabel || currentWindowLabel || "—";

  const nextLabel =
    (isWorldCupGroupRoom ? worldCupDisplayDay?.label || latestDayResult?.label || roomNextLabel : cupDoc?.currentWindowLabel) ||
    room?.competitionState?.currentLabel ||
    room?.["competitionState.currentLabel"] ||
    "—";

  const winText =
    winStartMs && winEndMs ? `${fmtDT(winStartMs)} → ${fmtDT(winEndMs)}` : "—";

  


  return (
    <div className={`tpPage worldcup-page ${isWorldCupGroupRoom ? "worldcup-group-page" : "worldcup-knockout-page"}`}>
      <div className="tpWrap">
        {/* --- HEADER --- */}
        <div className="tpHeaderRow">
          <div className="tpHeaderLeft">
            <div className="worldcup-flag-marquee" aria-label="World Cup flags">
              <div className="worldcup-flag-track">
                {marqueeFlags.map((country, index) => (
                  <span className="worldcup-flag" key={`${country}-${index}`} title={country}>
                    <FlagIcon country={country} size={26} title={country} />
                  </span>
                ))}
              </div>
            </div>
            <h2 className="tpTitle worldcup-title">{worldCupPageTitle}</h2>
            <div className="tpHeaderMetaBlock">
              {competitionLabel && (
                <div className="tpRoomMeta">
                  Competition: <b className="tpCompetitionLabel"><FlagIcon country={room?.competitionMeta?.country} size={16} /> {competitionLabel}</b>
                </div>
              )}
                <div className="tpRoomMeta">
                    {worldCupWindowLabel}: <b>{winText}</b> • {worldCupCurrentLabel}: <b style={{ color: "var(--color-primary)" }}>{nextLabel}</b>
                </div>
             {/*} {worldCupDisplayNotice && (
                <div className="tpRoomMeta worldcup-day-reset-note">
                  {worldCupDisplayNotice}
                </div>
              )} */}
              <div className="tpRoomMeta">Room: <b>{room?.name} - {roomId}</b></div>
              <div className="tpLiveHeaderLine">
                {headerIsLive ? (
                    <span>
                    <b className="tpLivePill live">Live Updating</b>
                    {nextUpdateInSec > 0 ? (
                      <> • Next update in: <b>{nextUpdateInSec}s</b></>
                    ) : nextUpdateInSec === 0 ? (
                      <> • Next update: <b>checking now</b></>
                    ) : null}
                    <> • Last update at: <b>{lastUpdateLabel}</b></>
                    </span>
                ) : (
                    <span>
                    Status: <b className={`tpLivePill ${headerStatusClass}`}>{headerStatusLabel}</b>
                    {pollNextAtMs > nowMs ? (
                      <> • Next update at: <b>{fmtDT(pollNextAtMs)}</b></>
                    ) : null}
                    <> • Last update at: <b>{lastUpdateLabel}</b></>
                    </span>
                )}
                </div>
            </div>
          </div>

        <div className="tpHeaderRight" ref={scoringRef}>
            <div className="tpHeaderButtons">
                <button
                type="button"
                className="tpScoringBtn"
                onClick={() => setShowScoring((v) => !v)}
                aria-expanded={showScoring}
                aria-haspopup="dialog"
                >
                Scoring <span className={`tpCaret ${showScoring ? "open" : ""}`}>▾</span>
                </button>
            </div>

            {showScoring && (
                <div className="tpScoringPopover" role="dialog" aria-label="Scoring rules">
                <div className="tpScoringTitle">Scoring</div>
                <ul className="tpScoringList">
                    {SCORING_DISPLAY.map((r) => (
                    <li key={r.label} className="tpScoringItem">
                        <span className="tpScoringLabel">{r.label}</span>
                        <span className="tpScoringDetail">{r.detail}</span>
                    </li>
                    ))}
                </ul>
                </div>
            )}

            </div>
        </div>

        {/* --- BODY --- */}
        <div className="tpGrid">
          {showFinalPodium && (
            <div className="tpCard tpFull">
              <FinalResultsCard
                finalResults={finalResultsDoc}
                title={isWorldCupGroupRoom ? "World Cup Group Stage Top 3" : "World Cup Knockout Champion"}
                subtitle="Top 3 Managers"
                badge="🏆"
                showWdl={false}
                matchLabel="Competition"
                fantasyLabel="Fantasy"
                renderUser={(uid, fallbackName) => (
                  <UserChip user={userById?.[uid] || { userId: uid, name: fallbackName }} />
                )}
              />
            </div>
          )}

          {/* LEADERBOARD */}
          <div className="tpCard tpFull">
            <h3 className="tpCardTitle">{worldCupLeaderboardTitle}</h3>
            <div className="tpBoard">
              <div className="tpBoardHead">
                <span>#</span>
                <span>Manager</span>
                <span>Total Fantasy Pts</span>
              </div>
              {displayLeaderboard.map((row, idx) => (
                <div key={row.userId} className="tpBoardRow" style={row.userId === myUid ? { backgroundColor: "rgba(255,255,255,0.05)" } : {}}>
                  <span style={{ fontWeight: "bold", color: idx === 0 ? "gold" : idx === 1 ? "silver" : idx === 2 ? "#cd7f32" : "inherit" }}>{idx + 1}</span>
                  <span><UserChip user={userById[row.userId] || { userId: row.userId, name: row.name }} /></span>
                  <span style={{ fontWeight: "bold" }}>
                    {Number(
                      row.totalPoints ??
                        row.totalFantasyPoints ??
                        row.points ??
                        0
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* YOUR ROSTER */}
          {!showFinalPodium && (
            <div className="tpCard tpFull">
              <h3 className="tpCardTitle">Your Roster</h3>
              <div className="tpLineups tpLineupsSingle">
                <div className="tpSide tpSideMe tpSideSolo">
                  <div className="tpLineupHead">
                    <span className="tpLineupName"><UserChip user={userById[myUid] || { userId: myUid, name: "You" }} /></span>
                    <span className="tpLineupTotal">{myRoundTotal} pts</span>
                  </div>
                  
                  <div className="tpSectionLabel">Starters</div>
                  <ul className="tpList">
                    {myStarters.map((p) => {
                      const isOpen = expandedPlayerId === p.id;
                      const displayTeamName = getDisplayTeamName(p, p, p.stats);
                      const displayOpponentName = getDisplayOpponentName(p, p, p.stats);
                      const isLiveNow = isPlayerLiveFromStats(p.stats);
                      return (
                        <li key={p.id} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                          <div className="tpRow" onClick={() => setExpandedPlayerId(isOpen ? null : p.id)}>
                            <PlayerIdentity
                              name={p.name}
                              country={p.country}
                              club={displayTeamName}
                            />

                            <div className="tpMeta">
                              {normalizeDisplayPos(p.position)}
                              <span className={`tpLivePill ${isLiveNow ? "live" : "idle"}`}>
                                {isLiveNow ? "LIVE" : "IDLE"}
                              </span>
                            </div>
                            <div className={`tpPts ${mainPointsClass(p.points)}`}>{p.points} pts</div>
                          </div>
                          {isOpen && (
                            <PlayerStatsCard
                                stats={p.stats}
                                breakdown={p.breakdown}
                                teamName={displayTeamName}
                                opponentName={displayOpponentName}
                            />
                            )}
                        </li>
                      );
                    })}
                    {!myStarters.length && isLineupLoading(myUid) && (
                      <li className="tpLineupLoading">Loading your lineup...</li>
                    )}
                  </ul>

                    <details className="tpBenchDetails">
                      <summary className="tpBenchSummary">
                        <div className="tpBenchLeft">
                          <span className="tpBenchTitle">Bench</span>
                          <span className="tpBenchNote">Not counted</span>
                        </div>
                        <div className="tpBenchRight">
                          <span className="tpLineupTotal">{myBenchTotal} pts</span>
                          <span className="tpBenchCaret">▾</span>
                        </div>
                      </summary>
                      <ul className="tpList tpBenchList">
                        {myBench.map((p) => {
                          const isOpen = expandedPlayerId === p.id;
                          const displayTeamName = getDisplayTeamName(p, p, p.stats);
                          const displayOpponentName = getDisplayOpponentName(p, p, p.stats);
                          const isLiveNow = isPlayerLiveFromStats(p.stats);
                          return (
                            <li key={p.id} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                              <div className="tpRow" onClick={() => setExpandedPlayerId(isOpen ? null : p.id)}>
                                <PlayerIdentity
                                  name={p.name}
                                  country={p.country}
                                  club={displayTeamName}
                                />

                                <div className="tpMeta">
                                  {normalizeDisplayPos(p.position)}
                                  <span className={`tpLivePill ${isLiveNow ? "live" : "idle"}`}>
                                    {isLiveNow ? "LIVE" : "IDLE"}
                                  </span>
                                </div>
                                <div className={`tpPts ${mainPointsClass(p.points)}`}>{p.points} pts</div>
                              </div>
                                {isOpen && (
                                    <PlayerStatsCard
                                        stats={p.stats}
                                        breakdown={p.breakdown}
                                        teamName={displayTeamName}
                                        opponentName={displayOpponentName}
                                    />
                                    )}
                            </li>
                          );
                        })}
                        {!myBench.length && isLineupLoading(myUid) && (
                          <li className="tpLineupLoading">Loading your bench...</li>
                        )}
                      </ul>
                    </details>
                
                </div>
              </div>
            </div>
          )}

          {/* OTHER MANAGERS */}
          {!showFinalPodium && (
            <div className="tpCard tpFull">
              <h3 className="tpCardTitle">Other Managers</h3>
              {!otherUsers.length ? (
                <p className="tpText">No other managers.</p>
              ) : (
                <div className="tpMatchup">
                  {otherUsers.map((u) => {
                    const isOpen = expandedOtherUser === u.userId;
                    const oppStarters = sortPlayersForDisplay(getResolvedRoster(u.userId, 'starters'));
                    const oppBench = sortPlayersForDisplay(getResolvedRoster(u.userId, 'bench'));

                    const oppRoundTotal = Number(
                      currentBreakdownByUserId?.[u.userId]?.total ??
                        livePoints?.[u.userId] ??
                        sumDisplayedPoints(oppStarters)
                    );
                    const oppBenchTotal = sumDisplayedPoints(oppBench);

                    return (
                      <div key={u.userId} className={`tpOtherMatchupItem ${isOpen ? "open" : ""}`}>
                        <button
                          type="button"
                          className="tpOtherMatchupTop"
                          onClick={() => setExpandedOtherUser(isOpen ? null : u.userId)}
                        >
                          <div className="tpMatchTeams"><UserChip user={u} /></div>
                          <div className="tpOtherScore">
                            <span className={`tpPts ${mainPointsClass(oppRoundTotal)}`}>{oppRoundTotal} pts</span>
                            <span className={`tpCaret ${isOpen ? "open" : ""}`}>▾</span>
                          </div>
                        </button>

                        {isOpen && (
                          <div className="tpOtherMatchupBody">
                            <div className="tpLineups tpLineupsSingle" style={{ marginTop: 0 }}>
                              <div className="tpSide tpSideSolo">
                                <div className="tpSectionLabel">Starters</div>
                                <ul className="tpList">
                                  {oppStarters.map((p) => {
                                    const isPlayerOpen = expandedPlayerId === `opp-${p.id}`;
                                    const displayTeamName = getDisplayTeamName(p, p, p.stats);
                                    const displayOpponentName = getDisplayOpponentName(p, p, p.stats);
                                    const isLiveNow = isPlayerLiveFromStats(p.stats);
                                    return (
                                      <li key={p.id} className={`tpRowWrap ${isPlayerOpen ? "tpRowOpen" : ""}`}>
                                        <div className="tpRow" onClick={() => setExpandedPlayerId(isPlayerOpen ? null : `opp-${p.id}`)}>
                                            <PlayerIdentity
                                              name={p.name}
                                              country={p.country}
                                              club={displayTeamName}
                                            />

                                            <div className="tpMeta">
                                              {normalizeDisplayPos(p.position)}
                                              <span className={`tpLivePill ${isLiveNow ? "live" : "idle"}`}>
                                                {isLiveNow ? "LIVE" : "IDLE"}
                                              </span>
                                            </div>
                                            <div className={`tpPts ${mainPointsClass(p.points)}`}>{p.points} pts</div>
                                        </div>
                                        {isPlayerOpen && <PlayerStatsCard
                                             stats={p.stats}
                                            breakdown={p.breakdown}
                                            teamName={displayTeamName}
                                            opponentName={displayOpponentName}
                                        />}
                                      </li>
                                    );
                                  })}
                                  {!oppStarters.length && isLineupLoading(u.userId) && (
                                    <li className="tpLineupLoading">Loading lineups...</li>
                                  )}
                                </ul>

                                
                                  <details className="tpBenchDetails">
                                    <summary className="tpBenchSummary">
                                      <div className="tpBenchLeft">
                                        <span className="tpBenchTitle">Bench</span>
                                        <span className="tpBenchNote">Not counted</span>
                                      </div>
                                      <div className="tpBenchRight">
                                        <span className="tpLineupTotal">{oppBenchTotal} pts</span>
                                        <span className="tpBenchCaret">▾</span>
                                      </div>
                                    </summary>
                                    <ul className="tpList tpBenchList">
                                      {oppBench.map((p) => {
                                        const isPlayerOpen = expandedPlayerId === `opp-${p.id}`;
                                        const displayTeamName = getDisplayTeamName(p, p, p.stats);
                                        const displayOpponentName = getDisplayOpponentName(p, p, p.stats);
                                        const isLiveNow = isPlayerLiveFromStats(p.stats);
                                        return (
                                          <li key={p.id} className={`tpRowWrap ${isPlayerOpen ? "tpRowOpen" : ""}`}>
                                            <div className="tpRow" onClick={() => setExpandedPlayerId(isPlayerOpen ? null : `opp-${p.id}`)}>
                                              <PlayerIdentity
                                                name={p.name}
                                                country={p.country}
                                                club={displayTeamName}
                                              />

                                              <div className="tpMeta">
                                                {normalizeDisplayPos(p.position)}
                                                <span className={`tpLivePill ${isLiveNow ? "live" : "idle"}`}>
                                                  {isLiveNow ? "LIVE" : "IDLE"}
                                                </span>
                                              </div>
                                              <div className={`tpPts ${mainPointsClass(p.points)}`}>{p.points} pts</div>
                                            </div>
                                            {isPlayerOpen && (
                                              <PlayerStatsCard
                                                stats={p.stats}
                                                breakdown={p.breakdown}
                                                teamName={displayTeamName}
                                                opponentName={displayOpponentName}
                                              />
                                            )}
                                          </li>
                                        );
                                      })}
                                      {!oppBench.length && isLineupLoading(u.userId) && (
                                        <li className="tpLineupLoading">Loading bench...</li>
                                      )}
                                    </ul>
                                  </details>
                                
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          
          {/* DAILY RESULTS */}
          <div className="tpCard tpFull">
            {!historyEnabled ? (
              <div className="tpHistoryLoadCard">
                <div>
                  <h3 className="tpHistoryLoadTitle">
                    {worldCupHistoryTitle}
                  </h3>
                  <p className="tpHistoryLoadText">
                    
                  </p>
                </div>
                <button type="button" className="tpPointsBtn" onClick={() => setHistoryEnabled(true)}>
                  {isWorldCupGroupRoom ? "Load Daily Results" : "Load Knockout Results"}
                </button>
              </div>
            ) : (
              <>
            <div className="tpHistoryHeader">
              <h3 className="tpCardTitle tpHistoryTitle">
                {worldCupHistoryTitle}
              </h3>

              <div className="tpHistoryControls">
                <select
                  className="tpHistorySelect"
                  value={selectedHistoryId}
                  onChange={(e) => setSelectedHistoryId(e.target.value)}
                  disabled={displayHistoryRounds.length === 0}
                >
                  <option value="">
                    {displayHistoryRounds.length === 0
                      ? (isWorldCupGroupRoom ? "No daily results yet" : "No knockout results yet")
                      : (isWorldCupGroupRoom ? "Select daily results..." : "Select knockout results...")}
                  </option>

                  {displayHistoryRounds.map((h) => (
                    <option key={h.id} value={h.id}>
                      {isWorldCupGroupRoom
                        ? `${h.label || "Day"}${h.dateLabel ? ` - ${h.dateLabel}` : ""}`
                        : (h.label || "Cup")}
                      {!isWorldCupGroupRoom && h.startAtMs ? ` • ${fmtDT(h.startAtMs)}` : ""}
                    </option>
                  ))}
                </select>
                
                {/* ✅ ADDED: The Clear Button */}
                {selectedHistoryId && selectedHistoryId !== "" && (
                  <button 
                    type="button" 
                    className="tpMiniBtn" 
                    onClick={() => setSelectedHistoryId("")}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {selectedHistory == null ? (
              <p className="tpText">
                {isWorldCupGroupRoom
                  ? "Pick daily results to view scores."
                  : "Pick knockout results to view final scores."}
              </p>
            ) : (
              <>
                <div className="tpHistoryMetaGrid">
                  <div className="tpHistoryMetaCard">
                    <span className="tpHistoryMetaLabel">
                      {isWorldCupGroupRoom ? "Day Window" : "Window"}
                    </span>
                    <span className="tpHistoryMetaValue">{selectedHistoryRange}</span>
                  </div>

                  <div className="tpHistoryMetaCard">
                    <span className="tpHistoryMetaLabel">
                      {worldCupHistoryTitle}
                    </span>
                    <span className="tpHistoryMetaValue">
                      {isWorldCupGroupRoom && selectedHistory?.dateLabel
                        ? `${selectedHistoryLabel} - ${selectedHistory.dateLabel}`
                        : selectedHistoryLabel}
                    </span>
                  </div>

                  <div className="tpHistoryMetaCard">
                    <span className="tpHistoryMetaLabel">Winner</span>
                    <span className="tpHistoryMetaValue">
                      {selectedHistoryRows[0]?.name || "—"}
                    </span>
                  </div>
                </div>

                {selectedHistoryRows.length > 0 ? (
                  <div className="tpHistoryList">
                    {selectedHistoryRows.map((row) => {
                      const rowUid = String(row.userId || row.uid || "");
                      const rowKey = rowUid || `${row.rank || "rank"}-${row.name || "unknown"}`;
                      const historyBreakdownKey = `${selectedHistoryId}:${rowKey}`;
                      const isOpen = openHistoryBreakdownKey === historyBreakdownKey;
                      const rowUser = userById[rowUid] || {
                        userId: rowUid,
                        displayName: row.name || "Unknown",
                        name: row.name || "Unknown",
                        teamName: row.teamName || "",
                        photoURL: row.photoURL || "",
                      };
                      const historyBreakdown = getHistoryBreakdownForUser(rowUid);
                      const hasHistoryBreakdown =
                        historyBreakdown.starters.length > 0 ||
                        historyBreakdown.bench.length > 0;
                      const emptyHistoryBreakdownText = isWorldCupGroupRoom
                        ? "No player breakdown saved for this day."
                        : "No player breakdown saved for this knockout round.";

                      const pointsToneClass = (points) => {
                        const n = Number(points);
                        if (Number.isFinite(n) && n > 0) return "tpBreakdownPointsPillPositive";
                        if (Number.isFinite(n) && n < 0) return "tpBreakdownPointsPillNegative";
                        return "tpBreakdownPointsPillNeutral";
                      };

                      const valueToneClass = (value) => {
                        const n = typeof value === "number" ? value : Number(value);
                        if (Number.isFinite(n) && n > 0) return "tpBreakdownValuePositive";
                        if (Number.isFinite(n) && n < 0) return "tpBreakdownValueNegative";
                        return "tpBreakdownValueNeutral";
                      };

                      const renderHistoryPlayer = (player, prefix) => {
                        const parts = normalizeHistoryParts(player);
                        const visibleParts = Object.entries(parts || {}).filter(([, v]) => {
                          if (v == null || v === false || v === "" || v === "0") return false;
                          if (typeof v === "number" && v === 0) return false;
                          return true;
                        });
                        const totalPts = Number(player?.points ?? player?.total ?? 0);

                        return (
                          <details key={`${prefix}-${player.id}`} className="tpBreakdownPlayer">
                            <summary className="tpBreakdownSummary">
                              <span className="tpBreakdownName">{player.name || "Player"}</span>
                              <span className="tpBreakdownMeta">
                                <span className="tpBreakdownPosBadge">{player.position || "—"}</span>
                                <span className={`tpBreakdownPointsPill ${pointsToneClass(totalPts)}`}>
                                  {totalPts} pts
                                </span>
                              </span>
                            </summary>

                            {visibleParts.length ? (
                              <div className="tpBreakdownParts">
                                {visibleParts.map(([k, v]) => (
                                  <div key={k} className="tpBreakdownPartRow">
                                    <span className="tpBreakdownPartKey">{prettyStatLabel(k)}</span>
                                    <span className={`tpBreakdownPartVal ${valueToneClass(v)}`}>{String(v)}</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="tpBreakdownParts tpMuted">No stat breakdown saved</div>
                            )}
                          </details>
                        );
                      };

                      return (
                        <div className="tpHistoryRowWrap" key={rowKey}>
                          <div className="tpHistoryRow">
                            <div className="tpHistoryTeams">
                              <span className="tpHistoryRankBadge">#{row.rank}</span>
                              <UserChip user={rowUser} />
                            </div>

                            <div className="tpHistoryScore">
                              <span className="tpHistoryResult">
                                {isWorldCupGroupRoom ? "Day Pts" : "Round Pts"}
                              </span>
                              <span className="tpHistoryPointsPill">
                                {Number(row.roundPoints || 0)} pts
                              </span>
                              <button
                                type="button"
                                className="tpMiniBtn"
                                onClick={() =>
                                  setOpenHistoryBreakdownKey(isOpen ? null : historyBreakdownKey)
                                }
                              >
                                {isOpen ? "Hide" : "Breakdown"}
                              </button>
                            </div>
                          </div>

                          {isOpen && (
                            <div className="tpBreakdownWrap">
                              {hasHistoryBreakdown ? (
                                <div className="tpBreakdownCols tpBreakdownColsSingle">
                                  <div className="tpBreakdownCol">
                                    <div className="tpBreakdownColTitle">
                                      {row.name || rowUser.displayName || "Manager"}
                                    </div>

                                    <div className="tpBreakdownSectionTitle">Starters</div>
                                    {historyBreakdown.starters.length ? (
                                      historyBreakdown.starters.map((player) =>
                                        renderHistoryPlayer(player, `hist-starter-${rowKey}`)
                                      )
                                    ) : (
                                      <div className="tpMuted">No starters saved for this result</div>
                                    )}

                                    <div className="tpBreakdownSectionTitle tpBreakdownBenchSection">Bench (not counted)</div>
                                    {historyBreakdown.bench.length ? (
                                      historyBreakdown.bench.map((player) =>
                                        renderHistoryPlayer(player, `hist-bench-${rowKey}`)
                                      )
                                    ) : (
                                      <div className="tpMuted">No bench saved for this result</div>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <div className="tpMuted">{emptyHistoryBreakdownText}</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="tpText">
                    {isWorldCupGroupRoom
                      ? "No scores saved for this day yet."
                      : "No scores saved for this knockout round yet."}
                  </p>
                )}
              </>
            )}
              </>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

