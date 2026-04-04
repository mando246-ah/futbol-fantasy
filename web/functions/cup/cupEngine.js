"use strict";

const { scorePlayer, scoreTeam } = require("../shared/scoringCore");
const { pickCupWindow } = require("./cupWindows");
const { cupCurrentRef, cupFixtureRef, getCreditedMap } = require("./cupLedger");

function isInPlay(short) {
  return ["1H", "HT", "2H", "ET", "BT", "P"].includes(short);
}
function isFinished(short) {
  return ["FT", "AET", "PEN"].includes(short);
}

function toPos(pos) {
  const p = String(pos || "").toUpperCase();
  if (p.includes("GOALKEEP") || p === "GK" || p === "GKP") return "GK";
  if (p.includes("DEFEND") || p.includes("BACK") || p === "DEF") return "DEF";
  if (p.includes("MID") || p === "MID") return "MID";
  if (p.includes("ATTACK") || p.includes("FORW") || p.includes("STRIK") || p === "FWD") return "FWD";
  if (p === "ATT") return "FWD";
  return "MID";
}

function normalizePlayer(raw, metaById) {
  if (!raw) return null;

  if (typeof raw === "string" || typeof raw === "number") {
    const id = String(raw);
    const m = metaById?.get(id) || null;
    return { id, name: m?.name || "Unknown", position: toPos(m?.position || "MID") };
  }

  const id = raw.id || raw.playerId || raw.pid || raw.apiPlayerId || raw?.player?.id || raw?.player?.playerId;
  if (!id) return null;

  const pid = String(id);
  const m = metaById?.get(pid) || null;

  return {
    id: pid,
    name: raw.name || raw.fullName || raw.displayName || raw?.player?.name || m?.name || "Unknown",
    position: toPos(raw.position || raw.pos || raw.role || raw?.player?.position || m?.position || "MID"),
  };
}

function extractList(lineupData, candidates, metaById) {
  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue;
    const out = c.map((x) => normalizePlayer(x, metaById)).filter(Boolean);
    if (out.length) return out;
  }
  return [];
}

function extractStarters(lineupData, metaById) {
  if (!lineupData) return [];
  return extractList(
    lineupData,
    [
      lineupData.startingXI,
      lineupData.starting11,
      lineupData.starters,
      lineupData.starterIds,
      lineupData.startingIds,
      lineupData.lineup?.startingXI,
      lineupData.lineup?.starting11,
      lineupData.lineup?.starters,
    ],
    metaById
  );
}

function extractBench(lineupData, metaById) {
  if (!lineupData) return [];
  return extractList(
    lineupData,
    [
      lineupData.bench,
      lineupData.subs,
      lineupData.substitutes,
      lineupData.benchIds,
      lineupData.subIds,
      lineupData.benchPlayers,
      lineupData.benchPlayerIds,
      lineupData.lineup?.bench,
      lineupData.lineup?.subs,
      lineupData.currentLineup?.bench,
      lineupData.currentLineup?.subs,
    ],
    metaById
  );
}

function sumNumberMaps(a = {}, b = {}) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[k] = Number(out[k] || 0) + n;
  }
  return out;
}

function mergeStatObjects(a = {}, b = {}) {
  const out = { ...(a || {}) };

  for (const [k, v] of Object.entries(b || {})) {
    if (typeof v === "number") {
      out[k] = Number(out[k] || 0) + v;
    } else if (typeof v === "boolean") {
      out[k] = Boolean(out[k]) || v;
    } else if ((out[k] === undefined || out[k] === null || out[k] === "") && v != null) {
      out[k] = v;
    }
  }

  return out;
}

function buildCupPerPlayerEntry(playerObj, stats, one, counted) {
  return {
    id: String(playerObj?.id || ""),
    name: playerObj?.name || "Unknown",
    position: playerObj?.position || "MID",
    points: Number(one?.points || 0),
    counted: !!counted,
    stats: stats || {},
    breakdown: one?.breakdown || one?.parts || {},
    teamName:
      stats?.teamName ||
      stats?.realTeamName ||
      stats?.team?.name ||
      "",
    opponentName:
      stats?.opponentName ||
      stats?.opponent?.name ||
      "",
  };
}

function mergeCupPerPlayerEntry(prev = {}, next = {}) {
  return {
    id: next.id || prev.id || "",
    name: next.name || prev.name || "Unknown",
    position: next.position || prev.position || "MID",
    points: Number(prev.points || 0) + Number(next.points || 0),
    counted: next.counted ?? prev.counted ?? true,
    stats: mergeStatObjects(prev.stats || {}, next.stats || {}),
    breakdown: sumNumberMaps(prev.breakdown || {}, next.breakdown || {}),
    teamName: next.teamName || prev.teamName || "",
    opponentName: next.opponentName || prev.opponentName || "",
  };
}

function mergeCupBreakdownByUserId(base = {}, add = {}) {
  const out = { ...(base || {}) };

  for (const [uid, incoming] of Object.entries(add || {})) {
    const prev = out[uid] || { total: 0, benchTotal: 0, perPlayer: {} };

    const mergedPerPlayer = { ...(prev.perPlayer || {}) };
    for (const [pid, entry] of Object.entries(incoming?.perPlayer || {})) {
      mergedPerPlayer[pid] = mergeCupPerPlayerEntry(mergedPerPlayer[pid], entry);
    }

    out[uid] = {
      total: Number(prev.total || 0) + Number(incoming?.total || 0),
      benchTotal: Number(prev.benchTotal || 0) + Number(incoming?.benchTotal || 0),
      perPlayer: mergedPerPlayer,
    };
  }

  return out;
}

async function discoverFixtures({ apiFootballGet, apiKey, league, season, timezone }) {
  const out = [];

  try {
    const live = await apiFootballGet("fixtures", { live: "all", league, season }, apiKey);
    const list = Array.isArray(live?.response) ? live.response : [];
    out.push(...list);
  } catch (_) {}

  try {
    const up = await apiFootballGet("fixtures", { league, season, next: 100, timezone }, apiKey);
    const list2 = Array.isArray(up?.response) ? up.response : [];
    out.push(...list2);
  } catch (_) {}

  // FIX: Fallback to 90-day search if 'next' returns nothing (Very common for Cups)
  if (out.length === 0) {
    try {
      const now = new Date();
      const from = now.toISOString().split("T")[0];
      now.setUTCDate(now.getUTCDate() + 90);
      const to = now.toISOString().split("T")[0];
      const range = await apiFootballGet("fixtures", { league, season, from, to, timezone }, apiKey);
      const list3 = Array.isArray(range?.response) ? range.response : [];
      out.push(...list3);
    } catch (_) {}
  }

  const parsed = [];
  for (const m of out) {
    const id = String(m?.fixture?.id || "");
    const kickoffMs = m?.fixture?.timestamp ? Number(m.fixture.timestamp) * 1000 : Date.parse(m?.fixture?.date);
    if (!id || !Number.isFinite(kickoffMs)) continue;
    parsed.push({ id, kickoffMs, round: m?.league?.round || null });
  }

  return parsed;
}

function sortCupRows(rows) {
  rows.sort((a, b) => {
    const aPts = Number(a.totalFantasyPoints || 0);
    const bPts = Number(b.totalFantasyPoints || 0);
    if (bPts !== aPts) return bPts - aPts;

    const aTable = Number(a.tablePoints || 0);
    const bTable = Number(b.tablePoints || 0);
    if (bTable !== aTable) return bTable - aTable;

    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  return rows.map((row, i) => ({ ...row, rank: i + 1 }));
}

async function loadMemberMeta(db, roomId, memberUids) {
  const metaByUid = {};

  await Promise.all(
    memberUids.map(async (uid) => {
      const memberSnap = await db.doc(`rooms/${roomId}/members/${uid}`).get();
      const m = memberSnap.exists ? (memberSnap.data() || {}) : {};
      metaByUid[uid] = {
        name:
          m.displayName ||
          m.name ||
          m.username ||
          m.handle ||
          m.email ||
          "Unknown",
      };
    })
  );

  return metaByUid;
}

function buildCupStandings({ memberUids, memberMetaByUid, totalsByUid }) {
  const rows = memberUids.map((uid) => {
    const total = Number(totalsByUid?.[uid] || 0);
    const name = memberMetaByUid?.[uid]?.name || "Unknown";

    return {
      userId: uid,
      uid,
      name,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      tablePoints: total,
      totalFantasyPoints: total,
    };
  });

  return sortCupRows(rows);
}

async function writeCupStandings({ db, roomId, memberUids, memberMetaByUid, totalsByUid, nowMs }) {
  const standings = buildCupStandings({ memberUids, memberMetaByUid, totalsByUid });

  await db.doc(`rooms/${roomId}/standings/current`).set(
    {
      roomId,
      standings,
      updatedAtMs: nowMs,
      source: "cup",
    },
    { merge: true }
  );

  return standings;
}

function makeCupHistoryDocId(windowId, startAtMs, endAtMs) {
  const safeWindowId = String(windowId || "cup-window").replaceAll("/", "_");
  return `${safeWindowId}__${Number(startAtMs || 0)}__${Number(endAtMs || 0)}`;
}

function buildCupHistoryRows({ memberUids, memberMetaByUid, windowPointsByUid, totalsByUid }) {
  const rows = memberUids.map((uid) => ({
    userId: uid,
    uid,
    name: memberMetaByUid?.[uid]?.name || "Unknown",
    roundPoints: Number(windowPointsByUid?.[uid] || 0),
    totalAfter: Number(totalsByUid?.[uid] || 0),
  }));

  rows.sort((a, b) => {
    if (b.totalAfter !== a.totalAfter) return b.totalAfter - a.totalAfter;
    if (b.roundPoints !== a.roundPoints) return b.roundPoints - a.roundPoints;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

async function writeCupHistorySummary({
    db,
    roomId,
    cupDoc,
    memberUids,
    memberMetaByUid,
    nowMs,
  }) {
    const windowId = cupDoc?.currentWindowId || null;
    const label = cupDoc?.currentWindowLabel || "Cup";
    const startAtMs = Number(cupDoc?.currentWindowStartAtMs || 0) || null;
    const endAtMs = Number(cupDoc?.currentWindowEndAtMs || 0) || null;
    const fixtureIds = Array.isArray(cupDoc?.currentWindowFixtureIds)
      ? cupDoc.currentWindowFixtureIds.map(String).filter(Boolean)
      : [];

    const windowPointsByUid = cupDoc?.windowPointsByUid || {};
    const cupTotalsAfterByUid = cupDoc?.cupTotalsByUid || {};

    const rows = buildCupHistoryRows({
      memberUids,
      memberMetaByUid,
      windowPointsByUid,
      totalsByUid: cupTotalsAfterByUid,
    });

    const historyId = makeCupHistoryDocId(windowId, startAtMs, endAtMs);

    await db.doc(`rooms/${roomId}/cupHistory/${historyId}`).set(
      {
        historyId,
        roomId,
        source: "cup",
        windowId,
        label,
        startAtMs,
        endAtMs,
        fixtureIds,
        fixtureCount: fixtureIds.length,
        closedAtMs: nowMs,
        windowPointsByUid,
        cupTotalsAfterByUid,
        breakdownByUserId: cupDoc?.breakdownByUserId || {},
        rows,
      },
      { merge: true }
    );
  }

async function writeCupFinalResults({ db, roomId, standings, nowMs }) {
  const top3 = standings.slice(0, 3).map((r, i) => ({
    rank: i + 1,
    userId: r.userId || r.uid || null,
    name: r.name || "Unknown",
    played: Number(r.played ?? 0),
    wins: Number(r.wins ?? 0),
    draws: Number(r.draws ?? 0),
    losses: Number(r.losses ?? 0),
    tablePoints: Number(r.tablePoints ?? 0),
    totalFantasyPoints: Number(r.totalFantasyPoints ?? 0),
  }));

  const payload = {
    roomId,
    computedAtMs: nowMs,
    championUserId: top3?.[0]?.userId || null,
    top3,
    standingsSnapshot: standings,
    source: "cup",
  };

  await db.doc(`rooms/${roomId}/finalResults/current`).set(payload, { merge: true });
  return payload;
}

async function armNextCupWindow({
  db,
  roomId,
  roomRef,
  cupRef,
  apiFootballGet,
  apiKey,
  league,
  season,
  timezone,
  nowMs,
}) {
  const candidates = await discoverFixtures({ apiFootballGet, apiKey, league, season, timezone });
  const nextWindow = pickCupWindow(candidates, { nowMs, gapHours: 12 });

  if (!nextWindow || !Array.isArray(nextWindow.fixtureIds) || !nextWindow.fixtureIds.length) {
    return null;
  }

  await cupRef.set(
    {
      status: "scheduled",
      currentWindowId: nextWindow.windowId,
      currentWindowLabel: nextWindow.label || "Cup",
      currentWindowFixtureIds: nextWindow.fixtureIds.map(String),
      currentWindowStartAtMs: Number(nextWindow.startAtMs || 0) || null,
      currentWindowEndAtMs: Number(nextWindow.endAtMs || 0) || null,
      windowPointsByUid: {},
      creditedFixtures: {},
      lastWindowClosedAtMs: nowMs,
      updatedAtMs: nowMs,
      breakdownByUserId: {},
      livePointsByUid: {},
    },
    { merge: true }
  );

  await roomRef.set(
    {
      "competitionState.currentLabel": nextWindow.label || "Cup",
      "competitionState.weekStatus": "scheduled",
      "competitionState.updatedAtMs": nowMs,
    },
    { merge: true }
  );

  return nextWindow;
}

async function finalizeCupCompetition({
  db,
  roomId,
  roomRef,
  cupRef,
  memberUids,
  memberMetaByUid,
  totalsByUid,
  nowMs,
}) {
  const standings = await writeCupStandings({
    db,
    roomId,
    memberUids,
    memberMetaByUid,
    totalsByUid,
    nowMs,
  });

  await writeCupFinalResults({ db, roomId, standings, nowMs });

  await cupRef.set(
    {
      status: "FINAL",
      completed: true,
      completedAtMs: nowMs,
      currentWindowId: null,
      currentWindowLabel: "Final",
      currentWindowFixtureIds: [],
      currentWindowStartAtMs: null,
      currentWindowEndAtMs: null,
      windowPointsByUid: {},
      creditedFixtures: {},
      updatedAtMs: nowMs,
    },
    { merge: true }
  );

  await roomRef.set(
    {
      "competitionState.currentLabel": "Final",
      "competitionState.weekStatus": "final",
      "competitionState.isDone": true,
      "competitionState.updatedAtMs": nowMs,
    },
    { merge: true }
  );

  return standings;
}

async function runCupEngine({
  db,
  roomId,
  room,
  nowMs,
  apiKey,
  apiFootballGet,
  getFixtureStatusMap,
  getFixturePlayersStatsMapCached,
}) {
  if (!room) {
    const snap = await db.doc(`rooms/${roomId}`).get();
    room = snap.exists ? (snap.data() || {}) : {};
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const cupRef = cupCurrentRef(db, roomId);

  

  try {
    const competition = room.competition;
    if (!competition?.league || !competition?.season) return;

    if (Boolean(room?.competitionState?.isDone)) return;

    const cupSnap = await cupRef.get();
    let cup = cupSnap.exists ? (cupSnap.data() || {}) : null;

    // --- ✅ ADD SMART TIME GATE LOGIC ---
    if (cup) {
      const status = String(cup.status || "").toLowerCase();
      const startAtMs = Number(cup.currentWindowStartAtMs || 0);
      const endAtMs = Number(cup.currentWindowEndAtMs || 0);

      const PRE_MS = 20 * 60 * 1000;        // 20 min pre-kickoff
      const POST_MS = 3 * 60 * 60 * 1000;   // 3 hrs post-kickoff

      // Only apply sleep logic if scheduled or idle
      if (startAtMs > 0 && endAtMs > 0 && status !== "resolving" && status !== "live" && status !== "final") {
        if (nowMs < startAtMs - PRE_MS || nowMs > endAtMs + POST_MS) {
          // Outside the active window: SLEEP!
          return; 
        }
      }

      if (cup.completed || status === "final") return;
    }

    await cupRef.set({ lastPollAtMs: nowMs, updatedAtMs: nowMs }, { merge: true });

    if (!cup) {
      cup = {
        status: "scheduled",
        completed: false,
        cupTotalsByUid: {},
        windowPointsByUid: {},
        currentWindowId: null,
        currentWindowLabel: null,
        currentWindowFixtureIds: [],
        updatedAtMs: nowMs,
      };
      await cupRef.set(cup, { merge: true });
    }

    if (cup.completed || cup.status === "FINAL") return;

    let currentIds = Array.isArray(cup.currentWindowFixtureIds)
      ? cup.currentWindowFixtureIds.map(String).filter(Boolean)
      : [];

    if (!currentIds.length) {
      const armed = await armNextCupWindow({
        db,
        roomId,
        roomRef,
        cupRef,
        apiFootballGet,
        apiKey,
        league,
        season,
        timezone,
        nowMs,
      });

      if (!armed) {
        await cupRef.set({ status: "scheduled", updatedAtMs: nowMs }, { merge: true });
        await roomRef.set(
          {
            "competitionState.weekStatus": "scheduled",
            "competitionState.updatedAtMs": nowMs,
          },
          { merge: true }
        );
        return;
      }

      currentIds = armed.fixtureIds.map(String);
      cup = {
        ...(cup || {}),
        currentWindowId: armed.windowId,
        currentWindowLabel: armed.label || "Cup",
        currentWindowStartAtMs: Number(armed.startAtMs || 0) || null,
        currentWindowEndAtMs: Number(armed.endAtMs || 0) || null,
        currentWindowFixtureIds: currentIds,
        windowPointsByUid: {},
        creditedFixtures: {},
      };
    }

    const shortById = await getFixtureStatusMap({ fixtureIds: currentIds, timezone, apiKey });

    const anyLive = currentIds.some((fid) => isInPlay(shortById[fid]));
    const anyFin = currentIds.some((fid) => isFinished(shortById[fid]));
    const allFin = currentIds.length > 0 && currentIds.every((fid) => isFinished(shortById[fid]));
    const creditedMap = cup.creditedFixtures || {};
    const allFinAndCredited =
      currentIds.length > 0 && currentIds.every((fid) => isFinished(shortById[fid]) && creditedMap[fid]);

    if (allFin && allFinAndCredited) {
      const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
      const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean);
      const memberMetaByUid = await loadMemberMeta(db, roomId, memberUids);
      const totalsByUid = cup.cupTotalsByUid || {};

      await writeCupHistorySummary({
        db,
        roomId,
        cupDoc: {
          ...cup,
          currentWindowId: cup.currentWindowId,
          currentWindowLabel: cup.currentWindowLabel,
          currentWindowStartAtMs: cup.currentWindowStartAtMs,
          currentWindowEndAtMs: cup.currentWindowEndAtMs,
          currentWindowFixtureIds: currentIds,
          windowPointsByUid: cup.windowPointsByUid || {},
          cupTotalsByUid: totalsByUid,
          breakdownByUserId: cup.breakdownByUserId || {}
        },
        memberUids,
        memberMetaByUid,
        nowMs,
      });

      const armed = await armNextCupWindow({
        db,
        roomId,
        roomRef,
        cupRef,
        apiFootballGet,
        apiKey,
        league,
        season,
        timezone,
        nowMs,
      });

      if (!armed) {
        await finalizeCupCompetition({
          db,
          roomId,
          roomRef,
          cupRef,
          memberUids,
          memberMetaByUid,
          totalsByUid,
          nowMs,
        });
      }
      return;
    }

    const needsResolving = anyFin && !allFinAndCredited;
    const roomWeekStatus = anyLive ? "live" : needsResolving ? "resolving" : "scheduled";

    await cupRef.set({ status: roomWeekStatus, updatedAtMs: nowMs }, { merge: true });
    await roomRef.set(
      {
        "competitionState.weekStatus": roomWeekStatus,
        "competitionState.updatedAtMs": nowMs,
      },
      { merge: true }
    );

    if (!anyLive && !needsResolving) return;

    const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
    const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean);
    if (!memberUids.length) return;

    const memberMetaByUid = await loadMemberMeta(db, roomId, memberUids);

    const picksSnap = await db.collection(`rooms/${roomId}/picks`).get();
    const pickRefByPid = new Map();
    const metaByPid = new Map();
    const rosterByUid = {};

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

    picksSnap.forEach((doc) => {
      const d = doc.data() || {};
      const pid = String(d.playerId ?? d.pid ?? d.apiPlayerId ?? d.player?.id ?? "");
      if (!pid) return;

      pickRefByPid.set(pid, doc.ref);

      const name = d.playerName || d.name || d.player?.name || "Unknown";
      const position = d.position || d.pos || d.role || d.player?.position || "MID";
      metaByPid.set(pid, { name, position });

      const ownerUid = inferOwnerUidFromPick(d);
      if (!ownerUid) return;

      if (!rosterByUid[ownerUid]) rosterByUid[ownerUid] = [];
      rosterByUid[ownerUid].push({
        id: pid,
        name,
        position: toPos(position),
      });
    });

    const lineupByUid = {};
    await Promise.all(
      memberUids.map(async (uid) => {
        const snap = await db.doc(`rooms/${roomId}/lineups/${uid}`).get();
        lineupByUid[uid] = snap.exists ? (snap.data() || {}) : null;
      })
    );

    const livePointsByUid = {};
    const liveBreakdownByUserId = {};
    const livePickUpdates = new Map();

    for (const uid of memberUids) {
      livePointsByUid[uid] = 0;
      liveBreakdownByUserId[uid] = { total: 0, benchTotal: 0, perPlayer: {} };
    }

    for (const fixtureId of currentIds) {
      const short = shortById[fixtureId] || null;
      if (!short || short === "NS") continue;
      if (creditedMap[fixtureId]) continue; // Skip if already permanently credited

      const statsMap = await getFixturePlayersStatsMapCached({
        fixtureId,
        apiKey,
        ttlMs: isInPlay(short) ? 60 * 1000 : 10 * 60 * 1000,
        timeZone: timezone,
      });

      if (!statsMap) continue;

      for (const uid of memberUids) {
        const lineup = lineupByUid[uid];
        const starters = extractStarters(lineup, metaByPid);
        let bench = extractBench(lineup, metaByPid);

        if (!bench.length) {
          const roster = rosterByUid[String(uid)] || [];
          const starterSet = new Set(starters.map((p) => String(p.id)));
          bench = roster.filter((p) => p?.id && !starterSet.has(String(p.id)));
        } else {
          const starterSet = new Set(starters.map((p) => String(p.id)));
          bench = bench.filter((p) => p?.id && !starterSet.has(String(p.id)));
        }

        const starterScored = scoreTeam(starters, statsMap, toPos);
        const benchScored = scoreTeam(bench, statsMap, toPos);
        const starterById = new Map(starters.map((p) => [String(p.id), p]));
        const benchById = new Map(bench.map((p) => [String(p.id), p]));

        liveBreakdownByUserId[uid].total += Number(starterScored.total || 0);
        liveBreakdownByUserId[uid].benchTotal += Number(benchScored.total || 0);

        livePointsByUid[uid] += Number(starterScored.total || 0);
        // Map updates for UI Breakdown Cards
        const processPicks = (playerList, scoredObj, counted) => {
          const listById = new Map(playerList.map((p) => [String(p.id), p]));
          
          for (const [pid, obj] of Object.entries(scoredObj.perPlayer || {})) {
            const p = String(pid);
            const ref = pickRefByPid.get(p);
            
            if (ref && statsMap[p]) {
              const playerObj = listById.get(p) || { id: p, name: metaByPid.get(p)?.name || "Unknown", position: metaByPid.get(p)?.position || "MID" };
              
              // This is what generates the detailed breakdown for the UI!
              const one = scorePlayer(playerObj, statsMap[p] || {}, toPos); 
              const entry = buildCupPerPlayerEntry(playerObj, statsMap[p] || {}, one, counted);

              liveBreakdownByUserId[uid].perPlayer[p] = mergeCupPerPlayerEntry(
                liveBreakdownByUserId[uid].perPlayer[p],
                entry
              );
              
              livePickUpdates.set(p, {
                ref,
                data: {
                  lastFixtureId: String(fixtureId),
                  lastDelta: Number(one?.points ?? obj.points ?? 0),
                  lastDeltaAtMs: nowMs,
                  lastCounted: counted,
                  lastStats: statsMap[p] || {},
                  lastBreakdown:
                    one?.breakdown ||
                    one?.parts ||
                    obj?.breakdown ||
                    obj?.parts ||
                    obj?.pointsBreakdown ||
                    {},
                  lastParts:
                    one?.parts ||
                    obj?.parts ||
                    {},
                  lastRealTeamName: statsMap[p].teamName || statsMap[p].realTeamName || statsMap[p].team?.name || "",
                  lastOpponentName: statsMap[p].opponentName || statsMap[p].opponent?.name || "",
                }
              });
            }
          }
        };

        processPicks(starters, starterScored, true);
        processPicks(bench, benchScored, false);
      }
    }

    // Write Live Points to cup doc
    await cupRef.set(
      {
        livePointsByUid,
        liveBreakdownByUserId,
      },
      { merge: true }
    );

    // Commit live UI updates
    if (livePickUpdates.size > 0) {
      const batches = [];
      let currentBatch = db.batch();
      let opCount = 0;
      for (const u of livePickUpdates.values()) {
        currentBatch.set(u.ref, u.data, { merge: true });
        opCount++;
        if (opCount >= 450) {
          batches.push(currentBatch.commit());
          currentBatch = db.batch();
          opCount = 0;
        }
      }
      if (opCount > 0) batches.push(currentBatch.commit());
      await Promise.all(batches);
    }

    for (const fixtureId of currentIds) {
      const short = shortById[fixtureId] || null;
      if (!isFinished(short)) continue;
      if (creditedMap[fixtureId]) continue;

      const statsMap = await getFixturePlayersStatsMapCached({
        fixtureId,
        apiKey,
        ttlMs: 60 * 60 * 1000,
        timeZone: timezone,
      });

      const pointsByUid = {};
      const pointsByPlayerId = {};
      const pickUpdates = [];
      const breakdownByUserId = {};

      for (const uid of memberUids) {
        const lineup = lineupByUid[uid];

        const starters = extractStarters(lineup, metaByPid);
        let bench = extractBench(lineup, metaByPid);

        if (!bench.length) {
          const roster = rosterByUid[String(uid)] || [];
          const starterSet = new Set(starters.map((p) => String(p.id)));
          bench = roster.filter((p) => p?.id && !starterSet.has(String(p.id)));
        } else {
          const starterSet = new Set(starters.map((p) => String(p.id)));
          bench = bench.filter((p) => p?.id && !starterSet.has(String(p.id)));
        }

        const starterScored = scoreTeam(starters, statsMap, toPos);
        const benchScored = scoreTeam(bench, statsMap, toPos);
        const starterById = new Map(starters.map((p) => [String(p.id), p]));
        const benchById = new Map(bench.map((p) => [String(p.id), p]));

        breakdownByUserId[uid] = {
          total: Number(starterScored.total || 0),
          benchTotal: Number(benchScored.total || 0),
          perPlayer: {},
        };

        pointsByUid[uid] = Number(starterScored.total || 0);

        for (const [pid, obj] of Object.entries(starterScored.perPlayer || {})) {
          const p = String(pid);
          pointsByPlayerId[p] = { points: obj.points, counted: true };
          const ref = pickRefByPid.get(p);
          const playerObj =
            starterById.get(p) ||
            { id: p, name: metaByPid.get(p)?.name || "Unknown", position: metaByPid.get(p)?.position || "MID" };

          const one = scorePlayer(playerObj, statsMap?.[p] || {}, toPos);
          breakdownByUserId[uid].perPlayer[p] = buildCupPerPlayerEntry(
            playerObj,
            statsMap?.[p] || {},
            one,
            true
          );

          if (ref) {
            pickUpdates.push({
              ref,
              data: {
                lastFixtureId: String(fixtureId),
                lastDelta: Number(one?.points ?? obj.points ?? 0),
                lastDeltaAtMs: nowMs,
                lastCounted: true,
                lastStats: statsMap?.[p] || {},
                lastBreakdown:
                  one?.breakdown ||
                  one?.parts ||
                  obj?.breakdown ||
                  obj?.parts ||
                  obj?.pointsBreakdown ||
                  {},
                lastParts:
                  one?.parts ||
                  obj?.parts ||
                  {},
                lastRealTeamName:
                  statsMap?.[p]?.teamName ||
                  statsMap?.[p]?.realTeamName ||
                  statsMap?.[p]?.team?.name ||
                  "",
                lastOpponentName:
                  statsMap?.[p]?.opponentName ||
                  statsMap?.[p]?.opponent?.name ||
                  "",
              },
            });
          }
        }

        for (const [pid, obj] of Object.entries(benchScored.perPlayer || {})) {
          const p = String(pid);
          pointsByPlayerId[p] = { points: obj.points, counted: false };
          const ref = pickRefByPid.get(p);
          const playerObj =
            benchById.get(p) ||
            { id: p, name: metaByPid.get(p)?.name || "Unknown", position: metaByPid.get(p)?.position || "MID" };

          const one = scorePlayer(playerObj, statsMap?.[p] || {}, toPos);
          breakdownByUserId[uid].perPlayer[p] = buildCupPerPlayerEntry(
            playerObj,
            statsMap?.[p] || {},
            one,
            false
          );
          if (ref) {
            pickUpdates.push({
              ref,
              data: {
                lastFixtureId: String(fixtureId),
                lastDelta: Number(one?.points ?? obj.points ?? 0),
                lastDeltaAtMs: nowMs,
                lastCounted: false,
                lastStats: statsMap?.[p] || {},
                lastBreakdown:
                  one?.breakdown ||
                  one?.parts ||
                  obj?.breakdown ||
                  obj?.parts ||
                  obj?.pointsBreakdown ||
                  {},
                lastParts:
                  one?.parts ||
                  obj?.parts ||
                  {},
                lastRealTeamName:
                  statsMap?.[p]?.teamName ||
                  statsMap?.[p]?.realTeamName ||
                  statsMap?.[p]?.team?.name ||
                  "",
                lastOpponentName:
                  statsMap?.[p]?.opponentName ||
                  statsMap?.[p]?.opponent?.name ||
                  "",
              },
            });
          }
        }
      }

      const fixturePayload = {
        fixtureId: String(fixtureId),
        creditedAtMs: nowMs,
        windowId: cup.currentWindowId || null,
        windowLabel: cup.currentWindowLabel || null,
        roundLabel: cup.currentWindowLabel || null,
        pointsByUid,
        pointsByPlayerId,
        breakdownByUserId,
      };

      await db.runTransaction(async (tx) => {
        const curCupSnap = await tx.get(cupRef);
        const cur = curCupSnap.exists ? (curCupSnap.data() || {}) : {};

        if (cur.creditedFixtures && cur.creditedFixtures[fixtureId]) return;

        const totals = { ...(cur.cupTotalsByUid || {}) };
        const windowPts = { ...(cur.windowPointsByUid || {}) };
        const mergedBreakdownByUserId = mergeCupBreakdownByUserId(
          cur.breakdownByUserId || {},
          breakdownByUserId || {}
        );

        for (const [uid, pts] of Object.entries(pointsByUid)) {
          const add = Number(pts || 0);
          totals[uid] = Number(totals[uid] || 0) + add;
          windowPts[uid] = Number(windowPts[uid] || 0) + add;
        }

        const fxRef = cupFixtureRef(db, roomId, fixtureId);
        tx.set(fxRef, fixturePayload, { merge: false });
        tx.set(
          cupRef,
          {
            status: "resolving",
            cupTotalsByUid: totals,
            windowPointsByUid: windowPts,
            lastCreditedFixtureId: String(fixtureId),
            lastCreditedAtMs: nowMs,
            updatedAtMs: nowMs,
            [`creditedFixtures.${fixtureId}`]: true,
            breakdownByUserId: mergedBreakdownByUserId,
          },
          { merge: true }
        );
      });

      if (pickUpdates.length) {
        const batch = db.batch();
        for (const u of pickUpdates) batch.set(u.ref, u.data, { merge: true });
        await batch.commit();
      }
    }

    const cupAfterSnap = await cupRef.get();
    const cupAfter = cupAfterSnap.exists ? (cupAfterSnap.data() || {}) : {};
    const totalsByUid = cupAfter.cupTotalsByUid || {};

    await writeCupStandings({
      db,
      roomId,
      memberUids,
      memberMetaByUid,
      totalsByUid,
      nowMs,
    });

    const creditedMap2 = await getCreditedMap(db, roomId, currentIds);
    const allCredited = currentIds.every((fid) => creditedMap2[fid]);

    if (allFin && allCredited) {
      await writeCupHistorySummary({
        db,
        roomId,
        cupDoc: {
          ...cupAfter,
          currentWindowId: cupAfter.currentWindowId || cup.currentWindowId,
          currentWindowLabel: cupAfter.currentWindowLabel || cup.currentWindowLabel,
          currentWindowStartAtMs: cupAfter.currentWindowStartAtMs || cup.currentWindowStartAtMs,
          currentWindowEndAtMs: cupAfter.currentWindowEndAtMs || cup.currentWindowEndAtMs,
          currentWindowFixtureIds: currentIds,
          windowPointsByUid: cupAfter.windowPointsByUid || {},
          cupTotalsByUid: totalsByUid,
          breakdownByUserId: cup.breakdownByUserId || {}
        },
        memberUids,
        memberMetaByUid,
        nowMs,
      });
      const armed = await armNextCupWindow({
        db,
        roomId,
        roomRef,
        cupRef,
        apiFootballGet,
        apiKey,
        league,
        season,
        timezone,
        nowMs,
      });

      if (!armed) {
        await finalizeCupCompetition({
          db,
          roomId,
          roomRef,
          cupRef,
          memberUids,
          memberMetaByUid,
          totalsByUid,
          nowMs,
        });
      }
    } else {
      const statusToSave = anyLive ? "live" : anyFin ? "resolving" : "scheduled";
      await cupRef.set({ status: statusToSave, updatedAtMs: nowMs }, { merge: true });
      await roomRef.set(
        {
          "competitionState.weekStatus": statusToSave,
          "competitionState.updatedAtMs": nowMs,
        },
        { merge: true }
      );
    }
  } catch (e) {
    console.error("[runCupEngine]", roomId, e);
    await cupRef.set(
      {
        status: "ERROR",
        lastError: String(e?.message || e),
        lastErrorAtMs: nowMs,
        updatedAtMs: nowMs,
      },
      { merge: true }
    );
  }
}

module.exports = { runCupEngine };