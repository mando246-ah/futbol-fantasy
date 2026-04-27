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

    // Firestore batch limit is 500 ops; stay under it comfortably
    let batch = db.batch();
    let ops = 0;

    function commitIfNeeded(force = false) {
      if (ops >= 450 || force) {
        const b = batch;
        batch = db.batch();
        ops = 0;
        return b.commit();
      }
      return Promise.resolve();
    }

    const seen = new Set();

    function pickBestStats(statsArr, preferredTeamId) {
      const arr = Array.isArray(statsArr) ? statsArr : [];
      if (!preferredTeamId) return arr[0] || null;
      const teamIdStr = String(preferredTeamId);

      return (
        arr.find((s) => String(s?.team?.id || "") === teamIdStr && String(s?.league?.id || "") === String(league)) ||
        arr.find((s) => String(s?.team?.id || "") === teamIdStr) ||
        arr[0] ||
        null
      );
    }

    async function upsertPlayerFromApiItem(it, preferredTeamId) {
      const p = it?.player;
      const playerId = p?.id;
      if (!playerId) return;

      const pid = String(playerId);
      if (seen.has(pid)) return;
      seen.add(pid);

      const st0 = pickBestStats(it?.statistics, preferredTeamId);

      const positionRaw = st0?.games?.position || st0?.games?.pos || "";
      const position = toPos(positionRaw);

      const teamId = st0?.team?.id ?? preferredTeamId ?? null;
      const teamIdStr = teamId ? String(teamId) : null;

      // If we're in fixture-date mode, only keep players whose club is in the slate.
      if (fixtureDate && teamIdStr && !teamMeta.has(teamIdStr)) return;

      const teamName = st0?.team?.name || (teamIdStr ? teamMeta.get(teamIdStr)?.name : "") || "";
      const teamLogo = st0?.team?.logo || (teamIdStr ? teamMeta.get(teamIdStr)?.logo : "") || "";

      const full = `${p?.firstname || ""} ${p?.lastname || ""}`.trim();
      const displayName = full || p?.name || "Unknown";

      const docRef = db.doc(`rooms/${roomId}/players/${pid}`);
      batch.set(
        docRef,
        {
          id: pid,
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
        },
        { merge: true }
      );

      ops += 1;
      written += 1;

      if (ops >= 450) await commitIfNeeded(true);
    }

    if (!fixtureDate) {
      // --- Original mode: pull players by league/season (paged) ---
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages && page <= maxPages && written < maxPlayers) {
        const res = await apiFootballGet("players", { league, season, page }, apiKey);
        totalPages = Number(res?.paging?.total ?? 1) || 1;
        pagesFetched += 1;

        const items = Array.isArray(res?.response) ? res.response : [];
        for (const it of items) {
          if(written >= maxPlayers) break;
          await upsertPlayerFromApiItem(it, null);
        }

        page += 1;
      }
    } else {
      // --- Fixture-date mode: pull players only for the clubs playing that day ---
      for (const teamIdStr of teamMeta.keys()) {
        let page = 1;
        if(written >= maxPlayers) break;
        let totalPages = 1;

        while (page <= totalPages && page <= maxPagesPerTeam && written < maxPlayers) {
          const res = await apiFootballGet("players", { team: teamIdStr, season, page }, apiKey);
          totalPages = Number(res?.paging?.total ?? 1) || 1;
          pagesFetched += 1;

          const items = Array.isArray(res?.response) ? res.response : [];
          for (const it of items) {
            if(written >= maxPlayers) break;
            await upsertPlayerFromApiItem(it, teamIdStr);
          }

          page += 1;
        }
      }
    }

    await commitIfNeeded(true);

    // Store competition choice + seeding filter on room
    const competition = {
      provider: "api-football",
      league,
      season,
      timezone,
    };

    // Ask API: what round are we in?
    let window = null;
    try {
      window = await fetchNextRoundWindow(competition, { fallbackDate: fixtureDate });
    } catch (e) {
      console.warn(`[seedPlayersFromCompetition] fetchNextRoundWindow failed`, e);
    }

    const roundLabel = window?.roundLabel || null;
    const phaseLabel = detectPhaseFromRoundLabel(roundLabel);

    // Only RegularSeason needs competitionMeta.totalRounds
    if (phaseLabel === "RegularSeason") {
      await ensureRoomTotalRounds({ roomId, room, competition, apiKey });
    }

    await roomRef.set(
      {
        competition,
        seedFilter: fixtureDate ? { fixtureDate } : admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),

        competitionState: {
          phaseLabel: phaseLabel,
          currentLabel: roundLabel,
          isDone: false,
          weekStatus: "scheduled",
        }
        
      },
      { merge: true }
    );

    return {
      ok: true,
      league,
      season,
      fixtureDate,
      timezone,
      pagesFetched,
      written,
      maxPlayers,
      hitCap: written >= maxPlayers,
      teamCount: fixtureDate ? teamMeta.size : null,

      // helpful for debugging in the client
      phaseLabel,
      roundLabel,
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

    await db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`).set(weekDoc, { merge: true });
    await roomRef.set({ currentWeekIndex: weekIndex, competition }, { merge: true });

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

      // fixture-based conceded (correct for DEF/MID too)
      let teamConceded = rawConceded;
      const homeTeamId = fixtureMeta?.homeTeamId ?? null;
      const awayTeamId = fixtureMeta?.awayTeamId ?? null;
      const goalsHome = toNum(fixtureMeta?.goalsHome);
      const goalsAway = toNum(fixtureMeta?.goalsAway);

      if (teamId && homeTeamId && awayTeamId) {
        if (teamId === homeTeamId) teamConceded = goalsAway;
        else if (teamId === awayTeamId) teamConceded = goalsHome;
      }

      // Use teamConceded for clean sheet + conceded scoring
      const goalsConceded = teamConceded;          // store real conceded
      const cleanSheet = minutes > 0 && teamConceded === 0;

      const ownGoals = 0; 

      out[String(pid)] = { 
        teamName,
        opponentName,
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

      const homeTeamId = f?.teams?.home?.id ?? null;
      const awayTeamId = f?.teams?.away?.id ?? null;
      const goalsHome = toNum(f?.goals?.home);
      const goalsAway = toNum(f?.goals?.away);

      out[fixtureId] = short;

      const ref = db.doc(`apiCache/fixtureStatus_${fixtureId}`);
      writes.push(
        ref.set(
          { short, updatedAtMs: now, homeTeamId, awayTeamId, goalsHome, goalsAway },
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
        isLive: false,
        fixtureStatus: null,
        fixtureId: null,
        kickoffMs: null,
      };
            
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

        isLive: Boolean(prev.isLive) || inPlay,
        fixtureStatus: prev.fixtureStatus || short || null,
        fixtureId: prev.fixtureId || fid,
        kickoffMs: prev.kickoffMs || ko || null,
      };
    }
  }

  const haveAnyStats = Object.keys(aggStatsByPlayerId).length > 0;
  if (!forceRecompute && !haveAnyStats && prevHadPoints && !anyInPlay) {
    // Keep previous points; only update status/timing
    await weekResultsRef.set(
      {
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
    await db.doc(`rooms/${roomId}`).set({ currentWeekIndex: nextExisting }, { merge: true });
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

  // Move the room forward ✅
  await db.doc(`rooms/${roomId}`).set(
    { currentWeekIndex: nextWeekIndex, competition, advancedAtMs: nowMs },
    { merge: true }
  );

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
  await db.doc(`rooms/${roomId}`).set({ currentWeekIndex: weekIndex, competition }, { merge: true });

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

async function fetchAggregatedStats(fixtureIds, apiKey) {
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

    const phase =
      room?.competitionState?.phaseLabel ??
      room?.["competitionState.phaseLabel"] ??
      room?.competitionState?.phaseLable ??
      room?.["competitionState.phaseLable"] ??
      null;

    if (phase !== "Cup") {
      throw new HttpsError("failed-precondition", "Room is not in Cup phase.");
    }

    const apiKey = APIFOOTBALL_KEY.value();
    const nowMs = Date.now();

    await roomRef.set(
      {
        "competitionState.weekStatus": "scheduled",
        "competitionState.updatedAtMs": nowMs,
        "competitionState.isDone": false,
      },
      { merge: true }
    );

    await db.doc(`rooms/${roomId}/cup/current`).set(
      {
        updatedAtMs: nowMs,
        lastManualDebugAtMs: nowMs,
        lastError: FieldValue.delete(),
        lastErrorAtMs: FieldValue.delete(),
      },
      { merge: true }
    );
    await runCupEngine({
      db,
      roomId,
      room: {
        ...room,
        competitionState: {
          ...(room.competitionState || {}),
          weekStatus: "scheduled",
          isDone: false,
        },
      },
      nowMs,
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
        ? (freshRoomSnap.data()?.competitionState || null)
        : null,
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

exports.pollLiveTournamentWeeks = onSchedule(
  { schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", region: "us-west2", secrets: [APIFOOTBALL_KEY] },
  async () => {
    const apiKey = APIFOOTBALL_KEY.value();
    const nowMs = Date.now();

    // Get all rooms (you can add filters later if you store an "active" flag)
    const roomsSnap = await db.collection("rooms")
    .where("competitionState.weekStatus", "in", ["scheduled", "live", "resolving"])
    .get();

    for (const roomDoc of roomsSnap.docs) {
      const roomId = roomDoc.id;
      const room = roomDoc.data() || {};

      try {
        // Check if this room is in a tournament phase (e.g. "Cup") that requires special handling
        const phase =
          room?.competitionState?.phaseLabel ??
          room?.["competitionState.phaseLabel"] ??
          room?.competitionState?.phaseLable ??
          room?.["competitionState.phaseLable"] ??
          null;

        if (phase === "Cup") {
          await db.doc(`rooms/${roomId}`).set(
            { "competitionState.lastCupPollAtMs": nowMs },
            { merge: true }
          );

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

          continue;
        }

        // For regular season rooms, we run the normal live week logic
        let weekIndex = Number(room.currentWeekIndex);
        if (!Number.isFinite(weekIndex)) {
          const created = await ensureCurrentWeekIfMissing({ roomId, room, apiKey });
          if (!created) continue;
          weekIndex = Number(created);
        }

        let weekRef = db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`);
        let weekSnap = await weekRef.get();
        if (!weekSnap.exists) continue;
        let week = weekSnap.data() || {};

        // ✅ AUTO-ADVANCE: if current is FINAL, move to next week
        if (week.status === "final") {
          const nextIdx = await autoAdvanceWeekIfFinal({ roomId, room, currentWeekIndex: weekIndex, apiKey });
          if (!nextIdx) continue;

          weekIndex = Number(nextIdx);
          weekRef = db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`);
          weekSnap = await weekRef.get();
          if (!weekSnap.exists) continue;
          week = weekSnap.data() || {};
        }

        const fixtures = Array.isArray(week.fixtures) ? week.fixtures : [];
        if (!fixtures.length) continue;

        // Smart time gate based on kickoff times (no API call needed to decide)
        const PRE_MS = 20 * 60 * 1000;        // 20 min pre-kickoff
        const POST_MS = 3 * 60 * 60 * 1000;   // 3 hrs post-kickoff

        let shouldRun = false;
        for (const g of fixtures) {
          const koMs = Number(g?.kickoffMs ?? (g?.fixture?.timestamp ? g.fixture.timestamp * 1000 : NaN));
          if (!Number.isFinite(koMs)) continue;
          if (nowMs >= koMs - PRE_MS && nowMs <= koMs + POST_MS) {
            shouldRun = true;
            break;
          }
        }

        if (!shouldRun) {
          const endAtMs = Number(week.endAtMs || 0);
          const POST_MS = 3 * 60 * 60 * 1000;

          // If we're past the post-window and not final yet, run compute once to finalize + advance
          if (week.status !== "final" && Number.isFinite(endAtMs) && nowMs >= endAtMs + POST_MS) {
            await computeAndWriteLiveWeek({ roomId, weekIndex: Number(weekIndex), apiKey });
          }
          continue;
        }

        await computeAndWriteLiveWeek({ roomId, weekIndex: Number(weekIndex), apiKey });
      } catch (e) {
        console.error(`Error processing room ${roomId}`, e);
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
exports.processMarketSchedule = onSchedule(
  { schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", region: "us-west2" },
  async () => {
    const now = Date.now();
    const activeMarketsSnap = await db.collectionGroup("market")
      .where("status", "in", ["scheduled", "open", "resolving"])
      .get();

    for (const marketSnap of activeMarketsSnap.docs) {
      const m = marketSnap.data() || {};
      const marketRef = db.doc(`rooms/${roomId}/market/current`);
      const roomId = marketRef.parent.parent.id; 
      const status = m.status || "idle";

      if (!marketSnap.exists) continue;

      const scheduledAt = Number(m.scheduledAt);
      const durationMs = Number(m.durationMs || 0);
      const closesAt = Number(m.closesAt);

      // 1) scheduled -> open
      if (status === "scheduled" && Number.isFinite(scheduledAt) && scheduledAt <= now) {
        // IMPORTANT: compute closesAt from scheduledAt (not "now"), so cron delay doesn't extend market
        const computedClosesAt = durationMs ? scheduledAt + durationMs : null;

        await marketRef.set(
          {
            status: "open",
            openedAt: now,
            closesAt: computedClosesAt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        continue;
      }

      // 2) If open but missing closesAt (safety), compute it
      if (
        status === "open" &&
        (!Number.isFinite(closesAt) || closesAt <= 0) &&
        Number.isFinite(scheduledAt) &&
        durationMs > 0
      ) {
        await marketRef.set(
          {
            closesAt: scheduledAt + durationMs,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      // 3) open -> resolving (UI should show "Resolving…" immediately) + then resolve
      if (status === "open" && Number.isFinite(closesAt) && closesAt <= now) {
        // Set resolving FIRST so the UI doesn't sit at 0 looking stuck
        await marketRef.set(
          {
            status: "resolving",
            closedAt: now,
            resolvingAt: now,
            scheduledAt: null, // prevent reopening
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // Now actually resolve (server-side). If it fails, we keep "resolving" and retry next minute.
        try {
          await resolveMarketForRoom(roomId, { trigger: "scheduler" });
        } catch (e) {
          console.error("resolveMarketForRoom failed", roomId, e);
        }
        continue;
      }

      // 4) Retry any stuck resolving markets (in case of transient errors)
      if (status === "resolving" && !m.resolvedAtMs && !m.resolvedAt) {
        const resolvingAt = Number(m.resolvingAt || m.closedAt || 0);

        // Wait at least 30s before retrying to avoid thrashing
        if (!resolvingAt || now - resolvingAt > 30 * 1000) {
          try {
            await resolveMarketForRoom(roomId, { trigger: "scheduler-retry" });
          } catch (e) {
            console.error("resolveMarketForRoom retry failed", roomId, e);
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

    if (status === "resolved" || m.resolvedAt) return { ok: false, reason: "already-resolved" };
    if (status === "resolving") return { ok: false, reason: "already-resolving" };

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

  // B) Load required data
  const [interestSnap, picksSnap, lineupsSnap, standingsByUid] = await Promise.all([
    roomRef.collection("marketInterest").get(),
    roomRef.collection("picks").get(),
    roomRef.collection("lineups").get(),
    loadStandingsByUid(roomRef), // ✅ THIS IS WHERE standingsByUid goes
  ]);

  // C) Index picks: uid+playerId -> pickDocId, and roster set for validation
  const pickDocIdByUidPlayer = new Map();
  const rosterByUid = new Map(); // uid -> Set(playerId)

  picksSnap.forEach((doc) => {
    const d = doc.data() || {};
    const uid = String(d.userId ?? d.uid ?? "");
    const playerId = String(d.playerId ?? "");
    if (!uid || !playerId) return;

    pickDocIdByUidPlayer.set(`${uid}:${playerId}`, doc.id);

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
    const uid = String(d.uid ?? doc.id);
    const choices = Array.isArray(d.choices) ? d.choices : [];
    const updatedAtMs =
      typeof d.updatedAtMs === "number"
        ? d.updatedAtMs
        : d.updatedAt?.toMillis?.() ?? 0;

    for (const c of choices) {
      const wantId = c?.wantId != null ? String(c.wantId) : null;
      const swapOutId = c?.swapOutId != null ? String(c.swapOutId) : null;
      if (!wantId || !swapOutId) continue;

      requests.push({ uid, wantId, swapOutId, updatedAtMs });
    }
  });

  // F) Group by wantId and pick winners by priority (lowest matchPts, tie lowest totalFantasy, tie earliest submit)
  const byWant = new Map();
  for (const r of requests) {
    if (!byWant.has(r.wantId)) byWant.set(r.wantId, []);
    byWant.get(r.wantId).push(r);
  }

  const decisions = []; // {wantId, uid, swapOutId, status, reason}
  for (const [wantId, list] of byWant.entries()) {
    // Validate each candidate
    const candidates = list.filter((r) => {
      const owned = rosterByUid.get(r.uid);
      if (!owned || !owned.has(r.swapOutId)) return false; // must own swapOut
      if (owned.has(wantId)) return false; // already owns want
      return true;
    });

    if (candidates.length === 0) {
      // No one eligible for this wantId
      continue;
    }

    candidates.sort((a, b) => {
      const pa = getPriority(standingsByUid, a.uid);
      const pb = getPriority(standingsByUid, b.uid);
      const cmp = comparePriority(pa, pb);
      if (cmp !== 0) return cmp;
      if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs - b.updatedAtMs;
      return String(a.uid).localeCompare(String(b.uid));
    });

    const winner = candidates[0];
    decisions.push({ wantId, uid: winner.uid, swapOutId: winner.swapOutId, status: "won" });

    // record losers (optional, helps UI reasons)
    for (let i = 1; i < candidates.length; i++) {
      decisions.push({ wantId, uid: candidates[i].uid, swapOutId: candidates[i].swapOutId, status: "lost" });
    }
  }

  // G) Apply changes + write results + cleanup
  const batch = db.batch();

  // Write marketResults
  for (const dec of decisions) {
    const resRef = roomRef.collection("marketResults").doc();
    batch.set(resRef, {
      uid: dec.uid,
      wantId: dec.wantId,
      swapOutId: dec.swapOutId,
      gotId: dec.status === "won" ? dec.wantId : null,
      result: dec.status,
      resolvedAtMs: now,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (dec.status !== "won") continue;

    // Update pick: swapOut -> want
    const pickId = pickDocIdByUidPlayer.get(`${dec.uid}:${dec.swapOutId}`);
    if (pickId) {
      batch.update(roomRef.collection("picks").doc(pickId), {
        playerId: dec.wantId,
        updatedAt: FieldValue.serverTimestamp(),
        source: "market",
      });
    }

    // Update lineup starters if needed
    const lineup = lineupByUid.get(dec.uid);
    if (lineup && Array.isArray(lineup.starters)) {
      const starters = lineup.starters.map(String);
      const idx = starters.indexOf(String(dec.swapOutId));
      if (idx >= 0) {
        starters[idx] = String(dec.wantId);
        batch.set(roomRef.collection("lineups").doc(dec.uid), { starters, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    }
  }

  // Cleanup interests (so next market starts fresh)
  interestSnap.forEach((doc) => batch.delete(doc.ref));

  // Mark market resolved
  batch.set(
    marketRef,
    {
      status: "resolved",
      resolvedAtMs: now,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await batch.commit();
  return { ok: true, resolvedCount: decisions.length };
}

exports.resolveMarketNow = onCall({ region: "us-west2" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const roomId = req.data?.roomId;
  if (!roomId) throw new HttpsError("invalid-argument", "roomId required.");
  return await resolveMarketForRoom(roomId, { trigger: "manual" });
});
