"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { WORLD_CUP_GROUP_PHASE, detectWorldCupPhaseFromRoundLabel } = require("./worldCupMode");

function kickoffMsFromFixture(fixture) {
  const timestamp = Number(fixture?.fixture?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp * 1000;

  const parsed = Date.parse(fixture?.fixture?.date || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDateKey(ms, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function formatDateLabel(ms, timezone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

function normalizeWorldCupFixture(rawFixture) {
  const kickoffMs = kickoffMsFromFixture(rawFixture);
  const fixtureId = rawFixture?.fixture?.id;
  if (!fixtureId || !Number.isFinite(kickoffMs)) return null;

  return {
    fixtureId: String(fixtureId),
    kickoffMs,
    homeTeam: rawFixture?.teams?.home?.name || "",
    awayTeam: rawFixture?.teams?.away?.name || "",
    homeTeamId: rawFixture?.teams?.home?.id ? String(rawFixture.teams.home.id) : null,
    awayTeamId: rawFixture?.teams?.away?.id ? String(rawFixture.teams.away.id) : null,
    round: rawFixture?.league?.round || null,
    statusShort: rawFixture?.fixture?.status?.short || null,
    statusLong: rawFixture?.fixture?.status?.long || null,
  };
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12, 0, 0, 0));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate()
  ).padStart(2, "0")}`;
}

function zonedDateTimeToUtcMs(dateKey, timezone) {
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
  const asUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second),
    0
  );

  return utcGuess + (utcGuess - asUtc);
}

function isGroupStageFixture(rawFixture) {
  return (
    detectWorldCupPhaseFromRoundLabel(rawFixture?.league?.round || "") === WORLD_CUP_GROUP_PHASE
  );
}

function buildDailyWindowsFromFixtures(rawFixtures = [], { timezone = "America/Los_Angeles" } = {}) {
  const grouped = new Map();
  const seenFixtureIds = new Set();

  for (const raw of Array.isArray(rawFixtures) ? rawFixtures : []) {
    if (!isGroupStageFixture(raw)) continue;

    const fixture = normalizeWorldCupFixture(raw);
    if (!fixture) continue;
    if (seenFixtureIds.has(fixture.fixtureId)) continue;
    seenFixtureIds.add(fixture.fixtureId);

    const dateKey = formatDateKey(fixture.kickoffMs, timezone);
    const list = grouped.get(dateKey) || [];
    list.push(fixture);
    grouped.set(dateKey, list);
  }

  return Array.from(grouped.entries())
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([dateKey, fixtures], index) => {
      const sortedFixtures = fixtures.sort((a, b) => a.kickoffMs - b.kickoffMs);
      const startAtMs = zonedDateTimeToUtcMs(dateKey, timezone);
      const endAtMs = zonedDateTimeToUtcMs(addDaysToDateKey(dateKey, 1), timezone) - 1;
      const firstKickoffMs = sortedFixtures[0]?.kickoffMs || null;
      const lastKickoffMs = sortedFixtures[sortedFixtures.length - 1]?.kickoffMs || null;

      return {
        dayIndex: index + 1,
        label: `Day ${index + 1}`,
        dateKey,
        dateLabel: firstKickoffMs ? formatDateLabel(firstKickoffMs, timezone) : dateKey,
        timezone,
        startAtMs,
        endAtMs,
        firstKickoffMs,
        lastKickoffMs,
        fixtureIds: sortedFixtures.map((fixture) => fixture.fixtureId),
        fixtures: sortedFixtures,
        status: "scheduled",
      };
    });
}

async function loadWorldCupGroupDailyWindows({
  apiFootballGet,
  apiKey,
  league,
  season,
  timezone = "America/Los_Angeles",
}) {
  const roundsRes = await apiFootballGet("fixtures/rounds", { league, season }, apiKey);
  const rounds = (Array.isArray(roundsRes?.response) ? roundsRes.response : []).filter(
    (roundLabel) => detectWorldCupPhaseFromRoundLabel(roundLabel) === WORLD_CUP_GROUP_PHASE
  );

  const rawFixtures = [];

  for (const round of rounds) {
    const fixturesRes = await apiFootballGet(
      "fixtures",
      { league, season, round, timezone },
      apiKey
    );
    rawFixtures.push(...(Array.isArray(fixturesRes?.response) ? fixturesRes.response : []));
  }

  return buildDailyWindowsFromFixtures(rawFixtures, { timezone });
}

async function writeWorldCupDailyWindowsForRoom({
  db,
  roomId,
  windows = [],
  nowMs = Date.now(),
}) {
  if (!roomId || !Array.isArray(windows) || !windows.length) return 0;

  let batch = db.batch();
  let ops = 0;
  let written = 0;

  const commitBatch = async () => {
    if (ops === 0) return;
    const current = batch;
    batch = db.batch();
    ops = 0;
    await current.commit();
  };

  for (const window of windows) {
    const dayIndex = Number(window?.dayIndex);
    if (!Number.isFinite(dayIndex) || dayIndex <= 0) continue;

    const dayRef = db.doc(`rooms/${roomId}/days/${String(dayIndex)}`);
    batch.set(
      dayRef,
      {
        ...window,
        roomId,
        updatedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    ops += 1;
    written += 1;

    if (ops >= 450) await commitBatch();
  }

  await commitBatch();
  return written;
}

module.exports = {
  buildDailyWindowsFromFixtures,
  loadWorldCupGroupDailyWindows,
  writeWorldCupDailyWindowsForRoom,
};
