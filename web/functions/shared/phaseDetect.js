"use strict";

/**
 * Decide whether the competition is in RegularSeason or Cup mode
 * based on API-Football round label (league.round).
 */
function detectPhaseFromRoundLabel(roundLabel) {
  const s = String(roundLabel || "").toLowerCase().trim();
  if (!s) return "RegularSeason"; // safe default

  // 1. Clear league / non-knockout labels first
  if (
    s.includes("regular season") ||
    s.includes("matchday") ||
    s.includes("group stage") ||
    s.includes("league stage") ||
    s.includes("clausura") ||
    s.includes("apertura")
  ) {
    return "RegularSeason";
  }

  // 2. Knockout labels (using \b for exact word boundaries, and s? for optional plurals)
  const koRegexes = [
    /\bround of\b/,
    /\bquarter\b/,
    /\bsemi\b/,
    /\bfinals?\b/,         // Matches "final" or "finals"
    /\bplay[- ]?offs?\b/,  // Matches "playoff", "play-off", "playoffs", etc.
    /\bknockouts?\b/,      // Matches "knockout" or "knockouts"
    /\b1\/8\b/,
    /\b1\/4\b/,
    /\b1\/2\b/,
  ];

  // 3. If any regex matches, it's a Cup!
  if (koRegexes.some((rx) => rx.test(s))) return "Cup";

  return "RegularSeason";
}

module.exports = { detectPhaseFromRoundLabel };