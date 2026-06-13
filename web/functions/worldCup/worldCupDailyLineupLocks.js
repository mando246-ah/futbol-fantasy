"use strict";

const WORLD_CUP_DAILY_LOCKS_FIELD = "worldCupDailyLocksByPlayerId";

function toPlayerId(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }

  return String(
    value.id ??
      value.playerId ??
      value.pid ??
      value.apiPlayerId ??
      value.player?.id ??
      ""
  ).trim();
}

function isWorldCupDailyRoom(room = {}) {
  const phaseLabel = String(
    room?.competitionState?.phaseLabel ||
      room?.phaseLabel ||
      room?.worldCup?.phaseLabel ||
      ""
  );
  const phase = String(room?.worldCupPhase || room?.worldCup?.phase || "");

  return (
    room?.engineType === "worldCupDaily" ||
    room?.worldCup?.engineType === "worldCupDaily" ||
    phase === "group" ||
    phase === "WorldCupGroup" ||
    phaseLabel === "WorldCupGroup"
  );
}

function hasScoringAppearance(stats = {}) {
  return Number(stats?.minutes ?? stats?.minutesPlayed ?? 0) > 0;
}

function dateKeyInTimeZone(ms, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addCalendarDays(dateKey, days) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
}

function zonedMidnightToUtcMs(dateKey, timezone) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcGuess));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second)
  );

  return utcGuess + (utcGuess - representedAsUtc);
}

function buildWorldCupDailyLockWindow(matchMs, timezone) {
  const safeTimezone = String(timezone || "America/Los_Angeles");
  const matchDate = dateKeyInTimeZone(matchMs, safeTimezone);
  const unlockDate = addCalendarDays(matchDate, 3);

  return {
    matchDate,
    lockedUntilMs: zonedMidnightToUtcMs(unlockDate, safeTimezone),
    timezone: safeTimezone,
  };
}

function getActiveWorldCupDailyLocks(lineup = {}, nowMs = Date.now()) {
  const raw =
    lineup?.[WORLD_CUP_DAILY_LOCKS_FIELD] &&
    typeof lineup[WORLD_CUP_DAILY_LOCKS_FIELD] === "object"
      ? lineup[WORLD_CUP_DAILY_LOCKS_FIELD]
      : {};
  const active = {};

  for (const [key, lock] of Object.entries(raw)) {
    const playerId = toPlayerId(lock?.playerId || key);
    const lockedUntilMs = Number(lock?.lockedUntilMs || 0);
    if (!playerId || !Number.isFinite(lockedUntilMs) || lockedUntilMs <= nowMs) continue;
    active[playerId] = { ...lock, playerId, lockedUntilMs };
  }

  return active;
}

function findWorldCupDailyLockViolation({
  lineup = {},
  nextStarters = [],
  nowMs = Date.now(),
}) {
  const activeLocks = getActiveWorldCupDailyLocks(lineup, nowMs);
  const starterIds = (Array.isArray(nextStarters) ? nextStarters : []).map(toPlayerId);

  for (const lock of Object.values(activeLocks)) {
    const starterIndex = Number(lock?.starterIndex);
    if (!Number.isInteger(starterIndex) || starterIndex < 0) continue;
    if (starterIds[starterIndex] !== lock.playerId) return lock;
  }

  return null;
}

function formatWorldCupDailyLockDate(lock = {}) {
  const lockedUntilMs = Number(lock?.lockedUntilMs || 0);
  if (!Number.isFinite(lockedUntilMs) || lockedUntilMs <= 0) return "the lock expires";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: String(lock?.timezone || "America/Los_Angeles"),
    month: "short",
    day: "numeric",
  }).format(new Date(lockedUntilMs));
}

module.exports = {
  WORLD_CUP_DAILY_LOCKS_FIELD,
  buildWorldCupDailyLockWindow,
  findWorldCupDailyLockViolation,
  formatWorldCupDailyLockDate,
  getActiveWorldCupDailyLocks,
  hasScoringAppearance,
  isWorldCupDailyRoom,
  toPlayerId,
};
