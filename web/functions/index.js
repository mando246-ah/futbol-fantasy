const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger"); // optional but nice

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const { scorePlayer, scoreTeam, SCORING } = require("./shared/scoringCore");
const { runCupEngine } = require("./cup/cupEngine");
const { detectPhaseFromRoundLabel } = require("./shared/phaseDetect");
const { deriveSeasonContext } = require("./shared/seasonMeta");
const {
  bootstrapSeasonPlayerPool,
  loadSeasonPlayerPool,
  replacePlayersInRoom,
} = require("./shared/seasonPlayerPool");
const {
  buildDefaultGlobalPipeline,
  getGlobalPipelineMode,
  isGlobalPlayerPoolEnabled,
  isGlobalLiveFixtureCacheEnabled,
  normalizeGlobalPipelineMode,
} = require("./shared/globalPipeline");
const {
  estimateDocBytes,
  getSeasonFixtureSummaryRef,
  getSeasonLiveFixtureRef,
  writeSeasonFixtureSummary,
  writeSeasonLiveFixture,
} = require("./shared/seasonLiveFixtures");
const {
  buildCompetitionStateRepairData,
  deleteBadFlatCompetitionStateFields,
  getCompetitionState,
  setCompetitionState,
} = require("./shared/competitionState");

//Serve Resolve Market Helpers
async function loadStandingsByUid(roomRef) {
  const snap = await roomRef.collection("standings").doc("current").get();
  const map = new Map();
  if (!snap.exists) return map;

  const data = snap.data() || {};
  const arr = Array.isArray(data.standings) ? data.standings : [];

  for (const row of arr) {
    const uid = row?.userId || row?.uid;
    if (!uid) continue;
    map.set(String(uid), row);
  }
  return map;
}

function getPriority(standingsByUid, uid) {
  const row = standingsByUid.get(String(uid)) || {};
  return {
    matchPts: Number(row.tablePoints ?? 0),
    totalFantasy: Number(row.totalFantasyPoints ?? 0),
  };
}

function comparePriority(a, b) {
  if (a.matchPts !== b.matchPts) return a.matchPts - b.matchPts;
  if (a.totalFantasy !== b.totalFantasy) return a.totalFantasy - b.totalFantasy;
  return 0;
}

function top3FromStandings(standingsArr) {
  const arr = Array.isArray(standingsArr) ? standingsArr : [];
  return arr.slice(0, 3).map((r, i) => ({
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
}

//Functions to help end Final Draft for regular season
function parseRoundNumber(label) {
  if (!label) return null;
  const m = String(label).match(/(\d+)\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

async function fetchTotalRoundsFromApi(competition, apiKey) {
  const league = Number(competition?.league);
  const season = Number(competition?.season);
  if (!Number.isFinite(league) || !Number.isFinite(season)) return null;

  // API-Football returns array like: ["Regular Season - 1", ... "Regular Season - 34"]
  const res = await apiFootballGet("fixtures/rounds", { league, season }, apiKey);
  const rounds = Array.isArray(res?.response) ? res.response : [];

  let maxNum = null;
  for (const r of rounds) {
    const n = parseRoundNumber(r);
    if (!Number.isFinite(n)) continue;
    maxNum = maxNum == null ? n : Math.max(maxNum, n);
  }

  // fallback if no numeric suffix
  if (maxNum == null && rounds.length) maxNum = rounds.length;

  return Number.isFinite(maxNum) && maxNum > 0 ? maxNum : null;
}

async function ensureRoomTotalRounds({ roomId, room, competition, apiKey }) {
  const existing = Number(room?.competitionMeta?.totalRounds);
  if (Number.isFinite(existing) && existing > 0) return existing;

  if (!apiKey) return null;

  const totalRounds = await fetchTotalRoundsFromApi(competition, apiKey);
  if (Number.isFinite(totalRounds) && totalRounds > 0) {
    await db.doc(`rooms/${roomId}`).set({ "competitionMeta.totalRounds": totalRounds }, { merge: true });
    return totalRounds;
  }
  return null;
}

async function writeFinalResultsSnapshot({ roomId }) {
  const finalRef = db.doc(`rooms/${roomId}/finalResults/current`);
  const finalSnap = await finalRef.get();
  if (finalSnap.exists) return finalSnap.data() || {};

  const standingsSnap = await db.doc(`rooms/${roomId}/standings/current`).get();
  const standingsDoc = standingsSnap.exists ? (standingsSnap.data() || {}) : {};
  const standings = Array.isArray(standingsDoc.standings) ? standingsDoc.standings : [];

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
    computedAt: admin.firestore.FieldValue.serverTimestamp(),
    computedAtMs: Date.now(),
    championUserId: top3?.[0]?.userId || null,
    top3,
    standingsSnapshot: standings, // optional but nice for frozen history
  };

  await finalRef.set(payload, { merge: true });
  return payload;
}

//Emails
async function getEmailsForUids(uids) {
  const list = Array.from(new Set((uids || []).map(String).filter(Boolean)));
  if (list.length === 0) return [];

  // Fetch emails from Firebase Auth (no need to store emails in /users docs)
  const emails = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const res = await admin.auth().getUsers(chunk.map((uid) => ({ uid })));
    for (const u of res.users) {
      if (u.email) emails.push(u.email);
    }
  }
  return emails;
}

const DEFAULT_TZ = "America/Los_Angeles";
const ADMIN_UIDS = new Set(["PASTE_MY_UID_HERE"]);

function getRoomTimeZone(room) {
  return (
    room?.competition?.timezone ||
    room?.competitionState?.timezone ||
    room?.timezone ||
    DEFAULT_TZ
  );
}

function formatWhen(ms, timeZone = DEFAULT_TZ) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";

  return new Date(n).toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "0m";

  const totalSeconds = Math.floor(n / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts = [];
  if (hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}



// Writes to Firestore `mail` collection (works with the "Trigger Email" Firebase extension)
async function queueEmails(recipients, subject, html, text, extra = {}) {
  const to = Array.from(new Set((recipients || []).map(String).filter(Boolean)));
  if (to.length === 0) return 0;

  const batch = db.batch();
  for (const email of to) {
    const ref = db.collection("mail").doc();
    batch.set(ref, {
      to: email,
      message: { subject, html, text },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...extra,
    });
  }
  await batch.commit();
  return to.length;
}

// Supports BOTH membership models: room.members[] and rooms/{roomId}/members subcollection
async function getRoomMemberUids(roomRef, room) {
  const arr = Array.isArray(room?.members) ? room.members : [];
  const fromArray = arr
    .map((m) => (typeof m === "string" ? m : m?.uid))
    .filter(Boolean)
    .map(String);

  let fromSub = [];
  try {
    const snap = await roomRef.collection("members").get();
    fromSub = snap.docs.map((d) => d.id).filter(Boolean);
  } catch (_) {}

  return Array.from(new Set([...fromArray, ...fromSub]));
}


//API
const { defineSecret } = require("firebase-functions/params");
const APIFOOTBALL_KEY = defineSecret("APIFOOTBALL_KEY");

async function apiFootballGet(path, params, apiKey) {
  const url = new URL(`https://v3.football.api-sports.io/${path}`);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  const res = await fetch(url.toString(), {
    headers: { "x-apisports-key": apiKey },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API-Football ${res.status}: ${text}`);
  }

    // Some endpoints return 204 No Content (e.g., fixtures/players before kickoff)
  if (res.status === 204) return { response: [] };

  return res.json();
}

function isHost(room, uid) {
  return !!room?.hostUid && room.hostUid === uid;
}

//Tournament 
function toPos(pos) {
  const p = String(pos || "").toUpperCase().trim();

  // Goalkeepers
  if (p.includes("GOALKEEP") || p === "GK" || p === "GKP") return "GK";

  // Defenders
  if (p.includes("DEFEND") || p.includes("BACK") || ["DEF", "CB", "LB", "RB", "LWB", "RWB"].includes(p)) return "DEF";

  // Attackers / Forwards / Strikers
  if (p.includes("ATTACK") || p.includes("FORW") || p.includes("STRIK") || ["FWD", "ATT", "ST", "CF", "LW", "RW", "WING"].includes(p)) return "FWD";

  // Midfielders
  if (p.includes("MID") || ["MID", "CM", "CDM", "CAM", "LM", "RM", "AM", "DM"].includes(p)) return "MID";

  // Ultimate Fallback
  return "MID";
}

function normalizePlayer(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { id: raw, name: "Unknown", position: "MID" };

  const id = raw.id || raw.playerId || raw.pid || raw.apiPlayerId;

  if (!id) return null;

  return {
    id: String(id),
    name: raw.name || raw.fullName || raw.displayName || "Unknown",
    position: toPos(raw.position || raw.pos || raw.role),
  };
}

function pickBestApiFootballPlayerStats(statsArr, { league, preferredTeamId = null } = {}) {
  const arr = Array.isArray(statsArr) ? statsArr : [];
  if (!arr.length) return null;

  if (preferredTeamId) {
    const teamIdStr = String(preferredTeamId);
    return (
      arr.find((s) => String(s?.team?.id || "") === teamIdStr && String(s?.league?.id || "") === String(league)) ||
      arr.find((s) => String(s?.team?.id || "") === teamIdStr) ||
      arr[0] ||
      null
    );
  }

  return (
    arr.find((s) => String(s?.league?.id || "") === String(league)) ||
    arr[0] ||
    null
  );
}

function buildPlayerPoolDocFromApiItem({
  item,
  league,
  season,
  preferredTeamId = null,
  allowedTeamIds = null,
  teamMeta = null,
}) {
  const p = item?.player;
  const playerId = p?.id;
  if (!playerId) return null;

  const st0 = pickBestApiFootballPlayerStats(item?.statistics, { league, preferredTeamId });
  const positionRaw = st0?.games?.position || st0?.games?.pos || "";
  const position = toPos(positionRaw);

  const teamId = st0?.team?.id ?? preferredTeamId ?? null;
  const teamIdStr = teamId ? String(teamId) : null;

  if (allowedTeamIds instanceof Set && teamIdStr && !allowedTeamIds.has(teamIdStr)) {
    return null;
  }

  const teamName =
    st0?.team?.name ||
    (teamMeta instanceof Map && teamIdStr ? teamMeta.get(teamIdStr)?.name : "") ||
    "";
  const teamLogo =
    st0?.team?.logo ||
    (teamMeta instanceof Map && teamIdStr ? teamMeta.get(teamIdStr)?.logo : "") ||
    "";

  const full = `${p?.firstname || ""} ${p?.lastname || ""}`.trim();
  const displayName = full || p?.name || "Unknown";

  return {
    id: String(playerId),
    name: displayName,
    position,
    teamId: teamIdStr,
    teamName,
    teamLogo,
    nationality: p?.nationality || "",
    provider: "api-football",
    league: String(league),
    season: String(season),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function fetchCompetitionPlayerPoolFromApi({
  apiKey,
  league,
  season,
  maxPlayers = 1500,
  maxPages = 200,
  maxPagesPerTeam = 10,
  teamIds = null,
  teamMeta = null,
}) {
  const seen = new Set();
  const players = [];
  let pagesFetched = 0;

  const pushPlayer = (item, preferredTeamId = null, allowedTeamIds = null) => {
    const playerDoc = buildPlayerPoolDocFromApiItem({
      item,
      league,
      season,
      preferredTeamId,
      allowedTeamIds,
      teamMeta,
    });
    if (!playerDoc) return;

    const pid = String(playerDoc.id);
    if (seen.has(pid)) return;
    seen.add(pid);
    players.push(playerDoc);
  };

  if (Array.isArray(teamIds) && teamIds.length > 0) {
    const allowedTeamIds = new Set(teamIds.map(String).filter(Boolean));

    for (const teamIdStr of allowedTeamIds) {
      if (players.length >= maxPlayers) break;

      let page = 1;
      let totalPages = 1;

      while (page <= totalPages && page <= maxPagesPerTeam && players.length < maxPlayers) {
        const res = await apiFootballGet("players", { team: teamIdStr, season, page }, apiKey);
        totalPages = Number(res?.paging?.total ?? 1) || 1;
        pagesFetched += 1;

        const items = Array.isArray(res?.response) ? res.response : [];
        for (const item of items) {
          if (players.length >= maxPlayers) break;
          pushPlayer(item, teamIdStr, allowedTeamIds);
        }

        page += 1;
      }
    }
  } else {
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && page <= maxPages && players.length < maxPlayers) {
      const res = await apiFootballGet("players", { league, season, page }, apiKey);
      totalPages = Number(res?.paging?.total ?? 1) || 1;
      pagesFetched += 1;

      const items = Array.isArray(res?.response) ? res.response : [];
      for (const item of items) {
        if (players.length >= maxPlayers) break;
        pushPlayer(item, null, null);
      }

      page += 1;
    }
  }

  return {
    players,
    written: players.length,
    pagesFetched,
    hitCap: players.length >= maxPlayers,
  };
}

exports.seedPlayersFromCompetition = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    const league = Number(request.data?.league ?? 2); // default UCL
    const season = Number(request.data?.season ?? 2025);

    // Optional: limit the pool to teams playing on a specific day (ex: UCL Wednesday slate).
    // Expected format: "YYYY-MM-DD" in the given timezone.
    const fixtureDate = request.data?.fixtureDate ? String(request.data.fixtureDate) : null;
    const timezone = String(request.data?.timezone ?? "America/Los_Angeles");

    // Safety caps
    // Target cap (hard limit)
    const maxPlayers = Math.max(1, Math.min(1500, Number(request.data?.maxPlayers ?? 1500)));

    // Safety caps (still keep guardrails, but allow enough pages to hit 1500)
    const maxPages = Math.max(1, Math.min(250, Number(request.data?.maxPages ?? 200))); // league paging mode
    const maxPagesPerTeam = Math.max(1, Math.min(20, Number(request.data?.maxPagesPerTeam ?? 10))); // fixture-date mode


    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");
    if (!Number.isFinite(league) || !Number.isFinite(season)) {
      throw new HttpsError("invalid-argument", "league and season are required.");
    }

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (room.hostUid !== uid) throw new HttpsError("permission-denied", "Host only.");

    const apiKey = APIFOOTBALL_KEY.value();
    const competition = {
      provider: "api-football",
      league,
      season,
      timezone,
    };
    let window = null;
    try {
      window = await fetchNextRoundWindow(competition, { fallbackDate: fixtureDate });
    } catch (e) {
      console.warn(`[seedPlayersFromCompetition] fetchNextRoundWindow failed`, e);
    }

    const roundLabel = window?.roundLabel || null;
    const phaseLabel = detectPhaseFromRoundLabel(roundLabel);
    const normalizedSeasonContext = deriveSeasonContext({
      roomSeasonKey: room?.seasonKey,
      roomCompetitionKey: room?.competitionKey,
      roomCompetitionType: room?.competitionType,
      roomCompetitionName:
        room?.competitionMeta?.name ||
        room?.competition?.name ||
        request.data?.competitionName ||
        null,
      season,
      league,
      phaseLabel,
      seasonKey: request.data?.seasonKey,
      competitionKey: request.data?.competitionKey,
      competitionType: request.data?.competitionType,
      seasonLabel: request.data?.seasonLabel,
    });
    const seasonKey = normalizedSeasonContext.seasonKey || "";
    const roomSeasonFieldUpdates = {};

    // Phase 1 global season foundation:
    // These fields are additive room metadata only. Existing room-scoped
    // competition, scoring, polling, and Cup/Regular Season flows continue
    // to read room.competition and room.competitionState as before.
    if (normalizedSeasonContext.seasonKey) {
      roomSeasonFieldUpdates.seasonKey = normalizedSeasonContext.seasonKey;
    }
    if (normalizedSeasonContext.competitionKey) {
      roomSeasonFieldUpdates.competitionKey = normalizedSeasonContext.competitionKey;
    }
    if (normalizedSeasonContext.competitionType) {
      roomSeasonFieldUpdates.competitionType = normalizedSeasonContext.competitionType;
    }

    // If fixtureDate is provided, fetch the fixtures for that day and build the allowed team set.
    // We'll then pull players by TEAM to avoid missing Wednesday teams due to league pagination limits.
    const teamMeta = new Map(); // teamId -> { id, name, logo }
    if (fixtureDate) {
      const fx = await apiFootballGet(
        "fixtures",
        { league, season, date: fixtureDate, timezone },
        apiKey
      );

      const fixtures = Array.isArray(fx?.response) ? fx.response : [];
      for (const f of fixtures) {
        const home = f?.teams?.home;
        const away = f?.teams?.away;

        if (home?.id) teamMeta.set(String(home.id), { id: String(home.id), name: home?.name || "", logo: home?.logo || "" });
        if (away?.id) teamMeta.set(String(away.id), { id: String(away.id), name: away?.name || "", logo: away?.logo || "" });
      }

      if (teamMeta.size === 0) {
        throw new HttpsError(
          "failed-precondition",
          `No fixtures found for ${fixtureDate} (league=${league}, season=${season}, timezone=${timezone}).`
        );
      }
    }

    let written = 0;
    let pagesFetched = 0;
    let usedGlobalSeasonPlayers = false;
    let hitCap = false;
    let globalBootstrapWritten = 0;
    let globalBootstrapError = null;
    const fetchedPlayerDocs = [];

    function filterPlayersForFixtureDate(players = []) {
      if (!fixtureDate) return players;

      return (players || []).filter((player) => {
        const teamIdStr = player?.teamId ? String(player.teamId) : "";
        return !teamIdStr || teamMeta.has(teamIdStr);
      });
    }

    const globalPlayerPoolEnabled = isGlobalPlayerPoolEnabled(room);

    if (globalPlayerPoolEnabled && seasonKey) {
      const seasonPlayers = await loadSeasonPlayerPool({ db, seasonKey });
      const roomSourcePlayers = filterPlayersForFixtureDate(seasonPlayers);

      if (seasonPlayers.length > 0 && (!fixtureDate || roomSourcePlayers.length > 0)) {
        written = await replacePlayersInRoom({
          db,
          roomId,
          players: roomSourcePlayers,
        });
        usedGlobalSeasonPlayers = true;
      }
    }

    if (!usedGlobalSeasonPlayers) {
      const fetchResult = await fetchCompetitionPlayerPoolFromApi({
        apiKey,
        league,
        season,
        maxPlayers,
        maxPages,
        maxPagesPerTeam,
        teamIds: fixtureDate ? Array.from(teamMeta.keys()) : null,
        teamMeta,
      });

      fetchedPlayerDocs.push(...fetchResult.players);
      written = fetchResult.written;
      pagesFetched = fetchResult.pagesFetched;
      hitCap = fetchResult.hitCap;
    }

    if (!usedGlobalSeasonPlayers && fetchedPlayerDocs.length > 0) {
      written = await replacePlayersInRoom({
        db,
        roomId,
        players: fetchedPlayerDocs,
      });
    }

    // Only bootstrap the global season pool from a full season seed.
    // Fixture-date seeding remains room-local fallback so we never create
    // an incomplete master season pool from a slate-specific request.
    if (!usedGlobalSeasonPlayers && seasonKey && !fixtureDate && fetchedPlayerDocs.length > 0) {
      try {
        globalBootstrapWritten = await bootstrapSeasonPlayerPool({
          db,
          seasonKey,
          players: fetchedPlayerDocs,
        });
      } catch (e) {
        globalBootstrapError = String(e?.message || e);
        console.warn("[seedPlayersFromCompetition] Global bootstrap failed but room seed succeeded", {
          roomId,
          seasonKey,
          error: globalBootstrapError,
        });
      }
    }

    // Only RegularSeason needs competitionMeta.totalRounds
    if (phaseLabel === "RegularSeason") {
      await ensureRoomTotalRounds({ roomId, room, competition, apiKey });
    }

    await roomRef.set(
      {
        competition,
        seedFilter: fixtureDate ? { fixtureDate } : admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...roomSeasonFieldUpdates,
        competitionLocked: true,
        status: "ready_to_draft",
        playerCount: written,
      },
      { merge: true }
    );

    await setCompetitionState(
      roomRef,
      {
        phaseLabel,
        currentLabel: roundLabel,
        isDone: false,
        weekStatus: "scheduled",
      },
      {
        roomData: room,
      }
    );

    return {
      ok: true,
      league,
      season,
      seasonKey,
      fixtureDate,
      timezone,
      pagesFetched,
      written,
      maxPlayers,
      hitCap: hitCap || written >= maxPlayers,
      teamCount: fixtureDate ? teamMeta.size : null,
      globalPlayerPoolEnabled,
      usedGlobalSeasonPlayers,
      source: usedGlobalSeasonPlayers ? "global-season-player-pool" : "api-football",
      globalBootstrapWritten,
      globalBootstrapError,

      // helpful for debugging in the client
      phaseLabel,
      roundLabel,
    };
  }
);

exports.bootstrapGlobalSeasonPlayerPool = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const league = Number(request.data?.league);
    const season = Number(request.data?.season);
    const timezone = String(request.data?.timezone ?? "America/Los_Angeles");
    const maxPlayers = Math.max(1, Math.min(1500, Number(request.data?.maxPlayers ?? 1500)));
    const maxPages = Math.max(1, Math.min(250, Number(request.data?.maxPages ?? 200)));

    if (!Number.isFinite(league) || !Number.isFinite(season)) {
      throw new HttpsError("invalid-argument", "league and season are required.");
    }

    const seasonContext = deriveSeasonContext({
      roomCompetitionName: request.data?.competitionName || null,
      league,
      season,
      seasonKey: request.data?.seasonKey,
      competitionKey: request.data?.competitionKey,
      competitionType: request.data?.competitionType,
      seasonLabel: request.data?.seasonLabel,
    });

    if (!seasonContext?.seasonKey) {
      throw new HttpsError("invalid-argument", "Could not derive seasonKey.");
    }

    const apiKey = APIFOOTBALL_KEY.value();
    const fetchResult = await fetchCompetitionPlayerPoolFromApi({
      apiKey,
      league,
      season,
      maxPlayers,
      maxPages,
    });

    const written = await bootstrapSeasonPlayerPool({
      db,
      seasonKey: seasonContext.seasonKey,
      players: fetchResult.players,
    });

    return {
      ok: true,
      seasonKey: seasonContext.seasonKey,
      competitionKey: seasonContext.competitionKey || "",
      competitionType: seasonContext.competitionType || "",
      timezone,
      written,
      pagesFetched: fetchResult.pagesFetched,
      hitCap: fetchResult.hitCap,
    };
  }
);

exports.setRoomGlobalPipelineMode = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = String(request.data?.roomId || "").trim();
    const rawMode = String(request.data?.mode || "").trim().toLowerCase();
    const mode = normalizeGlobalPipelineMode(rawMode);

    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");
    if (!rawMode || mode !== rawMode) {
      throw new HttpsError("invalid-argument", 'mode must be "legacy", "shadow", or "global".');
    }

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    const pipeline = buildDefaultGlobalPipeline(mode);

    await roomRef.set(
      {
        globalPipeline: pipeline,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      ok: true,
      roomId,
      mode: getGlobalPipelineMode({ globalPipeline: pipeline }),
      globalPipeline: pipeline,
    };
  }
);


function extractStarters(lineupData) {
  if (!lineupData) return [];

  const candidates = [
    lineupData.startingXI,
    lineupData.starting11,
    lineupData.starters,
    lineupData.starterIds,
    lineupData.startingIds,
    lineupData.lineup?.startingXI,
    lineupData.lineup?.starting11,
    lineupData.lineup?.starters,
  ];

  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue;

    if (typeof c[0] === "string") {
      return c.map((id) => ({ id: String(id), name: "Unknown", position: "MID" }));
    }

    const inline = c.map(normalizePlayer).filter(Boolean);
    if (inline.length) return inline;
  }

  return [];
}

function extractBench(lineupData) {
  if (!lineupData) return [];

  const candidates = [
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
  ];

  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue;

    // ids
    if (typeof c[0] === "string" || typeof c[0] === "number") {
      return c.map((id) => ({ id: String(id), name: "Unknown", position: "MID" }));
    }

    // inline objects
    const inline = c.map(normalizePlayer).filter(Boolean);
    if (inline.length) return inline;
  }

  return [];
}


// deterministic mock stats (same idea as your client mock)
function hashToUint32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}
function genMockStats(roundId, player) {
  const rng = mulberry32(hashToUint32(`${roundId}:${player.id}`));
  const roll = rng();
  const minutes = roll < 0.08 ? 0 : roll < 0.15 ? randInt(rng, 1, 30) : randInt(rng, 60, 90);

  const passBase = player.position === "MID" ? [35, 120]
    : player.position === "DEF" ? [25, 95]
    : player.position === "GK" ? [10, 45]
    : [10, 70];

  const passesCompleted = minutes === 0 ? 0 : randInt(rng, passBase[0], passBase[1]);

  const goalsChance = player.position === "FWD" ? 0.12 : player.position === "MID" ? 0.07 : player.position === "DEF" ? 0.03 : 0.002;
  const assistsChance = player.position === "MID" ? 0.10 : player.position === "FWD" ? 0.08 : player.position === "DEF" ? 0.04 : 0.005;

  const goals = minutes === 0 ? 0 : (rng() < goalsChance ? 1 : 0);
  const assists = minutes === 0 ? 0 : (rng() < assistsChance ? 1 : 0);

  return { minutes, passesCompleted, goals, assists };
}

function pairMatchups(users, totalsByUid, roundId) {
  const matchups = [];
  for (let i = 0; i < users.length; i += 2) {
    const a = users[i];
    const b = users[i + 1];
    if (!b) break;

    const aTotal = totalsByUid[a.userId] ?? 0;
    const bTotal = totalsByUid[b.userId] ?? 0;

    let aRes = "L", bRes = "W", winnerUserId = b.userId;
    if (aTotal > bTotal) { aRes = "W"; bRes = "L"; winnerUserId = a.userId; }
    else if (aTotal === bTotal) { aRes = "D"; bRes = "D"; winnerUserId = null; }

    matchups.push({
      roundId,
      homeUserId: a.userId,
      awayUserId: b.userId,
      homeTotal: aTotal,
      awayTotal: bTotal,
      homeResult: aRes,
      awayResult: bRes,
      winnerUserId,
      status: "FINAL",
    });
  }
  return matchups;
}

function buildLeaderboard(users, matchups, totalsByUid) {
  const tablePts = (r) => (r === "W" ? 3 : r === "D" ? 1 : 0);

  const rows = users.map((u) => {
    const m = matchups.find((x) => x.homeUserId === u.userId || x.awayUserId === u.userId);
    const res = !m ? "-" : (m.homeUserId === u.userId ? m.homeResult : m.awayResult);
    return {
      userId: u.userId,
      name: u.name,
      result: res,
      matchPoints: res === "-" ? 0 : tablePts(res),
      fantasyPoints: totalsByUid[u.userId] ?? 0,
    };
  });

  rows.sort((a, b) => (b.matchPoints - a.matchPoints) || (b.fantasyPoints - a.fantasyPoints));
  return rows;
}

exports.searchLeagues = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const q = String(request.data?.query || "").trim();
    if (q.length < 2) return { results: [] };

    const apiKey = APIFOOTBALL_KEY.value();
    const res = await apiFootballGet("leagues", { search: q }, apiKey);

    const items = Array.isArray(res?.response) ? res.response : [];

    const results = items
      .map((it) => {
        const league = it?.league || {};
        const country = it?.country || {};
        const seasons = Array.isArray(it?.seasons) ? it.seasons : [];

        const years = seasons
          .map((s) => Number(s?.year))
          .filter(Number.isFinite)
          .sort((a, b) => b - a);

        const currentSeason =
          seasons.find((s) => s?.current)?.year ?? (years[0] ?? null);

        return {
          leagueId: String(league.id || ""),
          name: league.name || "",
          type: league.type || "",
          logo: league.logo || "",
          country: country.name || "",
          seasons: years.slice(0, 8),
          currentSeason: currentSeason ? Number(currentSeason) : null,
        };
      })
      .filter((x) => x.leagueId && x.name)
      .slice(0, 12);

    return { results };
  }
);


exports.computeRoundResults = onCall({ region: "us-west2" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const roomId = request.data?.roomId;
  const roundId = Number(request.data?.roundId ?? 1);

  if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = roomSnap.data();
  if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

  // members
  const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
  const memberUids = membersSnap.docs.map((d) => d.id);

  if (memberUids.length < 2) {
    // still write results, but no matchups
    // (or you can throw)
  }

  // build users + starters
  const users = [];
  for (const mUid of memberUids) {
    const userSnap = await db.doc(`users/${mUid}`).get();
    const profile = userSnap.exists ? userSnap.data() : {};
    const display = (profile.displayName || profile.name || mUid).trim();

    const tnSnap = await db.doc(`rooms/${roomId}/teamNames/${mUid}`).get();
    const tn = tnSnap.exists ? (tnSnap.data().teamName || "") : "";
    const name = tn ? `${display} — ${tn}` : display;

    const lineupSnap = await db.doc(`rooms/${roomId}/lineups/${mUid}`).get();
    const lineup = lineupSnap.exists ? lineupSnap.data() : null;

    const starters = extractStarters(lineup);
    const bench = extractBench(lineup);
    users.push({ userId: mUid, name, starters, bench });
  }

  // generate stats + score
  const totalsByUid = {};
  const breakdownByUserId = {};
  const statsByPlayerIdByUserId = {};

  for (const u of users) {
    const statsByPlayerId = {};
    for (const p of u.starters) {
      statsByPlayerId[p.id] = genMockStats(roundId, p);
    }
    statsByPlayerIdByUserId[u.userId] = statsByPlayerId;

    const scored = scoreTeam(u.starters, statsByPlayerId, toPos);
    totalsByUid[u.userId] = scored.total;
    breakdownByUserId[u.userId] = scored;
  }

  const matchups = pairMatchups(users, totalsByUid, roundId);
  const leaderboard = buildLeaderboard(users, matchups, totalsByUid);

  const resultsDoc = {
    roomId,
    roundId,
    teamScoresByUserId: totalsByUid,
    breakdownByUserId,
    matchups,
    leaderboard,
    computedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.doc(`rooms/${roomId}/roundResults/${String(roundId)}`).set(resultsDoc, { merge: true });

  return { ok: true, roundId };
});

//Demo Opponenets for testing
function buildBotLineup(botId, botNum) {
  // 4-4-2 starters + 4 bench
  const starters = [
    { id: `${botId}_gk1`, name: `Bot ${botNum} GK`, position: "GK" },

    { id: `${botId}_def1`, name: `Bot ${botNum} DEF 1`, position: "DEF" },
    { id: `${botId}_def2`, name: `Bot ${botNum} DEF 2`, position: "DEF" },
    { id: `${botId}_def3`, name: `Bot ${botNum} DEF 3`, position: "DEF" },
    { id: `${botId}_def4`, name: `Bot ${botNum} DEF 4`, position: "DEF" },

    { id: `${botId}_mid1`, name: `Bot ${botNum} MID 1`, position: "MID" },
    { id: `${botId}_mid2`, name: `Bot ${botNum} MID 2`, position: "MID" },
    { id: `${botId}_mid3`, name: `Bot ${botNum} MID 3`, position: "MID" },
    { id: `${botId}_mid4`, name: `Bot ${botNum} MID 4`, position: "MID" },

    { id: `${botId}_fwd1`, name: `Bot ${botNum} FWD 1`, position: "FWD" },
    { id: `${botId}_fwd2`, name: `Bot ${botNum} FWD 2`, position: "FWD" },
  ].map((p) => ({ ...p, position: toPos(p.position) }));

  const bench = [
    { id: `${botId}_bgk`, name: `Bot ${botNum} Bench GK`, position: "GK" },
    { id: `${botId}_bdef`, name: `Bot ${botNum} Bench DEF`, position: "DEF" },
    { id: `${botId}_bmid`, name: `Bot ${botNum} Bench MID`, position: "MID" },
    { id: `${botId}_bfwd`, name: `Bot ${botNum} Bench FWD`, position: "FWD" },
  ].map((p) => ({ ...p, position: toPos(p.position) }));

  return { starters, bench };
}

function safeId(str) {
  return String(str || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 40);
}


exports.seedDemoOpponents = onCall({ region: "us-west2" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const roomId = request.data?.roomId;
  const countRaw = Number(request.data?.count ?? 3);
  const count = Math.max(1, Math.min(7, isFinite(countRaw) ? countRaw : 3));

  if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = roomSnap.data() || {};
  if (room.hostUid !== uid) throw new HttpsError("permission-denied", "Host only.");

  const roomTag = safeId(roomId);

  const batch = db.batch();

  for (let i = 1; i <= count; i++) {
    const botUid = `bot_${roomTag}_${i}`;

    // users/{botUid}
    batch.set(
      db.doc(`users/${botUid}`),
      { displayName: `Bot ${i}`, isBot: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    // rooms/{roomId}/members/{botUid}
    batch.set(
      db.doc(`rooms/${roomId}/members/${botUid}`),
      { isBot: true, joinedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    // rooms/{roomId}/teamNames/{botUid}
    batch.set(
      db.doc(`rooms/${roomId}/teamNames/${botUid}`),
      { teamName: `Bot Squad ${i}`, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    // rooms/{roomId}/lineups/{botUid}
    const lineup = buildBotLineup(botUid, i);
    batch.set(
      db.doc(`rooms/${roomId}/lineups/${botUid}`),
      { ...lineup, isBot: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  await batch.commit();

  return { ok: true, created: count };
});


function extractRoster(lineupData) {
  const starters = extractStarters(lineupData);
  const bench = extractBench(lineupData);
  const byId = new Map();

  for (const p of [...starters, ...bench]) {
    if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
  }

  return Array.from(byId.values());
}

function startOfUtcDay(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// deterministic mock fixtures around "now" (later replaced by API fixtures)
// creates fixtures for days [now-2 .. now+2] with random kickoff times per day
function genMockFixturesAroundNow(playerId, nowMs) {
  const rng = mulberry32(hashToUint32(`${playerId}:lock-fixtures`));
  const day0 = startOfUtcDay(nowMs) - 2 * 24 * 60 * 60 * 1000;

  const fixtures = [];
  for (let i = 0; i < 5; i++) {
    // ~55% chance this player plays that day (for testing variety)
    if (rng() < 0.55) {
      const hour = randInt(rng, 12, 22);
      const minute = randInt(rng, 0, 59);
      const kickoffMs = day0 + i * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000 + minute * 60 * 1000;

      fixtures.push({
        fixtureId: `${playerId}_lock_${kickoffMs}`,
        kickoffMs,
      });
    }
  }
  fixtures.sort((a, b) => a.kickoffMs - b.kickoffMs);
  return fixtures;
}

function isLive(nowMs, kickoffMs) {
  const DURATION_MS = 2 * 60 * 60 * 1000; // ~2 hours
  return nowMs >= kickoffMs && nowMs <= kickoffMs + DURATION_MS;
}

exports.getUserLockStatus = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const nowMs = Number(request.data?.nowMs ?? Date.now());

    // 1) Room + competition (fallback to UCL test)
    const roomSnap = await db.doc(`rooms/${roomId}`).get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");
    const room = roomSnap.data() || {};

    const competition = room.competition;
    if (!competition?.league || !competition?.season) {
      console.warn(`[autoAdvanceWeekIfFinal] Missing room.competition for room ${roomId}`);
      return null; // or throw, depending on your preference
    }

    const league = Number(competition.league ?? 2);
    const season = Number(competition.season ?? 2025);
    const timezone = String(competition.timezone || "America/Los_Angeles");

    // 2) Get THIS user's STARTING XI (lock only if starters are live)
    // 2) Get THIS user's ENTIRE ROSTER
    const lineupSnap = await db.doc(`rooms/${roomId}/lineups/${uid}`).get();
    const lineup = lineupSnap.exists ? (lineupSnap.data() || null) : null;

    const starters = extractStarters(lineup);
    const bench = extractBench(lineup);
    const allRoster = [...starters, ...bench]; // COMBINE THEM

    // collect teamIds from the whole roster
    const myTeamIds = new Set(
      allRoster
        .map((p) => p.apiTeamId ?? p.teamId ?? null)
        .filter((x) => x != null)
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n))
    );

    if (myTeamIds.size === 0) {
      return {
        ok: true,
        locked: false,
        nowMs,
        livePlayers: [],
        checkedPlayers: allRoster.length,
        provider: "api-football",
      };
    }

    // 3) Cached live fixtures for competition
    async function getLiveFixturesCached() {
      const cacheId = `${league}_${season}`;
      //const cacheRef = db.collection("apiCache").doc(`liveFixtures_${cacheId}`);
      const cacheRef = db.doc(`apiCache/liveFixtures_${cacheId}`);
      const cacheSnap = await cacheRef.get();

      const TTL_MS = 30 * 1000; // 30s cache
      if (cacheSnap.exists) {
        const c = cacheSnap.data() || {};
        if (c.updatedAtMs && nowMs - Number(c.updatedAtMs) < TTL_MS && c.data) {
          return { cached: true, data: c.data };
        }
      }

      const apiKey = APIFOOTBALL_KEY.value();
      const data = await apiFootballGet(
        "fixtures",
        { live: "all", league, season, timezone },
        apiKey
      );

      await cacheRef.set(
        { updatedAtMs: nowMs, data },
        { merge: true }
      );

      return { cached: false, data };
    }

    const liveFxRes = await getLiveFixturesCached();
    const fxList = Array.isArray(liveFxRes?.data?.response) ? liveFxRes.data.response : [];

    // 4) Match live fixtures to user's teamIds
    const matchedFixtures = [];
    const liveTeamIds = new Set();

    for (const m of fxList) {
      const homeId = Number(m?.teams?.home?.id);
      const awayId = Number(m?.teams?.away?.id);

      const matchHasMyTeam = (myTeamIds.has(homeId) || myTeamIds.has(awayId));
      if (!matchHasMyTeam) continue;

      matchedFixtures.push({
        fixtureId: m?.fixture?.id ?? null,
        kickoff: m?.fixture?.date ?? null,
        status: m?.fixture?.status?.short ?? null,
        homeTeamId: homeId,
        awayTeamId: awayId,
        home: m?.teams?.home?.name ?? "",
        away: m?.teams?.away?.name ?? "",
      });

      if (myTeamIds.has(homeId)) liveTeamIds.add(homeId);
      if (myTeamIds.has(awayId)) liveTeamIds.add(awayId);
    }

    // 5) Build a "livePlayers" list for UI (players whose team is currently live)
    const livePlayers = allRoster // <- USE allRoster HERE
      .filter((p) => {
        const tid = Number(p.apiTeamId ?? p.teamId ?? NaN);
        return Number.isFinite(tid) && liveTeamIds.has(tid);
      })
      .map((p) => ({
        playerId: String(p.id || ""),
        name: p.name || "Unknown",
        position: p.position || "MID",
        teamId: Number(p.apiTeamId ?? p.teamId ?? NaN),
    }));

    return {
      ok: true,
      locked: matchedFixtures.length > 0,
      nowMs,
      provider: "api-football",
      cached: liveFxRes.cached,
      checkedPlayers: (starters || []).length,
      livePlayers,          // for your UI “Subs locked: names…”
      matchedFixtures,      // useful for debugging
      competition: { league, season, timezone },
    };
  }
);


// ---------------- Weeks (mock for now, API later) ----------------

// mock fixture generator (later replaced by API fixtures)
function genMockUpcomingFixtures(afterMs, playerId, count = 6) {
  const rng = mulberry32(hashToUint32(`${playerId}:fixtures`));
  let t = Number(afterMs) + randInt(rng, 6, 20) * 60 * 60 * 1000; // 6–20 hours after

  const fixtures = [];
  for (let md = 1; md <= count; md++) {
    t += randInt(rng, 20, 60) * 60 * 60 * 1000; // 20–60h gaps
    fixtures.push({
      fixtureId: `${playerId}_fx_${md}_${t}`,
      kickoffMs: t,
      roundLabel: `MD${md}`, // stand-in for API matchday/round label
    });
  }
  return fixtures;
}

// prefer roundLabel grouping; fallback to time-gap clustering
function buildWeekWindowFromFixtures(fixtures, gapHours = 36) {
  if (!fixtures.length) return null;

  fixtures.sort((a, b) => a.kickoffMs - b.kickoffMs);
  const earliest = fixtures[0];

  // Prefer matchday/round grouping if available
  if (earliest.roundLabel) {
    const sameRound = fixtures.filter((f) => f.roundLabel === earliest.roundLabel);
    const startAtMs = Math.min(...sameRound.map((f) => f.kickoffMs));
    const endAtMs = Math.max(...sameRound.map((f) => f.kickoffMs));
    return { startAtMs, endAtMs, roundLabel: earliest.roundLabel, fixtureIds: sameRound.map((f) => f.fixtureId) };
  }

  // Fallback: gap clustering
  const gapMs = gapHours * 60 * 60 * 1000;
  let endIdx = 0;
  for (let i = 1; i < fixtures.length; i++) {
    const prev = fixtures[i - 1].kickoffMs;
    const cur = fixtures[i].kickoffMs;
    if (cur - prev > gapMs) break;
    endIdx = i;
  }
  const cluster = fixtures.slice(0, endIdx + 1);
  return {
    startAtMs: cluster[0].kickoffMs,
    endAtMs: cluster[cluster.length - 1].kickoffMs,
    roundLabel: null,
    fixtureIds: cluster.map((f) => f.fixtureId),
  };
}

// round-robin pairing (circle method)
// weekIndex starts at 1
function roundRobinPairings(teamIds, weekIndex) {
  const ids = [...teamIds].sort(); // stable
  const n = ids.length;
  if (n % 2 !== 0) throw new Error("Round-robin requires an even number of managers.");

  const rounds = n - 1;
  const r = (Number(weekIndex) - 1) % rounds;

  const fixed = ids[0];
  let rot = ids.slice(1);

  // rotate r times
  for (let i = 0; i < r; i++) {
    rot = [rot[rot.length - 1], ...rot.slice(0, rot.length - 1)];
  }

  const list = [fixed, ...rot];
  const pairs = [];

  for (let i = 0; i < n / 2; i++) {
    let home = list[i];
    let away = list[n - 1 - i];

    // alternate home/away by round to balance
    if ((r % 2) === 1) [home, away] = [away, home];

    pairs.push({ homeUserId: home, awayUserId: away });
  }

  return pairs;
}

// combine stats across multiple fixtures in the same week window (mock)
function genMockFixtureStats(weekIndex, player, kickoffMs) {
  const rng = mulberry32(hashToUint32(`${weekIndex}:${player.id}:${kickoffMs}`));
  const roll = rng();
  const minutes = roll < 0.08 ? 0 : roll < 0.15 ? randInt(rng, 1, 30) : randInt(rng, 60, 90);

  const passBase = player.position === "MID" ? [35, 120]
    : player.position === "DEF" ? [25, 95]
    : player.position === "GK" ? [10, 45]
    : [10, 70];

  const passesCompleted = minutes === 0 ? 0 : randInt(rng, passBase[0], passBase[1]);

  const goalsChance = player.position === "FWD" ? 0.12 : player.position === "MID" ? 0.07 : player.position === "DEF" ? 0.03 : 0.002;
  const assistsChance = player.position === "MID" ? 0.10 : player.position === "FWD" ? 0.08 : player.position === "DEF" ? 0.04 : 0.005;

  const goals = minutes === 0 ? 0 : (rng() < goalsChance ? 1 : 0);
  const assists = minutes === 0 ? 0 : (rng() < assistsChance ? 1 : 0);

  return { minutes, passesCompleted, goals, assists };
}

function sumStats(a, b) {
  return {
    minutes: (a.minutes || 0) + (b.minutes || 0),
    passesCompleted: (a.passesCompleted || 0) + (b.passesCompleted || 0),
    goals: (a.goals || 0) + (b.goals || 0),
    assists: (a.assists || 0) + (b.assists || 0),
  };
}

function isoDateInTZ(timeZone, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addDaysISO(iso, days) {
  const dt = new Date(`${iso}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}


async function fetchNextRoundWindow({ league, season, timezone }, opts={}) {
  const apiKey = APIFOOTBALL_KEY.value();
  const fallbackDate = opts.fallbackDate || null;

  const minKickoffMs = Number(opts.minKickoffMs ?? NaN);

  function applyMinKickoff(list) {
    if (!Number.isFinite(minKickoffMs)) return list;
    return (Array.isArray(list) ? list : []).filter((m) => {
      const ko = m?.fixture?.timestamp
        ? Number(m.fixture.timestamp) * 1000
        : Date.parse(m?.fixture?.date);
      return Number.isFinite(ko) && ko > minKickoffMs;
    });
  }


  // 1) Try normal upcoming fixtures
  let fx = await apiFootballGet("fixtures", { league, season, next: 100, timezone }, apiKey);
  let list = Array.isArray(fx?.response) ? fx.response : [];
  list = applyMinKickoff(list);

  // ✅ If we’re advancing after a finished week, ignore fixtures at/before that week’s end
  if (Number.isFinite(minKickoffMs)) {
    list = list.filter((m) => {
      const ko = m?.fixture?.timestamp
        ? Number(m.fixture.timestamp) * 1000
        : Date.parse(m?.fixture?.date);
      return Number.isFinite(ko) && ko > minKickoffMs;
    });
  }


  // 2) If empty, try a from/to window (more reliable than next on some configs)
  if (!list.length) {
    const from = isoDateInTZ(timezone);
    const to = addDaysISO(from, 90);
    fx = await apiFootballGet("fixtures", { league, season, from, to, timezone }, apiKey);
    list = Array.isArray(fx?.response) ? fx.response : [];
    list = applyMinKickoff(list);
  }

  // 3) If STILL empty, fallback to the seeded Wednesday date
  if (!list.length && fallbackDate) {
    fx = await apiFootballGet("fixtures", { league, season, date: fallbackDate, timezone }, apiKey);
    list = Array.isArray(fx?.response) ? fx.response : [];
    list = applyMinKickoff(list);
  }

  if (!list.length) return null;

  const roundLabel = list[0]?.league?.round || null;
      if (roundLabel) {
        const fxAll = await apiFootballGet("fixtures", { league, season, round: roundLabel, timezone }, apiKey);
        let allList = Array.isArray(fxAll?.response) ? fxAll.response : [];
        allList = applyMinKickoff(allList);

        // ✅ re-apply minKickoff filter to the round-expanded list too
        if (Number.isFinite(minKickoffMs)) {
          allList = allList.filter((m) => {
            const ko = m?.fixture?.timestamp
              ? Number(m.fixture.timestamp) * 1000
              : Date.parse(m?.fixture?.date);
            return Number.isFinite(ko) && ko > minKickoffMs;
          });
        }

        if (allList.length) list = allList;
      }
  
  const sameRound = roundLabel ? list.filter((m) => m?.league?.round === roundLabel) : list;

  const fixtures = sameRound
    .map((m) => ({
      id: String(m?.fixture?.id),
      kickoffMs: (m?.fixture?.timestamp ? Number(m.fixture.timestamp) * 1000 : Date.parse(m?.fixture?.date)),
      round: m?.league?.round || null,
    }))
    .filter((f) => f.id && Number.isFinite(f.kickoffMs))
    .sort((a, b) => a.kickoffMs - b.kickoffMs);

  if (!fixtures.length) return null;

  return {
    roundLabel: fixtures[0].round,
    startAtMs: fixtures[0].kickoffMs,
    endAtMs: fixtures[fixtures.length - 1].kickoffMs,
    fixtures,
  };
}

async function ensureDefaultLineupsForRoom(roomId, memberUids) {
  // Load players to know positions (for GK preference)
  const playersSnap = await db.collection(`rooms/${roomId}/players`).get();
  const posById = new Map();
  playersSnap.forEach((doc) => {
    const d = doc.data() || {};
    const pid = String(d.id ?? d.playerId ?? doc.id);
    posById.set(pid, toPos(d.position || d.pos || d.role));
  });

  // Load picks to build roster per user (in pick order if available)
  const picksSnap = await db.collection(`rooms/${roomId}/picks`).get();
  const rosterByUid = new Map();

  function inferOwnerUid(d) {
    const v =
      d?.ownerUid ?? d?.ownerId ?? d?.ownedBy ?? d?.managerUid ??
      d?.userId ?? d?.uid ?? d?.pickedByUid ?? d?.pickedBy ??
      d?.owner?.uid ?? d?.owner?.id;
    if (!v) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object") return v.uid || v.id || null;
    return null;
  }

  function pickOrder(d) {
    const ms = d?.createdAt?.toMillis?.() ?? 0;
    const n =
      d?.pickIndex ?? d?.overallPick ?? d?.pickNumber ?? d?.pickNo ?? d?.index ?? d?.turn ?? d?.createdAtMs ?? ms;
    const num = Number(n);
    return Number.isFinite(num) ? num : ms;
  }

  picksSnap.forEach((doc) => {
    const d = doc.data() || {};
    const uid = inferOwnerUid(d);
    const pid = String(d.playerId ?? d.pid ?? d.apiPlayerId ?? d.player?.id ?? d.player?.playerId ?? "");
    if (!uid || !pid) return;

    const arr = rosterByUid.get(uid) || [];
    arr.push({ pid, order: pickOrder(d), pos: posById.get(pid) || "MID" });
    rosterByUid.set(uid, arr);
  });

  const batch = db.batch();
  let writes = 0;

  for (const uid of memberUids) {
    const lineupRef = db.doc(`rooms/${roomId}/lineups/${uid}`);
    const snap = await lineupRef.get();
    const existing = snap.exists ? (snap.data() || {}) : null;

    // only create if missing or no starters
    const startersExisting = Array.isArray(existing?.starters) ? existing.starters : [];
    if (snap.exists && startersExisting.length > 0) continue;

    const roster = (rosterByUid.get(uid) || [])
      .sort((a, b) => a.order - b.order)
      .map((x) => x.pid);

    // choose XI: prefer 1 GK if available, then fill by pick order
    const uniq = [];
    const seen = new Set();
    for (const pid of roster) {
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      uniq.push(pid);
    }

    const gk = uniq.find((pid) => posById.get(pid) === "GK");
    const starters = [];

    if (gk) starters.push(gk);
    for (const pid of uniq) {
      if (starters.length >= 11) break;
      if (pid === gk) continue;
      starters.push(pid);
    }

    const starterSet = new Set(starters.map(String));
    const bench = uniq.filter((pid) => !starterSet.has(String(pid)));

    batch.set(
      lineupRef,
      {
        starters,          
        bench,            
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        autoInit: true,
      },
      { merge: true }
    );
    writes++;
  }

  if (writes > 0) await batch.commit();
  return { writes };
}

exports.saveLineupSubstitution = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = String(request.data?.roomId || "").trim();
    const starterOutId = String(request.data?.starterOutId || "").trim();
    const benchInId = String(request.data?.benchInId || "").trim();
    const targetUid = String(request.data?.targetUid || uid).trim() || uid;

    if (!roomId || !starterOutId || !benchInId) {
      throw new HttpsError(
        "invalid-argument",
        "roomId, starterOutId, and benchInId are required."
      );
    }

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (uid !== targetUid && !isHost(room, uid)) {
      throw new HttpsError("permission-denied", "Not allowed to edit this lineup.");
    }

    const lineupRef = db.doc(`rooms/${roomId}/lineups/${targetUid}`);
    let lineupSnap = await lineupRef.get();

    if (!lineupSnap.exists) {
      await ensureDefaultLineupsForRoom(roomId, [targetUid]);
      lineupSnap = await lineupRef.get();
    }

    const lineup = lineupSnap.exists ? (lineupSnap.data() || {}) : {};
    const starters = Array.isArray(lineup?.starters)
      ? lineup.starters.map((id) => String(id))
      : [];
    const bench = Array.isArray(lineup?.bench)
      ? lineup.bench.map((id) => String(id))
      : [];
    const startingXI = Array.isArray(lineup?.startingXI) ? lineup.startingXI : null;
    const benchXI = Array.isArray(lineup?.benchXI) ? lineup.benchXI : null;

    if (!starters.includes(starterOutId)) {
      throw new HttpsError("failed-precondition", "starterOutId is not in starters.");
    }

    if (!bench.includes(benchInId)) {
      throw new HttpsError("failed-precondition", "benchInId is not in bench.");
    }

    const nextStarters = starters.map((id) =>
      id === starterOutId ? benchInId : id
    );
    const nextBench = bench.map((id) =>
      id === benchInId ? starterOutId : id
    );
    const entryIdOf = (entry) => {
      if (entry == null) return "";
      if (typeof entry === "string") return String(entry);
      return String(
        entry.id ??
        entry.playerId ??
        entry.apiPlayerId ??
        entry.name ??
        ""
      );
    };
    let nextStartingXI = startingXI;
    let nextBenchXI = benchXI;

    if (Array.isArray(startingXI) && Array.isArray(benchXI)) {
      const starterOutEntry = startingXI.find(
        (entry) => entryIdOf(entry) === starterOutId
      );
      const benchInEntry = benchXI.find(
        (entry) => entryIdOf(entry) === benchInId
      );

      if (starterOutEntry && benchInEntry) {
        nextStartingXI = startingXI.map((entry) =>
          entryIdOf(entry) === starterOutId ? benchInEntry : entry
        );
        nextBenchXI = benchXI.map((entry) =>
          entryIdOf(entry) === benchInId ? starterOutEntry : entry
        );
      }
    }
    const nowMs = Date.now();

    const lineupPatch = {
      uid: targetUid,
      starters: nextStarters,
      bench: nextBench,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: uid,
    };

    if (Array.isArray(nextStartingXI)) {
      lineupPatch.startingXI = nextStartingXI;
    }

    if (Array.isArray(nextBenchXI)) {
      lineupPatch.benchXI = nextBenchXI;
    }

    await lineupRef.set(lineupPatch, { merge: true });

    return {
      ok: true,
      starters: nextStarters,
      bench: nextBench,
    };
  }
);

exports.repairDefaultLineupsForRoom = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = String(request.data?.roomId || "").trim();
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
    const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean);

    const result = await ensureDefaultLineupsForRoom(roomId, memberUids);
    return {
      ok: true,
      writes: Number(result?.writes || 0),
    };
  }
);

exports.createNextWeek = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    // require even managers
    const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
    const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean);
    if (memberUids.length < 2) throw new HttpsError("failed-precondition", "Need at least 2 managers.");
    if (memberUids.length % 2 !== 0) throw new HttpsError("failed-precondition", "Managers must be an even number.");

    await ensureDefaultLineupsForRoom(roomId, memberUids);

    // determine next weekIndex
    const weeksSnap = await db.collection(`rooms/${roomId}/weeks`).get();
    let maxIdx = 0;
    for (const d of weeksSnap.docs) {
      const idx = Number(d.data()?.index ?? d.id);
      if (Number.isFinite(idx)) maxIdx = Math.max(maxIdx, idx);
    }
    const weekIndex = maxIdx + 1;

    // Competition config (default to UCL for your test)
   // Competition config (MUST come from the room)
    const competition = room.competition;
    if (!competition?.league || !competition?.season) {
      throw new HttpsError("failed-precondition", "Competition not selected yet.");
    }

    // ✅ Auto-fetch totalRounds once (for new rooms)
    const existingTR = Number(room?.competitionMeta?.totalRounds || 0);
    if (!(Number.isFinite(existingTR) && existingTR > 0)) {
      const apiKey = APIFOOTBALL_KEY.value();
      const totalRounds = await fetchTotalRoundsFromApi(competition, apiKey);

      if (Number.isFinite(totalRounds) && totalRounds > 0) {
        await roomRef.set({ "competitionMeta.totalRounds": totalRounds }, { merge: true });
      }
    }

    const fallbackDate = room?.seedFilter?.fixtureDate || null;
    const window = await fetchNextRoundWindow(competition, { fallbackDate });
    if (!window) throw new HttpsError("failed-precondition", "No upcoming fixtures found for this competition.");

    // Round-robin matchups
    const pairs = roundRobinPairings(memberUids, weekIndex);

    const weekDoc = {
      index: weekIndex,
      startAtMs: window.startAtMs,
      endAtMs: window.endAtMs,
      roundLabel: window.roundLabel || null,

      // store fixtures so compute can seed stats per fixture
      fixtures: window.fixtures,
      fixtureIds: window.fixtures.map((f) => f.id),

      competition,
      matchups: pairs,
      status: "scheduled",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const nowMs = Date.now();

    await db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`).set(weekDoc, { merge: true });
    const pollInfo = getNextPollAtMsFromFixtures(window.fixtures, nowMs);

    await roomRef.set(
      {
        currentWeekIndex: weekIndex,
        competition,
      },
      { merge: true }
    );

    await setCompetitionState(
      roomRef,
      {
        weekStatus: "scheduled",
        nextPollAtMs: pollInfo.nextPollAtMs,
        nextKickoffMs: pollInfo.nextKickoffMs,
      },
      {
        roomData: room,
        nowMs,
      }
    );

    await upsertTournamentPollTask({
      roomId,
      phase: "RegularSeason",
      nextPollAtMs: pollInfo.nextPollAtMs,
      reason: "week-created",
      nowMs,
    });

    return { ok: true, weekIndex, ...window };
  }
);

exports.computeWeekResults = onCall({ region: "us-west2" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const roomId = request.data?.roomId;
  const weekIndex = Number(request.data?.weekIndex);
  if (!roomId || !Number.isFinite(weekIndex)) {
    throw new HttpsError("invalid-argument", "roomId and weekIndex are required.");
  }

  const roomSnap = await db.doc(`rooms/${roomId}`).get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");
  const room = roomSnap.data() || {};
  if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

  const weekSnap = await db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`).get();
  if (!weekSnap.exists) throw new HttpsError("failed-precondition", "Week doc not found. Create week first.");
  const week = weekSnap.data() || {};
  const startAtMs = Number(week.startAtMs);
  const endAtMs = Number(week.endAtMs);

  const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
  const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean).sort();

  // build users + starters (starters only score)
  const users = [];
  for (const mUid of memberUids) {
    const userSnap = await db.doc(`users/${mUid}`).get();
    const profile = userSnap.exists ? userSnap.data() : {};
    const display = (profile.displayName || profile.name || mUid).trim();

    const tnSnap = await db.doc(`rooms/${roomId}/teamNames/${mUid}`).get();
    const tn = tnSnap.exists ? (tnSnap.data().teamName || "") : "";
    const name = tn ? `${display} — ${tn}` : display;

    const lineupSnap = await db.doc(`rooms/${roomId}/lineups/${mUid}`).get();
    const lineup = lineupSnap.exists ? lineupSnap.data() : null;

    const starters = extractStarters(lineup);
    const bench = extractBench(lineup);
    users.push({ userId: mUid, name, starters, bench });
  }

  // matchups from week doc, else generate
  const matchupPairs = Array.isArray(week.matchups) && week.matchups.length
    ? week.matchups
    : roundRobinPairings(memberUids, weekIndex);

  // score
  const totalsByUid = {};
  const breakdownByUserId = {};

  for (const u of users) {
    const statsByPlayerId = {};
    for (const p of u.starters) {
      const weekFixtures = Array.isArray(week.fixtures) ? week.fixtures : [];
      const inWindow = weekFixtures.filter((f) => f.kickoffMs >= startAtMs && f.kickoffMs <= endAtMs);

      let agg = { minutes: 0, passesCompleted: 0, goals: 0, assists: 0 };

      if (inWindow.length === 0) {
        agg = { minutes: 0, passesCompleted: 0, goals: 0, assists: 0 };
      } else {
        // For now (until we store apiTeamId), assign each player to ONE fixture deterministically
        const pickIdx = hashToUint32(`${weekIndex}:${p.id}`) % inWindow.length;
        const fx = inWindow[pickIdx];
        agg = sumStats(agg, genMockFixtureStats(weekIndex, p, fx.kickoffMs));
      }

      statsByPlayerId[p.id] = agg;
    }

    const scored = scoreTeam(u.starters, statsByPlayerId, toPos);
    totalsByUid[u.userId] = scored.total;
    breakdownByUserId[u.userId] = scored;
  }

  // build matchups results
  const matchups = matchupPairs.map((pair) => {
    const homeTotal = totalsByUid[pair.homeUserId] ?? 0;
    const awayTotal = totalsByUid[pair.awayUserId] ?? 0;

    let homeResult = "L", awayResult = "W", winnerUserId = pair.awayUserId;
    if (homeTotal > awayTotal) { homeResult = "W"; awayResult = "L"; winnerUserId = pair.homeUserId; }
    else if (homeTotal === awayTotal) { homeResult = "D"; awayResult = "D"; winnerUserId = null; }

    return {
      weekIndex,
      homeUserId: pair.homeUserId,
      awayUserId: pair.awayUserId,
      homeTotal,
      awayTotal,
      homeResult,
      awayResult,
      winnerUserId,
      status: "FINAL",
    };
  });

  // week leaderboard (not season standings)
  const weekLeaderboard = buildLeaderboard(users, matchups, totalsByUid);

  // recompute cumulative standings from all weekResults (idempotent)
  const resultsSnap = await db.collection(`rooms/${roomId}/weekResults`).get();
  const agg = {}; // uid -> { played,w,d,l,tablePoints,totalFantasyPoints,name }
  function ensure(uid, name) {
    if (!agg[uid]) agg[uid] = { userId: uid, name, played: 0, wins: 0, draws: 0, losses: 0, tablePoints: 0, totalFantasyPoints: 0 };
    if (name) agg[uid].name = name;
    return agg[uid];
  }

  // include this computed week (even if not written yet)
  const allWeeks = resultsSnap.docs
    .map((d) => d.data())
    .filter(Boolean)
    .filter((d) => Number(d.weekIndex) !== weekIndex);

  allWeeks.push({
    weekIndex,
    matchups,
    teamScoresByUserId: totalsByUid,
  });

  for (const w of allWeeks) {
    const ms = Array.isArray(w.matchups) ? w.matchups : [];
    for (const m of ms) {
      const home = ensure(m.homeUserId);
      const away = ensure(m.awayUserId);

      home.played += 1;
      away.played += 1;

      const homePts = m.homeResult === "W" ? 3 : m.homeResult === "D" ? 1 : 0;
      const awayPts = m.awayResult === "W" ? 3 : m.awayResult === "D" ? 1 : 0;

      home.tablePoints += homePts;
      away.tablePoints += awayPts;

      if (m.homeResult === "W") home.wins += 1;
      else if (m.homeResult === "D") home.draws += 1;
      else home.losses += 1;

      if (m.awayResult === "W") away.wins += 1;
      else if (m.awayResult === "D") away.draws += 1;
      else away.losses += 1;
    }

    const scores = w.teamScoresByUserId || {};
    for (const uid2 of Object.keys(scores)) {
      const row = ensure(uid2);
      row.totalFantasyPoints += Number(scores[uid2] || 0);
    }
  }

  // attach names from current users array
  for (const u of users) ensure(u.userId, u.name);

  const standings = Object.values(agg).sort(
    (a, b) => (b.tablePoints - a.tablePoints) || (b.totalFantasyPoints - a.totalFantasyPoints)
  );

  // write weekResults + standings/current
  await db.doc(`rooms/${roomId}/weekResults/${String(weekIndex)}`).set(
    {
      roomId,
      weekIndex,
      startAtMs,
      endAtMs,
      roundLabel: week.roundLabel || null,
      teamScoresByUserId: totalsByUid,
      breakdownByUserId,
      matchups,
      weekLeaderboard,
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await db.doc(`rooms/${roomId}/standings/current`).set(
    {
      roomId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      standings,
    },
    { merge: true }
  );

  await db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`).set(
    { status: "final", finalizedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  return { ok: true, weekIndex };
});

// ------------------------------
// LIVE SCORING (API-Football) — scheduled polling
// ------------------------------
function toNum(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(String(v).replace("%", "").trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function buildPlayerStatsMapFromFixturePlayersResponse(responseArr, fixtureMeta) {
  const out = {};
  const teams = Array.isArray(responseArr) ? responseArr : [];

  for (const t of teams) {
    const teamId = t.team?.id;
    const teamName = t.team?.name || "";
    
    // Find Opponent
    const opponent = teams.find(x => x.team?.id !== teamId);
    const opponentName = opponent?.team?.name || "";
    
    const players = Array.isArray(t?.players) ? t.players : [];
    
    for (const row of players) {
      const pid = row?.player?.id;
      if (!pid) continue;

      const st = Array.isArray(row?.statistics) ? row.statistics[0] : null;
      if (!st) continue;

      // ... (Keep your existing minutes/goals/passes logic here) ...
      const minutes = toNum(st?.games?.minutes);
      const goals = toNum(st?.goals?.total);
      const assists = toNum(st?.goals?.assists);
      const passesCompleted = toNum(st?.passes?.total); // Using Total Passes as discussed
      
      const saves = toNum(st?.goals?.saves);
      const yellow = toNum(st?.cards?.yellow);
      const red = toNum(st?.cards?.red);
      const pensSaved = toNum(st?.penalty?.saved);
      const pensMissed = toNum(st?.penalty?.missed);
      const pos = toPos(st?.games?.position);
      const rating = toNum(st?.games?.rating);

      const tackles = toNum(st?.tackles?.total);
      const duelsWon = toNum(st?.duels?.won);
      const dribblesSuccess = toNum(st?.dribbles?.success);

      const foulsCommitted = toNum(st?.fouls?.committed);
      const offsides = toNum(st?.offsides);
      const shotsOnTarget = toNum(st?.shots?.on);
      const pensCommitted = toNum(st?.penalty?.commited ?? st?.penalty?.committed);

      // raw from API (mostly only useful for GK)
      const rawConceded = toNum(st?.goals?.conceded);

      // fixture-based score/conceded
      let teamConceded = rawConceded;
      let teamScore = null;
      let opponentScore = null;

      const homeTeamId = fixtureMeta?.homeTeamId ?? null;
      const awayTeamId = fixtureMeta?.awayTeamId ?? null;
      const goalsHome = toNum(fixtureMeta?.goalsHome);
      const goalsAway = toNum(fixtureMeta?.goalsAway);

      const teamIdStr = teamId != null ? String(teamId) : "";
      const homeTeamIdStr = homeTeamId != null ? String(homeTeamId) : "";
      const awayTeamIdStr = awayTeamId != null ? String(awayTeamId) : "";

      if (teamIdStr && homeTeamIdStr && awayTeamIdStr) {
        if (teamIdStr === homeTeamIdStr) {
          teamConceded = goalsAway;
          teamScore = goalsHome;
          opponentScore = goalsAway;
        } else if (teamIdStr === awayTeamIdStr) {
          teamConceded = goalsHome;
          teamScore = goalsAway;
          opponentScore = goalsHome;
        }
      }

      // Use teamConceded for clean sheet + conceded scoring
      const goalsConceded = teamConceded;          // store real conceded
      const cleanSheet = minutes > 0 && teamConceded === 0;

      const ownGoals = 0; 

      out[String(pid)] = { 
        teamId: teamId ? String(teamId) : "",
        teamName,
        opponentName,

        teamScore,
        opponentScore,
        teamGoals: teamScore,
        opponentGoals: opponentScore,
        fixtureStatus: fixtureMeta?.fixtureStatus || fixtureMeta?.statusShort || null,
        matchStatus: fixtureMeta?.statusShort || fixtureMeta?.fixtureStatus || null,
        statusShort: fixtureMeta?.statusShort || fixtureMeta?.fixtureStatus || null,
        statusLong: fixtureMeta?.statusLong || null,
        elapsed: fixtureMeta?.elapsed ?? null,
        extra: fixtureMeta?.extra ?? null,
        statusUpdatedAtMs: fixtureMeta?.statusUpdatedAtMs ?? null,
        kickoffMs: fixtureMeta?.kickoffMs ?? null,
        minutes, 
        goals, 
        assists, 

        passesCompleted,
        saves,
        goalsConceded,
        yellow,
        red,
        pensSaved,
        pensMissed,
        cleanSheet,
        ownGoals,
        position: pos,
        rating,
        tackles,
        duelsWon,
        dribblesSuccess,
        foulsCommitted,
        offsides,
        shotsOnTarget,
        pensCommitted,
      };
    }
  }
  return out;
}

async function getFixturePlayersStatsMapCached({ fixtureId, apiKey, ttlMs, timeZone }) {
  //const ref = db.collection("apiCache").doc(`fixturePlayers_${String(fixtureId)}`);
  const ref = db.doc(`apiCache/fixturePlayers_${String(fixtureId)}`);
  const now = Date.now();
  const metaSnap = await db.doc(`apiCache/fixtureStatus_${String(fixtureId)}`).get();
  const metaDoc = metaSnap.exists ? (metaSnap.data() || {}) : {};

  const fixtureMeta = {
    homeTeamId: metaDoc.homeTeamId ?? null,
    awayTeamId: metaDoc.awayTeamId ?? null,
    goalsHome: toNum(metaDoc.goalsHome),
    goalsAway: toNum(metaDoc.goalsAway),

    // Timer/status info for Cup + Regular player stat cards
    statusShort: metaDoc.short || metaDoc.statusShort || null,
    fixtureStatus: metaDoc.short || metaDoc.statusShort || null,
    statusLong: metaDoc.statusLong || null,
    elapsed: Number.isFinite(Number(metaDoc.elapsed)) ? Number(metaDoc.elapsed) : null,
    extra: Number.isFinite(Number(metaDoc.extra)) ? Number(metaDoc.extra) : null,
    statusUpdatedAtMs: Number.isFinite(Number(metaDoc.updatedAtMs)) ? Number(metaDoc.updatedAtMs) : null,
    kickoffMs: Number.isFinite(Number(metaDoc.kickoffMs)) ? Number(metaDoc.kickoffMs) : null,
  };

  try {
    const snap = await ref.get();
    if (snap.exists) {
      const d = snap.data() || {};
      const updatedAtMs = Number(d.updatedAtMs || 0);
      if (updatedAtMs && now - updatedAtMs < ttlMs && d.playerStats) return d.playerStats;
    }
  } catch (_) {}

  // If fixture hasn't started yet, this can return 204 No Content (handled in apiFootballGet)
  const json = await apiFootballGet("fixtures/players", { fixture: String(fixtureId) }, apiKey);
  const fresh = buildPlayerStatsMapFromFixturePlayersResponse(json?.response || [], fixtureMeta);

  // Sometimes the API returns 204/empty even when a fixture should have stats.
  // Do NOT overwrite a previously cached non-empty map with an empty one.
  if (!fresh || Object.keys(fresh).length === 0) {
    try {
      const snap2 = await ref.get();
      if (snap2.exists) {
        const d2 = snap2.data() || {};
        const prev = d2.playerStats;
        if (prev && Object.keys(prev).length > 0) {
          await ref.set({ updatedAtMs: now }, { merge: true });
          return prev;
        }
      }
    } catch (_) {}
  }

  await ref.set(
    {
      updatedAtMs: now,
      playerStats: fresh,
    },
    { merge: true }
  );

  return fresh;
}

async function getFixtureStatusMap({ fixtureIds, timezone, apiKey }) {
  const ids = [...new Set((fixtureIds || []).map((x) => String(x)).filter(Boolean))];
  const out = {};
  if (!ids.length) return out;

  const now = Date.now();

  // TTL policy (tweak anytime)
  const LIVE_TTL_MS = 60 * 1000;        // 1 min while in-play
  const NS_TTL_MS = 10 * 60 * 1000;     // 10 min if not started
  const FIN_TTL_MS = 60 * 60 * 1000;    // 60 min if finished
  const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min fallback

  const ttlForShort = (short) => {
    if (!short) return DEFAULT_TTL_MS;
    if (isInPlay(short)) return LIVE_TTL_MS;
    if (short === "NS") return NS_TTL_MS;
    if (isFinished(short)) return FIN_TTL_MS;
    return DEFAULT_TTL_MS;
  };

  // 1) Read cache for each fixtureId (global cache by fixture)
  // We only fetch from API for ids that are missing/expired.
  const missing = [];

  await Promise.all(
    ids.map(async (id) => {
      try {
        const ref = db.doc(`apiCache/fixtureStatus_${id}`);
        const snap = await ref.get();
        if (!snap.exists) {
          missing.push(id);
          return;
        }

        const d = snap.data() || {};
        const short = d.short || null;
        const updatedAtMs = Number(d.updatedAtMs || 0);
        const ttlMs = ttlForShort(short);

        if (short && updatedAtMs && now - updatedAtMs < ttlMs) {
          out[id] = short;
        } else {
          // expired or incomplete, refetch
          missing.push(id);
        }
      } catch (_) {
        // If cache read fails, refetch from API
        missing.push(id);
      }
    })
  );

  // 2) Fetch missing statuses from API (try multi-id first)
  const fetchList = async (params) => {
    const r = await apiFootballGet("fixtures", { ...params, timezone }, apiKey);
    return Array.isArray(r?.response) ? r.response : [];
  };

  let list = [];

  if (missing.length) {
    if (missing.length > 1) {
      list = await fetchList({ ids: missing.join("-") });
      if (!list.length) list = await fetchList({ ids: missing.join(",") });
    } else {
      list = await fetchList({ id: missing[0] });
    }

    // Fallback per-id if still empty
    if (!list.length) {
      for (const id of missing) {
        const one = await fetchList({ id });
        if (one?.[0]) list.push(one[0]);
      }
    }
  }

  // 3) Write fresh statuses back to global cache and to output map
  // Note: we only cache statuses we actually received.
  if (list.length) {
    const writes = [];

    for (const f of list) {
      const fixtureId = String(f?.fixture?.id ?? "");
      const short = f?.fixture?.status?.short ?? null;
      if (!fixtureId || !short) continue;

      const kickoffMs = f?.fixture?.timestamp
        ? Number(f.fixture.timestamp) * 1000
        : Date.parse(f?.fixture?.date);
      const homeTeamId = f?.teams?.home?.id ?? null;
      const homeTeamName = f?.teams?.home?.name || "";
      const homeTeamLogo = f?.teams?.home?.logo || "";
      const awayTeamId = f?.teams?.away?.id ?? null;
      const awayTeamName = f?.teams?.away?.name || "";
      const awayTeamLogo = f?.teams?.away?.logo || "";
      const goalsHome = toNum(f?.goals?.home);
      const goalsAway = toNum(f?.goals?.away);

      const statusLong = f?.fixture?.status?.long ?? null;
      const elapsed = toNum(f?.fixture?.status?.elapsed);
      const extra = toNum(f?.fixture?.status?.extra);
      const leagueId = f?.league?.id ?? null;

      const leagueName = f?.league?.name || "";
      const leagueRound = f?.league?.round || null;

      out[fixtureId] = short;

      const ref = db.doc(`apiCache/fixtureStatus_${fixtureId}`);
      writes.push(
        ref.set(
          {
            fixtureId,
            short,
            statusLong,
            elapsed,
            extra,
            kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : null,
            updatedAtMs: now,
            homeTeamId,
            homeTeamName,
            homeTeamLogo,
            awayTeamId,
            awayTeamName,
            awayTeamLogo,
            goalsHome,
            goalsAway,
            leagueId,
            leagueName,
            leagueRound,
          },
          { merge: true }
        )
      );
    }

    // Don't fail the whole function if a write fails
    try {
      await Promise.all(writes);
    } catch (_) {}
  }

  return out;
}

function isInPlay(short) {
  return ["1H", "HT", "2H", "ET", "BT", "P"].includes(short);
}
function isFinished(short) {
  return ["FT", "AET", "PEN"].includes(short);
}

function hasFixtureStarted(short) {
  const s = String(short || "").trim().toUpperCase();
  if (!s) return false;
  if (["NS", "TBD", "PST", "CANC"].includes(s)) return false;
  return true;
}

function getRoomPhaseLabel(room) {
  return getCompetitionState(room)?.phaseLabel ?? null;
}

function extractFixtureIdsFromWeekDoc(week) {
  const ids = new Set();

  for (const id of Array.isArray(week?.fixtureIds) ? week.fixtureIds : []) {
    const str = String(id || "").trim();
    if (str) ids.add(str);
  }

  for (const fixture of Array.isArray(week?.fixtures) ? week.fixtures : []) {
    const str = String(fixture?.id || fixture?.fixture?.id || "").trim();
    if (str) ids.add(str);
  }

  return Array.from(ids);
}

async function loadFixtureStatusDetailsMap(fixtureIds = []) {
  const ids = [...new Set((fixtureIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return {};

  const refs = ids.map((id) => db.doc(`apiCache/fixtureStatus_${id}`));
  const snaps = await db.getAll(...refs);
  const out = {};

  for (let i = 0; i < snaps.length; i += 1) {
    const snap = snaps[i];
    if (!snap.exists) continue;
    out[ids[i]] = snap.data() || {};
  }

  return out;
}

function deriveRoomSeasonContext(room = {}) {
  const competition = room?.competition || {};
  const league = Number(competition?.league);
  const season = Number(competition?.season);

  return deriveSeasonContext({
    roomSeasonKey: room?.seasonKey,
    roomCompetitionKey: room?.competitionKey,
    roomCompetitionType: room?.competitionType,
    roomCompetitionName:
      room?.competitionMeta?.name ||
      room?.competition?.name ||
      null,
    league,
    season,
    phaseLabel: getRoomPhaseLabel(room),
  });
}

async function loadGlobalLiveFixturesForSeason({ db, seasonKey, fixtureIds }) {
  const ids = [...new Set((fixtureIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!db || !seasonKey || !ids.length) {
    return { liveFixturesById: {}, missingFixtureIds: ids };
  }

  const refs = ids.map((fixtureId) => getSeasonLiveFixtureRef(db, seasonKey, fixtureId));
  const snaps = await db.getAll(...refs);
  const liveFixturesById = {};
  const missingFixtureIds = [];

  for (let i = 0; i < snaps.length; i += 1) {
    const snap = snaps[i];
    const fixtureId = ids[i];

    if (!snap.exists) {
      missingFixtureIds.push(fixtureId);
      continue;
    }

    liveFixturesById[fixtureId] = {
      ...(snap.data() || {}),
      fixtureId,
    };
  }

  return { liveFixturesById, missingFixtureIds };
}

async function loadGlobalFixtureSummariesForSeason({ db, seasonKey, fixtureIds }) {
  const ids = [...new Set((fixtureIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!db || !seasonKey || !ids.length) return {};

  const refs = ids.map((fixtureId) => getSeasonFixtureSummaryRef(db, seasonKey, fixtureId));
  const snaps = await db.getAll(...refs);
  const summariesById = {};

  for (let i = 0; i < snaps.length; i += 1) {
    const snap = snaps[i];
    if (!snap.exists) continue;
    const fixtureId = ids[i];
    summariesById[fixtureId] = {
      ...(snap.data() || {}),
      fixtureId,
    };
  }

  return summariesById;
}

async function loadRoomUsersLineupsForGlobalAggregation({ db, roomId }) {
  function inferOwnerUid(d) {
    const v =
      d?.ownerUid ?? d?.ownerId ?? d?.ownedBy ?? d?.managerUid ??
      d?.userId ?? d?.uid ?? d?.pickedByUid ?? d?.pickedBy ??
      d?.owner?.uid ?? d?.owner?.id;

    if (!v) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object") return v.uid || v.id || null;
    return null;
  }

  const [membersSnap, lineupsSnap, picksSnap, playersSnap] = await Promise.all([
    db.collection(`rooms/${roomId}/members`).get(),
    db.collection(`rooms/${roomId}/lineups`).get(),
    db.collection(`rooms/${roomId}/picks`).get(),
    db.collection(`rooms/${roomId}/players`).get(),
  ]);

  const membersByUid = new Map();
  membersSnap.forEach((doc) => {
    const data = doc.data() || {};
    const uid = String(doc.id || data.uid || "").trim();
    if (!uid) return;
    membersByUid.set(uid, {
      uid,
      displayName: String(data.displayName || data.name || uid),
    });
  });

  const playersById = new Map();
  playersSnap.forEach((doc) => {
    const d = doc.data() || {};
    const pid = String(d.id ?? d.playerId ?? doc.id);
    if (!pid) return;

    playersById.set(pid, {
      id: pid,
      name: d.name || d.playerName || "Unknown",
      position: toPos(d.position || d.pos || d.role),
      teamName: d.teamName || "",
      nationality: d.nationality || "",
      teamLogo: d.teamLogo || "",
    });
  });

  const pickDocToPlayer = new Map();
  const rosterByUid = {};

  picksSnap.forEach((doc) => {
    const d = doc.data() || {};
    const owner = inferOwnerUid(d);
    const pid = String(d.playerId ?? d.pid ?? d.apiPlayerId ?? d.player?.id ?? d.player?.playerId ?? "");
    if (!owner || !pid) return;

    const player = {
      id: pid,
      name: d.playerName || d.name || playersById.get(pid)?.name || "Unknown",
      position: toPos(d.position || d.pos || d.role || playersById.get(pid)?.position || ""),
      teamName: d.teamName || playersById.get(pid)?.teamName || "",
      nationality: d.nationality || playersById.get(pid)?.nationality || "",
      teamLogo: d.teamLogo || playersById.get(pid)?.teamLogo || "",
    };

    if (!playersById.has(pid)) {
      playersById.set(pid, player);
    }

    (rosterByUid[String(owner)] ||= []).push(player);
    pickDocToPlayer.set(doc.id, player);
  });

  const lineupsByUid = new Map();
  lineupsSnap.forEach((doc) => lineupsByUid.set(String(doc.id), doc.data() || {}));

  const memberUids = Array.from(
    new Set([
      ...membersByUid.keys(),
      ...lineupsByUid.keys(),
      ...Object.keys(rosterByUid),
    ])
  ).filter(Boolean).sort();

  const users = [];

  for (const uid of memberUids) {
    const lineup = lineupsByUid.get(uid) || null;

    const resolveLineupEntry = (entry) => {
      const raw = String(entry?.id ?? entry?.playerId ?? entry ?? "");
      if (!raw) return null;

      const fromPick = pickDocToPlayer.get(raw) || null;
      const pid = String(fromPick?.id ?? raw);
      const known = playersById.get(pid) || fromPick || null;

      return {
        id: pid,
        name:
          known?.name ||
          entry?.name ||
          entry?.fullName ||
          entry?.displayName ||
          "Unknown",
        position: toPos(known?.position || entry?.position || entry?.pos || entry?.role || ""),
        teamName: known?.teamName || "",
        nationality: known?.nationality || "",
        teamLogo: known?.teamLogo || "",
      };
    };

    const starters = extractStarters(lineup).map(resolveLineupEntry).filter(Boolean);
    let bench = extractBench(lineup).map(resolveLineupEntry).filter(Boolean);

    if (!bench.length) {
      const roster = rosterByUid[String(uid)] || [];
      const starterSet = new Set(starters.map((p) => String(p.id)));
      bench = roster.filter((p) => p?.id && !starterSet.has(String(p.id)));
    } else {
      const starterSet = new Set(starters.map((p) => String(p.id)));
      bench = bench.filter((p) => p?.id && !starterSet.has(String(p.id)));
    }

    users.push({
      uid,
      displayName: membersByUid.get(uid)?.displayName || uid,
      starters,
      bench,
    });
  }

  return users;
}

function mergeShadowAccumulatorValue(existingValue, incomingValue) {
  if (incomingValue == null) return existingValue;

  if (typeof incomingValue === "number" && Number.isFinite(incomingValue)) {
    const current = typeof existingValue === "number" && Number.isFinite(existingValue)
      ? existingValue
      : 0;
    return current + incomingValue;
  }

  if (typeof incomingValue === "boolean") {
    return Boolean(existingValue) || incomingValue;
  }

  if (Array.isArray(incomingValue)) {
    return Array.isArray(existingValue) && existingValue.length > 0
      ? existingValue
      : incomingValue.slice();
  }

  if (incomingValue && typeof incomingValue === "object") {
    const out = existingValue && typeof existingValue === "object" && !Array.isArray(existingValue)
      ? { ...existingValue }
      : {};

    for (const [key, value] of Object.entries(incomingValue)) {
      out[key] = mergeShadowAccumulatorValue(out[key], value);
    }
    return out;
  }

  return existingValue == null || existingValue === "" ? incomingValue : existingValue;
}

function buildAggregatedGlobalFantasyByPlayerId(liveFixturesById = {}) {
  const aggregated = {};

  for (const fixture of Object.values(liveFixturesById || {})) {
    const fantasyByPlayerId =
      fixture?.fantasyByPlayerId && typeof fixture.fantasyByPlayerId === "object"
        ? fixture.fantasyByPlayerId
        : {};
    const rawStatsByPlayerId =
      fixture?.rawStatsByPlayerId && typeof fixture.rawStatsByPlayerId === "object"
        ? fixture.rawStatsByPlayerId
        : {};

    for (const [rawPlayerId, fantasy] of Object.entries(fantasyByPlayerId)) {
      const playerId = String(rawPlayerId || "").trim();
      if (!playerId) continue;

      const current = aggregated[playerId] || {
        id: playerId,
        points: 0,
        breakdown: {},
        stats: {},
        position: "",
        teamName: "",
        opponentName: "",
      };

      current.points += Number(fantasy?.points || 0);
      current.breakdown = mergeShadowAccumulatorValue(current.breakdown, fantasy?.breakdown || {});
      current.stats = mergeShadowAccumulatorValue(
        current.stats,
        fantasy?.stats || rawStatsByPlayerId[playerId] || {}
      );
      current.position = current.position || toPos(fantasy?.position || "");
      current.teamName = current.teamName || fantasy?.teamName || "";
      current.opponentName = current.opponentName || fantasy?.opponentName || "";

      aggregated[playerId] = current;
    }
  }

  return aggregated;
}

function mergeGlobalRawPlayerStats(prev = {}, next = {}, fixtureId = "") {
  const out = { ...(prev || {}) };

  const sumKeys = [
    "minutes",
    "goals",
    "assists",
    "passesCompleted",
    "saves",
    "goalsConceded",
    "yellow",
    "red",
    "pensSaved",
    "pensMissed",
    "pensCommitted",
    "ownGoals",
    "tackles",
    "duelsWon",
    "dribblesSuccess",
    "foulsCommitted",
    "offsides",
    "shotsOnTarget",
  ];

  for (const key of sumKeys) {
    out[key] = toNum(out[key]) + toNum(next?.[key]);
  }

  out.cleanSheet = Boolean(out.cleanSheet) || Boolean(next?.cleanSheet);
  out.rating = Math.max(toNum(out.rating), toNum(next?.rating));

  const preferNextKeys = [
    "teamId",
    "teamName",
    "opponentName",
    "teamScore",
    "opponentScore",
    "teamGoals",
    "opponentGoals",
    "fixtureStatus",
    "matchStatus",
    "statusShort",
    "statusLong",
    "kickoffMs",
    "elapsed",
    "extra",
    "statusUpdatedAtMs",
  ];

  for (const key of preferNextKeys) {
    if (next?.[key] !== undefined && next?.[key] !== null && next?.[key] !== "") {
      out[key] = next[key];
    } else if (out[key] === undefined) {
      out[key] = null;
    }
  }

  // Keep API position for debugging only.
  // Room/fantasy position will be used later when scoring.
  out.position = out.position || next?.position || "";

  const ids = new Set(Array.isArray(out.fixtureIds) ? out.fixtureIds.map(String) : []);
  const fid = String(fixtureId || next?.fixtureId || "").trim();
  if (fid) ids.add(fid);
  out.fixtureIds = Array.from(ids);
  out.fixtureId = out.fixtureId || fid || null;

  return out;
}

function buildAggregatedGlobalRawStatsByPlayerId(liveFixturesById = {}) {
  const aggregated = {};

  for (const fixture of Object.values(liveFixturesById || {})) {
    const fixtureId = String(fixture?.fixtureId || "").trim();

    const rawStatsByPlayerId =
      fixture?.rawStatsByPlayerId && typeof fixture.rawStatsByPlayerId === "object"
        ? fixture.rawStatsByPlayerId
        : {};

    for (const [rawPlayerId, stats] of Object.entries(rawStatsByPlayerId)) {
      const playerId = String(rawPlayerId || "").trim();
      if (!playerId) continue;

      const current = aggregated[playerId] || {
        id: playerId,
        stats: {},
        teamName: "",
        opponentName: "",
        position: "",
      };

      const mergedStats = mergeGlobalRawPlayerStats(
        current.stats || {},
        stats || {},
        fixtureId
      );

      aggregated[playerId] = {
        id: playerId,
        stats: mergedStats,
        teamName: mergedStats.teamName || current.teamName || "",
        opponentName: mergedStats.opponentName || current.opponentName || "",
        position: mergedStats.position || current.position || "",
      };
    }
  }

  return aggregated;
}

async function computeGlobalCupShadowResults({ db, roomId, nowMs }) {
  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = roomSnap.data() || {};
  if (getRoomPhaseLabel(room) !== "Cup") {
    throw new HttpsError("failed-precondition", "Room is not in Cup phase.");
  }

  const cupRef = roomRef.collection("cup").doc("current");
  const cupSnap = await cupRef.get();
  const cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
  const fixtureIds = [...new Set((Array.isArray(cup?.currentWindowFixtureIds) ? cup.currentWindowFixtureIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];

  const seasonContext = deriveRoomSeasonContext(room);
  if (!seasonContext?.seasonKey) {
    throw new HttpsError("failed-precondition", "Could not resolve seasonKey for room.");
  }

  const { liveFixturesById, missingFixtureIds } = await loadGlobalLiveFixturesForSeason({
    db,
    seasonKey: seasonContext.seasonKey,
    fixtureIds,
  });

  const users = await loadRoomUsersLineupsForGlobalAggregation({ db, roomId });
  const globalRawStatsByPlayerId = buildAggregatedGlobalRawStatsByPlayerId(liveFixturesById);

  const globalTotalsByUid = {};
  const globalBreakdownByUserId = {};
  const globalBenchTotalsByUid = {};
  const missingPlayerIdsByUid = {};

  for (const user of users) {
    const uid = String(user.uid);
    const perPlayer = {};
    const startersOut = [];
    const benchOut = [];
    const missing = new Set();
    let starterTotal = 0;
    let benchTotal = 0;

    const consumePlayer = (player, counted) => {
      const pid = String(player?.id || "").trim();
      if (!pid) return;

      const aggregated = globalRawStatsByPlayerId[pid] || null;
      const rawStats = aggregated?.stats || null;

      // IMPORTANT:
      // Score global raw stats using the room/fantasy player position,
      // not API-Football's fixture position.
      const scorePosition = toPos(
        player?.position ||
        aggregated?.position ||
        rawStats?.position ||
        "MID"
      );

      const scored = rawStats
        ? scorePlayer(rawStats, scorePosition)
        : { points: 0, breakdown: {} };

      const entry = {
        id: pid,
        name: player?.name || "Unknown",
        position: scorePosition,
        teamName: rawStats?.teamName || aggregated?.teamName || player?.teamName || "",
        nationality: player?.nationality || "",
        opponentName: rawStats?.opponentName || aggregated?.opponentName || "",
        points: Number(scored?.points ?? scored?.total ?? 0),
        breakdown: scored?.breakdown || scored?.parts || scored?.pointsBreakdown || {},
        stats: rawStats || { teamName: player?.teamName || "" },
        counted,
      };

      perPlayer[pid] = entry;

      if (aggregated) {
        if (counted) starterTotal += entry.points;
        else benchTotal += entry.points;
      } else {
        missing.add(pid);
      }

      if (counted) startersOut.push(entry);
      else benchOut.push(entry);
    };

    for (const player of Array.isArray(user.starters) ? user.starters : []) {
      consumePlayer(player, true);
    }

    for (const player of Array.isArray(user.bench) ? user.bench : []) {
      consumePlayer(player, false);
    }

    globalTotalsByUid[uid] = starterTotal;
    globalBenchTotalsByUid[uid] = benchTotal;
    globalBreakdownByUserId[uid] = {
      uid,
      displayName: user.displayName || uid,
      total: starterTotal,
      benchTotal,
      starters: startersOut,
      bench: benchOut,
      perPlayer,
    };
    missingPlayerIdsByUid[uid] = Array.from(missing);
  }

  const legacyCupTotalsByUid =
    cup?.cupTotalsByUid && typeof cup.cupTotalsByUid === "object"
      ? cup.cupTotalsByUid
      : {};

  const legacyProjectedTotalsByUid =
    cup?.projectedTotalsByUid && typeof cup.projectedTotalsByUid === "object"
      ? cup.projectedTotalsByUid
      : {};

  const legacyWindowPointsByUid =
    cup?.windowPointsByUid && typeof cup.windowPointsByUid === "object"
      ? cup.windowPointsByUid
      : {};

  const legacyLivePointsByUid =
    cup?.livePointsByUid && typeof cup.livePointsByUid === "object"
      ? cup.livePointsByUid
      : {};

  // Shadow comparison should be current window vs current window.
  // Global reads cup.currentWindowFixtureIds, so compare it against
  // legacy windowPointsByUid + livePointsByUid, not full Cup totals.
  const legacyCurrentWindowTotalsByUid = {};
  const legacyTotalUsedByUid = {};
  const legacyCompareSourceByUid = {};
  const diffsByUid = {};

  const allUids = new Set([
    ...Object.keys(globalTotalsByUid || {}),
    ...Object.keys(legacyWindowPointsByUid || {}),
    ...Object.keys(legacyLivePointsByUid || {}),
  ]);

  for (const uid of allUids) {
    const legacyTotal =
      Number(legacyWindowPointsByUid[uid] || 0) +
      Number(legacyLivePointsByUid[uid] || 0);

    legacyCurrentWindowTotalsByUid[uid] = legacyTotal;
    legacyTotalUsedByUid[uid] = legacyTotal;
    legacyCompareSourceByUid[uid] = "windowPointsByUid+livePointsByUid";

    diffsByUid[uid] = Number(globalTotalsByUid[uid] || 0) - legacyTotal;
  }

  const payload = {
    mode: "cup-shadow-aggregator",
    source: "global-live-fixtures",
    compareScope: "current-cup-window",

    roomId,
    seasonKey: seasonContext.seasonKey,
    fixtureIds,

    globalTotalsByUid,
    globalBreakdownByUserId,
    globalBenchTotalsByUid,

    // Kept for debugging full Cup state
    legacyCupTotalsByUid,
    legacyProjectedTotalsByUid,

    // Used for the actual shadow diff
    legacyWindowPointsByUid,
    legacyLivePointsByUid,
    legacyCurrentWindowTotalsByUid,

    diffsByUid,
    missingFixtureIds,
    missingPlayerIdsByUid,

    updatedAtMs: nowMs,
    updatedAt: FieldValue.serverTimestamp(),

    legacyTotalUsedByUid,
    legacyCompareSourceByUid,
  };

  await roomRef.collection("globalShadowResults").doc("cup-current").set(payload, { merge: false });

  return {
    ...payload,
    userCount: users.length,
  };
}

async function computeGlobalRegularShadowResults({ db, roomId, weekIndex, nowMs }) {
  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = roomSnap.data() || {};
  const phase = getRoomPhaseLabel(room);

  if (phase === "Cup") {
    throw new HttpsError("failed-precondition", "Room is Cup phase. Use Cup shadow test instead.");
  }

  const resolvedWeekIndex = Number(
    Number.isFinite(Number(weekIndex)) && Number(weekIndex) > 0
      ? weekIndex
      : room?.currentWeekIndex
  );

  if (!Number.isFinite(resolvedWeekIndex) || resolvedWeekIndex <= 0) {
    throw new HttpsError("failed-precondition", "Room does not have a currentWeekIndex.");
  }

  const weekRef = roomRef.collection("weeks").doc(String(resolvedWeekIndex));
  const weekSnap = await weekRef.get();
  if (!weekSnap.exists) {
    throw new HttpsError("failed-precondition", `Week ${resolvedWeekIndex} does not exist.`);
  }

  const week = weekSnap.data() || {};
  const fixtureIds = extractFixtureIdsFromWeekDoc(week);

  const seasonContext = deriveRoomSeasonContext(room);
  if (!seasonContext?.seasonKey) {
    throw new HttpsError("failed-precondition", "Could not resolve seasonKey for room.");
  }

  const { liveFixturesById, missingFixtureIds } = await loadGlobalLiveFixturesForSeason({
    db,
    seasonKey: seasonContext.seasonKey,
    fixtureIds,
  });
  const fixtureSummariesById = await loadGlobalFixtureSummariesForSeason({
    db,
    seasonKey: seasonContext.seasonKey,
    fixtureIds,
  });

  const fixtureCoverage = fixtureIds.map((fixtureId) => {
    const live = liveFixturesById[String(fixtureId)] || null;
    const summary = fixtureSummariesById[String(fixtureId)] || null;
    const fantasyByPlayerId =
      live?.fantasyByPlayerId && typeof live.fantasyByPlayerId === "object"
        ? live.fantasyByPlayerId
        : {};
    const rawStatsByPlayerId =
      live?.rawStatsByPlayerId && typeof live.rawStatsByPlayerId === "object"
        ? live.rawStatsByPlayerId
        : {};

    return {
      fixtureId: String(fixtureId),
      hasLivePayload: Boolean(live),
      hasSummary: Boolean(summary),
      statusShort: live?.statusShort || summary?.short || summary?.statusShort || null,
      statusLong: live?.statusLong || summary?.statusLong || null,
      kickoffMs: Number(live?.kickoffMs ?? summary?.kickoffMs ?? 0) || null,
      fantasyPlayerCount: Object.keys(fantasyByPlayerId).length,
      rawStatsPlayerCount: Object.keys(rawStatsByPlayerId).length,
    };
  });

  const users = await loadRoomUsersLineupsForGlobalAggregation({ db, roomId });
  const globalRawStatsByPlayerId = buildAggregatedGlobalRawStatsByPlayerId(liveFixturesById);

  const globalTotalsByUid = {};
  const globalBenchTotalsByUid = {};
  const globalBreakdownByUserId = {};
  const missingPlayerIdsByUid = {};

  for (const user of users) {
    const uid = String(user.uid);
    const perPlayer = {};
    const startersOut = [];
    const benchOut = [];
    const missing = new Set();

    let starterTotal = 0;
    let benchTotal = 0;

    const consumePlayer = (player, counted) => {
      const pid = String(player?.id || "").trim();
      if (!pid) return;

      const aggregated = globalRawStatsByPlayerId[pid] || null;
      const rawStats = aggregated?.stats || null;

      // Score global raw stats using the room/fantasy player position,
      // not API-Football's fixture position.
      const scorePosition = toPos(
        player?.position ||
        aggregated?.position ||
        rawStats?.position ||
        "MID"
      );

      const scored = rawStats
        ? scorePlayer(rawStats, scorePosition)
        : { points: 0, breakdown: {} };

      const entry = {
        id: pid,
        name: player?.name || "Unknown",
        position: scorePosition,
        teamName: rawStats?.teamName || aggregated?.teamName || player?.teamName || "",
        nationality: player?.nationality || "",
        opponentName: rawStats?.opponentName || aggregated?.opponentName || "",
        points: Number(scored?.points ?? scored?.total ?? 0),
        breakdown: scored?.breakdown || scored?.parts || scored?.pointsBreakdown || {},
        stats: rawStats || { teamName: player?.teamName || "" },
        counted,
      };

      perPlayer[pid] = entry;

      if (aggregated) {
        if (counted) starterTotal += entry.points;
        else benchTotal += entry.points;
      } else {
        missing.add(pid);
      }

      if (counted) startersOut.push(entry);
      else benchOut.push(entry);
    };

    for (const player of Array.isArray(user.starters) ? user.starters : []) {
      consumePlayer(player, true);
    }

    for (const player of Array.isArray(user.bench) ? user.bench : []) {
      consumePlayer(player, false);
    }

    globalTotalsByUid[uid] = starterTotal;
    globalBenchTotalsByUid[uid] = benchTotal;
    globalBreakdownByUserId[uid] = {
      uid,
      displayName: user.displayName || uid,
      total: starterTotal,
      benchTotal,
      starters: startersOut,
      bench: benchOut,
      perPlayer,
    };

    missingPlayerIdsByUid[uid] = Array.from(missing);
  }

  const weekResultsRef = roomRef.collection("weekResults").doc(String(resolvedWeekIndex));
  const weekResultsSnap = await weekResultsRef.get();
  const weekResults = weekResultsSnap.exists ? (weekResultsSnap.data() || {}) : {};
  const legacyBreakdownByUserId =
    weekResults?.breakdownByUserId && typeof weekResults.breakdownByUserId === "object"
      ? weekResults.breakdownByUserId
      : {};

  const legacyTotalsByUid =
    weekResults?.teamScoresByUserId && typeof weekResults.teamScoresByUserId === "object"
      ? weekResults.teamScoresByUserId
      : {};

  const diffsByUid = {};
  const allUids = new Set([
    ...Object.keys(globalTotalsByUid || {}),
    ...Object.keys(legacyTotalsByUid || {}),
  ]);

  for (const uid of allUids) {
    diffsByUid[uid] =
      Number(globalTotalsByUid[uid] || 0) -
      Number(legacyTotalsByUid[uid] || 0);
  }

  function flattenLegacyPerPlayer(legacyUserBreakdown = {}) {
    const out = {};
    const directCandidates = [
      legacyUserBreakdown?.perPlayer,
      legacyUserBreakdown?.partsByPlayerId,
      legacyUserBreakdown?.playersById,
    ];

    for (const candidate of directCandidates) {
      if (!candidate || typeof candidate !== "object") continue;
      for (const [playerId, value] of Object.entries(candidate)) {
        out[String(playerId)] = value || {};
      }
    }

    const addList = (list) => {
      for (const entry of Array.isArray(list) ? list : []) {
        const pid = String(entry?.id ?? entry?.playerId ?? entry?.apiPlayerId ?? "").trim();
        if (!pid || out[pid]) continue;
        out[pid] = entry || {};
      }
    };

    addList(legacyUserBreakdown?.starters);
    addList(legacyUserBreakdown?.bench);

    return out;
  }

  function hasMeaningfulStats(value) {
    return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
  }

  const playerMismatches = [];
  const statMismatches = [];

  for (const uid of allUids) {
    const legacyUserBreakdown = legacyBreakdownByUserId?.[uid] || {};
    const legacyPerPlayer = flattenLegacyPerPlayer(legacyUserBreakdown);
    const globalPerPlayer =
      globalBreakdownByUserId?.[uid]?.perPlayer &&
      typeof globalBreakdownByUserId[uid].perPlayer === "object"
        ? globalBreakdownByUserId[uid].perPlayer
        : {};
    const playerIds = new Set([
      ...Object.keys(legacyPerPlayer),
      ...Object.keys(globalPerPlayer),
    ]);

    for (const playerId of playerIds) {
      const legacyEntry = legacyPerPlayer[playerId] || {};
      const globalEntry = globalPerPlayer[playerId] || {};
      const legacyPoints = Number(legacyEntry.points ?? legacyEntry.total ?? legacyEntry.fantasyPoints ?? 0);
      const globalPoints = Number(globalEntry.points ?? 0);
      const diff = globalPoints - legacyPoints;
      const legacyStats = legacyEntry.stats || {};
      const globalStats = globalEntry.stats || {};
      const legacyHasStats = hasMeaningfulStats(legacyStats);
      const globalHasStats = hasMeaningfulStats(globalStats);

      if (diff !== 0 || legacyHasStats !== globalHasStats) {
        playerMismatches.push({
          uid,
          playerId,
          name: globalEntry.name || legacyEntry.name || "Unknown",
          legacyPoints,
          globalPoints,
          diff,
          legacyBreakdown: legacyEntry.breakdown || {},
          globalBreakdown: globalEntry.breakdown || {},
          legacyStats,
          globalStats,
        });
      }

      if (legacyHasStats !== globalHasStats) {
        statMismatches.push({
          uid,
          playerId,
          name: globalEntry.name || legacyEntry.name || "Unknown",
          legacyHasStats,
          globalHasStats,
        });
      }
    }
  }

  const payload = {
    mode: "regular-shadow-aggregator",
    source: "global-live-fixtures",
    compareScope: "current-regular-week",

    roomId,
    weekIndex: resolvedWeekIndex,
    seasonKey: seasonContext.seasonKey,
    fixtureIds,

    globalTotalsByUid,
    globalBenchTotalsByUid,
    globalBreakdownByUserId,

    legacyTotalsByUid,
    diffsByUid,
    fixtureCoverage,
    playerMismatches,
    statMismatches,

    missingFixtureIds,
    missingPlayerIdsByUid,

    weekStatus: weekResults.status || week.status || null,
    roundLabel: week.roundLabel || null,

    updatedAtMs: nowMs,
    updatedAt: FieldValue.serverTimestamp(),
  };

  await roomRef
    .collection("globalShadowResults")
    .doc(`week-${resolvedWeekIndex}`)
    .set(payload, { merge: false });

  return {
    ...payload,
    userCount: users.length,
  };
}

async function collectActiveSeasonFixtureTargets() {
  const roomsSnap = await db.collection("rooms")
    .where("competitionState.weekStatus", "in", ["scheduled", "live", "resolving"])
    .get();

  const roomTargets = await Promise.all(
    roomsSnap.docs.map(async (roomDoc) => {
      const roomId = roomDoc.id;
      const room = roomDoc.data() || {};
      if (!isGlobalLiveFixtureCacheEnabled(room)) {
        return null;
      }

      const competition = room?.competition || {};

      if (competition?.provider && competition.provider !== "api-football") {
        return null;
      }

      const league = Number(competition?.league);
      const season = Number(competition?.season);
      if (!Number.isFinite(league) || !Number.isFinite(season)) {
        return null;
      }

      const phaseLabel = getRoomPhaseLabel(room);
      const seasonContext = deriveSeasonContext({
        roomSeasonKey: room?.seasonKey,
        roomCompetitionKey: room?.competitionKey,
        roomCompetitionType: room?.competitionType,
        roomCompetitionName:
          room?.competitionMeta?.name ||
          room?.competition?.name ||
          null,
        league,
        season,
        phaseLabel,
      });

      if (!seasonContext?.seasonKey) {
        return null;
      }

      let fixtureIds = [];

      if (phaseLabel === "Cup") {
        const cupSnap = await db.doc(`rooms/${roomId}/cup/current`).get();
        const cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
        fixtureIds = Array.isArray(cup?.currentWindowFixtureIds)
          ? cup.currentWindowFixtureIds.map(String).filter(Boolean)
          : [];
      } else {
        const weekIndex = Number(room?.currentWeekIndex);
        if (!Number.isFinite(weekIndex)) {
          return null;
        }

        const weekSnap = await db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`).get();
        if (!weekSnap.exists) {
          return null;
        }

        fixtureIds = extractFixtureIdsFromWeekDoc(weekSnap.data() || {});
      }

      if (!fixtureIds.length) {
        return null;
      }

      return {
        roomId,
        seasonKey: seasonContext.seasonKey,
        competitionKey: seasonContext.competitionKey || "",
        competitionType: seasonContext.competitionType || "",
        league,
        season,
        timezone: String(competition?.timezone || "America/Los_Angeles"),
        fixtureIds,
      };
    })
  );

  const grouped = new Map();

  for (const target of roomTargets) {
    if (!target) continue;

    const existing = grouped.get(target.seasonKey) || {
      seasonKey: target.seasonKey,
      competitionKey: target.competitionKey,
      competitionType: target.competitionType,
      league: target.league,
      season: target.season,
      timezone: target.timezone,
      fixtureIds: new Set(),
      roomIds: new Set(),
    };

    for (const fixtureId of target.fixtureIds) {
      existing.fixtureIds.add(String(fixtureId));
    }
    existing.roomIds.add(String(target.roomId));
    grouped.set(target.seasonKey, existing);
  }

  return Array.from(grouped.values()).map((entry) => ({
    ...entry,
    fixtureIds: Array.from(entry.fixtureIds),
    roomIds: Array.from(entry.roomIds),
  }));
}

function buildGlobalFantasyByPlayerId(rawStatsByPlayerId = {}) {
  const fantasyByPlayerId = {};

  for (const [playerId, stats] of Object.entries(rawStatsByPlayerId || {})) {
    const position = toPos(stats?.position || stats?.pos || stats?.role);

    const playerObj = {
      id: String(playerId),
      name: stats?.name || "Unknown",
      position,
    };

    const scored = scorePlayer(stats || {}, position);

    fantasyByPlayerId[String(playerId)] = {
      points: Number(scored?.points ?? scored?.total ?? 0),
      breakdown: scored?.breakdown || scored?.parts || scored?.pointsBreakdown || {},
      stats: stats || {},
      position,
      teamName: stats?.teamName || stats?.realTeamName || "",
      opponentName: stats?.opponentName || "",
    };
  }

  return fantasyByPlayerId;
}

async function pollGlobalSeasonLiveFixturesOnce({ seasonTarget, apiKey, nowMs }) {
  const fixtureIds = [...new Set((seasonTarget?.fixtureIds || []).map(String).filter(Boolean))];
  if (!fixtureIds.length) {
    return { fixtureCount: 0, payloadCount: 0 };
  }

  const seasonKey = String(seasonTarget?.seasonKey || "").trim();
  if (!seasonKey) {
    return { fixtureCount: 0, payloadCount: 0 };
  }

  const timezone = String(seasonTarget?.timezone || "America/Los_Angeles");
  const statusByFixtureId = await getFixtureStatusMap({ fixtureIds, timezone, apiKey });
  const detailsByFixtureId = await loadFixtureStatusDetailsMap(fixtureIds);

  let payloadCount = 0;

  for (const fixtureId of fixtureIds) {
    const detail = detailsByFixtureId[fixtureId] || {};
    const short = statusByFixtureId[fixtureId] || detail?.short || null;
    const shouldFetchPlayers = hasFixtureStarted(short);

    let rawStatsByPlayerId = {};
    let fantasyByPlayerId = {};
    let payloadBytesEstimate = 0;

    if (shouldFetchPlayers) {
      const ttlMs = isInPlay(short) ? 60 * 1000 : 60 * 60 * 1000;
      rawStatsByPlayerId = await getFixturePlayersStatsMapCached({
        fixtureId,
        apiKey,
        ttlMs,
        timeZone: timezone,
      });
      fantasyByPlayerId = buildGlobalFantasyByPlayerId(rawStatsByPlayerId);

      const payloadDoc = {
        fixtureId: String(fixtureId),
        seasonKey,
        updatedAtMs: nowMs,
        computedAt: admin.firestore.FieldValue.serverTimestamp(),
        rawStatsByPlayerId,
        fantasyByPlayerId,
      };

      payloadBytesEstimate = estimateDocBytes(payloadDoc);
      if (payloadBytesEstimate >= 900000) {
        console.warn(
          `[pollGlobalSeasonLiveFixturesOnce] Large payload estimate ${payloadBytesEstimate} bytes for ${seasonKey}/${fixtureId}`
        );
      }

      await writeSeasonLiveFixture({
        db,
        seasonKey,
        fixtureId,
        payload: {
          ...payloadDoc,
          payloadBytesEstimate,
        },
      });
      payloadCount += 1;
    }

    await writeSeasonFixtureSummary({
      db,
      seasonKey,
      fixtureId,
      summary: {
        fixtureId: String(fixtureId),
        seasonKey,
        competitionKey: seasonTarget?.competitionKey || "",
        competitionType: seasonTarget?.competitionType || "",
        league: String(seasonTarget?.league || ""),
        season: String(seasonTarget?.season || ""),
        timezone,
        updatedAtMs: nowMs,
        computedAt: admin.firestore.FieldValue.serverTimestamp(),
        kickoffMs: Number.isFinite(Number(detail?.kickoffMs)) ? Number(detail.kickoffMs) : null,
        statusShort: short,
        statusLong: detail?.statusLong || null,
        elapsed: Number.isFinite(Number(detail?.elapsed)) ? Number(detail.elapsed) : null,
        isLive: isInPlay(short),
        isFinished: isFinished(short),
        hasStarted: hasFixtureStarted(short),
        homeTeamId: detail?.homeTeamId ?? null,
        homeTeamName: detail?.homeTeamName || "",
        homeTeamLogo: detail?.homeTeamLogo || "",
        awayTeamId: detail?.awayTeamId ?? null,
        awayTeamName: detail?.awayTeamName || "",
        awayTeamLogo: detail?.awayTeamLogo || "",
        goalsHome: toNum(detail?.goalsHome),
        goalsAway: toNum(detail?.goalsAway),
        roundLabel: detail?.leagueRound || null,
        leagueName: detail?.leagueName || "",
        rawStatsPlayerCount: Object.keys(rawStatsByPlayerId || {}).length,
        fantasyPlayerCount: Object.keys(fantasyByPlayerId || {}).length,
        payloadBytesEstimate,
        sourceRoomCount: Array.isArray(seasonTarget?.roomIds) ? seasonTarget.roomIds.length : 0,
      },
    });
  }

  return {
    fixtureCount: fixtureIds.length,
    payloadCount,
  };
}
async function recomputeRegularSeasonStandings({ roomId, users = [] }) {
  const resultsSnap = await db.collection(`rooms/${roomId}/weekResults`).get();

  const agg = {};

  function ensure(uid, name = "") {
    const key = String(uid || "");
    if (!key) return null;

    if (!agg[key]) {
      agg[key] = {
        userId: key,
        uid: key,
        name: name || key,
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        tablePoints: 0,
        totalFantasyPoints: 0,
      };
    }

    if (name) agg[key].name = name;
    return agg[key];
  }

  for (const u of users || []) {
    ensure(u.userId || u.uid, u.name || u.displayName || "");
  }

  const finalWeeks = resultsSnap.docs
    .map((d) => {
      const data = d.data() || {};
      return {
        ...data,
        id:d.id,
        weekIndex: Number(data.weekIndex ?? d.id),
      };
    })
    .filter((w) => {
      const status = String(w.status || "").toLowerCase();
      const hasFinalMatchups = Array.isArray(w.matchups) && w.matchups.some((m) => {
        const ms = String(m?.status || "").toLowerCase();
        return ms === "final";
      });

      const hasScores = Object.values(w.teamScoresByUserId || {}).some((v) => Number(v || 0) !== 0);

      return status === "final" || (hasFinalMatchups && hasScores);
    });

  for (const w of finalWeeks) {
    const matchups = Array.isArray(w.matchups) ? w.matchups : [];

    for (const m of matchups) {
      const home = ensure(m.homeUserId);
      const away = ensure(m.awayUserId);
      if (!home || !away) continue;

      home.played += 1;
      away.played += 1;

      const homeResult = String(m.homeResult || "").toUpperCase();
      const awayResult = String(m.awayResult || "").toUpperCase();

      const homePts = homeResult === "W" ? 3 : homeResult === "D" ? 1 : 0;
      const awayPts = awayResult === "W" ? 3 : awayResult === "D" ? 1 : 0;

      home.tablePoints += homePts;
      away.tablePoints += awayPts;

      if (homeResult === "W") home.wins += 1;
      else if (homeResult === "D") home.draws += 1;
      else home.losses += 1;

      if (awayResult === "W") away.wins += 1;
      else if (awayResult === "D") away.draws += 1;
      else away.losses += 1;
    }

    for (const [uid, score] of Object.entries(w.teamScoresByUserId || {})) {
      const row = ensure(uid);
      if (row) row.totalFantasyPoints += Number(score || 0);
    }
  }

  const standings = Object.values(agg).sort(
    (a, b) =>
      Number(b.tablePoints || 0) - Number(a.tablePoints || 0) ||
      Number(b.totalFantasyPoints || 0) - Number(a.totalFantasyPoints || 0)
  );

  await db.doc(`rooms/${roomId}/standings/current`).set(
    {
      roomId,
      source: "regular-season",
      includesLivePoints: false,
      finalWeekCount: finalWeeks.length,
      standings,
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return standings;
}

// ---------------- Live Week Compute (API stats) ----------------
async function computeAndWriteLiveWeek({ roomId, weekIndex, apiKey }) {
  if (!roomId || !Number.isFinite(Number(weekIndex))) return;

  const now = Date.now();
  const idx = String(weekIndex);

  const weekRef = db.doc(`rooms/${roomId}/weeks/${idx}`);
  const weekSnap = await weekRef.get();
  if (!weekSnap.exists) return;

  const week = weekSnap.data() || {};
  const startAtMs = Number(week.startAtMs || 0);
  const endAtMs = Number(week.endAtMs || 0);
  const timezone = week?.competition?.timezone || "America/Los_Angeles";

  const fixturesArr = Array.isArray(week.fixtures) ? week.fixtures : [];
  const fixtureIds = (Array.isArray(week.fixtureIds) && week.fixtureIds.length)
    ? week.fixtureIds.map((x) => String(x)).filter(Boolean)
    : fixturesArr.map((f) => String(f?.id ?? f?.fixtureId ?? f?.fixture?.id ?? "")).filter(Boolean);

  const kickoffMsByFixtureId = {};
  for (const f of fixturesArr) {
    const id = String(f?.id ?? f?.fixtureId ?? f?.fixture?.id ?? "");
    const ko = Number(f?.kickoffMs ?? (f?.fixture?.timestamp ? f.fixture.timestamp * 1000 : NaN));
    if (id && Number.isFinite(ko)) kickoffMsByFixtureId[id] = ko;
  }

  const weekResultsRef = db.doc(`rooms/${roomId}/weekResults/${idx}`);
  const prevSnap = await weekResultsRef.get();
  const prevResults = prevSnap.exists ? (prevSnap.data() || {}) : {};
  const prevTotals = prevResults.teamScoresByUserId || {};
  const prevHadPoints = Object.values(prevTotals).some((v) => Number(v) > 0);
  const prevFixtureStatusById = prevResults.fixtureStatusById || {};

  const forceRecompute = Boolean(prevResults.forceRecompute || week.forceRecompute);

  // If already final and long past the end window, skip unless forced
  const POST_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours
  if (!forceRecompute && week.status === "final" && Number.isFinite(endAtMs) && now > endAtMs + POST_WINDOW_MS) {
    return;
  }

  // 1) Fetch live statuses (single API hit usually)
  const statusByFixtureId = await getFixtureStatusMap({ fixtureIds, timezone, apiKey });

  // Timer/score details from apiCache/fixtureStatus_{fixtureId}
  const fixtureStatusDetailsById = await loadFixtureStatusDetailsMap(fixtureIds);

  // Fill missing statuses from previous write (prevents flapping on sparse API returns)
  // We always carry forward stable statuses (NS / finished).
  // For in-play statuses, we carry forward only while we're still within a reasonable match runtime window
  // (this avoids "LIVE → IDLE → LIVE" flapping when the API returns sparse/empty status payloads).
  const MATCH_RUNTIME_MS = 135 * 60 * 1000; // 2h15m (covers ET most of the time)
  for (const fId of fixtureIds) {
    const k = String(fId);
    const prevShort = prevFixtureStatusById[k] || null;

    if (!statusByFixtureId[k] && prevShort && (prevShort === "NS" || isFinished(prevShort))) {
      statusByFixtureId[k] = prevShort;
      continue;
    }

    if (!statusByFixtureId[k] && prevShort && isInPlay(prevShort)) {
      const ko = kickoffMsByFixtureId[k];
      if (Number.isFinite(ko) && now >= ko && now <= ko + MATCH_RUNTIME_MS) {
        statusByFixtureId[k] = prevShort;
      }
    }
  }

  const anyInPlay = fixtureIds.some((id) => isInPlay(statusByFixtureId[String(id)] || null));
  const allFinished = fixtureIds.length
    ? fixtureIds.every((id) => isFinished(statusByFixtureId[String(id)] || "") || statusByFixtureId[String(id)] === "NS")
    : false;

  const inRuntimeWindow = fixtureIds.some((id) => {
    const ko = kickoffMsByFixtureId[String(id)];
    return Number.isFinite(ko) && now >= ko && now <= ko + MATCH_RUNTIME_MS;
  });

  const shouldFinalize = Number.isFinite(endAtMs) && now >= endAtMs + POST_WINDOW_MS && !anyInPlay && allFinished;
  const statusValue = shouldFinalize ? "final" : ((anyInPlay || inRuntimeWindow) ? "live" : "idle");

  // Next kickoff (for UI + scheduling hints)
  let nextKickoffMs = null;
  for (const fId of fixtureIds) {
    const ko = kickoffMsByFixtureId[String(fId)];
    if (!Number.isFinite(ko)) continue;
    if (ko > now && (nextKickoffMs == null || ko < nextKickoffMs)) nextKickoffMs = ko;
  }

  // 2) Load members + lineups (starters only score)
  const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
  const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean).sort();
  function inferOwnerUid(d) {
    const v =
      d?.ownerUid ?? d?.ownerId ?? d?.ownedBy ?? d?.managerUid ??
      d?.userId ?? d?.uid ?? d?.pickedByUid ?? d?.pickedBy ??
      d?.owner?.uid ?? d?.owner?.id;

    if (!v) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object") return v.uid || v.id || null;
    return null;
  }

  // Build rosterByUid from room players (so bench can be roster - starters)
  // Build playersById map (id -> {id,name,position})
  const playersById = new Map();
  const pickDocToPlayer = new Map(); 
  const rosterByUid = {};
  const picksSnap = await db.collection(`rooms/${roomId}/picks`).get();

  for (const pk of picksSnap.docs) {
    const d = pk.data() || {};
    const owner = inferOwnerUid(d); 
    const pid = String(d.playerId ?? d.pid ?? d.apiPlayerId ?? d.player?.id ?? d.player?.playerId ?? "");

    if (!owner || !pid) continue;

    // Build our player object directly from the pick document!
    const p = {
      id: pid,
      name: d.playerName || d.name || "Unknown",
      position: toPos(d.position || d.pos || d.role),
      teamName: d.teamName || "",
    };
    
    playersById.set(pid, p); // Save it to the map for the lineup resolver
    (rosterByUid[String(owner)] ||= []).push(p);
    pickDocToPlayer.set(pk.id, p);
  }

  const users = [];
  for (const mUid of memberUids) {
    const userSnap = await db.doc(`users/${mUid}`).get();
    const profile = userSnap.exists ? userSnap.data() : {};
    const display = (profile.displayName || profile.name || mUid).trim();

    const tnSnap = await db.doc(`rooms/${roomId}/teamNames/${mUid}`).get();
    const tn = tnSnap.exists ? (tnSnap.data().teamName || "") : "";
    const name = tn ? `${display} — ${tn}` : display;

    const lineupSnap = await db.doc(`rooms/${roomId}/lineups/${mUid}`).get();
    const lineup = lineupSnap.exists ? lineupSnap.data() : null;

    const resolveLineupEntry = (entry) => {
    const raw = String(entry?.id ?? entry?.playerId ?? entry ?? "");
    if (!raw) return null;

    // If lineup stored the PICK DOC ID instead of playerId, translate it
      const fromPick = pickDocToPlayer.get(raw) || null;
      const pid = String(fromPick?.id ?? raw);

      // Prefer /players, then fallback to pick object
      const known = playersById.get(pid) || fromPick || null;

      return {
        id: pid,
        name: known?.name || entry?.name || entry?.fullName || entry?.displayName || "Unknown",
        position: toPos(known?.position || entry?.position || entry?.pos || entry?.role || ""),
        teamName: known?.teamName || "",
        teamLogo: known?.teamLogo || "",
      };
    };

    const starters = extractStarters(lineup).map(resolveLineupEntry).filter(Boolean);
    let bench = extractBench(lineup).map(resolveLineupEntry).filter(Boolean);
        

    // If lineup doc doesn't store bench, derive from roster (picks - starters)
    if (!bench.length) {
      const roster = rosterByUid[String(mUid)] || [];
      const starterSet = new Set(starters.map((p) => String(p.id)));
      bench = roster.filter((p) => p?.id && !starterSet.has(String(p.id)));
    } else {
      // safety: never allow overlap
      const starterSet = new Set(starters.map((p) => String(p.id)));
      bench = bench.filter((p) => p?.id && !starterSet.has(String(p.id)));
    }

    users.push({ userId: mUid, name, starters, bench });
  }

  const starterIds = new Set();
  const trackedIds = new Set();
  const benchByUserId = {};
  const startersByUserId = {};

  for (const u of users) {
    benchByUserId[u.userId] = u.bench || [];
    startersByUserId[u.userId] = u.starters || [];

    for (const p of (u.starters || [])) {
      const pid = String(p.id);
      starterIds.add(pid);
      trackedIds.add(pid);
    }

    for (const p of (u.bench || [])) {
      trackedIds.add(String(p.id));
    }
  }

  // If no starters yet, still write status so UI updates, but don't write totals
  if (starterIds.size === 0) {
    await weekResultsRef.set(
      {
        roomId,
        weekIndex: Number(weekIndex),
        startAtMs: startAtMs || null,
        endAtMs: endAtMs || null,
        roundLabel: week.roundLabel || null,
        status: statusValue,
        nextKickoffMs: nextKickoffMs ?? null,
        fixtureStatusById: statusByFixtureId,
        updatedAtMs: Date.now(),
        computedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return;
  }

  // 3) Aggregate stats across fixtures for starters
  const aggStatsByPlayerId = {};
  const LIVE_TTL_MS = 60 * 1000;
  const FINISHED_TTL_MS = 10 * 60 * 1000;

  for (const fId of fixtureIds) {
    const fid = String(fId);
    const short = statusByFixtureId[fid] || null;

    // Save API calls: skip not started
    if (!short || short === "NS") continue;

    const inPlay = isInPlay(short);
    const ko = kickoffMsByFixtureId[fid] ?? null;

    const fixtureDetail = fixtureStatusDetailsById[fid] || {};
    const elapsed = Number(fixtureDetail.elapsed);
    const extra = Number(fixtureDetail.extra);
    const statusUpdatedAtMs = Number(fixtureDetail.updatedAtMs);

    const ttlMs = inPlay ? LIVE_TTL_MS : (isFinished(short) ? FINISHED_TTL_MS : LIVE_TTL_MS);
    const map = await getFixturePlayersStatsMapCached({ fixtureId: fid, apiKey, ttlMs, timeZone: timezone });

    for (const [pidRaw, st] of Object.entries(map || {})) {
      const pid = String(pidRaw);
      if (!trackedIds.has(pid)) continue;

      const prev = aggStatsByPlayerId[pid] || {
        minutes: 0, passesCompleted: 0, goals: 0, assists: 0,
        saves: 0, goalsConceded: 0, yellow: 0, red: 0,
        pensSaved: 0, pensMissed: 0, pensCommitted: 0,
        rating: 0,

        tackles: 0,
        duelsWon: 0,
        dribblesSuccess: 0,
        foulsCommitted: 0,
        offsides: 0,
        shotsOnTarget: 0,

        cleanSheet: false,
        ownGoals: 0,

        teamName: "",
        opponentName: "",
        teamGoals: null,
        opponentGoals: null,

        isLive: false,
        fixtureStatus: null,
        matchStatus: null,
        statusShort: null,
        statusLong: null,
        elapsed: null,
        extra: null,
        statusUpdatedAtMs: null,
        fixtureId: null,
        kickoffMs: null,
      };
      
      const stTeamScore = st.teamScore ?? st.teamGoals ?? null;
      const stOpponentScore = st.opponentScore ?? st.opponentGoals ?? null;

      aggStatsByPlayerId[pid] = {
        minutes: prev.minutes + (st.minutes || 0),
        goals: prev.goals + (st.goals || 0),
        assists: prev.assists + (st.assists || 0),
        passesCompleted: prev.passesCompleted + (st.passesCompleted || 0),

        saves: prev.saves + (st.saves || 0),
        goalsConceded: prev.goalsConceded + (st.goalsConceded || 0),

        yellow: prev.yellow + (st.yellow || 0),
        red: prev.red + (st.red || 0),

        pensSaved: prev.pensSaved + (st.pensSaved || 0),
        pensMissed: prev.pensMissed + (st.pensMissed || 0),
        pensCommitted: (prev.pensCommitted || 0) + (st.pensCommitted || 0), 

        cleanSheet: Boolean(prev.cleanSheet) || Boolean(st.cleanSheet),
        ownGoals: (prev.ownGoals || 0) + (st.ownGoals || 0),

        // advanced stats (sum most, max rating)
        rating: Math.max(prev.rating || 0, st.rating || 0),
        tackles: (prev.tackles || 0) + (st.tackles || 0),
        duelsWon: (prev.duelsWon || 0) + (st.duelsWon || 0),
        dribblesSuccess: (prev.dribblesSuccess || 0) + (st.dribblesSuccess || 0),
        foulsCommitted: (prev.foulsCommitted || 0) + (st.foulsCommitted || 0),
        offsides: (prev.offsides || 0) + (st.offsides || 0),
        shotsOnTarget: (prev.shotsOnTarget || 0) + (st.shotsOnTarget || 0),

        teamName: st.teamName || prev.teamName || "",
        opponentName: st.opponentName || prev.opponentName || "",

        teamScore: stTeamScore ?? prev.teamScore ?? null,
        opponentScore: stOpponentScore ?? prev.opponentScore ?? null,
        teamGoals: stTeamScore ?? prev.teamGoals ?? null,
        opponentGoals: stOpponentScore ?? prev.opponentGoals ?? null,

        isLive: Boolean(prev.isLive) || inPlay,

        fixtureStatus: short || prev.fixtureStatus || null,
        matchStatus: short || prev.matchStatus || null,
        statusShort: short || prev.statusShort || null,
        statusLong: fixtureDetail.statusLong || prev.statusLong || null,

        elapsed: Number.isFinite(elapsed) ? elapsed : (prev.elapsed ?? null),
        extra: Number.isFinite(extra) ? extra : (prev.extra ?? null),
        statusUpdatedAtMs: Number.isFinite(statusUpdatedAtMs)
          ? statusUpdatedAtMs
          : (prev.statusUpdatedAtMs ?? now),

        fixtureId: prev.fixtureId || fid,
        kickoffMs: prev.kickoffMs || ko || null,
      };
    }
  }

  const haveAnyStats = Object.keys(aggStatsByPlayerId).length > 0;
  if (!forceRecompute && !haveAnyStats && prevHadPoints && !anyInPlay) {
    const keepPatch = {
      status: statusValue,
      nextKickoffMs: nextKickoffMs ?? null,
      fixtureStatusById: statusByFixtureId,
      updatedAtMs: Date.now(),
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (shouldFinalize) {
      keepPatch.status = "final";
      keepPatch.teamScoresByUserId = prevResults.teamScoresByUserId || {};
      keepPatch.breakdownByUserId = prevResults.breakdownByUserId || {};
      keepPatch.matchups = prevResults.matchups || [];
      keepPatch.weekLeaderboard = prevResults.weekLeaderboard || [];
    }

    await weekResultsRef.set(keepPatch, { merge: true });

    if (shouldFinalize) {
      await weekRef.set(
        {
          status: "final",
          finalizedAt: admin.firestore.FieldValue.serverTimestamp(),
          finalizedAtMs: Date.now(),
        },
        { merge: true }
      );

      await recomputeRegularSeasonStandings({ roomId, users });
    }

    return;
  }

  // 4) Score users (starters count; bench shows points but does NOT add to totals)
  // 4) Score users (Accumulator Logic)
  const totalsByUid = {};
  const breakdownByUserId = {};
  const newActiveScorers = {};
  const finalStartersByUserId = {};
  const finalBenchByUserId = {};

  for (const u of users) {
    // 1. Get previously locked-in scorers from this week
    const activeSet = new Set(prevResults.activeScorers?.[u.userId] || []);

    // 2. Lock in any CURRENT starters whose match has officially started
    for (const p of (u.starters || [])) {
      const pid = String(p.id);
      const st = aggStatsByPlayerId[pid];
      // If we have stats and the match is not "Not Started", lock them!
      const hasStarted = st && st.fixtureStatus && st.fixtureStatus !== "NS";
      
      if (hasStarted) {
        activeSet.add(pid);
      }
    }
    newActiveScorers[u.userId] = Array.from(activeSet);

    // 3. Build Effective Starters (Locked-in scorers + Current valid starters)
    const effectiveStarters = [];
    const addedIds = new Set();

    // First, add everyone who is locked in to score
    for (const pid of activeSet) {
      // playersById is defined earlier in your compute function
      const pObj = playersById.get(pid) || { id: pid, name: "Unknown", position: "MID" };
      effectiveStarters.push(pObj);
      addedIds.add(pid);
    }

    // Next, add current starters whose games haven't started yet
    for (const p of (u.starters || [])) {
      const pid = String(p.id);
      if (!addedIds.has(pid)) {
        effectiveStarters.push(p);
        addedIds.add(pid);
      }
    }
    finalStartersByUserId[u.userId] = effectiveStarters;

    // 4. Build Effective Bench (Remove anyone who was upgraded to an Effective Starter)
    const effectiveBench = [];
    for (const p of (u.bench || [])) {
      if (!addedIds.has(String(p.id))) {
        effectiveBench.push(p);
      }
    }
    finalBenchByUserId[u.userId] = effectiveBench;

    // 5. Extract Stats and Score!
    const starterStats = {};
    for (const p of effectiveStarters) {
      starterStats[String(p.id)] = aggStatsByPlayerId[String(p.id)] || {};
    }

    const benchStats = {};
    for (const p of effectiveBench) {
      benchStats[String(p.id)] = aggStatsByPlayerId[String(p.id)] || {};
    }

    const starterScored = scoreTeam(effectiveStarters, starterStats, toPos);
    const benchScored = scoreTeam(effectiveBench, benchStats, toPos);

    totalsByUid[u.userId] = starterScored.total;

    breakdownByUserId[u.userId] = {
      total: starterScored.total,
      perPlayer: { ...starterScored.perPlayer, ...benchScored.perPlayer },
      benchTotal: benchScored.total,
    };
  }

  // Guard (per-user): never drop an individual user's total from >0 to 0 mid-week due to a partial API payload.
  // This happens when the API returns stats for some fixtures/players but not others on a given poll.
  // We keep the previous total for that user until we can recompute with non-empty stats again (or until finalization).
  if (!forceRecompute && !shouldFinalize) {
    const prevBreakdowns = prevResults.breakdownByUserId || {};
    for (const [uid, prevVal] of Object.entries(prevTotals)) {
      const pv = Number(prevVal || 0);
      const cv = Number(totalsByUid[uid] || 0);
      if (pv > 0 && cv === 0) {
        totalsByUid[uid] = pv;
        if (prevBreakdowns[uid] && !breakdownByUserId[uid]) {
          breakdownByUserId[uid] = prevBreakdowns[uid];
        }
      }
    }
  }

  // Guard: never overwrite previously non-zero totals with all-zeros due to an API hiccup/empty stats payload.
  // Fantasy points can fluctuate up/down slightly (cards, etc.), but a full drop to 0 after having points is almost always wrong.
  const computedHadPoints = Object.values(totalsByUid).some((v) => Number(v) > 0);
  if (!forceRecompute && prevHadPoints && !computedHadPoints && !shouldFinalize) {
    // 7) Write weekResults (+ keep points stable)
    await weekResultsRef.set(
      {
        roomId,
        weekIndex: Number(weekIndex),
        startAtMs: startAtMs || null,
        endAtMs: endAtMs || null,
        roundLabel: week.roundLabel || null,
        status: statusValue,
        nextKickoffMs: nextKickoffMs ?? null,
        fixtureStatusById: statusByFixtureId,
        teamScoresByUserId: totalsByUid,
        breakdownByUserId,
        matchups,
        weekLeaderboard,
        updatedAtMs: Date.now(),
        computedAt: admin.firestore.FieldValue.serverTimestamp(),
        
        // NEW ACCUMULATOR DATA:
        activeScorers: newActiveScorers,
        benchByUserId: finalBenchByUserId,
        startersByUserId: finalStartersByUserId,
      },
      { merge: true }
    );
    return;
  }

  
  // 5) Matchups + leaderboard
  const matchupPairs = Array.isArray(week.matchups) && week.matchups.length
    ? week.matchups
    : roundRobinPairings(memberUids, Number(weekIndex));

  const matchups = matchupPairs.map((pair) => {
    const homeTotal = totalsByUid[pair.homeUserId] ?? 0;
    const awayTotal = totalsByUid[pair.awayUserId] ?? 0;

    let homeResult = "L", awayResult = "W", winnerUserId = pair.awayUserId;
    if (homeTotal > awayTotal) { homeResult = "W"; awayResult = "L"; winnerUserId = pair.homeUserId; }
    else if (homeTotal === awayTotal) { homeResult = "D"; awayResult = "D"; winnerUserId = null; }

    return {
      weekIndex: Number(weekIndex),
      homeUserId: pair.homeUserId,
      awayUserId: pair.awayUserId,
      homeTotal,
      awayTotal,
      homeResult,
      awayResult,
      winnerUserId,
      status: statusValue === "final" ? "FINAL" : (anyInPlay ? "LIVE" : "IDLE"),
    };
  });

  const weekLeaderboard = buildLeaderboard(users, matchups, totalsByUid);


  // 7) Write weekResults (+ keep points stable)
  await weekResultsRef.set(
    {
      roomId,
      weekIndex: Number(weekIndex),
      startAtMs: startAtMs || null,
      endAtMs: endAtMs || null,
      roundLabel: week.roundLabel || null,
      status: statusValue,
      nextKickoffMs: nextKickoffMs ?? null,
      fixtureStatusById: statusByFixtureId,
      teamScoresByUserId: totalsByUid,
      breakdownByUserId,
      matchups,
      weekLeaderboard,
      updatedAtMs: Date.now(),
      computedAt: admin.firestore.FieldValue.serverTimestamp(),

      activeScorers: newActiveScorers,
      benchByUserId: finalBenchByUserId,
      startersByUserId: finalStartersByUserId,
    },
    { merge: true }
  );


  if (shouldFinalize) {
    await weekRef.set(
      {
        status: "final",
        finalizedAt: admin.firestore.FieldValue.serverTimestamp(),
        finalizedAtMs: Date.now(),
      },
      { merge: true }
    );

    await recomputeRegularSeasonStandings({ roomId, users });
  }

  // Clear force flag if it was set
  if (prevResults.forceRecompute) {
    await weekResultsRef.set({ forceRecompute: admin.firestore.FieldValue.delete() }, { merge: true });
  }
}

async function autoAdvanceWeekIfFinal({ roomId, room, currentWeekIndex, apiKey }) {
  const nowMs = Date.now();

  // Load current week (must be final to advance)
  const curRef = db.doc(`rooms/${roomId}/weeks/${String(currentWeekIndex)}`);
  const curSnap = await curRef.get();
  if (!curSnap.exists) return null;

  const curWeek = curSnap.data() || {};
  if (curWeek.status !== "final") return null;
  const HOLD_FINAL_MS = 24 * 60 * 60 * 1000;

  const finalizedAtMs =
    Number(curWeek.finalizedAtMs || 0) ||
    (curWeek.finalizedAt?.toMillis ? curWeek.finalizedAt.toMillis() : 0);

  if (finalizedAtMs && nowMs < finalizedAtMs + HOLD_FINAL_MS) {
    return null; // stay on FINAL for 24h
  }

  const endAtMs = Number(curWeek.endAtMs || 0);

  // Determine competition + total rounds
  const competition = room.competition;
  if (!competition?.league || !competition?.season) {
    console.warn(`[autoAdvanceWeekIfFinal] Missing room.competition for room ${roomId}`);
    return null; // or throw, depending on your preference
  }

  const totalRounds = await ensureRoomTotalRounds({ roomId, room, competition, apiKey });
  const curRound = parseRoundNumber(curWeek.roundLabel);

  // If this was the LAST matchday, finalize season instead of creating next week
  // If this was the LAST matchday, finalize season instead of creating next week
  if (Number.isFinite(totalRounds) && Number.isFinite(curRound) && curRound >= totalRounds) {
    await writeFinalResultsSnapshot({ roomId });
    await db.doc(`rooms/${roomId}`).set({ seasonPhase: "COMPLETE", currentWeekIndex: null }, { merge: true });
    return null;
  }

  // If a future week already exists, move to the next one instead of creating a new one
  const weeksSnap = await db.collection(`rooms/${roomId}/weeks`).get();
  const indices = weeksSnap.docs
    .map((d) => Number(d.data()?.index ?? d.id))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const nextExisting = indices.find((i) => i > Number(currentWeekIndex));
  if (nextExisting) {
    const nextWeekSnap = await db.doc(`rooms/${roomId}/weeks/${String(nextExisting)}`).get();
    const nextWeek = nextWeekSnap.exists ? (nextWeekSnap.data() || {}) : {};
    const nextFixtures = Array.isArray(nextWeek.fixtures) ? nextWeek.fixtures : [];
    const pollInfo = getNextPollAtMsFromFixtures(nextFixtures, nowMs);

    await db.doc(`rooms/${roomId}`).set({ currentWeekIndex: nextExisting }, { merge: true });
    await setCompetitionState(
      db.doc(`rooms/${roomId}`),
      {
        weekStatus: "scheduled",
        nextPollAtMs: pollInfo.nextPollAtMs,
        nextKickoffMs: pollInfo.nextKickoffMs,
      },
      {
        roomData: room,
        nowMs,
      }
    );
    await upsertTournamentPollTask({
      roomId,
      phase: "RegularSeason",
      nextPollAtMs: pollInfo.nextPollAtMs,
      reason: "advance-existing-week",
      nowMs,
    });
    return nextExisting;
  }

  // Need even managers
  const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
  const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean);
  if (memberUids.length < 2 || memberUids.length % 2 !== 0) return null;

  const nextWeekIndex = (indices.length ? Math.max(...indices) : Number(currentWeekIndex)) + 1;

  const fallbackDate = room?.seedFilter?.fixtureDate || null;

  // ✅ This is the key: skip anything at/before last week end kickoff
  const window = await fetchNextRoundWindow(competition, {
    fallbackDate,
    minKickoffMs: endAtMs + 60 * 1000, // +1 minute
  });

  if (!window) return null;

  const pairs = roundRobinPairings(memberUids, nextWeekIndex);

  const weekDoc = {
    index: nextWeekIndex,
    startAtMs: window.startAtMs,
    endAtMs: window.endAtMs,
    roundLabel: window.roundLabel || null,
    fixtures: window.fixtures,
    fixtureIds: window.fixtures.map((f) => f.id),
    competition,
    matchups: pairs,
    status: "scheduled",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.doc(`rooms/${roomId}/weeks/${String(nextWeekIndex)}`).set(weekDoc, { merge: true });
  const pollInfo = getNextPollAtMsFromFixtures(window.fixtures, nowMs);

  // Move the room forward ✅
  await db.doc(`rooms/${roomId}`).set(
    { currentWeekIndex: nextWeekIndex, competition, advancedAtMs: nowMs },
    { merge: true }
  );
  await setCompetitionState(
    db.doc(`rooms/${roomId}`),
    {
      weekStatus: "scheduled",
      nextPollAtMs: pollInfo.nextPollAtMs,
      nextKickoffMs: pollInfo.nextKickoffMs,
    },
    {
      roomData: room,
      nowMs,
    }
  );
  await upsertTournamentPollTask({
    roomId,
    phase: "RegularSeason",
    nextPollAtMs: pollInfo.nextPollAtMs,
    reason: "advance-created-week",
    nowMs,
  });

  // Create a weekResults doc so UI immediately has something
  await db.doc(`rooms/${roomId}/weekResults/${String(nextWeekIndex)}`).set(
    {
      roomId,
      weekIndex: nextWeekIndex,
      startAtMs: window.startAtMs,
      endAtMs: window.endAtMs,
      roundLabel: window.roundLabel || null,
      status: "scheduled",
      teamScoresByUserId: {},
      breakdownByUserId: {},
      matchups: pairs.map((p) => ({
        ...p,
        homeTotal: 0,
        awayTotal: 0,
        homeResult: "D",
        awayResult: "D",
        winnerUserId: null,
      })),
      weekLeaderboard: [],
      updatedAtMs: Date.now(),
    },
    { merge: true }
  );

  return nextWeekIndex;
}


async function ensureCurrentWeekIfMissing({ roomId, room, apiKey }) {
  const nowMs = Date.now();
  const currentIdx = Number(room?.currentWeekIndex);
  if (Number.isFinite(currentIdx) && currentIdx > 0) return currentIdx;

  // require even managers
  const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
  const memberUids = membersSnap.docs.map((d) => d.id).filter(Boolean);
  if (memberUids.length < 2 || memberUids.length % 2 !== 0) return null;

  // determine next weekIndex
  const weeksSnap = await db.collection(`rooms/${roomId}/weeks`).get();
  let maxIdx = 0;
  for (const d of weeksSnap.docs) {
    const idx = Number(d.data()?.index ?? d.id);
    if (Number.isFinite(idx)) maxIdx = Math.max(maxIdx, idx);
  }
  const weekIndex = maxIdx + 1;

  const competition = room.competition;
  if (!competition?.league || !competition?.season) {
    console.warn(`[autoAdvanceWeekIfFinal] Missing room.competition for room ${roomId}`);
    return null; // or throw, depending on your preference
  }

  const fallbackDate = room?.seedFilter?.fixtureDate || null;
  const window = await fetchNextRoundWindow(competition, { fallbackDate });
  if (!window) return null;

  const pairs = roundRobinPairings(memberUids, weekIndex);

  const weekDoc = {
    index: weekIndex,
    startAtMs: window.startAtMs,
    endAtMs: window.endAtMs,
    roundLabel: window.roundLabel || null,
    fixtures: window.fixtures,
    fixtureIds: window.fixtures.map((f) => f.id),
    competition,
    matchups: pairs,
    status: "scheduled",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`).set(weekDoc, { merge: true });
  const pollInfo = getNextPollAtMsFromFixtures(window.fixtures, nowMs);
  await db.doc(`rooms/${roomId}`).set({ currentWeekIndex: weekIndex, competition }, { merge: true });
  await setCompetitionState(
    db.doc(`rooms/${roomId}`),
    {
      weekStatus: "scheduled",
      nextPollAtMs: pollInfo.nextPollAtMs,
      nextKickoffMs: pollInfo.nextKickoffMs,
    },
    {
      roomData: room,
      nowMs,
    }
  );
  await upsertTournamentPollTask({
    roomId,
    phase: "RegularSeason",
    nextPollAtMs: pollInfo.nextPollAtMs,
    reason: "ensure-current-week",
    nowMs,
  });

  // Create an empty weekResults doc so the UI has something immediately.
  await db.doc(`rooms/${roomId}/weekResults/${String(weekIndex)}`).set(
    {
      roomId,
      weekIndex,
      startAtMs: window.startAtMs,
      endAtMs: window.endAtMs,
      roundLabel: window.roundLabel || null,
      status: "scheduled",
      teamScoresByUserId: {},
      breakdownByUserId: {},
      matchups: pairs.map((p) => ({
        ...p,
        homeTotal: 0,
        awayTotal: 0,
        homeResult: "D",
        awayResult: "D",
        winnerUserId: null,
      })),
      weekLeaderboard: [],
      updatedAtMs: Date.now(),
    },
    { merge: true }
  );

  return weekIndex;
}

async function fetchAggregatedStats(fixtureIds, apiKey, timezone = "America/Los_Angeles") {
  const aggStatsByPlayerId = {};
  const fixtureStatusById = {};
  let nextKickoffMs = null;
  let anyInPlay = false;

  // 1. GET HIGH-LEVEL FIXTURE DATA (For Status & Time)
  // (Assumes you have a getLiveFixturesMap function, or you can implement a simple fetch here)
  // For simplicity, we will assume we fetch stats fixture-by-fixture below, 
  // but in a production app, fetching the schedule list first is better.

  for (const fId of fixtureIds) {
    // A. DETERMINE STATUS & TTL
    // We assume getFixturePlayersStatsMapCached returns the "fixture" object inside its response
    // or we infer it. To be safe, we use a default TTL.
    
    // FETCH STATS (API CALL)
    // We set a default TTL of 60s. The cache function handles the logic.
    const map = await getFixturePlayersStatsMapCached({ 
        fixtureId: fId, 
        apiKey, 
        ttlMs: 60 * 1000,
        timeZone: timezone
    });

    // We need the fixture status. Since your cache function returns a map of players, 
    // we might lose the top-level fixture data. 
    // TRICK: We will try to pull status from the first player in the map if available,
    // OR we relies on a separate call. 
    // BETTER WAY: Let's assume we call getFixtureStatusMap separately or previously.
    // For now, let's infer status from the map data if we saved it there.
    
    // If map is empty, we can't do much about status unless we fetched it separately.
    // Let's assume the loop logic from previous turns:
    
    if (!map) continue;

    // B. MERGE STATS
    for (const [pid, st] of Object.entries(map)) {
        // Save Status for UI (One time grab)
        if (!fixtureStatusById[fId] && st.matchStatus) {
            fixtureStatusById[fId] = st.matchStatus;
            if (st.isLive) anyInPlay = true;
        }

        if (!aggStatsByPlayerId[pid]) {
            aggStatsByPlayerId[pid] = {
                minutes: 0, goals: 0, assists: 0, passesCompleted: 0,
                saves: 0, goalsConceded: 0, yellow: 0, red: 0,
                pensSaved: 0, pensMissed: 0, cleanSheet: false, ownGoals: 0,
                teamName: "", opponentName: "",
                matchStatus: "NS", isLive: false
            };
        }

        const prev = aggStatsByPlayerId[pid];

        // --- GHOST PLAYER FIX ---
        const hasActivity = (st.goals > 0 || st.assists > 0 || st.passesCompleted > 0 || st.yellow > 0);
        let safeMinutes = st.minutes || 0;
        if (safeMinutes === 0 && hasActivity) safeMinutes = 1;

        aggStatsByPlayerId[pid] = {
            minutes: prev.minutes + safeMinutes,
            goals: prev.goals + (st.goals || 0),
            assists: prev.assists + (st.assists || 0),
            passesCompleted: prev.passesCompleted + (st.passesCompleted || 0),
            saves: prev.saves + (st.saves || 0),
            goalsConceded: prev.goalsConceded + (st.goalsConceded || 0),
            yellow: prev.yellow + (st.yellow || 0),
            red: prev.red + (st.red || 0),
            pensSaved: prev.pensSaved + (st.pensSaved || 0),
            pensMissed: prev.pensMissed + (st.pensMissed || 0),
            cleanSheet: prev.cleanSheet || st.cleanSheet || false,
            ownGoals: (prev.ownGoals || 0) + (st.ownGoals || 0),
            
            // Text & Status
            teamName: st.teamName || prev.teamName,
            opponentName: st.opponentName || prev.opponentName,
            matchStatus: st.matchStatus || prev.matchStatus,
            isLive: st.isLive || prev.isLive
        };
    }
  }
  
  return { aggStatsByPlayerId, fixtureStatusById, nextKickoffMs, anyInPlay };
}

// ============================================================================
// HELPER: Fetches Users and applies Position Fixes
// ============================================================================
async function fetchUsersAndLineups(roomId, room) {
  const membersSnap = await db.collection(`rooms/${roomId}/members`).get();
  const uids = membersSnap.docs.map(d => d.id);
  
  // Fetch Real Positions to fix "FWD marked as MID" issues
  const picksSnap = await db.collection(`rooms/${roomId}/picks`).get();
  const posMap = {};
  picksSnap.forEach(doc => {
      const d = doc.data() || {};
      const pid = String(d.playerId || d.pid || d.apiPlayerId || "");
      if (pid && d.position) posMap[pid] = toPos(d.position);
  });

  const users = [];
  for (const uid of uids) {
      const [uSnap, tnSnap, linSnap] = await Promise.all([
          db.doc(`users/${uid}`).get(),
          db.doc(`rooms/${roomId}/teamNames/${uid}`).get(),
          db.doc(`rooms/${roomId}/lineups/${uid}`).get()
      ]);

      const profile = uSnap.data() || {};
      const teamName = tnSnap.data()?.teamName || "";
      const display = profile.displayName || uid;
      
      const lineup = linSnap.data() || {};
      let starters = extractStarters(lineup); // Your existing helper

      // APPLY POSITION FIX
      starters = starters.map(p => ({
          ...p,
          position: posMap[String(p.id)] || p.position // Overwrite with DB position
      }));

      users.push({ userId: uid, name: teamName ? `${display} - ${teamName}` : display, starters });
  }
  return users;
}

// ============================================================================
// HELPER: Updates Standings (W/L/D)
// ============================================================================
async function updateStandings(roomId, users) {
  const weeksSnap = await db.collection(`rooms/${roomId}/weekResults`).get();
  const agg = {};

  // Init Aggregation
  users.forEach(u => {
      agg[u.userId] = { userId: u.userId, name: u.name, wins: 0, draws: 0, losses: 0, points: 0, fantasy: 0 };
  });

  weeksSnap.forEach(doc => {
      const w = doc.data();
      // Only count finalized weeks OR live weeks (depending on your preference)
      // Usually, we only count finalized for the table, but live for "Live Standings"
      
      // Add Fantasy Points
      if (w.teamScoresByUserId) {
          Object.entries(w.teamScoresByUserId).forEach(([uid, score]) => {
              if (agg[uid]) agg[uid].fantasy += Number(score);
          });
      }

      // Add Table Points (W/L/D)
      if (w.matchups) {
          w.matchups.forEach(m => {
              if (!agg[m.homeUserId] || !agg[m.awayUserId]) return;
              
              if (m.homeResult === "W") {
                  agg[m.homeUserId].wins++;
                  agg[m.homeUserId].points += 3;
                  agg[m.awayUserId].losses++;
              } else if (m.homeResult === "D") {
                  agg[m.homeUserId].draws++;
                  agg[m.homeUserId].points += 1;
                  agg[m.awayUserId].draws++;
                  agg[m.awayUserId].points += 1;
              } else {
                  agg[m.homeUserId].losses++;
                  agg[m.awayUserId].wins++;
                  agg[m.awayUserId].points += 3;
              }
          });
      }
  });

  const standings = Object.values(agg).sort((a,b) => (b.points - a.points) || (b.fantasy - a.fantasy));
  
  await db.doc(`rooms/${roomId}/standings/current`).set({
      roomId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      standings
  });
}

// --- REPAIR TOOL: Populates a week with ALL games from the league ---

exports.debugForceUpdateWeek = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    // 1. Auth Check
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const { roomId, weekIndex } = request.data;
    if (!roomId || !weekIndex) throw new HttpsError("invalid-argument", "Missing params.");

    console.log(`[DEBUG] Force updating Room ${roomId} Week ${weekIndex} by User ${uid}`);

    // 2. Run the logic immediately
    const apiKey = APIFOOTBALL_KEY.value();

    await db.doc(`rooms/${roomId}/weekResults/${String(weekIndex)}`).set(
      { forceRecompute: true },
      { merge: true }
    );
        
    // This calls your existing worker function
    try {
      await computeAndWriteLiveWeek({ roomId, weekIndex, apiKey });
    } catch (e) {
      console.error("debugForceUpdateWeek failed", e);
      throw new HttpsError("internal", e?.message || String(e));
    }

    // 3. Return the results so you can verify in browser console
    const resultRef = db.doc(`rooms/${roomId}/weekResults/${weekIndex}`);
    const snap = await resultRef.get();
    
    return { 
      success: true, 
      data: snap.data(),
      message: "Force update complete. Stats saved to DB."
    };
  }
);

exports.debugRecomputeRegularSeasonStandings = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = String(request.data?.roomId || "").trim();
    if (!roomId) {
      throw new HttpsError("invalid-argument", "roomId is required.");
    }

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) {
      throw new HttpsError("not-found", "Room not found.");
    }

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) {
      throw new HttpsError("permission-denied", "Host only.");
    }

    const phase = getRoomPhaseLabel(room);
    if (phase === "Cup") {
      throw new HttpsError(
        "failed-precondition",
        "This repair is only for regular season rooms."
      );
    }

    const memberUids = await getRoomMemberUids(roomRef, room);

    const users = [];

    for (const mUid of memberUids.sort()) {
      const [userSnap, memberSnap, teamNameSnap] = await Promise.all([
        db.doc(`users/${mUid}`).get(),
        db.doc(`rooms/${roomId}/members/${mUid}`).get(),
        db.doc(`rooms/${roomId}/teamNames/${mUid}`).get(),
      ]);

      const profile = userSnap.exists ? userSnap.data() || {} : {};
      const member = memberSnap.exists ? memberSnap.data() || {} : {};
      const teamNameDoc = teamNameSnap.exists ? teamNameSnap.data() || {} : {};

      const displayName = String(
        profile.displayName ||
          profile.name ||
          member.displayName ||
          member.name ||
          mUid
      ).trim();

      const teamName = String(teamNameDoc.teamName || member.teamName || "").trim();

      users.push({
        userId: String(mUid),
        uid: String(mUid),
        displayName,
        name: teamName ? `${displayName} — ${teamName}` : displayName,
      });
    }

    const standings = await recomputeRegularSeasonStandings({
      roomId,
      users,
    });

    const standingsSnap = await db.doc(`rooms/${roomId}/standings/current`).get();

    return {
      ok: true,
      roomId,
      userCount: users.length,
      standingsCount: standings.length,
      standingsDoc: standingsSnap.exists ? standingsSnap.data() || null : null,
      standings,
    };
  }
);

exports.debugForceRunCup = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    const phase = getRoomPhaseLabel(room);

    if (phase !== "Cup") {
      throw new HttpsError("failed-precondition", "Room is not in Cup phase.");
    }

    const apiKey = APIFOOTBALL_KEY.value();
    const nowMs = Date.now();

    await setCompetitionState(
      roomRef,
      {
        weekStatus: "scheduled",
        isDone: false,
        nextPollAtMs: null,
        nextCupPollAtMs: null,
      },
      {
        roomData: room,
        nowMs,
      }
    );

    // Clear false Cup podium/final snapshot before re-arming.
    await db.doc(`rooms/${roomId}/finalResults/current`).delete().catch(() => {});

    await db.doc(`rooms/${roomId}/cup/current`).set(
      {
        status: "scheduled",
        completed: false,
        completedAtMs: FieldValue.delete(),
        updatedAtMs: nowMs,
        lastManualDebugAtMs: nowMs,
        lastError: FieldValue.delete(),
        lastErrorAtMs: FieldValue.delete(),

        currentWindowId: null,
        currentWindowLabel: null,
        currentWindowFixtureIds: [],
        currentWindowFixtures: [],
        currentWindowStartAtMs: null,
        currentWindowEndAtMs: null,

        windowPointsByUid: {},
        creditedFixtures: {},
        breakdownByUserId: {},
        livePointsByUid: {},
        liveBreakdownByUserId: {},
        projectedTotalsByUid: {},
        projectedIncludesLivePoints: false,

      },
      { merge: true }
    );
    
    await runCupEngine({
      db,
      roomId,
      room: {
        ...room,
        competitionState: {
          ...(getCompetitionState(room) || {}),
          weekStatus: "scheduled",
          isDone: false,
        },
      },
      nowMs,
      forceRun: true,
      apiKey,
      apiFootballGet,
      getFixtureStatusMap,
      getFixturePlayersStatsMapCached,
    });

    const [cupSnap, freshRoomSnap] = await Promise.all([
      db.doc(`rooms/${roomId}/cup/current`).get(),
      roomRef.get(),
    ]);

    return {
      ok: true,
      message: "Cup sync ran successfully.",
      cup: cupSnap.exists ? cupSnap.data() : null,
      competitionState: freshRoomSnap.exists
        ? getCompetitionState(freshRoomSnap.data() || {})
        : null,
    };
  }
);

exports.debugComputeGlobalShadowRegularRoom = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = String(request.data?.roomId || "").trim();
    const weekIndexRaw = request.data?.weekIndex;

    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    const phase = getRoomPhaseLabel(room);
    if (phase === "Cup") {
      throw new HttpsError("failed-precondition", "Room is Cup phase. Use the Cup shadow test.");
    }

    const pipelineMode = getGlobalPipelineMode(room);
    const liveFixtureCacheEnabled =
      isGlobalLiveFixtureCacheEnabled(room) ||
      pipelineMode === "shadow" ||
      pipelineMode === "global";

    if (!liveFixtureCacheEnabled) {
      throw new HttpsError(
        "failed-precondition",
        "Room does not have global live fixture cache enabled."
      );
    }

    const result = await computeGlobalRegularShadowResults({
      db,
      roomId,
      weekIndex: weekIndexRaw,
      nowMs: Date.now(),
    });

    const diffValues = Object.values(result.diffsByUid || {}).map((value) =>
      Math.abs(Number(value || 0))
    );
    const maxAbsDiff = diffValues.length ? Math.max(...diffValues) : 0;

    return {
      ok: true,
      roomId,
      weekIndex: result.weekIndex,
      seasonKey: result.seasonKey,
      fixtureCount: Array.isArray(result.fixtureIds) ? result.fixtureIds.length : 0,
      missingFixtureCount: Array.isArray(result.missingFixtureIds)
        ? result.missingFixtureIds.length
        : 0,
      userCount: Number(result.userCount || 0),
      maxAbsDiff,
      diffsByUid: result.diffsByUid || {},
      globalTotalsByUid: result.globalTotalsByUid || {},
      legacyTotalsByUid: result.legacyTotalsByUid || {},
      fixtureCoverage: result.fixtureCoverage || [],
      playerMismatches: result.playerMismatches || [],
      statMismatches: result.statMismatches || [],
      compareScope: "current-regular-week",
      source: "global-live-fixtures",
    };
  }
);

exports.debugComputeGlobalShadowCupRoom = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = String(request.data?.roomId || "").trim();
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    const phase = getRoomPhaseLabel(room);
    if (phase !== "Cup") {
      throw new HttpsError("failed-precondition", "Room is not in Cup phase.");
    }

    const pipelineMode = getGlobalPipelineMode(room);
    const liveFixtureCacheEnabled =
      isGlobalLiveFixtureCacheEnabled(room) ||
      pipelineMode === "shadow" ||
      pipelineMode === "global";

    if (!liveFixtureCacheEnabled) {
      throw new HttpsError(
        "failed-precondition",
        "Room does not have global live fixture cache enabled."
      );
    }

    const result = await computeGlobalCupShadowResults({
      db,
      roomId,
      nowMs: Date.now(),
    });

    const diffValues = Object.values(result.diffsByUid || {}).map((value) => Math.abs(Number(value || 0)));
    const maxAbsDiff = diffValues.length ? Math.max(...diffValues) : 0;

    return {
      ok: true,
      roomId,
      seasonKey: result.seasonKey,
      fixtureCount: Array.isArray(result.fixtureIds) ? result.fixtureIds.length : 0,
      missingFixtureCount: Array.isArray(result.missingFixtureIds) ? result.missingFixtureIds.length : 0,
      userCount: Number(result.userCount || 0),
      maxAbsDiff,
      diffsByUid: result.diffsByUid || {},
    };
  }
);

exports.repairCompetitionStateFields = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
    if (!ADMIN_UIDS.has(uid)) {
      throw new HttpsError("permission-denied", "Admin only.");
    }

    const nowMs = Date.now();
    const roomsSnap = await db.collection("rooms").get();

    let scanned = 0;
    let repaired = 0;
    let deletedFlatFields = 0;

    for (const roomDoc of roomsSnap.docs) {
      scanned += 1;

      const room = roomDoc.data() || {};
      const { competitionState, badFlatKeys } = buildCompetitionStateRepairData(room, nowMs);
      const needsRepair =
        badFlatKeys.length > 0 ||
        !room.competitionState ||
        room?.competitionState?.phaseLable !== undefined;

      if (!needsRepair) continue;

      await roomDoc.ref.set(
        {
          competitionState,
          repairedCompetitionStateAtMs: nowMs,
          repairedCompetitionStateAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (badFlatKeys.length) {
        deletedFlatFields += await deleteBadFlatCompetitionStateFields(roomDoc.ref, badFlatKeys);
      }

      repaired += 1;
    }

    return {
      ok: true,
      scanned,
      repaired,
      deletedFlatFields,
    };
  }
);


exports.debugForceFinalizeSeason = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    const currentIdx = room.currentWeekIndex;

    // 1. Force finalize the current active week so it can move to history
    if (currentIdx) {
      await db.doc(`rooms/${roomId}/weeks/${currentIdx}`).set(
        { status: "final", finalizedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      await db.doc(`rooms/${roomId}/weekResults/${currentIdx}`).set(
        { status: "final" },
        { merge: true }
      );
    }

    // 2. Build final podium from standings
    const standSnap = await db.doc(`rooms/${roomId}/standings/current`).get();
    const standings = standSnap.exists ? (standSnap.data()?.standings || []) : [];
    const top3 = top3FromStandings(standings);

    const finalRef = db.doc(`rooms/${roomId}/finalResults/current`);
    await finalRef.set(
      {
        roomId,
        computedAt: admin.firestore.FieldValue.serverTimestamp(),
        computedAtMs: Date.now(),
        championUserId: top3?.[0]?.userId || null,
        top3,
        standingsSnapshot: standings,
        preview: true,
      },
      { merge: true }
    );

    // 3. Mark the room complete and clear current week so UI switches to post-season
    await roomRef.set(
      { seasonPhase: "COMPLETE", currentWeekIndex: null },
      { merge: true }
    );

    return { ok: true, top3Count: top3.length };
  }
);

exports.debugClearFinalResults = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const roomSnap = await db.doc(`rooms/${roomId}`).get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    await db.doc(`rooms/${roomId}/finalResults/current`).delete();
    return { ok: true };
  }
);

exports.debugSyncTotalRounds = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = request.data?.roomId;
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    const competition = room.competition || {};
    const apiKey = APIFOOTBALL_KEY.value();

    const totalRounds = await fetchTotalRoundsFromApi(competition, apiKey);
    if (!totalRounds) throw new HttpsError("failed-precondition", "Could not determine total rounds.");

    await roomRef.set({ "competitionMeta.totalRounds": totalRounds }, { merge: true });
    return { ok: true, totalRounds };
  }
);

exports.repairWeekFixtures = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    // 1. Inputs (Pass these when you call the function)
    const roomId = request.data.roomId;   // e.g. "YCMC3A"
    const weekIndex = request.data.weekIndex; // e.g. 1

    if (!roomId || !weekIndex) return { error: "Missing roomId or weekIndex" };

    // 2. Get the Week Data to find dates
    const weekRef = db.doc(`rooms/${roomId}/weeks/${weekIndex}`);
    const weekSnap = await weekRef.get();
    if (!weekSnap.exists) return { error: "Week not found" };
    
    const week = weekSnap.data();
    const competition = week.competition || { league: 2, season: 2025 }; // Default to UCL/2025 if missing
    
    // Convert timestamps to API Date Format (YYYY-MM-DD)
    // We expand the window slightly (-1 day, +1 day) to ensure we don't miss kickoff times due to timezone
    const startObj = new Date(week.startAtMs - 86400000); 
    const endObj = new Date(week.endAtMs + 86400000); 
    
    const fromStr = startObj.toISOString().split('T')[0];
    const toStr = endObj.toISOString().split('T')[0];

    console.log(`FETCHING fixtures for League ${competition.league} | ${fromStr} to ${toStr}`);
    const timezone = week?.competition?.timezone || "America/Los_Angeles";

    // 3. Call API to get ALL games in this window
    const apiKey = APIFOOTBALL_KEY.value();
    const res = await apiFootballGet("fixtures", {
      league: competition.league,
      season: competition.season,
      from: fromStr,
      to: toStr,
      timezone,
    }, apiKey);

    const games = res.response || [];
    console.log(`FOUND ${games.length} games.`);

    if (games.length === 0) return { success: false, message: "No games found in API for these dates." };

    // 4. Save ALL these games to the database
    // We save both the list of objects (fixtures) and the list of IDs (fixtureIds)
        const fixtures = (games || [])
      .map((m) => {
        const id = m?.fixture?.id;
        const kickoffMs =
          m?.fixture?.timestamp ? Number(m.fixture.timestamp) * 1000 : Date.parse(m?.fixture?.date);
        return {
          id: id ? String(id) : null,
          kickoffMs,
          round: m?.league?.round || null,
        };
      })
      .filter((f) => f.id && Number.isFinite(f.kickoffMs))
      .sort((a, b) => a.kickoffMs - b.kickoffMs);

    //const fixtureIds = fixtures.map((f) => f.id);
    const fixtureIds = fixtures.map((f) => String(f.id));
await weekRef.set(
      {
        fixtures,          // ✅ shape your compute expects
        fixtureIds,
        fixturesRaw: games // optional: keep full API objects for UI/debug
      },
      { merge: true }
    );


    return { 
      success: true, 
      message: `Updated Week ${weekIndex} with ${games.length} fixtures.`,
      teams: games.map(g => `${g.teams.home.name} vs ${g.teams.away.name}`)
    };
  }
);

exports.pollGlobalSeasonLiveFixtures = onSchedule(
  { schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async () => {
    const apiKey = APIFOOTBALL_KEY.value();
    const nowMs = Date.now();
    const seasonTargets = await collectActiveSeasonFixtureTargets();            //Temp for debuging -------------------------------------------------------------
        console.log("[pollGlobalSeasonLiveFixtures] summary", {
      seasonTargets: seasonTargets.length,
      nowMs,
    });

    for (const seasonTarget of seasonTargets) {
      try {
        const result = await pollGlobalSeasonLiveFixturesOnce({
          seasonTarget,
          apiKey,
          nowMs,
        });

        console.log(
          `[pollGlobalSeasonLiveFixtures] season=${seasonTarget.seasonKey} fixtures=${result.fixtureCount} payloads=${result.payloadCount}`
        );
      } catch (e) {
        console.error(
          `[pollGlobalSeasonLiveFixtures] Failed season=${seasonTarget?.seasonKey || "unknown"}`,
          e
        );
      }
    }
  }
);

const TOURNAMENT_PRE_MS = 20 * 60 * 1000;          // wake 20 min before kickoff
const TOURNAMENT_ACTIVE_POLL_MS = 60 * 1000;       // every minute during active window
const TOURNAMENT_UNKNOWN_RECHECK_MS = 60 * 60 * 1000; // check hourly if no kickoff time
const TOURNAMENT_POST_MS = 3 * 60 * 60 * 1000;     // keep your current 3h post-kickoff
const TOURNAMENT_SWEEP_MS = 60 * 60 * 1000;        // hourly safety sweep

function kickoffMsFromFixture(g) {
  return Number(
    g?.kickoffMs ??
    g?.fixtureId?.kickoffMs ??
    (g?.fixture?.timestamp ? g.fixture.timestamp * 1000 : NaN)
  );
}

function getFutureKickoffs(fixtures, nowMs) {
  return (Array.isArray(fixtures) ? fixtures : [])
    .map(kickoffMsFromFixture)
    .filter(Number.isFinite)
    .filter((ms) => ms > nowMs)
    .sort((a, b) => a - b);
}

function getNextPollAtMsFromFixtures(fixtures, nowMs) {
  const futureKickoffs = getFutureKickoffs(fixtures, nowMs);
  const nextKickoffMs = futureKickoffs[0] || null;

  // No kickoff known yet, or API did not give times. Recheck once per hour.
  if (!nextKickoffMs) {
    return {
      nextKickoffMs: null,
      nextPollAtMs: nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
      reason: "no-known-kickoff",
    };
  }

  return {
    nextKickoffMs,
    nextPollAtMs: Math.max(nowMs + TOURNAMENT_ACTIVE_POLL_MS, nextKickoffMs - TOURNAMENT_PRE_MS),
    reason: "next-kickoff-minus-20min",
  };
}

async function upsertTournamentPollTask({
  roomId,
  phase = "",
  nextPollAtMs,
  reason = "",
  nowMs = Date.now(),
}) {
  if (!roomId) return;

  const safeNextPollAtMs = Number.isFinite(Number(nextPollAtMs))
    ? Number(nextPollAtMs)
    : nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS;

  await db.doc(`tournamentPollQueue/${roomId}`).set(
    {
      roomId,
      phase,
      nextPollAtMs: safeNextPollAtMs,
      reason,
      updatedAtMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function deleteTournamentPollTask(roomId) {
  if (!roomId) return;
  await db.doc(`tournamentPollQueue/${roomId}`).delete().catch(() => {});
}

// Runs only once per hour, so old rooms/missing queue docs can self-heal.
async function shouldRunTournamentSweep(nowMs) {
  const sweepRef = db.doc("system/tournamentPollSweep");
  let shouldSweep = false;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(sweepRef);
    const lastSweepAtMs = snap.exists ? Number(snap.data()?.lastSweepAtMs || 0) : 0;

    if (!lastSweepAtMs || nowMs - lastSweepAtMs >= TOURNAMENT_SWEEP_MS) {
      shouldSweep = true;
      tx.set(
        sweepRef,
        {
          lastSweepAtMs: nowMs,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  });

  return shouldSweep;
}

exports.pollLiveTournamentWeeks = onSchedule(
  { schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async () => {
    const apiKey = APIFOOTBALL_KEY.value();
    const nowMs = Date.now();

    const runSweep = await shouldRunTournamentSweep(nowMs);

    const [
      queueSnap,
      activeSnap,
      sweepSnap,
    ] = await Promise.all([
      // ✅ Main cheap path: only rooms whose wake time is due.
      db.collection("tournamentPollQueue")
        .where("nextPollAtMs", "<=", nowMs)
        .limit(50)
        .get(),

      // ✅ Live/resolving rooms stay watched.
      db.collection("rooms")
        .where("competitionState.weekStatus", "in", ["live", "resolving"])
        .get(),

      // ✅ Hourly safety check for scheduled rooms without queue/missing kickoff.
      runSweep
        ? db.collection("rooms")
            .where("competitionState.weekStatus", "==", "scheduled")
            .get()
        : Promise.resolve({ docs: [], size: 0 }),
    ]);

    const roomDocsById = new Map();

    // Queue tasks: read the room doc only when its wake time is due.
    for (const taskDoc of queueSnap.docs) {
      const task = taskDoc.data() || {};
      const roomId = String(task.roomId || taskDoc.id || "");
      if (!roomId) continue;

      const roomSnap = await db.doc(`rooms/${roomId}`).get();
      if (!roomSnap.exists) {
        await taskDoc.ref.delete().catch(() => {});
        continue;
      }

      roomDocsById.set(roomId, roomSnap);
    }

    // Active rooms: usually very small number.
    for (const roomDoc of activeSnap.docs) {
      roomDocsById.set(roomDoc.id, roomDoc);
    }

    // Hourly sweep: keeps old/missing queue rooms from being forgotten.
    for (const roomDoc of sweepSnap.docs) {
      roomDocsById.set(roomDoc.id, roomDoc);
    }

    const roomDocs = Array.from(roomDocsById.values());

    console.log("[pollLiveTournamentWeeks] summary", {
      roomsFound: roomDocs.length,
      queueDue: queueSnap.size,
      activeRooms: activeSnap.size,
      sweepRooms: sweepSnap.size || 0,
      runSweep,
      nowMs,
    });

    for (const roomDoc of roomDocs) {
      const roomId = roomDoc.id;
      const roomRef = roomDoc.ref;
      const room = roomDoc.data() || {};

      try {
        const competitionState = getCompetitionState(room);
        const weekStatus = String(competitionState?.weekStatus || "").toLowerCase();

        // If room is no longer active/scheduled, remove it from the queue.
        if (!["scheduled", "live", "resolving"].includes(weekStatus)) {
          await deleteTournamentPollTask(roomId);
          continue;
        }

        const phase = getRoomPhaseLabel(room);

        // -------------------------
        // CUP ROOMS
        // -------------------------
        if (phase === "Cup") {
          const nextCupPollAtMs = Number(competitionState?.nextCupPollAtMs || 0);

          if (Number.isFinite(nextCupPollAtMs) && nextCupPollAtMs > nowMs && !runSweep) {
            await upsertTournamentPollTask({
              roomId,
              phase,
              nextPollAtMs: nextCupPollAtMs,
              reason: "cup-next-poll",
              nowMs,
            });
            continue;
          }

          console.log("[pollLiveTournamentWeeks] running cup engine", {
            roomId,
            nextCupPollAtMs,
            nowMs,
          });

          await runCupEngine({
            db,
            roomId,
            room,
            nowMs,
            apiKey,
            apiFootballGet,
            getFixtureStatusMap,
            getFixturePlayersStatsMapCached,
          });

          // Read fresh room state because Cup engine may write nextCupPollAtMs.
          const freshRoomSnap = await roomRef.get();
          const freshRoom = freshRoomSnap.exists ? (freshRoomSnap.data() || {}) : {};
          const freshState = getCompetitionState(freshRoom);
          const freshNextCupPollAtMs = Number(freshState?.nextCupPollAtMs || 0);
          const freshWeekStatus = String(freshState?.weekStatus || "scheduled").toLowerCase();

          if (!["scheduled", "live", "resolving"].includes(freshWeekStatus)) {
            await deleteTournamentPollTask(roomId);
            continue;
          }

          await upsertTournamentPollTask({
            roomId,
            phase,
            nextPollAtMs:
              Number.isFinite(freshNextCupPollAtMs) && freshNextCupPollAtMs > nowMs
                ? freshNextCupPollAtMs
                : nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
            reason: "cup-engine-next",
            nowMs,
          });

          continue;
        }

        // -------------------------
        // REGULAR SEASON ROOMS
        // -------------------------
        let weekIndex = Number(room.currentWeekIndex);

        if (!Number.isFinite(weekIndex)) {
          const created = await ensureCurrentWeekIfMissing({ roomId, room, apiKey });

          if (!created) {
            await upsertTournamentPollTask({
              roomId,
              phase: phase || "RegularSeason",
              nextPollAtMs: nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
              reason: "no-current-week",
              nowMs,
            });
            continue;
          }

          weekIndex = Number(created);
        }

        let weekRef = db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`);
        let weekSnap = await weekRef.get();

        if (!weekSnap.exists) {
          await upsertTournamentPollTask({
            roomId,
            phase: phase || "RegularSeason",
            nextPollAtMs: nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
            reason: "week-doc-missing",
            nowMs,
          });
          continue;
        }

        let week = weekSnap.data() || {};

        // Auto-advance if current week is final.
        if (week.status === "final") {
          const nextIdx = await autoAdvanceWeekIfFinal({
            roomId,
            room,
            currentWeekIndex: weekIndex,
            apiKey,
          });

          if (!nextIdx) {
            await upsertTournamentPollTask({
              roomId,
              phase: phase || "RegularSeason",
              nextPollAtMs: nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
              reason: "final-no-next-week",
              nowMs,
            });
            continue;
          }

          weekIndex = Number(nextIdx);
          weekRef = db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`);
          weekSnap = await weekRef.get();

          if (!weekSnap.exists) {
            await upsertTournamentPollTask({
              roomId,
              phase: phase || "RegularSeason",
              nextPollAtMs: nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
              reason: "next-week-doc-missing",
              nowMs,
            });
            continue;
          }

          week = weekSnap.data() || {};
        }

        const fixtures = Array.isArray(week.fixtures) ? week.fixtures : [];

        if (!fixtures.length) {
          await upsertTournamentPollTask({
            roomId,
            phase: phase || "RegularSeason",
            nextPollAtMs: nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
            reason: "no-fixtures",
            nowMs,
          });

          await setCompetitionState(
            roomRef,
            {
              weekStatus: "scheduled",
              nextPollAtMs: nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
            },
            {
              roomData: { ...room, competitionState },
              nowMs,
            }
          );

          continue;
        }

        let shouldRun = false;

        for (const g of fixtures) {
          const koMs = kickoffMsFromFixture(g);
          if (!Number.isFinite(koMs)) continue;

          if (nowMs >= koMs - TOURNAMENT_PRE_MS && nowMs <= koMs + TOURNAMENT_POST_MS) {
            shouldRun = true;
            break;
          }
        }

        const sleepInfo = getNextPollAtMsFromFixtures(fixtures, nowMs);

        console.log("[pollLiveTournamentWeeks] time gate", {
          roomId,
          weekIndex,
          shouldRun,
          nowMs,
          fixtureCount: fixtures.length,
          nextKickoffMs: sleepInfo.nextKickoffMs,
          nextPollAtMs: sleepInfo.nextPollAtMs,
          reason: sleepInfo.reason,
        });

        if (!shouldRun) {
          const endAtMs = Number(week.endAtMs || 0);

          // If we're past the post-window and not final yet, run compute once to finalize + advance.
          if (
            week.status !== "final" &&
            Number.isFinite(endAtMs) &&
            endAtMs > 0 &&
            nowMs >= endAtMs + TOURNAMENT_POST_MS
          ) {
            console.log("[pollLiveTournamentWeeks] running finalization compute", {
              roomId,
              weekIndex,
            });

            await computeAndWriteLiveWeek({
              roomId,
              weekIndex: Number(weekIndex),
              apiKey,
            });

            await upsertTournamentPollTask({
              roomId,
              phase: phase || "RegularSeason",
              nextPollAtMs: nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
              reason: "post-finalization-recheck",
              nowMs,
            });

            continue;
          }

          // ✅ Main read saver: room goes back to sleep.
          await Promise.all([
            upsertTournamentPollTask({
              roomId,
              phase: phase || "RegularSeason",
              nextPollAtMs: sleepInfo.nextPollAtMs,
              reason: sleepInfo.reason,
              nowMs,
            }),

            setCompetitionState(
              roomRef,
              {
                weekStatus: "scheduled",
                nextPollAtMs: sleepInfo.nextPollAtMs,
                nextKickoffMs: sleepInfo.nextKickoffMs,
              },
              {
                roomData: { ...room, competitionState },
                nowMs,
              }
            ),
          ]);

          continue;
        }

        // ✅ Active window: now we actually compute.
        console.log("[pollLiveTournamentWeeks] running computeAndWriteLiveWeek", {
          roomId,
          weekIndex,
        });

        await computeAndWriteLiveWeek({
          roomId,
          weekIndex: Number(weekIndex),
          apiKey,
        });

        // Keep polling every minute while active.
        await Promise.all([
          upsertTournamentPollTask({
            roomId,
            phase: phase || "RegularSeason",
            nextPollAtMs: nowMs + TOURNAMENT_ACTIVE_POLL_MS,
            reason: "active-window",
            nowMs,
          }),

          setCompetitionState(
            roomRef,
            {
              weekStatus: "live",
              nextPollAtMs: nowMs + TOURNAMENT_ACTIVE_POLL_MS,
            },
            {
              roomData: { ...room, competitionState },
              nowMs,
            }
          ),
        ]);
      } catch (e) {
        console.error(`Error processing room ${roomId}`, e);

        // Avoid hammering a broken room every minute.
        await upsertTournamentPollTask({
          roomId,
          phase: "",
          nextPollAtMs: nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
          reason: `error: ${String(e?.message || e).slice(0, 120)}`,
          nowMs,
        });
      }
    }
  }
);

exports.scheduleDraft = onCall({ region: "us-west2" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { roomId, startAtMs } = request.data || {};
  if (!roomId || !startAtMs) {
    throw new HttpsError("invalid-argument", "Missing roomId/startAtMs.");
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = snap.data() || {};
  if (room.hostUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only host can schedule.");
  }

  const tz = getRoomTimeZone(room);
  const whenStr = formatWhen(Number(startAtMs), tz);

  const memberUids = await getRoomMemberUids(roomRef, room);

  const reminderSendAtMs = Number(startAtMs) - 10 * 60 * 1000;
  const oldReminderId = room.draftReminderId || null;
  const newReminderRef = db.collection("reminders").doc();

  const batch = db.batch();
  if (oldReminderId) batch.delete(db.doc(`reminders/${oldReminderId}`));

  batch.set(newReminderRef, {
    type: "draft_10min",
    roomId,
    sendAtMs: reminderSendAtMs,
    startAtMs: Number(startAtMs),
    recipientUids: memberUids,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    sentAt: null,
  });

  batch.update(roomRef, {
    startAt: Number(startAtMs),
    draftReminderId: newReminderRef.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();

  if (memberUids.length === 0) return { ok: true, emailsQueued: 0 };

  const recipients = await getEmailsForUids(memberUids);
  const subject = "Fútbol Fantasy — Draft Scheduled";
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <h2>Draft Scheduled</h2>
      <p><b>Host</b> has scheduled the draft for:</p>
      <p style="font-size:16px;"><b>${whenStr}</b></p>
      <p>Room: <b>${roomId}</b></p>
      <p>You’ll get a reminder 10 minutes before it starts.</p>
    </div>
  `;
  const text = `Draft Scheduled\nHost has scheduled the draft for: ${whenStr}\nRoom: ${roomId}\nReminder: 10 minutes before.`;

  const emailsQueued = await queueEmails(recipients, subject, html, text, {
    type: "draft_scheduled",
    roomId,
    startAtMs: Number(startAtMs),
  });

  return { ok: true, emailsQueued };
});

/**
 * Market scheduling: writes schedule to rooms/{roomId}/market/current
 * + NEW: creates a "market_10min" reminder doc
 */
exports.scheduleMarket = onCall({ region: "us-west2" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");

  const { roomId, scheduledAtMs, durationMs } = request.data || {};
  if (!roomId || scheduledAtMs == null || durationMs == null) {
    throw new HttpsError("invalid-argument", "Missing roomId/scheduledAtMs/durationMs.");
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = snap.data() || {};
  if (room.hostUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only host can schedule.");
  }

  // ✅ NOW it's safe to use room + the input vars
  const tz = getRoomTimeZone(room);
  const openStr = formatWhen(Number(scheduledAtMs), tz);
  const durStr = formatDuration(Number(durationMs));

  const memberUids = await getRoomMemberUids(roomRef, room);

  const marketRef = db.doc(`rooms/${roomId}/market/current`);
  const marketSnap = await marketRef.get();
  const prevMarket = marketSnap.exists ? (marketSnap.data() || {}) : {};
  const marketQueueRef = db.doc(`marketQueue/${roomId}`);

  const reminderSendAtMs = Number(scheduledAtMs) - 10 * 60 * 1000;
  const oldMarketReminderId = prevMarket.marketReminderId || null;
  const newMarketReminderRef = db.collection("reminders").doc();

  const batch = db.batch();
  if (oldMarketReminderId) batch.delete(db.doc(`reminders/${oldMarketReminderId}`));

  batch.set(newMarketReminderRef, {
    type: "market_10min",
    roomId,
    sendAtMs: reminderSendAtMs,
    scheduledAtMs: Number(scheduledAtMs),
    durationMs: Number(durationMs),
    recipientUids: memberUids,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    sentAt: null,
  });

  batch.set(
    marketRef,
    {
      roomId,
      status: "scheduled",
      scheduledAt: Number(scheduledAtMs),
      durationMs: Number(durationMs),
      openedAt: null,
      closesAt: null,
      resolvedAt: null,
      marketReminderId: newMarketReminderRef.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

    batch.set(
    marketQueueRef,
    {
      roomId,
      status: "scheduled",
      scheduledAt: Number(scheduledAtMs),
      durationMs: Number(durationMs),
      openedAt: null,
      closesAt: null,
      resolvedAt: null,
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await batch.commit();

  // Email: "Market Scheduled" (immediate)
  if (memberUids.length === 0) return { ok: true, emailsQueued: 0 };

  const recipients = await getEmailsForUids(memberUids);
  const subject = "Fútbol Fantasy — Market Scheduled";
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <h2>Market Scheduled</h2>
      <p><b>Host</b> has scheduled the market to open at:</p>
      <p style="font-size:16px;"><b>${openStr}</b></p>
      <p>It will stay open for: <b>${durStr}</b></p>
      <p>Room: <b>${roomId}</b></p>
      <p>You’ll get a reminder 10 minutes before it opens.</p>
    </div>
  `;
  const text = `Market Scheduled\nHost scheduled market open at: ${openStr}\nOpen duration: ${durStr}\nRoom: ${roomId}\nReminder: 10 minutes before.`;

  const emailsQueued = await queueEmails(recipients, subject, html, text, {
    type: "market_scheduled",
    roomId,
    scheduledAtMs: Number(scheduledAtMs),
    durationMs: Number(durationMs),
  });

  return { ok: true, emailsQueued };
});


/**
 * Runs every minute to send reminder emails that are due
 * (Draft 10-min reminders + Market 10-min reminders)
 */
exports.processReminders = onSchedule(
  { schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", region: "us-west2" },
  async () => {
    const now = Date.now();

    const snap = await db
      .collection("reminders")
      .where("sentAt", "==", null)
      .where("sendAtMs", "<=", now)
      .limit(50)
      .get();

    if (snap.empty) return;

    for (const docSnap of snap.docs) {
      const r = docSnap.data();

      const uidsRaw = Array.isArray(r.recipientUids) ? r.recipientUids : [];
      const uids = uidsRaw.map((m) => (typeof m === "string" ? m : m?.uid)).filter(Boolean);
      const recipients = await getEmailsForUids(uids);

      // --- Draft reminder ---
      if (r.type === "draft_10min") {
        const whenStr = formatWhen(r.startAtMs);

        const subject = "Fútbol Fantasy — Draft starts in 10 minutes";
        const html = `
          <div style="font-family:Arial,sans-serif;">
            <h2>Draft Reminder</h2>
            <p>The draft begins in <b>10 minutes</b>.</p>
            <p><b>Start time:</b> ${whenStr}</p>
            <p>Room: <b>${r.roomId}</b></p>
          </div>
        `;
        const text = `Draft Reminder\nThe draft begins in 10 minutes.\nStart time: ${whenStr}\nRoom: ${r.roomId}`;

        await queueEmails(recipients, subject, html, text, {
          type: "draft_10min_reminder",
          roomId: r.roomId,
          startAtMs: r.startAtMs,
        });

        await docSnap.ref.update({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
        continue;
      }

      // --- NEW: Market reminder ---
      if (r.type === "market_10min") {
        const openStr = formatWhen(r.scheduledAtMs);
        const durStr = formatDuration(Number(r.durationMs || 0));

        const subject = "Fútbol Fantasy — Market opens in 10 minutes";
        const html = `
          <div style="font-family:Arial,sans-serif;">
            <h2>Market Reminder</h2>
            <p>The market opens in <b>10 minutes</b>.</p>
            <p><b>Opens at:</b> ${openStr}</p>
            <p><b>Duration:</b> ${durStr}</p>
            <p>Room: <b>${r.roomId}</b></p>
          </div>
        `;
        const text = `Market Reminder\nThe market opens in 10 minutes.\nOpens at: ${openStr}\nDuration: ${durStr}\nRoom: ${r.roomId}`;

        await queueEmails(recipients, subject, html, text, {
          type: "market_10min_reminder",
          roomId: r.roomId,
          scheduledAtMs: r.scheduledAtMs,
          durationMs: r.durationMs,
        });

        await docSnap.ref.update({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
        continue;
      }

      // Unknown reminder type: mark as sent so it doesn't loop forever
      await docSnap.ref.update({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }
);

/**
 * Market scheduler (auto open/close)
 */
/**
 * Market scheduler (auto open/close)
 *
 * Beta-safe version:
 * - Scans rooms directly
 * - Reads rooms/{roomId}/market/current
 * - Avoids collectionGroup path issues
 */
exports.processMarketSchedule = onSchedule(
  { schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", region: "us-west2" },
  async () => {
    const now = Date.now();

    // ✅ Only read active market tasks.
    // No more scanning every room.
    const queueSnap = await db
      .collection("marketQueue")
      .where("status", "in", ["scheduled", "open", "resolving"])
      .get();

    if (queueSnap.empty) {
      console.log("[processMarketSchedule] no active market tasks");
      return;
    }

    console.log("[processMarketSchedule] active market tasks:", queueSnap.size);

    for (const taskDoc of queueSnap.docs) {
      const task = taskDoc.data() || {};
      const roomId = String(task.roomId || taskDoc.id || "");

      if (!roomId) {
        console.warn("[processMarketSchedule] queue task missing roomId", taskDoc.id);
        continue;
      }

      const marketRef = db.doc(`rooms/${roomId}/market/current`);
      const marketSnap = await marketRef.get();

      if (!marketSnap.exists) {
        console.warn("[processMarketSchedule] market doc missing, deleting queue task", {
          roomId,
          queueId: taskDoc.id,
        });

        await taskDoc.ref.delete();
        continue;
      }

      const m = marketSnap.data() || {};
      const status = String(m.status || task.status || "idle").toLowerCase();

      if (!["scheduled", "open", "resolving"].includes(status)) {
        await taskDoc.ref.delete();
        continue;
      }

      const scheduledAt = Number(m.scheduledAt ?? task.scheduledAt);
      const durationMs = Number(m.durationMs ?? task.durationMs ?? 0);
      const closesAt = Number(m.closesAt ?? task.closesAt ?? 0);

      console.log("[processMarketSchedule] market state", {
        roomId,
        status,
        scheduledAt,
        closesAt,
        now,
      });

      // 1) scheduled -> open
      if (
        status === "scheduled" &&
        Number.isFinite(scheduledAt) &&
        scheduledAt > 0 &&
        scheduledAt <= now
      ) {
        const computedClosesAt =
          durationMs > 0 ? scheduledAt + durationMs : null;

        console.log("[processMarketSchedule] opening market", {
          roomId,
          scheduledAt,
          now,
          durationMs,
          computedClosesAt,
        });

        await Promise.all([
          marketRef.set(
            {
              status: "open",
              openedAt: now,
              closesAt: computedClosesAt,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          ),

          taskDoc.ref.set(
            {
              status: "open",
              openedAt: now,
              closesAt: computedClosesAt,
              updatedAtMs: now,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          ),
        ]);

        continue;
      }

      // 2) open but missing closesAt
      if (
        status === "open" &&
        (!Number.isFinite(closesAt) || closesAt <= 0) &&
        Number.isFinite(scheduledAt) &&
        scheduledAt > 0 &&
        durationMs > 0
      ) {
        const computedClosesAt = scheduledAt + durationMs;

        console.log("[processMarketSchedule] repairing closesAt", {
          roomId,
          computedClosesAt,
        });

        await Promise.all([
          marketRef.set(
            {
              closesAt: computedClosesAt,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          ),

          taskDoc.ref.set(
            {
              closesAt: computedClosesAt,
              updatedAtMs: now,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          ),
        ]);

        continue;
      }

      // 3) open -> resolved
      if (
        status === "open" &&
        Number.isFinite(closesAt) &&
        closesAt > 0 &&
        closesAt <= now
      ) {
        console.log("[processMarketSchedule] closing/resolving market", {
          roomId,
          closesAt,
          now,
        });

        try {
          await resolveMarketForRoom(roomId, { trigger: "scheduler" });

          // ✅ Done. Remove queue task so this room is not checked anymore.
          await taskDoc.ref.delete();
        } catch (e) {
          console.error("resolveMarketForRoom failed", roomId, e);

          await Promise.all([
            marketRef.set(
              {
                status: "resolving",
                closedAt: now,
                resolvingAt: now,
                lastResolveError: String(e?.message || e),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            ),

            taskDoc.ref.set(
              {
                status: "resolving",
                closedAt: now,
                resolvingAt: now,
                lastResolveError: String(e?.message || e),
                updatedAtMs: now,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            ),
          ]);
        }

        continue;
      }

      // 4) Retry stuck resolving markets
      if (status === "resolving" && !m.resolvedAt) {
        const resolvingAt = Number(m.resolvingAt || m.closedAt || task.resolvingAt || 0);

        if (!resolvingAt || now - resolvingAt > 30 * 1000) {
          console.log("[processMarketSchedule] retrying resolving market", {
            roomId,
            resolvingAt,
            now,
          });

          try {
            await resolveMarketForRoom(roomId, { trigger: "scheduler-retry" });

            // ✅ Done. Remove queue task.
            await taskDoc.ref.delete();
          } catch (e) {
            console.error("resolveMarketForRoom retry failed", roomId, e);

            await Promise.all([
              marketRef.set(
                {
                  lastResolveError: String(e?.message || e),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              ),

              taskDoc.ref.set(
                {
                  lastResolveError: String(e?.message || e),
                  updatedAtMs: now,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              ),
            ]);
          }
        }
      }
    }
  }
);


exports.getLiveFixturesCached = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const league = Number(request.data?.league);
    const season = Number(request.data?.season);
    if (!Number.isFinite(league) || !Number.isFinite(season)) {
      throw new HttpsError("invalid-argument", "league and season are required.");
    }

    // Cache doc per competition
    const cacheId = `${league}_${season}`;
    const cacheRef = db.collection("apiCache").doc(`liveFixtures_${cacheId}`);
    const cacheSnap = await cacheRef.get();

    const now = Date.now();
    const TTL_MS = 30 * 1000; // 30s cache during live windows

    if (cacheSnap.exists) {
      const c = cacheSnap.data();
      if (c?.updatedAtMs && now - c.updatedAtMs < TTL_MS) {
        return { ok: true, cached: true, data: c.data };
      }
    }

    const apiKey = APIFOOTBALL_KEY.value();
    // API-Football exposes livescore/live fixtures endpoints in docs/plans
    const data = await apiFootballGet("fixtures", { live: "all", league, season }, apiKey);

    await cacheRef.set(
      { updatedAtMs: now, data },
      { merge: true }
    );

    return { ok: true, cached: false, data };
  }
);

//Market Server side
async function resolveMarketForRoom(roomId, { trigger = "scheduler" } = {}) {
  const roomRef = db.doc(`rooms/${roomId}`);
  const marketRef = roomRef.collection("market").doc("current");
  const now = Date.now();
  const lockId = `${trigger}-${now}-${Math.random().toString(16).slice(2)}`;

  // A) Lock + sanity checks
  const locked = await db.runTransaction(async (tx) => {
    const mSnap = await tx.get(marketRef);
    if (!mSnap.exists) return { ok: false, reason: "no-market-doc" };

    const m = mSnap.data() || {};
    const status = m.status || "idle";
    const closesAt = Number(m.closesAt || 0);

    // Allow scheduler retry OR manual button to recover stuck resolving markets.
    const canRecoverResolving = ["scheduler-retry", "manual", "manual-retry"].includes(trigger);

    if (status === "resolving" && !canRecoverResolving) {
      return { ok: false, reason: "already-resolving" };
    }

    if (status === "scheduled") return { ok: false, reason: "market-not-open-yet" };

    // Only resolve after close time (or if already closed)
    if (status === "open" && closesAt && closesAt > now) {
      return { ok: false, reason: "not-closed-yet" };
    }

    tx.set(
      marketRef,
      {
        status: "resolving",
        resolveLock: lockId,
        resolvingAt: now,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true };
  });

  if (!locked.ok) return locked;
  // Needed for display names and safe room context.
  // Without this, memberNameByUid can crash with "room is not defined"
  // after the market has already been set to resolving.
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) {
    await marketRef.set(
      {
        status: "open",
        lastResolveError: "Room not found during market resolve.",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: false, reason: "room-not-found" };
  }

  const room = roomSnap.data() || {};


  function inferPickOwnerUid(d) {
    const v =
      d?.userId ??
      d?.uid ??
      d?.ownerUid ??
      d?.ownerId ??
      d?.ownedBy ??
      d?.managerUid ??
      d?.pickedByUid ??
      d?.pickedBy ??
      d?.owner?.uid ??
      d?.owner?.id;

    if (!v) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object") return v.uid || v.id || null;
    return String(v);
  }

  function inferPickPlayerId(d) {
    const v =
      d?.playerId ??
      d?.pid ??
      d?.apiPlayerId ??
      d?.player?.id ??
      d?.player?.playerId;

    return v == null ? null : String(v);
  }

  function inferInterestOwnerUid(d, docId) {
    const v =
      d?.uid ??
      d?.userId ??
      d?.ownerUid ??
      d?.ownerId ??
      d?.managerUid ??
      docId;

    return v == null ? null : String(v);
  }

  const memberNameByUid = new Map(
    (Array.isArray(room?.members) ? room.members : [])
      .filter((m) => m?.uid)
      .map((m) => [String(m.uid), String(m.displayName || m.uid)])
  );

  // B) Load required data
  const [interestSnap, picksSnap, lineupsSnap, standingsByUid] = await Promise.all([
    roomRef.collection("marketInterest").get(),
    roomRef.collection("picks").get(),
    roomRef.collection("lineups").get(),
    loadStandingsByUid(roomRef), // ✅ THIS IS WHERE standingsByUid goes
  ]);

  // C) Index picks: uid+playerId -> pickDocId, and roster set for validation
  const pickDocIdByUidPlayer = new Map();
  const pickDataByUidPlayer = new Map();
  const rosterByUid = new Map(); // uid -> Set(playerId)
  const ownerByPlayerId = new Map(); // playerId -> uid

  picksSnap.forEach((doc) => {
    const d = doc.data() || {};
    const uid = inferPickOwnerUid(d);
    const playerId = inferPickPlayerId(d);
    if (!uid || !playerId) return;

    pickDocIdByUidPlayer.set(`${uid}:${playerId}`, doc.id);
    pickDataByUidPlayer.set(`${uid}:${playerId}`, { id: doc.id, ...d });
    ownerByPlayerId.set(playerId, uid);

    if (!rosterByUid.has(uid)) rosterByUid.set(uid, new Set());
    rosterByUid.get(uid).add(playerId);
  });

  // D) Index lineups
  const lineupByUid = new Map();
  lineupsSnap.forEach((doc) => lineupByUid.set(String(doc.id), doc.data() || {}));

  // E) Collect all requests (one doc per user, with choices[])
  const requests = [];
  interestSnap.forEach((doc) => {
    const d = doc.data() || {};
    const uid = inferInterestOwnerUid(d, doc.id);
    const choices = Array.isArray(d.choices) ? d.choices : [];
    const updatedAtMs =
      typeof d.updatedAtMs === "number"
        ? d.updatedAtMs
        : d.updatedAt?.toMillis?.() ?? 0;

    for (const c of choices) {
      const wantId = c?.wantId != null ? String(c.wantId) : null;
      const swapOutId = c?.swapOutId != null ? String(c.swapOutId) : null;
      requests.push({ uid, wantId, swapOutId, updatedAtMs });
    }
  });

  const uniqueWantIds = Array.from(
    new Set(requests.map((r) => r.wantId).filter(Boolean))
  );
  const wantPlayerDocs = await Promise.all(
    uniqueWantIds.map(async (wantId) => {
      const snap = await roomRef.collection("players").doc(String(wantId)).get();
      return [String(wantId), snap.exists ? (snap.data() || null) : null];
    })
  );
  const playerById = new Map(wantPlayerDocs);

  function buildDecision(r, status, reason) {
    return {
      uid: r.uid,
      wantId: r.wantId,
      swapOutId: r.swapOutId,
      status,
      reason,
    };
  }

  // F) Validate every request first so all submissions get a result doc.
  const byWant = new Map();
  const decisions = []; // { wantId, uid, swapOutId, status, reason }

  for (const r of requests) {
    const owned = r.uid ? rosterByUid.get(r.uid) : null;

    if (!r.uid || !r.wantId || !r.swapOutId) {
      decisions.push(buildDecision(r, "lost", "MISSING_FIELDS"));
      continue;
    }

    if (!owned || !owned.has(r.swapOutId)) {
      decisions.push(buildDecision(r, "lost", "SWAPOUT_NOT_OWNED"));
      continue;
    }

    if (owned.has(r.wantId)) {
      decisions.push(buildDecision(r, "lost", "SAME_PLAYER"));
      continue;
    }

    if (!playerById.has(r.wantId) || !playerById.get(r.wantId)) {
      decisions.push(buildDecision(r, "lost", "WANT_NOT_IN_POOL"));
      continue;
    }

    const currentOwner = ownerByPlayerId.get(r.wantId);
    if (currentOwner && currentOwner !== r.uid) {
      decisions.push(buildDecision(r, "lost", "WANT_NOT_AVAILABLE"));
      continue;
    }

    if (!byWant.has(r.wantId)) byWant.set(r.wantId, []);
    byWant.get(r.wantId).push(r);
  }

  // G) Award by priority and record explicit losers for the same target.
  for (const [wantId, list] of byWant.entries()) {
    list.sort((a, b) => {
      const pa = getPriority(standingsByUid, a.uid);
      const pb = getPriority(standingsByUid, b.uid);
      const cmp = comparePriority(pa, pb);
      if (cmp !== 0) return cmp;
      if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs - b.updatedAtMs;
      return String(a.uid).localeCompare(String(b.uid));
    });

    const winner = list[0];
    decisions.push(buildDecision(winner, "won", "AWARDED"));

    for (let i = 1; i < list.length; i++) {
      decisions.push(buildDecision(list[i], "lost", "WANT_NOT_AVAILABLE"));
    }
  }

  function entryIdOf(entry) {
    if (entry == null) return "";
    if (typeof entry === "string") return String(entry);
    return String(
      entry.id ??
      entry.playerId ??
      entry.apiPlayerId ??
      entry.name ??
      ""
    );
  }

  function buildLineupPlayerEntry(playerId, playerMeta) {
    const rawPos = String(playerMeta?.position || "MID").toUpperCase();
    return {
      id: String(playerId),
      name: String(playerMeta?.name || "Unknown"),
      position: rawPos === "ATT" ? "FWD" : rawPos,
      teamId: playerMeta?.teamId ?? null,
      apiPlayerId: playerMeta?.id ?? playerId,
    };
  }

  // G) Apply changes + write results + cleanup
  const batch = db.batch();
  const wonCount = decisions.filter((d) => d.status === "won").length;

  // Write marketResults
  for (const dec of decisions) {
    const wantPlayer = dec.wantId ? playerById.get(String(dec.wantId)) : null;
    const releasedPick = dec.uid && dec.swapOutId
      ? pickDataByUidPlayer.get(`${dec.uid}:${dec.swapOutId}`)
      : null;
    const normalizedReason =
      dec.reason || (dec.status === "won" ? "AWARDED" : "WANT_NOT_AVAILABLE");
    const resRef = roomRef.collection("marketResults").doc();
    batch.set(resRef, {
      uid: dec.uid,
      displayName: memberNameByUid.get(String(dec.uid || "")) || dec.uid || "Unknown",
      wantId: dec.wantId,
      swapOutId: dec.swapOutId,
      gotId: dec.status === "won" ? dec.wantId : null,
      releasedId: dec.swapOutId || null,
      releasedName:
        releasedPick?.playerName ||
        releasedPick?.name ||
        dec.swapOutId ||
        null,
      gotName:
        dec.status === "won"
          ? wantPlayer?.name || dec.wantId || null
          : null,
      result: dec.status,
      ok: dec.status === "won",
      reason: normalizedReason,
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedAtMs: now,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (dec.status !== "won") continue;

    // Update pick: swapOut -> want
    const pickId = pickDocIdByUidPlayer.get(`${dec.uid}:${dec.swapOutId}`);
    if (pickId) {
      const pickPatch = {
        playerId: dec.wantId,
        updatedAt: FieldValue.serverTimestamp(),
        source: "market",
      };

      if (wantPlayer) {
        if (wantPlayer.name || wantPlayer.playerName) {
          pickPatch.playerName = wantPlayer.name || wantPlayer.playerName;
          pickPatch.name = wantPlayer.name || wantPlayer.playerName;
        }
        if (wantPlayer.position) pickPatch.position = wantPlayer.position;
        if (wantPlayer.teamName) pickPatch.teamName = wantPlayer.teamName;
        if (wantPlayer.teamId) pickPatch.teamId = wantPlayer.teamId;
        if (wantPlayer.teamLogo) pickPatch.teamLogo = wantPlayer.teamLogo;
        if (wantPlayer.nationality) pickPatch.nationality = wantPlayer.nationality;
        pickPatch.provider = wantPlayer.provider || "api-football";
      }

      batch.update(roomRef.collection("picks").doc(pickId), pickPatch);
    }

    // Update lineup starters/bench if needed
    const lineup = lineupByUid.get(dec.uid);
    if (lineup) {
      const lineupPatch = {
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (Array.isArray(lineup.starters)) {
        const starters = lineup.starters.map(String);
        const idx = starters.indexOf(String(dec.swapOutId));
        if (idx >= 0) {
          starters[idx] = String(dec.wantId);
          lineupPatch.starters = starters;
        }
      }

      if (Array.isArray(lineup.bench)) {
        const bench = lineup.bench.map(String);
        const idx = bench.indexOf(String(dec.swapOutId));
        if (idx >= 0) {
          bench[idx] = String(dec.wantId);
          lineupPatch.bench = bench;
        }
      }

      if (Array.isArray(lineup.startingXI) && wantPlayer) {
        const replacement = buildLineupPlayerEntry(dec.wantId, wantPlayer);
        lineupPatch.startingXI = lineup.startingXI.map((entry) =>
          entryIdOf(entry) === String(dec.swapOutId) ? replacement : entry
        );
      }

      if (Array.isArray(lineup.benchXI) && wantPlayer) {
        const replacement = buildLineupPlayerEntry(dec.wantId, wantPlayer);
        lineupPatch.benchXI = lineup.benchXI.map((entry) =>
          entryIdOf(entry) === String(dec.swapOutId) ? replacement : entry
        );
      }

      batch.set(
        roomRef.collection("lineups").doc(dec.uid),
        lineupPatch,
        { merge: true }
      );
    }
  }

  // Cleanup interests (so next market starts fresh)
  interestSnap.forEach((doc) => batch.delete(doc.ref));

  // Mark market resolved
  batch.set(
    marketRef,
    {
      status: "resolved",
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedAtMs: now,
      lastResolveSummary: {
        interestDocs: interestSnap.size,
        requestCount: requests.length,
        decisionCount: decisions.length,
        wonCount,
        resolvedAtMs: now,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log("[resolveMarketForRoom] committing market resolution", {
    roomId,
    trigger,
    interestDocs: interestSnap.size,
    requestCount: requests.length,
    decisionCount: decisions.length,
    wonCount,
  });
  await batch.commit();
  return { ok: true, resolvedCount: decisions.length };
}

exports.resolveMarketNow = onCall({ region: "us-west2" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const roomId = req.data?.roomId;
  if (!roomId) throw new HttpsError("invalid-argument", "roomId required.");
  return await resolveMarketForRoom(roomId, { trigger: "manual" });
});
