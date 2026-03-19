"use strict";

/**
 * Decide whether the competition is in RegularSeason or Cup mode
 * based on API-Football round label (league.round).
 */
function detectPhaseFromRoundLabel(roundLabel) {
  const s = String(roundLabel || "").toLowerCase().trim();
  if (!s) return "RegularSeason"; // safe default

  // Knockout-ish keywords
  const KO = [
    "round of", "16", "8", "quarter", "semi", "final",
    "play-off", "playoff", "knockout",
    "1/8", "1/4", "1/2",
  ];

  // If any knockout keyword appears, treat as Cup
  if (KO.some((k) => s.includes(k))) return "Cup";

  // Everything else (matchday, group stage, league stage, regular season, etc.)
  return "RegularSeason";
}

module.exports = { detectPhaseFromRoundLabel };