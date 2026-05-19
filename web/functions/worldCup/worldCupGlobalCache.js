"use strict";

function toId(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value);
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function loadWorldCupGlobalFixtureCache({ db, seasonKey, fixtureIds }) {
  const ids = [...new Set((Array.isArray(fixtureIds) ? fixtureIds : []).map(toId).filter(Boolean))];
  const safeSeasonKey = toId(seasonKey);

  const fixtureSummariesById = {};
  const liveFixturesById = {};
  const statusByFixtureId = {};
  const playerStatsByFixtureId = {};
  const missingSummaryFixtureIds = [];
  const missingLiveFixtureIds = [];

  if (!db || !safeSeasonKey || !ids.length) {
    return {
      fixtureSummariesById,
      liveFixturesById,
      statusByFixtureId,
      playerStatsByFixtureId,
      missingSummaryFixtureIds: ids,
      missingLiveFixtureIds: ids,
    };
  }

  await Promise.all(ids.map(async (fixtureId) => {
    const [summarySnap, liveSnap] = await Promise.all([
      db.doc(`globalData/main/seasons/${safeSeasonKey}/fixtureSummaries/${fixtureId}`).get(),
      db.doc(`globalData/main/seasons/${safeSeasonKey}/liveFixtures/${fixtureId}`).get(),
    ]);

    const summary = summarySnap.exists ? (summarySnap.data() || {}) : null;
    const live = liveSnap.exists ? (liveSnap.data() || {}) : null;

    if (summary) {
      fixtureSummariesById[fixtureId] = summary;
    } else {
      missingSummaryFixtureIds.push(fixtureId);
    }

    if (live) {
      liveFixturesById[fixtureId] = live;
    } else {
      missingLiveFixtureIds.push(fixtureId);
    }

    statusByFixtureId[fixtureId] =
      summary?.statusShort ||
      summary?.short ||
      live?.statusShort ||
      live?.short ||
      null;

    playerStatsByFixtureId[fixtureId] = asPlainObject(live?.rawStatsByPlayerId);
  }));

  return {
    fixtureSummariesById,
    liveFixturesById,
    statusByFixtureId,
    playerStatsByFixtureId,
    missingSummaryFixtureIds,
    missingLiveFixtureIds,
  };
}

module.exports = {
  loadWorldCupGlobalFixtureCache,
};
