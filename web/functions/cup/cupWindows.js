"use strict";

// Picks a "window" of Cup fixtures to score together.
//
// Important:
// Knockout rounds can have the same API round label across different dates.
// Example:
//   Semi-finals Leg 1 = "Semi-finals"
//   Semi-finals Leg 2 = "Semi-finals"
//
// We still keep the same label, but we split the window by kickoff gaps.
// This keeps Tue/Wed games together, but separates fixtures a week apart.
function pickCupWindow(
  candidates,
  {
    nowMs,
    gapHours = 36,
    afterMs = null,
    excludeFixtureIds = [],
  } = {}
) {
  const exclude = new Set(
    (Array.isArray(excludeFixtureIds) ? excludeFixtureIds : [])
      .map(String)
      .filter(Boolean)
  );

  const afterNumber = Number(afterMs);

  let list = Array.isArray(candidates) ? [...candidates] : [];

  list = list
    .map((x) => ({
      ...x,
      id: String(x?.id || ""),
      kickoffMs: Number(x?.kickoffMs || 0),
      round: x?.round || null,
    }))
    .filter((x) => x.id)
    .filter((x) => Number.isFinite(x.kickoffMs) && x.kickoffMs > 0)
    .filter((x) => !exclude.has(String(x.id)));

  // When moving to the next window after a completed one,
  // do not allow the picker to re-arm the same old window.
  if (Number.isFinite(afterNumber) && afterNumber > 0) {
    list = list.filter((x) => Number(x.kickoffMs) > afterNumber);
  }

  if (!list.length) return null;

  list.sort((a, b) => Number(a.kickoffMs) - Number(b.kickoffMs));

  const effectiveNowMs = Number(nowMs || Date.now());
  const START_GRACE_MS = 3 * 60 * 60 * 1000;

  const startIdx = list.findIndex(
    (x) => Number(x.kickoffMs) >= effectiveNowMs - START_GRACE_MS
  );

  const seed = list[startIdx >= 0 ? startIdx : 0];
  if (!seed) return null;

  const round = seed.round || null;

  const pool = round
    ? list.filter((x) => String(x.round || "") === String(round))
    : list;

  pool.sort((a, b) => Number(a.kickoffMs) - Number(b.kickoffMs));

  let seedIdx = pool.findIndex((x) => String(x.id) === String(seed.id));
  if (seedIdx < 0) {
    seedIdx = pool.findIndex(
      (x) => Number(x.kickoffMs) >= effectiveNowMs - START_GRACE_MS
    );
  }
  if (seedIdx < 0) seedIdx = 0;

  const gapMs = gapHours * 60 * 60 * 1000;

  let left = seedIdx;
  while (left > 0) {
    const cur = pool[left];
    const prev = pool[left - 1];

    if (Number(cur.kickoffMs) - Number(prev.kickoffMs) > gapMs) break;
    left -= 1;
  }

  let right = seedIdx;
  while (right < pool.length - 1) {
    const cur = pool[right];
    const next = pool[right + 1];

    if (Number(next.kickoffMs) - Number(cur.kickoffMs) > gapMs) break;
    right += 1;
  }

  const picked = pool.slice(left, right + 1);

  const fixtureIds = picked.map((x) => String(x.id)).filter(Boolean);
  if (!fixtureIds.length) return null;

  const label = round || "Cup";
  const minKo = Math.min(...picked.map((x) => Number(x.kickoffMs)));
  const maxKo = Math.max(...picked.map((x) => Number(x.kickoffMs)));

  return {
    windowId: `${label}:${minKo}-${maxKo}`,
    label,
    fixtureIds,
    fixtures: picked.map((x) => ({
      id: String(x.id),
      kickoffMs: Number(x.kickoffMs) || null,
      round: x.round || null,
    })),
    startAtMs: minKo,
    endAtMs: maxKo,
  };
}

module.exports = { pickCupWindow };