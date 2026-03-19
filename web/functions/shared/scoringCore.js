"use strict";

/**
 * Shared scoring rules + helpers.
 * Extracted from index.js so Regular Season + Cup can reuse it.
 */

const SCORING = {
  appearance: { anyMinutes: 1, sixtyPlus: 1 },
  assists: 3,
  goals: { GK: 6, DEF: 6, MID: 5, FWD: 4 },
  cleanSheet: { GK: 4, DEF: 4, MID: 1, FWD: 0, minMinutes: 60 },
  goalsConceded: { GK: -1, DEF: -1, per: 2 },
  saves: { GK: 1, per: 2 },
  cards: { yellow: -1, red: -3 },
  pens: { saved: 5, missed: -2, committed: -1 },
  rating: { threshold: 8.5, points: 3 },

  passesCompleted: {
    enabled: true,
    perByPos: { GK: 30, DEF: 25, MID: 25, FWD: 20 },
    pointsPerChunk: 1,
  },

  tackles: { per: 2, pointsPerChunk: 1 },
  duelsWon: { per: 4, pointsPerChunk: 1 },
  dribblesSuccess: { per: 2, pointsPerChunk: 1 },
  foulsCommitted: { per: 2, pointsPerChunk: -1 },
  offsides: { per: 3, pointsPerChunk: -1 },
  shotsOnTarget: { per: 1, pointsPerChunk: 1 },
};

/**
 * scorePlayer(stats, pos, scoring?)
 * - pos should already be normalized: "GK" | "DEF" | "MID" | "FWD"
 */
function scorePlayer(stats, pos, scoring = SCORING) {
  const s = {
    minutes: Number(stats?.minutes ?? 0),

    goals: Number(stats?.goals ?? 0),
    assists: Number(stats?.assists ?? 0),

    passesCompleted: Number(stats?.passesCompleted ?? 0),

    cleanSheet: Boolean(stats?.cleanSheet),

    goalsConceded: Number(stats?.goalsConceded ?? 0),
    saves: Number(stats?.saves ?? 0),

    yellow: Number(stats?.yellow ?? 0),
    red: Number(stats?.red ?? 0),

    pensSaved: Number(stats?.pensSaved ?? 0),
    pensMissed: Number(stats?.pensMissed ?? 0),
    pensCommitted: Number(stats?.pensCommitted ?? 0),

    rating: Number(stats?.rating ?? 0),

    tackles: Number(stats?.tackles ?? 0),
    duelsWon: Number(stats?.duelsWon ?? 0),
    dribblesSuccess: Number(stats?.dribblesSuccess ?? 0),
    foulsCommitted: Number(stats?.foulsCommitted ?? 0),
    offsides: Number(stats?.offsides ?? 0),
    shotsOnTarget: Number(stats?.shotsOnTarget ?? 0),

    ownGoals: Number(stats?.ownGoals ?? 0),
  };

  // Critical fix from your index.js: if player has activity but 0 minutes, give them 1 minute
  const hasActivity =
    s.goals > 0 ||
    s.assists > 0 ||
    s.passesCompleted > 0 ||
    s.yellow > 0 ||
    s.red > 0 ||
    s.saves > 0;

  if (s.minutes <= 0 && hasActivity) s.minutes = 1;
  if (s.minutes <= 0) return { points: 0, breakdown: {} };

  let points = 0;
  const breakdown = {};

  // 1) Appearance
  points += scoring.appearance.anyMinutes;
  breakdown.appearance = scoring.appearance.anyMinutes;

  if (s.minutes >= 60) {
    points += scoring.appearance.sixtyPlus;
    breakdown.sixtyPlus = scoring.appearance.sixtyPlus;
  }

  // 2) Goals
  if (s.goals > 0) {
    const pts = (scoring.goals[pos] || 4) * s.goals;
    points += pts;
    breakdown.goals = pts;
  }

  // 3) Assists
  if (s.assists > 0) {
    const pts = scoring.assists * s.assists;
    points += pts;
    breakdown.assists = pts;
  }

  // 4) Clean sheet
  if (s.cleanSheet) {
    const rule = scoring.cleanSheet[pos];
    if (rule !== undefined && s.minutes >= (scoring.cleanSheet.minMinutes || 60)) {
      points += rule;
      breakdown.cleanSheet = rule;
    }
  }

  // 5) Saves (GK)
  if (pos === "GK" && s.saves > 0) {
    const chunk = scoring.saves.per || 3;
    const pts = Math.floor(s.saves / chunk) * (scoring.saves[pos] || 1);
    if (pts > 0) {
      points += pts;
      breakdown.saves = pts;
    }
  }

  // 6) Goals conceded (GK/DEF)
  if ((pos === "GK" || pos === "DEF") && s.goalsConceded > 0) {
    const chunk = scoring.goalsConceded.per || 2;
    const pts =
      Math.floor(s.goalsConceded / chunk) * (scoring.goalsConceded[pos] || -1);
    if (pts !== 0) {
      points += pts;
      breakdown.goalsConceded = pts;
    }
  }

  // 7) Penalties
  if (s.pensSaved > 0) {
    const pts = (scoring.pens.saved || 5) * s.pensSaved;
    points += pts;
    breakdown.pensSaved = pts;
  }
  if (s.pensMissed > 0) {
    const pts = (scoring.pens.missed || -2) * s.pensMissed;
    points += pts;
    breakdown.pensMissed = pts;
  }
  if (s.pensCommitted > 0) {
    const pts = (scoring.pens.committed || -1) * s.pensCommitted;
    points += pts;
    breakdown.pensCommitted = pts;
  }

  // 8) Cards
  if (s.yellow > 0) {
    const pts = (scoring.cards.yellow || -1) * s.yellow;
    points += pts;
    breakdown.yellow = pts;
  }
  if (s.red > 0) {
    const pts = (scoring.cards.red || -3) * s.red;
    points += pts;
    breakdown.red = pts;
  }

  // Rating bonus
  if (s.rating >= (scoring.rating.threshold || 8.5)) {
    points += scoring.rating.points || 3;
    breakdown.rating85 = scoring.rating.points || 3;
  }

  // Advanced chunks
  if (s.tackles > 0) {
    const chunk = scoring.tackles.per || 2;
    const pts = Math.floor(s.tackles / chunk) * (scoring.tackles.pointsPerChunk || 1);
    if (pts) { points += pts; breakdown.tackles = pts; }
  }

  if (s.duelsWon > 0) {
    const chunk = scoring.duelsWon.per || 4;
    const pts = Math.floor(s.duelsWon / chunk) * (scoring.duelsWon.pointsPerChunk || 1);
    if (pts) { points += pts; breakdown.duelsWon = pts; }
  }

  if (s.dribblesSuccess > 0) {
    const chunk = scoring.dribblesSuccess.per || 2;
    const pts = Math.floor(s.dribblesSuccess / chunk) * (scoring.dribblesSuccess.pointsPerChunk || 1);
    if (pts) { points += pts; breakdown.dribblesSuccess = pts; }
  }

  if (s.foulsCommitted > 0) {
    const chunk = scoring.foulsCommitted.per || 2;
    const pts = Math.floor(s.foulsCommitted / chunk) * (scoring.foulsCommitted.pointsPerChunk || -1);
    if (pts) { points += pts; breakdown.foulsCommitted = pts; }
  }

  if (s.offsides > 0) {
    const chunk = scoring.offsides.per || 3;
    const pts = Math.floor(s.offsides / chunk) * (scoring.offsides.pointsPerChunk || -1);
    if (pts) { points += pts; breakdown.offsides = pts; }
  }

  if (s.shotsOnTarget > 0) {
    const pts = s.shotsOnTarget * (scoring.shotsOnTarget.pointsPerChunk || 1);
    if (pts) { points += pts; breakdown.shotsOnTarget = pts; }
  }

  // Passes completed (total)
  if (scoring.passesCompleted.enabled && s.passesCompleted > 0) {
    const threshold = scoring.passesCompleted.perByPos[pos] || 25;
    const pts = Math.floor(s.passesCompleted / threshold) * scoring.passesCompleted.pointsPerChunk;
    if (pts > 0) {
      points += pts;
      breakdown.passesCompleted = pts;
    }
  }

  return { points, breakdown };
}

/**
 * scoreTeam(players, statsByPlayerId, toPosFn?, scoring?)
 * - toPosFn is injected from index.js so we don't have to move your toPos() yet
 */
function scoreTeam(players, statsByPlayerId, toPosFn = (x) => x, scoring = SCORING) {
  let total = 0;
  const perPlayer = {};

  for (const p of players || []) {
    const st = (statsByPlayerId && p?.id) ? (statsByPlayerId[p.id] || {}) : {};
    const pos = toPosFn(p?.position || st.position || st.pos || st.role);
    const r = scorePlayer(st, pos, scoring);

    perPlayer[p.id] = {
      points: r.points,
      breakdown: r.breakdown,
      stats: st,
      realTeamName: st.teamName || "",
      opponentName: st.opponentName || "",
    };

    total += r.points;
  }

  return { total, perPlayer };
}

module.exports = { SCORING, scorePlayer, scoreTeam };