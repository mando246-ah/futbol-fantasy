"use strict";

// Picks a "window" of fixtures to score together.
// Prefer grouping by round label; otherwise cluster by kickoff gaps.
function pickCupWindow(candidates, { nowMs, gapHours = 12 } = {}) {
  const list = Array.isArray(candidates) ? [...candidates] : [];
  if (!list.length) return null;

  list.sort((a, b) => Number(a.kickoffMs) - Number(b.kickoffMs));

  // Allow windows that started recently (so we still grab live fixtures)
  const START_GRACE_MS = 3 * 60 * 60 * 1000; // 3h
  const startIdx = list.findIndex((x) => Number(x.kickoffMs) >= (nowMs - START_GRACE_MS));
  const seed = list[startIdx >= 0 ? startIdx : 0];
  if (!seed) return null;

  const round = seed.round || null;

  let picked = [];
  if (round) {
    picked = list.filter((x) => x.round === round);
  } else {
    const gapMs = gapHours * 60 * 60 * 1000;
    picked = [seed];
    for (let i = (startIdx >= 0 ? startIdx : 0) + 1; i < list.length; i++) {
      const prev = picked[picked.length - 1];
      const cur = list[i];
      if (Number(cur.kickoffMs) - Number(prev.kickoffMs) > gapMs) break;
      picked.push(cur);
    }
  }

  const fixtureIds = picked.map((x) => String(x.id)).filter(Boolean);
  if (!fixtureIds.length) return null;

  const label = round || "Cup";
  const minKo = Math.min(...picked.map((x) => Number(x.kickoffMs)));
  const maxKo = Math.max(...picked.map((x) => Number(x.kickoffMs)));

  return {
    windowId: `${label}:${minKo}-${maxKo}`,
    label,
    fixtureIds,
  };
}

module.exports = { pickCupWindow };