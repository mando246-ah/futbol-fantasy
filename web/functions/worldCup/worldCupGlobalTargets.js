"use strict";

function toId(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value);
}

function toNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isWorldCupGroupRoom(room = {}) {
  return (
    room?.engineType === "worldCupDaily" ||
    room?.worldCup?.engineType === "worldCupDaily" ||
    room?.worldCupPhase === "group" ||
    room?.worldCup?.phase === "group" ||
    room?.competitionState?.phaseLabel === "WorldCupGroup"
  );
}

function isFinalDayStatus(status) {
  return ["final", "complete", "completed"].includes(String(status || "").trim().toLowerCase());
}

function kickoffMsFromFixture(fixture = {}) {
  const direct = toNumber(fixture?.kickoffMs ?? fixture?.startAtMs ?? fixture?.fixture?.kickoffMs, NaN);
  if (Number.isFinite(direct)) return direct;

  const timestampMs = fixture?.fixture?.timestamp
    ? Number(fixture.fixture.timestamp) * 1000
    : NaN;
  if (Number.isFinite(timestampMs)) return timestampMs;

  return toNumber(Date.parse(fixture?.fixture?.date || fixture?.date || ""), NaN);
}

function fixtureIdFromFixture(fixture = {}) {
  return toId(
    fixture?.fixtureId ??
      fixture?.id ??
      fixture?.fixture?.id
  );
}

function isFixtureInActivePollingWindow(fixture, nowMs, preMs, postMs) {
  const kickoffMs = kickoffMsFromFixture(fixture);
  return (
    Number.isFinite(kickoffMs) &&
    nowMs >= kickoffMs - preMs &&
    nowMs <= kickoffMs + postMs
  );
}

function getActiveFixtureIdsFromDay(day = {}, nowMs, preMs, postMs) {
  const fixtures = Array.isArray(day.fixtures) ? day.fixtures : [];
  const fixturesById = new Map();

  for (const fixture of fixtures) {
    const fixtureId = fixtureIdFromFixture(fixture);
    if (fixtureId) fixturesById.set(fixtureId, fixture);
  }

  const candidateIds = [
    ...(Array.isArray(day.fixtureIds) ? day.fixtureIds : []),
    ...fixtures.map(fixtureIdFromFixture),
  ].map(toId).filter(Boolean);

  const seen = new Set();
  const activeIds = [];

  for (const fixtureId of candidateIds) {
    if (seen.has(fixtureId)) continue;
    seen.add(fixtureId);

    const fixture = fixturesById.get(fixtureId);
    if (!fixture || !isFixtureInActivePollingWindow(fixture, nowMs, preMs, postMs)) continue;
    activeIds.push(fixtureId);
  }

  return activeIds;
}

async function loadDayByIndex({ db, roomId, dayIndex }) {
  const index = Number(dayIndex);
  if (!Number.isFinite(index) || index <= 0) return null;

  const snap = await db.doc(`rooms/${roomId}/days/${String(index)}`).get();
  return snap.exists ? { id: snap.id, ...(snap.data() || {}) } : null;
}

async function loadCandidateDays({ db, roomId }) {
  const snap = await db.collection(`rooms/${roomId}/days`).orderBy("dayIndex").get();
  return (snap.docs || [])
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter((day) => !isFinalDayStatus(day.status))
    .filter((day) =>
      (Array.isArray(day.fixtures) && day.fixtures.length > 0) ||
      (Array.isArray(day.fixtureIds) && day.fixtureIds.length > 0)
    );
}

async function buildWorldCupGroupSeasonTargetForRoom({
  db,
  roomId,
  room,
  nowMs,
  preMs,
  postMs,
}) {
  if (!db || !roomId || !isWorldCupGroupRoom(room)) return null;

  const competition = room?.competition || {};
  const league = Number(competition?.league);
  const season = Number(competition?.season);
  const seasonKey = toId(room?.seasonKey || room?.worldCup?.seasonKey);

  if (!Number.isFinite(league) || !Number.isFinite(season) || !seasonKey) {
    return null;
  }

  const currentDayIndex = room?.worldCup?.currentDayIndex;
  const preferredDay = await loadDayByIndex({ db, roomId, dayIndex: currentDayIndex });
  const preferredFixtureIds = preferredDay
    ? getActiveFixtureIdsFromDay(preferredDay, nowMs, preMs, postMs)
    : [];

  let selectedDay = preferredFixtureIds.length ? preferredDay : null;
  let fixtureIds = preferredFixtureIds;

  if (!selectedDay) {
    const candidateDays = await loadCandidateDays({ db, roomId });
    for (const day of candidateDays) {
      const activeFixtureIds = getActiveFixtureIdsFromDay(day, nowMs, preMs, postMs);
      if (!activeFixtureIds.length) continue;
      selectedDay = day;
      fixtureIds = activeFixtureIds;
      break;
    }
  }

  if (!selectedDay || !fixtureIds.length) {
    return {
      skipped: true,
      reason: "no-active-world-cup-day",
      sleeping: true,
    };
  }

  return {
    roomId: String(roomId),
    seasonKey,
    competitionKey: room?.competitionKey || "",
    competitionType: room?.competitionType || "world-cup",
    league,
    season,
    timezone: String(competition?.timezone || "America/Los_Angeles"),
    fixtureIds,
    roomIds: [String(roomId)],
    source: "world-cup-group-day",
    dayIndex: Number(selectedDay.dayIndex || selectedDay.id) || null,
    dayLabel: selectedDay.label || "",
    fixtureCount: fixtureIds.length,
  };
}

module.exports = {
  buildWorldCupGroupSeasonTargetForRoom,
};
