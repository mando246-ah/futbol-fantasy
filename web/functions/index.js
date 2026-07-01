const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger"); // optional but nice

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const { scorePlayer, scoreTeam, SCORING } = require("./shared/scoringCore");
const { runCupEngine } = require("./cup/cupEngine");
const { createCupGlobalEngine } = require("./cup/cupGlobalEngine");
const { pickCupWindow } = require("./cup/cupWindows");
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
  isGlobalRoomAggregatorEnabled,
  normalizeGlobalPipelineMode,
} = require("./shared/globalPipeline");
const {
  estimateDocBytes,
  getSeasonFixtureSummaryRef,
  getSeasonFixturesCollectionRef,
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
const {
  WORLD_CUP_COMPETITION_KEY,
  WORLD_CUP_COMPETITION_TYPE,
  WORLD_CUP_GROUP_ENGINE,
  WORLD_CUP_GROUP_PHASE,
  WORLD_CUP_KNOCKOUT_ENGINE,
  WORLD_CUP_KNOCKOUT_PHASE,
  buildWorldCupSeasonKey,
  buildWorldCupRoomMode,
  getWorldCupQualifiedTeamsDocPath,
  isWorldCupCompetition,
} = require("./worldCup/worldCupMode");
const {
  loadWorldCupGroupDailyWindows,
  writeWorldCupDailyWindowsForRoom,
} = require("./worldCup/worldCupDailyWindows");
const {
  runWorldCupGroupEngine,
  recomputeWorldCupGroupDayFromSavedFixtures,
  summarizeWorldCupRepairDiffs,
} = require("./worldCup/worldCupGroupEngine");
const {
  findWorldCupDailyLockViolation,
  formatWorldCupDailyLockDate,
  getActiveWorldCupDailyLocks,
  isWorldCupDailyRoom: isWorldCupDailyLineupRoom,
} = require("./worldCup/worldCupDailyLineupLocks");
const {
  buildWorldCupGroupSeasonTargetForRoom,
} = require("./worldCup/worldCupGlobalTargets");
const {
  WORLD_CUP_GLOBAL_PLAYER_POOL_MIN,
  WORLD_CUP_GLOBAL_PLAYER_POOL_STALE_MS,
  collectWorldCupTeamsFromDailyWindows,
  ensureFreshWorldCupGlobalPlayerPool,
  fetchWorldCupTeamPlayerPool,
} = require("./worldCup/worldCupPlayerPool");

const { defineSecret } = require("firebase-functions/params");

const APIFOOTBALL_KEY = defineSecret("APIFOOTBALL_KEY");
const SUPPORT_EMAIL_USER = defineSecret("SUPPORT_EMAIL_USER");
const SUPPORT_EMAIL_PASS = defineSecret("SUPPORT_EMAIL_PASS");
const SUPPORT_TO_EMAIL = defineSecret("SUPPORT_TO_EMAIL");

const nodemailer = require("nodemailer");
const REGULAR_FINAL_HOLD_MS = 24 * 60 * 60 * 1000;
const CUP_GLOBAL_BOOTSTRAP_PRE_MS = 20 * 60 * 1000;
const CUP_GLOBAL_DISCOVERY_RETRY_MS = 60 * 60 * 1000;
const CUP_GLOBAL_DRAFT_RECHECK_MS = 10 * 60 * 1000;
const CUP_GLOBAL_ACTIVE_RECHECK_MS = 60 * 1000;
const CUP_GLOBAL_CACHE_REFRESH_DEDUPE_MS = 45 * 1000;
const API_FOOTBALL_RUNTIME_PATH = "system/apiFootballRuntime";
const API_FOOTBALL_MIN_COOLDOWN_MS = 60 * 60 * 1000;
const API_FOOTBALL_SCHEDULED_RETRY_MS = 60 * 60 * 1000;
const API_FOOTBALL_COOLDOWN_CODE = "api-football-cooldown";
const API_FOOTBALL_COOLDOWN_MESSAGE =
  "API-Football Safe Mode is enabled or quota cooldown is active. Try again after reset.";
const FIXTURE_PLAYERS_REFRESH_LOCK_MS = 90 * 1000;
const FIXTURE_PLAYERS_LOCK_WAIT_MS = 1200;
const FIXTURE_STATUS_REFRESH_LOCK_MS = 90 * 1000;
const FIXTURE_STATUS_LOCK_WAIT_MS = 1000;
const FIXTURE_STATUS_LIVE_MIN_TTL_MS = 60 * 1000;
const FIXTURE_STATUS_STALE_NS_MIN_TTL_MS = 75 * 1000;
const FIXTURE_STATUS_SCHEDULED_MIN_TTL_MS = 5 * 60 * 1000;
const FIXTURE_STATUS_FINAL_MIN_TTL_MS = 5 * 60 * 1000;
const GLOBAL_SEASON_REFRESH_DEDUPE_MS = 55 * 1000;
const GLOBAL_SEASON_REFRESH_LOCK_MS = 90 * 1000;
const cupGlobalRefreshResultByKey = new Map();

exports.trimRoomChatMessages = onDocumentCreated(
  {
    document: "rooms/{roomId}/chatMessages/{messageId}",
    region: "us-west2",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const roomId = String(event.params?.roomId || "").trim();
    if (!roomId) return;

    const messagesRef = db.collection(`rooms/${roomId}/chatMessages`);
    const latestSnap = await messagesRef
      .orderBy("createdAtMs", "desc")
      .limit(31)
      .get();
    const expiredDocs = latestSnap.docs.slice(30);

    if (!expiredDocs.length) return;

    const mediaPaths = expiredDocs
      .map((messageDoc) => String(messageDoc.data()?.mediaPath || "").trim())
      .filter(Boolean);
    const batch = db.batch();

    for (const messageDoc of expiredDocs) {
      batch.delete(messageDoc.ref);
    }

    await batch.commit();

    await Promise.all(
      mediaPaths.map(async (mediaPath) => {
        try {
          await admin.storage().bucket().file(mediaPath).delete({
            ignoreNotFound: true,
          });
        } catch (error) {
          console.warn("[trimRoomChatMessages] media cleanup failed", {
            roomId,
            mediaPath,
            message: error?.message,
          });
        }
      })
    );

    console.log("[trimRoomChatMessages] removed expired room chat messages", {
      roomId,
      deletedMessageCount: expiredDocs.length,
      deletedMediaCount: mediaPaths.length,
    });
  }
);

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

function seededTieValue(seed, wantId, uid) {
  return hashToUint32(`${seed}:${wantId}:${uid}`);
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
const ADMIN_UIDS = new Set(["WspA06q2KlQr7KUq2PP58FMyIJk2"]);

// Owner-only tools. Never expose to regular users.
function requireAdminUid(uid) {
  if (!uid || !ADMIN_UIDS.has(String(uid))) {
    throw new HttpsError("permission-denied", "Owner only.");
  }
}

const CLIENT_ERROR_SEVERITIES = new Set([
  "info",
  "warning",
  "error",
  "critical",
]);
const CLIENT_ERROR_SENSITIVE_KEY =
  /password|token|accesstoken|idtoken|apikey|secret|authorization/i;

function redactClientErrorString(value, maxLength = 2000) {
  const text = String(value || "")
    .replace(
      /(password|access[_-]?token|id[_-]?token|api[_-]?key|secret|authorization)(\s*[:=]\s*)([^\s,;}"']+)/gi,
      "$1$2[REDACTED]"
    )
    .replace(/bearer\s+[a-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
  return text.slice(0, maxLength);
}

function sanitizeClientErrorValue(value, depth = 0) {
  if (depth > 4) return "[TRUNCATED]";
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "string") {
    return redactClientErrorString(value, 2000);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 25)
      .map((item) => sanitizeClientErrorValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const clean = {};
    for (const [rawKey, rawValue] of Object.entries(value).slice(0, 50)) {
      const key = redactClientErrorString(rawKey, 120);
      clean[key] = CLIENT_ERROR_SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : sanitizeClientErrorValue(rawValue, depth + 1);
    }
    return clean;
  }
  return redactClientErrorString(value, 500);
}

exports.reportClientErrorCallable = onCall(
  { region: "us-west2", timeoutSeconds: 30, memory: "256MiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }

    try {
      const data = request.data || {};
      const token = request.auth?.token || {};
      const requestedSeverity = String(data.severity || "error").toLowerCase();
      const severity = CLIENT_ERROR_SEVERITIES.has(requestedSeverity)
        ? requestedSeverity
        : "error";
      const nowMs = Date.now();

      const payload = {
        source: "client",
        severity,
        area: redactClientErrorString(data.area, 120),
        action: redactClientErrorString(data.action, 160),
        roomId: redactClientErrorString(data.roomId, 160),
        uid: String(uid),
        email: redactClientErrorString(token.email, 320),
        displayName: redactClientErrorString(
          token.name || token.displayName || "",
          200
        ),
        message: redactClientErrorString(data.message, 2000),
        code: redactClientErrorString(data.code, 160),
        stack: redactClientErrorString(data.stack, 8000),
        userMessage: redactClientErrorString(data.userMessage, 1000),
        url: redactClientErrorString(data.url, 2000),
        path: redactClientErrorString(data.path, 1000),
        userAgent: redactClientErrorString(data.userAgent, 1000),
        extra: sanitizeClientErrorValue(
          data.extra && typeof data.extra === "object" ? data.extra : {}
        ),
        status: "new",
        createdAtMs: nowMs,
        createdAt: FieldValue.serverTimestamp(),
      };

      const reportRef = await db.collection("adminErrors").add(payload);
      return { ok: true, reportId: reportRef.id };
    } catch (error) {
      console.error("[reportClientErrorCallable] failed", {
        uid,
        code: error?.code,
        message: error?.message,
      });
      return { ok: false };
    }
  }
);

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

function roomRequiresEvenManagers(room = {}) {
  const competitionState = getCompetitionState(room);
  const phase = String(
    competitionState?.phaseLabel ||
      room?.competitionState?.phaseLabel ||
      room?.phaseLabel ||
      ""
  );

  const isWorldCupGroup =
    room?.engineType === "worldCupDaily" ||
    room?.worldCup?.engineType === "worldCupDaily" ||
    room?.worldCupPhase === WORLD_CUP_GROUP_PHASE ||
    room?.worldCupPhase === "group" ||
    room?.worldCupPhase === "WorldCupGroup" ||
    room?.worldCup?.phase === WORLD_CUP_GROUP_PHASE ||
    room?.worldCup?.phase === "group" ||
    phase === "WorldCupGroup";

  const isCup = phase === "Cup" && !isWorldCupGroup;
  return !isCup && !isWorldCupGroup;
}

function requireDraftManagerCount(memberUids = [], room = {}) {
  const managerCount = Array.from(new Set((memberUids || []).map(String).filter(Boolean))).length;

  if (managerCount < 2) {
    throw new HttpsError(
      "failed-precondition",
      "Need at least 2 managers to start the draft."
    );
  }

  if (roomRequiresEvenManagers(room) && managerCount % 2 !== 0) {
    throw new HttpsError(
      "failed-precondition",
      "Regular Season head-to-head rooms need an even number of managers."
    );
  }

  return managerCount;
}


//API

function normalizeApiFootballRuntime(data = {}, nowMs = Date.now()) {
  const cooldownUntilMs = Number(data?.cooldownUntilMs || 0);
  const safeMode = data?.safeMode === true;
  const cooldownActive =
    Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs;

  return {
    ...data,
    safeMode,
    safeModeActive: safeMode,
    cooldownUntilMs:
      Number.isFinite(cooldownUntilMs) && cooldownUntilMs > 0
        ? cooldownUntilMs
        : 0,
    cooldownActive,
    blocked: safeMode || cooldownActive,
    cooldownRemainingMs: cooldownActive
      ? Math.max(0, cooldownUntilMs - nowMs)
      : 0,
    nowMs,
  };
}

async function readApiFootballRuntimeStatus(nowMs = Date.now()) {
  try {
    const snap = await db.doc(API_FOOTBALL_RUNTIME_PATH).get();
    const data = snap.exists ? snap.data() || {} : {};
    return normalizeApiFootballRuntime(data, nowMs);
  } catch (error) {
    console.warn("[apiFootballGet] runtime guard read failed; allowing API call", {
      message: error?.message || String(error),
    });
    return normalizeApiFootballRuntime(
      {
        runtimeReadError: String(error?.message || error),
      },
      nowMs
    );
  }
}

function createApiFootballCooldownError({
  reason = "api-football-cooldown",
  cooldownUntilMs = 0,
  safeMode = false,
  path = "",
  status = null,
} = {}) {
  const err = new HttpsError(
    "resource-exhausted",
    API_FOOTBALL_COOLDOWN_MESSAGE,
    {
      apiFootballCode: API_FOOTBALL_COOLDOWN_CODE,
      reason,
      cooldownUntilMs:
        Number.isFinite(Number(cooldownUntilMs)) && Number(cooldownUntilMs) > 0
          ? Number(cooldownUntilMs)
          : null,
      safeMode: Boolean(safeMode),
      path: String(path || ""),
      status,
    }
  );

  err.isApiFootballCooldown = true;
  err.apiFootballCode = API_FOOTBALL_COOLDOWN_CODE;
  err.cooldownUntilMs =
    Number.isFinite(Number(cooldownUntilMs)) && Number(cooldownUntilMs) > 0
      ? Number(cooldownUntilMs)
      : null;
  err.safeMode = Boolean(safeMode);
  err.reason = reason;
  return err;
}

function isApiFootballCooldownError(err) {
  return (
    err?.isApiFootballCooldown === true ||
    err?.apiFootballCode === API_FOOTBALL_COOLDOWN_CODE ||
    err?.details?.apiFootballCode === API_FOOTBALL_COOLDOWN_CODE ||
    err?.customData?.details?.apiFootballCode === API_FOOTBALL_COOLDOWN_CODE
  );
}

function apiFootballCooldownReason(err) {
  const details = err?.details || err?.customData?.details || {};
  if (details.safeMode === true || err?.safeMode === true) {
    return "api-football-safe-mode";
  }
  return details.reason || err?.reason || "api-football-cooldown";
}

function getApiFootballCooldownRetryAtMs(err, nowMs = Date.now()) {
  const details = err?.details || err?.customData?.details || {};
  const cooldownUntilMs = Number(
    err?.cooldownUntilMs || details?.cooldownUntilMs || 0
  );

  return Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs
    ? cooldownUntilMs
    : nowMs + API_FOOTBALL_SCHEDULED_RETRY_MS;
}

function isApiFootballQuotaOrRateLimit(status, text = "") {
  const body = String(text || "").toLowerCase();
  return (
    Number(status) === 429 ||
    body.includes("quota") ||
    body.includes("rate limit") ||
    body.includes("ratelimit") ||
    body.includes("too many requests") ||
    body.includes("limit reached") ||
    body.includes("limit exceeded")
  );
}

function apiFootballJsonQuotaText(json = {}) {
  const candidates = [];
  const errors = json?.errors;

  if (typeof errors === "string") {
    candidates.push(errors);
  } else if (Array.isArray(errors)) {
    candidates.push(...errors.map((value) => String(value || "")));
  } else if (errors && typeof errors === "object") {
    for (const [key, value] of Object.entries(errors)) {
      candidates.push(key, String(value || ""));
    }
  }

  candidates.push(
    json?.message,
    json?.error,
    json?.reason,
    json?.description
  );

  return candidates.filter(Boolean).join(" ").toLowerCase();
}

function apiFootballJsonIndicatesQuotaOrRateLimit(json = {}) {
  const body = apiFootballJsonQuotaText(json);
  if (!body) return false;

  return (
    body.includes("quota") ||
    body.includes("rate limit") ||
    body.includes("ratelimit") ||
    body.includes("too many requests") ||
    body.includes("daily limit") ||
    body.includes("plan limit") ||
    body.includes("limit reached") ||
    body.includes("limit exceeded")
  );
}

async function assertApiFootballRuntimeAllowsCall(path, nowMs = Date.now()) {
  const runtime = await readApiFootballRuntimeStatus(nowMs);

  if (runtime.safeMode === true) {
    throw createApiFootballCooldownError({
      reason: "api-football-safe-mode",
      cooldownUntilMs: runtime.cooldownUntilMs || 0,
      safeMode: true,
      path,
    });
  }

  if (runtime.cooldownActive === true) {
    throw createApiFootballCooldownError({
      reason: runtime.cooldownReason || "api-football-cooldown",
      cooldownUntilMs: runtime.cooldownUntilMs,
      safeMode: false,
      path,
    });
  }

  return runtime;
}

async function writeApiFootballCooldown({
  path = "",
  status = null,
  text = "",
  nowMs = Date.now(),
} = {}) {
  const cooldownUntilMs = nowMs + API_FOOTBALL_MIN_COOLDOWN_MS;
  const cooldownReason =
    Number(status) === 429
      ? "api-football-rate-limit"
      : "api-football-quota";

  await db.doc(API_FOOTBALL_RUNTIME_PATH).set(
    {
      cooldownUntilMs,
      cooldownReason,
      lastCooldownStatus: status,
      lastCooldownPath: String(path || ""),
      lastCooldownBody: String(text || "").slice(0, 500),
      updatedAtMs: nowMs,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  ).catch((error) => {
    console.warn("[apiFootballGet] failed to write cooldown state", {
      path,
      status,
      message: error?.message || String(error),
    });
  });

  return { cooldownUntilMs, cooldownReason };
}

function apiFootballLogPayload(path, params = {}, meta = {}, extra = {}) {
  return {
    path: String(path || ""),
    params: params || {},
    source: String(meta?.source || meta?.caller || ""),
    roomId: meta?.roomId ? String(meta.roomId) : "",
    fixtureId: meta?.fixtureId ? String(meta.fixtureId) : "",
    fixtureIds: Array.isArray(meta?.fixtureIds)
      ? meta.fixtureIds.map((id) => String(id || "")).filter(Boolean)
      : undefined,
    forceRefresh: Boolean(meta?.forceRefresh),
    cacheHit: Boolean(meta?.cacheHit),
    cacheMiss: Boolean(meta?.cacheMiss),
    lockAcquired: Boolean(meta?.lockAcquired),
    lockSkipped: Boolean(meta?.lockSkipped),
    safeModeBlocked: Boolean(extra?.safeModeBlocked),
    status: extra?.status ?? null,
  };
}

async function apiFootballGet(path, params, apiKey, meta = {}) {
  const url = new URL(`https://v3.football.api-sports.io/${path}`);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  try {
    await assertApiFootballRuntimeAllowsCall(path);
  } catch (error) {
    console.warn(
      "[apiFootballGet] blocked by runtime guard",
      apiFootballLogPayload(path, params, meta, { safeModeBlocked: true })
    );
    throw error;
  }

  console.log(
    "[apiFootballGet] request",
    apiFootballLogPayload(path, params, meta, { safeModeBlocked: false })
  );

  const res = await fetch(url.toString(), {
    headers: { "x-apisports-key": apiKey },
  });

  if (!res.ok) {
    const text = await res.text();
    if (isApiFootballQuotaOrRateLimit(res.status, text)) {
      const { cooldownUntilMs, cooldownReason } = await writeApiFootballCooldown({
        path,
        status: res.status,
        text,
      });

      throw createApiFootballCooldownError({
        reason: cooldownReason,
        cooldownUntilMs,
        safeMode: false,
        path,
        status: res.status,
      });
    }

    throw new Error(`API-Football ${res.status}: ${text}`);
  }

    // Some endpoints return 204 No Content (e.g., fixtures/players before kickoff)
  if (res.status === 204) return { response: [] };

  const json = await res.json();
  if (apiFootballJsonIndicatesQuotaOrRateLimit(json)) {
    const text = apiFootballJsonQuotaText(json).slice(0, 500);
    const { cooldownUntilMs, cooldownReason } = await writeApiFootballCooldown({
      path,
      status: res.status,
      text,
    });

    throw createApiFootballCooldownError({
      reason: cooldownReason,
      cooldownUntilMs,
      safeMode: false,
      path,
      status: res.status,
    });
  }

  return json;
}

function isHost(room, uid) {
  return !!room?.hostUid && room.hostUid === uid;
}

const DEFAULT_DRAFT_TURN_SECONDS = 60;

function draftMemberUidOf(member) {
  return String(
    typeof member === "string"
      ? member
      : member?.uid ?? member?.userId ?? member?.id ?? ""
  ).trim();
}

function getDraftRoundMode(room = {}) {
  return room?.draftRoundMode === "fixed" ? "fixed" : "snake";
}

function getDraftOrderMode(room = {}) {
  return room?.draftOrderMode === "custom" ? "custom" : "random";
}

function getDraftTurnSecondsValue(value, fallback = DEFAULT_DRAFT_TURN_SECONDS) {
  const n = Number(value);
  const fallbackNumber = Number(fallback);
  const safeFallback =
    Number.isFinite(fallbackNumber) && fallbackNumber > 0
      ? fallbackNumber
      : DEFAULT_DRAFT_TURN_SECONDS;
  const safe = Number.isFinite(n) && n > 0 ? n : safeFallback;
  return Math.max(10, Math.min(300, safe));
}

function getDraftTotalRounds(room = {}) {
  const n = Number(room?.totalRounds);
  return Number.isFinite(n) && n > 0 ? n : 16;
}

function getPickerUidForTurn(baseOrder, turnIndex, roundMode = "snake") {
  const order = (Array.isArray(baseOrder) ? baseOrder : [])
    .map(draftMemberUidOf)
    .filter(Boolean);
  const n = order.length;
  if (!n) return null;

  const ti = Math.max(0, Math.floor(Number(turnIndex || 0)));
  const roundIndex = Math.floor(ti / n);
  const withinRound = ti % n;
  if (roundMode === "fixed") return order[withinRound] || null;

  const orderIndex = roundIndex % 2 === 0 ? withinRound : n - 1 - withinRound;
  return order[orderIndex] || null;
}

function shuffleDraftOrder(memberUids = []) {
  const arr = Array.from(new Set((memberUids || []).map(String).filter(Boolean)));
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isDraftCompleteRoom(room = {}, memberUids = []) {
  const status = String(room?.status || "").toLowerCase();
  const draftStatus = String(room?.draftStatus || "").toLowerCase();
  if (
    room?.draftComplete === true ||
    room?.draftCompleted === true ||
    status === "draft_complete" ||
    draftStatus === "complete"
  ) {
    return true;
  }

  const orderCount =
    (Array.isArray(room?.draftOrder) && room.draftOrder.length) ||
    (Array.isArray(memberUids) && memberUids.length) ||
    0;
  const maxPicks = orderCount * getDraftTotalRounds(room);
  const turnIndex = Number(room?.turnIndex || 0);
  return maxPicks > 0 && Number.isFinite(turnIndex) && turnIndex >= maxPicks;
}

function validateCustomDraftOrderForMembers(customDraftOrder, memberUids = []) {
  const current = Array.from(new Set((memberUids || []).map(String).filter(Boolean)));
  const currentSet = new Set(current);
  const raw = Array.isArray(customDraftOrder) ? customDraftOrder : [];
  const order = raw.map(String).map((uid) => uid.trim()).filter(Boolean);
  const seen = new Set();
  const duplicates = [];
  const unknown = [];

  for (const uid of order) {
    if (seen.has(uid)) duplicates.push(uid);
    seen.add(uid);
    if (!currentSet.has(uid)) unknown.push(uid);
  }

  const missing = current.filter((uid) => !seen.has(uid));

  if (
    order.length !== current.length ||
    duplicates.length ||
    unknown.length ||
    missing.length
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Custom draft order must include every current manager before the draft can start.",
      {
        missing,
        duplicates: Array.from(new Set(duplicates)),
        unknown: Array.from(new Set(unknown)),
        managerCount: current.length,
        customOrderCount: order.length,
      }
    );
  }

  return order;
}

function getDraftStartAtMs(room = {}) {
  const raw = room?.startAt ?? room?.scheduledStartAtMs ?? null;
  if (typeof raw === "number") return raw;
  if (raw?.toMillis) return raw.toMillis();
  if (raw?.toDate) return raw.toDate().getTime();
  return null;
}

function normalizeDraftPosition(pos) {
  const p = String(pos || "").toUpperCase().trim();
  if (["FWD", "FW", "ST", "CF", "LW", "RW"].includes(p)) return "ATT";
  if (["ATT", "MID", "DEF", "GK"].includes(p)) return p;
  if (["GKP"].includes(p)) return "GK";
  if (["MF", "CM", "CDM", "CAM", "LM", "RM"].includes(p)) return "MID";
  if (["DF", "CB", "LB", "RB", "LWB", "RWB"].includes(p)) return "DEF";
  return p;
}

function draftMemberLabelFromRoom(room = {}, uid = "") {
  const cleanUid = String(uid || "");
  const members = Array.isArray(room?.members) ? room.members : [];
  const member = members.find((m) => draftMemberUidOf(m) === cleanUid);
  if (member && typeof member === "object") {
    return (
      member.displayName ||
      member.name ||
      member.fullName ||
      member.email ||
      cleanUid ||
      "Manager"
    );
  }
  return cleanUid || "Manager";
}

async function draftUserDisplayName(uid, fallback = "Manager") {
  const cleanUid = String(uid || "");
  if (!cleanUid) return fallback;
  try {
    const snap = await db.doc(`users/${cleanUid}`).get();
    const data = snap.exists ? snap.data() || {} : {};
    return (
      data.displayName ||
      data.name ||
      data.fullName ||
      fallback ||
      "Manager"
    );
  } catch (_) {
    return fallback || "Manager";
  }
}

async function startDraftForRoom({
  roomRef,
  room,
  turnSeconds,
  nowMs = Date.now(),
  requiredHostUid = null,
}) {
  const memberUids = await getRoomMemberUids(roomRef, room);
  requireDraftManagerCount(memberUids, room);

  const safeTurnSeconds = getDraftTurnSecondsValue(turnSeconds, room?.turnSeconds);
  const turnDeadlineAt = nowMs + safeTurnSeconds * 1000;

  return db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(roomRef);
    if (!freshSnap.exists) {
      throw new HttpsError("not-found", "Room not found.");
    }

    const freshRoom = freshSnap.data() || {};
    if (requiredHostUid && !isHost(freshRoom, requiredHostUid)) {
      throw new HttpsError("permission-denied", "Only host can start.");
    }
    if (freshRoom.started) {
      return {
        ok: true,
        started: false,
        alreadyStarted: true,
        draftOrder: freshRoom.draftOrder || [],
        draftOrderMode: getDraftOrderMode(freshRoom),
        draftRoundMode: getDraftRoundMode(freshRoom),
      };
    }
    if (isDraftCompleteRoom(freshRoom, memberUids)) {
      throw new HttpsError("failed-precondition", "Draft is complete.");
    }

    const draftOrderMode = getDraftOrderMode(freshRoom);
    const draftRoundMode = getDraftRoundMode(freshRoom);
    const finalDraftOrder =
      draftOrderMode === "custom"
        ? validateCustomDraftOrderForMembers(freshRoom.customDraftOrder, memberUids)
        : shuffleDraftOrder(memberUids);

    tx.set(
      roomRef,
      {
        started: true,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        draftOrder: finalDraftOrder,
        draftOrderMode,
        draftRoundMode,
        turnIndex: 0,
        turnSeconds: safeTurnSeconds,
        turnDeadlineAt,
        draftOrderLockedAtMs: nowMs,
        draftOrderLockedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      ok: true,
      started: true,
      draftOrder: finalDraftOrder,
      draftOrderMode,
      draftRoundMode,
      turnDeadlineAt,
    };
  });
}

exports.setDraftOrderSettings = onCall({ region: "us-west2" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const roomId = String(request.data?.roomId || "").trim();
  if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

  const draftOrderMode = String(request.data?.draftOrderMode || "random").trim();
  const draftRoundMode = String(request.data?.draftRoundMode || "snake").trim();

  if (!["random", "custom"].includes(draftOrderMode)) {
    throw new HttpsError("invalid-argument", "draftOrderMode must be random or custom.");
  }
  if (!["snake", "fixed"].includes(draftRoundMode)) {
    throw new HttpsError("invalid-argument", "draftRoundMode must be snake or fixed.");
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = roomSnap.data() || {};
  if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");
  if (room.started) {
    throw new HttpsError("failed-precondition", "Draft order is locked after the draft starts.");
  }

  const memberUids = await getRoomMemberUids(roomRef, room);
  if (isDraftCompleteRoom(room, memberUids)) {
    throw new HttpsError("failed-precondition", "Draft is complete.");
  }

  const customDraftOrder =
    draftOrderMode === "custom"
      ? validateCustomDraftOrderForMembers(request.data?.customDraftOrder, memberUids)
      : [];
  const nowMs = Date.now();

  await roomRef.set(
    {
      draftOrderMode,
      draftRoundMode,
      customDraftOrder,
      draftOrderSettingsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      draftOrderSettingsUpdatedAtMs: nowMs,
      draftOrderSettingsUpdatedBy: uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    ok: true,
    draftOrderMode,
    draftRoundMode,
    customDraftOrder,
  };
});

exports.startDraftNow = onCall({ region: "us-west2" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const roomId = String(request.data?.roomId || "").trim();
  if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = roomSnap.data() || {};
  if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Only host can start.");

  return startDraftForRoom({
    roomRef,
    room,
    turnSeconds: request.data?.turnSeconds,
    nowMs: Date.now(),
    requiredHostUid: uid,
  });
});

exports.maybeStartDraft = onCall({ region: "us-west2" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const roomId = String(request.data?.roomId || "").trim();
  if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = roomSnap.data() || {};
  if (room.started) {
    return { ok: true, started: false, alreadyStarted: true };
  }

  const nowMs = Date.now();
  const startAtMs = getDraftStartAtMs(room);
  if (!Number.isFinite(startAtMs) || nowMs < startAtMs) {
    return { ok: true, started: false, due: false, startAtMs };
  }

  return startDraftForRoom({
    roomRef,
    room,
    turnSeconds: request.data?.turnSeconds,
    nowMs,
  });
});

exports.makePick = onCall({ region: "us-west2" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const roomId = String(request.data?.roomId || "").trim();
  const playerId = String(request.data?.playerId || "").trim();
  if (!roomId || !playerId) {
    throw new HttpsError("invalid-argument", "roomId and playerId are required.");
  }

  const pos = normalizeDraftPosition(request.data?.position);
  if (!["ATT", "MID", "DEF", "GK"].includes(pos)) {
    throw new HttpsError("invalid-argument", "Position must be one of ATT, MID, DEF, GK.");
  }

  const displayName = await draftUserDisplayName(
    uid,
    request.auth?.token?.name || request.auth?.token?.email || "Manager"
  );
  const nowMs = Date.now();
  const roomRef = db.doc(`rooms/${roomId}`);
  const pickRef = roomRef.collection("picks").doc(playerId);

  return db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!room.started) throw new HttpsError("failed-precondition", "Draft has not started.");

    const order = (Array.isArray(room.draftOrder) ? room.draftOrder : [])
      .map(draftMemberUidOf)
      .filter(Boolean);
    if (!order.length) throw new HttpsError("failed-precondition", "Room has no draft order.");

    const turnIndex = Math.max(0, Math.floor(Number(room.turnIndex || 0)));
    const totalRounds = getDraftTotalRounds(room);
    const maxPicks = order.length * totalRounds;
    if (turnIndex >= maxPicks) {
      throw new HttpsError("failed-precondition", "Draft is complete.");
    }

    const draftRoundMode = getDraftRoundMode(room);
    const pickerUid = getPickerUidForTurn(order, turnIndex, draftRoundMode);
    if (!pickerUid) throw new HttpsError("failed-precondition", "Invalid draft order.");
    if (pickerUid !== uid) throw new HttpsError("failed-precondition", "Not your turn.");

    const existingPick = await tx.get(pickRef);
    if (existingPick.exists) {
      throw new HttpsError("failed-precondition", "Player already picked.");
    }

    const nextTurnIndex = turnIndex + 1;
    const nextDeadline =
      nextTurnIndex < maxPicks
        ? nowMs + getDraftTurnSecondsValue(room.turnSeconds) * 1000
        : null;
    const round = Math.floor(turnIndex / order.length) + 1;

    tx.set(pickRef, {
      playerId,
      playerName: String(request.data?.playerName || playerId),
      position: pos,
      uid,
      displayName,
      turn: turnIndex + 1,
      round,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(request.data?.apiPlayerId != null
        ? { apiPlayerId: Number(request.data.apiPlayerId) }
        : {}),
      ...(request.data?.apiTeamId != null
        ? { apiTeamId: Number(request.data.apiTeamId) }
        : {}),
      ...(request.data?.teamName ? { teamName: String(request.data.teamName) } : {}),
      ...(request.data?.nationality ? { nationality: String(request.data.nationality) } : {}),
    });

    tx.set(
      roomRef,
      {
        turnIndex: nextTurnIndex,
        turnDeadlineAt: nextDeadline,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true, turnIndex: nextTurnIndex };
  });
});

exports.autoPick = onCall({ region: "us-west2" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const roomId = String(request.data?.roomId || "").trim();
  if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

  const candidates = Array.isArray(request.data?.candidates)
    ? request.data.candidates
    : [];
  if (!candidates.length) {
    throw new HttpsError("failed-precondition", "No candidates available for auto-pick.");
  }

  const nowMs = Date.now();
  const roomRef = db.doc(`rooms/${roomId}`);

  return db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!room.started) throw new HttpsError("failed-precondition", "Draft not started.");
    if (!isHost(room, uid)) {
      throw new HttpsError("permission-denied", "Only host can auto-pick.");
    }

    const order = (Array.isArray(room.draftOrder) ? room.draftOrder : [])
      .map(draftMemberUidOf)
      .filter(Boolean);
    if (!order.length) throw new HttpsError("failed-precondition", "Room has no draft order.");

    const totalRounds = getDraftTotalRounds(room);
    const maxPicks = order.length * totalRounds;
    const turnIndex = Math.max(0, Math.floor(Number(room.turnIndex || 0)));
    if (turnIndex >= maxPicks) {
      throw new HttpsError("failed-precondition", "Draft complete.");
    }

    const deadline = Number(room.turnDeadlineAt || 0);
    if (!Number.isFinite(deadline) || !deadline || nowMs < deadline) {
      throw new HttpsError("failed-precondition", "Deadline not reached.");
    }

    const draftRoundMode = getDraftRoundMode(room);
    const pickerUid = getPickerUidForTurn(order, turnIndex, draftRoundMode);
    if (!pickerUid) throw new HttpsError("failed-precondition", "Invalid draft order.");

    let choice = null;
    for (let safety = 0; safety < 50 && !choice; safety += 1) {
      const candidate = candidates[Math.floor(Math.random() * candidates.length)];
      if (!candidate) continue;
      const candidateId = String(candidate.id || candidate.playerId || "").trim();
      const candidatePos = normalizeDraftPosition(candidate.position);
      if (!candidateId || !["ATT", "MID", "DEF", "GK"].includes(candidatePos)) continue;

      const candidateRef = roomRef.collection("picks").doc(candidateId);
      const candidateSnap = await tx.get(candidateRef);
      if (!candidateSnap.exists) {
        choice = { ...candidate, id: candidateId, position: candidatePos, ref: candidateRef };
      }
    }

    if (!choice) {
      throw new HttpsError("failed-precondition", "Could not find a free player to auto-pick.");
    }

    const pickerName = draftMemberLabelFromRoom(room, pickerUid);
    const nextTurnIndex = turnIndex + 1;
    const nextDeadline =
      nextTurnIndex < maxPicks
        ? nowMs + getDraftTurnSecondsValue(room.turnSeconds) * 1000
        : null;
    const round = Math.floor(turnIndex / order.length) + 1;

    tx.set(choice.ref, {
      playerId: choice.id,
      playerName: String(choice.name || choice.playerName || choice.id),
      position: choice.position,
      uid: pickerUid,
      displayName: pickerName,
      turn: turnIndex + 1,
      round,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      autoPicked: true,
      ...(choice.apiPlayerId != null ? { apiPlayerId: Number(choice.apiPlayerId) } : {}),
      ...(choice.apiTeamId != null ? { apiTeamId: Number(choice.apiTeamId) } : {}),
      ...(choice.teamName ? { teamName: String(choice.teamName) } : {}),
      ...(choice.nationality ? { nationality: String(choice.nationality) } : {}),
    });

    tx.set(
      roomRef,
      {
        turnIndex: nextTurnIndex,
        turnDeadlineAt: nextDeadline,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true, playerId: choice.id, pickerUid, turnIndex: nextTurnIndex };
  });
});

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

function collectFixtureTeams(fixtures = []) {
  const teamsById = new Map();

  for (const fixture of Array.isArray(fixtures) ? fixtures : []) {
    for (const side of [fixture?.teams?.home, fixture?.teams?.away]) {
      const id = side?.id;
      if (!id) continue;

      const key = String(id);
      if (teamsById.has(key)) continue;

      teamsById.set(key, {
        id: key,
        name: side?.name || "",
        logo: side?.logo || "",
      });
    }
  }

  return Array.from(teamsById.values());
}

function collectWeekWindowTeams({ window = null, teamMeta = null } = {}) {
  const teamsById = new Map();

  const addTeam = (id, name = "", logo = "") => {
    if (id == null || id === "") return;
    const key = String(id);
    if (!key || teamsById.has(key)) return;
    teamsById.set(key, { id: key, name: name || "", logo: logo || "" });
  };

  if (teamMeta instanceof Map) {
    for (const [id, meta] of teamMeta.entries()) {
      addTeam(id, meta?.name || "", meta?.logo || "");
    }
  }

  for (const fixture of Array.isArray(window?.fixtures) ? window.fixtures : []) {
    addTeam(fixture?.homeTeamId, fixture?.homeTeamName, fixture?.homeTeamLogo);
    addTeam(fixture?.awayTeamId, fixture?.awayTeamName, fixture?.awayTeamLogo);
    addTeam(fixture?.teams?.home?.id, fixture?.teams?.home?.name, fixture?.teams?.home?.logo);
    addTeam(fixture?.teams?.away?.id, fixture?.teams?.away?.name, fixture?.teams?.away?.logo);
  }

  return Array.from(teamsById.values());
}

function getGlobalPlayerPoolCoverage({ seasonPlayers = [], requiredTeams = [] } = {}) {
  const poolTeamIds = new Set(
    (Array.isArray(seasonPlayers) ? seasonPlayers : [])
      .map((player) => player?.teamId ?? player?.apiTeamId ?? player?.team?.id ?? null)
      .filter((id) => id != null && id !== "")
      .map(String)
  );

  const missingTeams = (Array.isArray(requiredTeams) ? requiredTeams : []).filter((team) => {
    const id = String(team?.id || "").trim();
    return id && !poolTeamIds.has(id);
  });

  return {
    ok: missingTeams.length === 0,
    missingTeams,
    missingTeamIds: missingTeams.map((team) => String(team.id)),
    missingTeamNames: missingTeams.map((team) => team.name || String(team.id)),
  };
}

function buildCupGlobalSeedBootstrap({
  roomId,
  window,
  league,
  season,
  nowMs,
}) {
  const allFixtures = (Array.isArray(window?.fixtures) ? window.fixtures : [])
    .map((fixture) => {
      const fixtureId = String(fixture?.fixtureId || fixture?.id || "").trim();
      const kickoffMs = Number(fixture?.kickoffMs || 0);
      if (!fixtureId || !Number.isFinite(kickoffMs) || kickoffMs <= 0) return null;

      return {
        id: fixtureId,
        fixtureId,
        kickoffMs,
        round: fixture?.round || fixture?.roundLabel || window?.roundLabel || null,
        statusShort: fixture?.statusShort || null,
        statusLong: fixture?.statusLong || null,
        homeTeamId: fixture?.homeTeamId || "",
        homeTeamName: fixture?.homeTeamName || "",
        homeTeamLogo: fixture?.homeTeamLogo || "",
        awayTeamId: fixture?.awayTeamId || "",
        awayTeamName: fixture?.awayTeamName || "",
        awayTeamLogo: fixture?.awayTeamLogo || "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.kickoffMs - b.kickoffMs);

  if (!allFixtures.length) return null;

  const fixtureById = new Map(
    allFixtures.map((fixture) => [String(fixture.fixtureId), fixture])
  );
  const selectedWindow = pickCupWindow(
    allFixtures.map((fixture) => ({
      id: fixture.fixtureId,
      kickoffMs: fixture.kickoffMs,
      round: fixture.round,
    })),
    { nowMs, gapHours: 36 }
  );
  if (!selectedWindow?.fixtureIds?.length) return null;

  const fixtures = selectedWindow.fixtureIds
    .map((fixtureId) => fixtureById.get(String(fixtureId)))
    .filter(Boolean)
    .sort((a, b) => a.kickoffMs - b.kickoffMs);
  if (!fixtures.length) return null;

  const firstKickoffMs = fixtures[0].kickoffMs;
  const lastKickoffMs = fixtures[fixtures.length - 1].kickoffMs;
  const startAtMs = Number(selectedWindow.startAtMs || 0) || firstKickoffMs;
  const endAtMs = Number(selectedWindow.endAtMs || 0) || lastKickoffMs;
  const label = selectedWindow.label || window?.roundLabel || fixtures[0]?.round || "Cup";
  const currentWindowId = selectedWindow.windowId || `${label}:${startAtMs}-${endAtMs}`;
  const nextPollAtMs = Math.max(
    nowMs,
    firstKickoffMs - CUP_GLOBAL_BOOTSTRAP_PRE_MS
  );

  return {
    cupCurrent: {
      roomId,
      status: "scheduled",
      source: "global-live-fixtures",
      currentWindowId,
      currentWindowLabel: label,
      currentWindowFixtureIds: fixtures.map((fixture) => fixture.fixtureId),
      currentWindowFixtures: fixtures,
      currentWindowStartAtMs: startAtMs,
      currentWindowEndAtMs: endAtMs,
      windowPointsByUid: {},
      creditedFixtures: {},
      breakdownByUserId: {},
      livePointsByUid: {},
      liveBreakdownByUserId: {},
      projectedTotalsByUid: {},
      projectedIncludesLivePoints: false,
      globalApplyStatus: "scheduled",
      nextPollAtMs,
      updatedAtMs: nowMs,
      updatedAt: FieldValue.serverTimestamp(),
    },
    competitionState: {
      phaseLabel: "Cup",
      currentLabel: label,
      weekStatus: "scheduled",
      nextPollAtMs,
      nextCupPollAtMs: nextPollAtMs,
      nextKickoffMs: firstKickoffMs,
      isDone: false,
    },
    fixtureSummaries: fixtures.map((fixture) => ({
      fixtureId: fixture.fixtureId,
      kickoffMs: fixture.kickoffMs,
      roundLabel: fixture.round || label,
      leagueRound: fixture.round || label,
      round: fixture.round || label,
      league: String(league),
      leagueId: league,
      season: String(season),
      homeTeamId: fixture.homeTeamId || null,
      homeTeamName: fixture.homeTeamName || "",
      homeTeamLogo: fixture.homeTeamLogo || "",
      awayTeamId: fixture.awayTeamId || null,
      awayTeamName: fixture.awayTeamName || "",
      awayTeamLogo: fixture.awayTeamLogo || "",
      ...(fixture.statusShort ? { statusShort: fixture.statusShort } : {}),
      ...(fixture.statusLong ? { statusLong: fixture.statusLong } : {}),
      updatedAtMs: nowMs,
      updatedAt: FieldValue.serverTimestamp(),
    })),
  };
}

async function fetchWorldCupQualifiedTeamsFromApi({
  apiKey,
  competition,
  roundLabel,
  timezone,
}) {
  const league = Number(competition?.league);
  const season = Number(competition?.season);
  const tz = String(timezone || competition?.timezone || "America/Los_Angeles");
  let knockoutFixtures = [];
  let source = "upcoming-knockout-fixtures";

  if (roundLabel) {
    const roundRes = await apiFootballGet(
      "fixtures",
      { league, season, round: roundLabel, timezone: tz },
      apiKey
    );
    knockoutFixtures = (Array.isArray(roundRes?.response) ? roundRes.response : []).filter(
      (fixture) =>
        buildWorldCupRoomMode({
          roundLabel: fixture?.league?.round || roundLabel,
          season,
        }).worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE
    );
    if (knockoutFixtures.length) source = "current-knockout-round";
  }

  if (!knockoutFixtures.length) {
    const from = isoDateInTZ(tz);
    const to = addDaysISO(from, 120);
    const fixturesRes = await apiFootballGet(
      "fixtures",
      { league, season, from, to, timezone: tz },
      apiKey
    );
    knockoutFixtures = (Array.isArray(fixturesRes?.response) ? fixturesRes.response : []).filter(
      (fixture) =>
        buildWorldCupRoomMode({
          roundLabel: fixture?.league?.round || "",
          season,
        }).worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE
    );
  }

  const teams = collectFixtureTeams(knockoutFixtures);

  return {
    teamIds: teams.map((team) => String(team.id)).filter(Boolean),
    teams,
    fixtureCount: knockoutFixtures.length,
    source,
  };
}

async function ensureWorldCupQualifiedTeams({
  db,
  seasonKey,
  competition,
  apiKey,
  roundLabel,
  timezone,
  nowMs,
}) {
  const docPath = getWorldCupQualifiedTeamsDocPath(seasonKey);
  const ref = db.doc(docPath);
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data() || {}) : {};
  const existingTeamIds = Array.isArray(existing.teamIds)
    ? existing.teamIds.map(String).filter(Boolean)
    : [];

  if (existing.status === "ready" && existingTeamIds.length > 0) {
    return {
      docPath,
      status: "ready",
      reused: true,
      teamIds: existingTeamIds,
      teams: Array.isArray(existing.teams) ? existing.teams : [],
      source: existing.source || "global-qualified-teams",
    };
  }

  const buildingAtMs = Number(existing.buildingAtMs || 0);
  const lockFresh = existing.status === "building" && nowMs - buildingAtMs < 5 * 60 * 1000;
  if (lockFresh) {
    throw new HttpsError(
      "aborted",
      "World Cup qualified teams are currently being built. Try again shortly."
    );
  }

  await ref.set(
    {
      status: "building",
      buildingAtMs: nowMs,
      updatedAtMs: nowMs,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  try {
    const built = await fetchWorldCupQualifiedTeamsFromApi({
      apiKey,
      competition,
      roundLabel,
      timezone,
    });

    if (!built.teamIds.length) {
      throw new HttpsError(
        "failed-precondition",
        "Could not determine World Cup knockout qualified teams from upcoming fixtures."
      );
    }

    await ref.set(
      {
        status: "ready",
        teamIds: built.teamIds,
        teams: built.teams,
        fixtureCount: built.fixtureCount,
        source: built.source,
        builtAtMs: nowMs,
        updatedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      docPath,
      status: "ready",
      reused: false,
      ...built,
    };
  } catch (e) {
    await ref.set(
      {
        status: "error",
        error: String(e?.message || e),
        updatedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    throw e;
  }
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
    const isNewCupEngineSeed =
      phaseLabel === "Cup" &&
      room?.started !== true &&
      !String(room?.engineType || "").trim() &&
      getRoomPhaseLabel(room) !== "Cup";
    const newCupGlobalPipeline = isNewCupEngineSeed
      ? {
          ...buildDefaultGlobalPipeline("global"),
          ...(room?.globalPipeline && typeof room.globalPipeline === "object"
            ? room.globalPipeline
            : {}),
          mode: "global",
          playerPool: true,
          liveFixtureCache: true,
          roomAggregator: true,
          cupGlobalAutoApply: true,
          cupGlobalCurrentWindowApply: true,
          cupAggregator: true,
          cupGlobalFinalize: true,
        }
      : null;
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
    let globalPlayerPoolCoverageOk = true;
    let missingGlobalPoolTeamIds = [];
    let missingGlobalPoolTeamNames = [];
    const fetchedPlayerDocs = [];

    function filterPlayersForFixtureDate(players = []) {
      if (!fixtureDate) return players;

      return (players || []).filter((player) => {
        const teamIdStr = player?.teamId ? String(player.teamId) : "";
        return !teamIdStr || teamMeta.has(teamIdStr);
      });
    }

    const globalPlayerPoolEnabled = newCupGlobalPipeline
      ? true
      : isGlobalPlayerPoolEnabled(room);

    if (globalPlayerPoolEnabled && seasonKey) {
      let seasonPlayers = await loadSeasonPlayerPool({ db, seasonKey });
      const requiredTeams = collectWeekWindowTeams({ window, teamMeta });
      let coverage = getGlobalPlayerPoolCoverage({ seasonPlayers, requiredTeams });
      globalPlayerPoolCoverageOk = coverage.ok;
      missingGlobalPoolTeamIds = coverage.missingTeamIds;
      missingGlobalPoolTeamNames = coverage.missingTeamNames;

      if (seasonPlayers.length > 0 && !coverage.ok && coverage.missingTeamIds.length > 0) {
        try {
          console.warn("[seedPlayersFromCompetition] Global player pool missing current-window teams; repairing", {
            roomId,
            seasonKey,
            missingGlobalPoolTeamIds,
            missingGlobalPoolTeamNames,
          });

          const missingTeamMeta = new Map(
            coverage.missingTeams.map((team) => [
              String(team.id),
              { id: String(team.id), name: team.name || "", logo: team.logo || "" },
            ])
          );
          const repairFetch = await fetchCompetitionPlayerPoolFromApi({
            apiKey,
            league,
            season,
            maxPlayers,
            maxPages,
            maxPagesPerTeam,
            teamIds: coverage.missingTeamIds,
            teamMeta: missingTeamMeta,
          });

          pagesFetched += repairFetch.pagesFetched;
          hitCap = hitCap || repairFetch.hitCap;

          if (repairFetch.players.length > 0) {
            globalBootstrapWritten += await bootstrapSeasonPlayerPool({
              db,
              seasonKey,
              players: repairFetch.players,
            });

            const byId = new Map();
            for (const player of [...seasonPlayers, ...repairFetch.players]) {
              const id = String(player?.id ?? player?.playerId ?? "").trim();
              if (id) byId.set(id, player);
            }
            seasonPlayers = Array.from(byId.values());
          }

          coverage = getGlobalPlayerPoolCoverage({ seasonPlayers, requiredTeams });
          globalPlayerPoolCoverageOk = coverage.ok;
          missingGlobalPoolTeamIds = coverage.missingTeamIds;
          missingGlobalPoolTeamNames = coverage.missingTeamNames;
        } catch (e) {
          globalBootstrapError = String(e?.message || e);
          globalPlayerPoolCoverageOk = false;
          console.warn("[seedPlayersFromCompetition] Global player pool repair failed; falling back to API seed", {
            roomId,
            seasonKey,
            error: globalBootstrapError,
          });
        }
      }

      const roomSourcePlayers = globalPlayerPoolCoverageOk
        ? filterPlayersForFixtureDate(seasonPlayers)
        : [];

      if (globalPlayerPoolCoverageOk && seasonPlayers.length > 0 && (!fixtureDate || roomSourcePlayers.length > 0)) {
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

    const playersFrom = usedGlobalSeasonPlayers ? "global-season-player-pool" : "api-football";
    const seededAtMs = Date.now();
    const cupGlobalSeedBootstrap =
      newCupGlobalPipeline && seasonKey
        ? buildCupGlobalSeedBootstrap({
            roomId,
            window,
            league,
            season,
            nowMs: seededAtMs,
          })
        : null;

    await roomRef.set(
      {
        competition,
        seedFilter: fixtureDate ? { fixtureDate } : admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...roomSeasonFieldUpdates,
        ...(newCupGlobalPipeline
          ? {
              engineType: "cupEngine",
              globalPipeline: newCupGlobalPipeline,
            }
          : {}),
        competitionLocked: true,
        status: "ready_to_draft",
        playerCount: written,
        playersFrom,
        playersFromLabel: usedGlobalSeasonPlayers ? "Global Season Player Pool" : "API-Football",
        usedGlobalSeasonPlayers,
        globalPlayerPoolEnabledAtSeed: globalPlayerPoolEnabled,
        seedSeasonKey: seasonKey || "",
        seededAtMs,
        seededAt: admin.firestore.FieldValue.serverTimestamp(),
        seedPagesFetched: pagesFetched,
        seedGlobalBootstrapWritten: globalBootstrapWritten,
        seedGlobalBootstrapError: globalBootstrapError || null,
        globalPlayerPoolCoverageOk,
        missingGlobalPoolTeamIds,
        missingGlobalPoolTeamNames,
      },
      { merge: true }
    );

    if (cupGlobalSeedBootstrap) {
      await roomRef.collection("cup").doc("current").set(
        cupGlobalSeedBootstrap.cupCurrent,
        { merge: true }
      );

      await Promise.all(
        cupGlobalSeedBootstrap.fixtureSummaries.map((summary) =>
          getSeasonFixtureSummaryRef(db, seasonKey, summary.fixtureId).set(
            summary,
            { merge: true }
          )
        )
      );

      console.log("[seedPlayersFromCompetition] bootstrapped Cup global window", {
        roomId,
        seasonKey,
        currentWindowId: cupGlobalSeedBootstrap.cupCurrent.currentWindowId,
        currentWindowLabel: cupGlobalSeedBootstrap.cupCurrent.currentWindowLabel,
        fixtureCount:
          cupGlobalSeedBootstrap.cupCurrent.currentWindowFixtureIds.length,
        nextPollAtMs: cupGlobalSeedBootstrap.cupCurrent.nextPollAtMs,
      });
    }

    await setCompetitionState(
      roomRef,
      cupGlobalSeedBootstrap?.competitionState || {
        phaseLabel,
        currentLabel: roundLabel,
        isDone: false,
        weekStatus: "scheduled",
      },
      {
        roomData: {
          ...room,
          competition,
          ...roomSeasonFieldUpdates,
          ...(newCupGlobalPipeline
            ? {
                engineType: "cupEngine",
                globalPipeline: newCupGlobalPipeline,
              }
            : {}),
        },
        nowMs: seededAtMs,
      }
    );

    if (cupGlobalSeedBootstrap) {
      await upsertTournamentPollTask({
        roomId,
        phase: "Cup",
        nextPollAtMs: cupGlobalSeedBootstrap.cupCurrent.nextPollAtMs,
        reason: "cup-global-seed-window",
        nowMs: seededAtMs,
      });
    }

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
      source: playersFrom,
      playersFrom,
      globalBootstrapWritten,
      globalBootstrapError,
      globalPlayerPoolCoverageOk,
      missingGlobalPoolTeamIds,
      missingGlobalPoolTeamNames,

      // helpful for debugging in the client
      phaseLabel,
      roundLabel,
    };
  }
);

exports.seedWorldCupRoom = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = String(request.data?.roomId || "").trim();
    const league = Number(request.data?.league);
    const season = Number(request.data?.season);
    const timezone = String(request.data?.timezone ?? "America/Los_Angeles");
    const competitionName = String(request.data?.competitionName || "World Cup");
    const requestedWorldCupPhase = String(
      request.data?.requestedWorldCupPhase || ""
    ).trim().toLowerCase();
    const worldCupMaxPlayers = Math.max(
      WORLD_CUP_GLOBAL_PLAYER_POOL_MIN,
      Math.min(
        8000,
        Number(request.data?.worldCupMaxPlayers ?? 5000)
      )
    );
    const maxPagesPerTeam = Math.max(1, Math.min(20, Number(request.data?.maxPagesPerTeam ?? 10)));

    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");
    if (!Number.isFinite(league) || !Number.isFinite(season)) {
      throw new HttpsError("invalid-argument", "league and season are required.");
    }
    if (
      requestedWorldCupPhase !== WORLD_CUP_GROUP_PHASE &&
      requestedWorldCupPhase !== WORLD_CUP_KNOCKOUT_PHASE
    ) {
      throw new HttpsError(
        "invalid-argument",
        "requestedWorldCupPhase must be 'group' or 'knockout'."
      );
    }
    if (!isWorldCupCompetition({ competitionName, competitionKey: request.data?.competitionKey })) {
      throw new HttpsError("failed-precondition", "Selected competition is not World Cup.");
    }

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) throw new HttpsError("permission-denied", "Host only.");

    const existingWorldCupPhase = String(
      room?.worldCupPhase || room?.worldCup?.phase || ""
    ).trim().toLowerCase();
    const existingWorldCupEngine = String(
      room?.engineType || room?.worldCup?.engineType || ""
    ).trim();
    if (existingWorldCupPhase || existingWorldCupEngine) {
      throw new HttpsError(
        "failed-precondition",
        "World Cup room format is already configured."
      );
    }

    const apiKey = APIFOOTBALL_KEY.value();
    const competition = {
      provider: "api-football",
      league,
      season,
      timezone,
    };
    const nowMs = Date.now();
    const roundLabel = null;
    const requestedSeasonKey = String(request.data?.seasonKey || "").trim().toLowerCase();
    const mode = {
      seasonKey: /^worldcup-[a-z0-9-]+$/.test(requestedSeasonKey)
        ? requestedSeasonKey
        : buildWorldCupSeasonKey(season),
      competitionKey: WORLD_CUP_COMPETITION_KEY,
      competitionType: WORLD_CUP_COMPETITION_TYPE,
      worldCupPhase: requestedWorldCupPhase,
      engineType:
        requestedWorldCupPhase === WORLD_CUP_KNOCKOUT_PHASE
          ? WORLD_CUP_KNOCKOUT_ENGINE
          : WORLD_CUP_GROUP_ENGINE,
    };
    if (!mode.seasonKey) {
      throw new HttpsError("failed-precondition", "Could not build World Cup season key.");
    }

    let qualifiedTeams = null;
    let qualifiedTeamsError = null;
    if (mode.worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE) {
      try {
        qualifiedTeams = await ensureWorldCupQualifiedTeams({
          db,
          seasonKey: mode.seasonKey,
          competition,
          apiKey,
          roundLabel,
          timezone,
          nowMs,
        });
      } catch (e) {
        qualifiedTeamsError = String(e?.message || e);
        console.warn("[seedWorldCupRoom] qualified teams unavailable; using player-pool fallback", {
          roomId,
          seasonKey: mode.seasonKey,
          error: qualifiedTeamsError,
        });
      }
      if (!Array.isArray(qualifiedTeams?.teamIds) || !qualifiedTeams.teamIds.length) {
        qualifiedTeamsError =
          qualifiedTeamsError ||
          "World Cup knockout qualified teams are not available yet.";
      }
    }

    const dailyWindows =
      mode.worldCupPhase === WORLD_CUP_GROUP_PHASE
        ? await loadWorldCupGroupDailyWindows({
            apiFootballGet,
            apiKey,
            league,
            season,
            timezone,
          })
        : [];

    if (mode.worldCupPhase === WORLD_CUP_GROUP_PHASE && !dailyWindows.length) {
      throw new HttpsError(
        "failed-precondition",
        "No World Cup group-stage daily windows could be created."
      );
    }

    let globalPoolResult;
    try {
      globalPoolResult = await ensureFreshWorldCupGlobalPlayerPool({
        db,
        apiFootballGet,
        apiKey,
        seasonKey: mode.seasonKey,
        season,
        dailyWindows,
        qualifiedTeams,
        worldCupPhase: mode.worldCupPhase,
        maxPlayers: worldCupMaxPlayers,
        maxPagesPerTeam,
        forceRefresh: false,
        nowMs,
        loadDailyWindows:
          mode.worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE
            ? () =>
                loadWorldCupGroupDailyWindows({
                  apiFootballGet,
                  apiKey,
                  league,
                  season,
                  timezone,
                })
            : null,
      });
    } catch (error) {
      const code = ["aborted", "failed-precondition"].includes(error?.code)
        ? error.code
        : "internal";
      throw new HttpsError(
        code,
        error?.message || "World Cup global player pool refresh failed."
      );
    }

    if (
      globalPoolResult.refreshed &&
      (
        globalPoolResult.latestFetchedCount <
          WORLD_CUP_GLOBAL_PLAYER_POOL_MIN ||
        globalPoolResult.allTeamsProcessed === false ||
        globalPoolResult.hitCap === true
      )
    ) {
      throw new HttpsError(
        "failed-precondition",
        "World Cup global player pool refresh was incomplete. Retry before seeding this room."
      );
    }

    const roomPlayers = Array.isArray(globalPoolResult.players)
      ? globalPoolResult.players
      : [];
    const usedGlobalSeasonPlayers = true;
    const globalBootstrapWritten = Number(
      globalPoolResult.globalWrittenCount || 0
    );
    const globalBootstrapError =
      (globalPoolResult.errors || []).join("; ") || null;
    const worldCupPlayerPoolIncomplete =
      roomPlayers.length < WORLD_CUP_GLOBAL_PLAYER_POOL_MIN ||
      globalPoolResult.allTeamsProcessed === false ||
      globalPoolResult.hitCap === true;
    const worldCupPlayerPoolWarning = (globalPoolResult.warnings || []).join(
      " "
    );
    const worldCupTeamIds = Array.isArray(globalPoolResult.teamIds)
      ? globalPoolResult.teamIds
      : [];
    const worldCupTeams = Array.isArray(globalPoolResult.teams)
      ? globalPoolResult.teams
      : [];
    const worldCupTeamFetchSummary = Array.isArray(
      globalPoolResult.teamFetchSummary
    )
      ? globalPoolResult.teamFetchSummary
      : [];
    const ignoredIncompleteGlobalWorldCupPoolCount =
      globalPoolResult.beforeCount > 0 &&
      globalPoolResult.beforeCount < WORLD_CUP_GLOBAL_PLAYER_POOL_MIN
        ? globalPoolResult.beforeCount
        : null;
    const playersFrom = globalPoolResult.source;
    const playersFromLabel = globalPoolResult.refreshed
      ? "Refreshed Global Season Player Pool"
      : "Global Season Player Pool";
    const fetchResult = {
      players: [],
      pagesFetched: Number(globalPoolResult.pagesFetched || 0),
      hitCap: Boolean(globalPoolResult.hitCap),
      teamFetchSummary: worldCupTeamFetchSummary,
      teamIds: worldCupTeamIds,
      teamCount: Number(globalPoolResult.teamCount || 0),
      processedTeamCount: Number(globalPoolResult.processedTeamCount || 0),
      expectedTeamCount: Number(globalPoolResult.expectedTeamCount || 0),
      allTeamsProcessed: globalPoolResult.allTeamsProcessed === true,
      missingFetchTeamIds: globalPoolResult.missingFetchTeamIds || [],
      missingFetchTeamNames: globalPoolResult.missingFetchTeamNames || [],
      skippedTeamIdsDueToGlobalCap:
        globalPoolResult.skippedTeamIdsDueToGlobalCap || [],
      usedSquadFallbackTeamIds: [],
      emptyTeamIds: [],
      maxPlayers: worldCupMaxPlayers,
    };

    if (!roomPlayers.length) {
      throw new HttpsError(
        "failed-precondition",
        "Could not load World Cup player pool from team fixtures."
      );
    }

    const written = await replacePlayersInRoom({
      db,
      roomId,
      players: roomPlayers,
    });

    const worldCupProcessedTeamCount = Number(fetchResult.processedTeamCount || 0);
    const worldCupExpectedTeamCount = Number(fetchResult.expectedTeamCount || 0);
    const worldCupMissingFetchTeamIds = Array.isArray(fetchResult.missingFetchTeamIds)
      ? fetchResult.missingFetchTeamIds
      : [];
    const worldCupMissingFetchTeamNames = Array.isArray(fetchResult.missingFetchTeamNames)
      ? fetchResult.missingFetchTeamNames
      : [];
    const worldCupAllTeamsProcessed =
      globalPoolResult.allTeamsProcessed !== false;
    const worldCupHitGlobalCap = Boolean(fetchResult.hitCap);
    const worldCupSkippedTeamIdsDueToGlobalCap = Array.isArray(fetchResult.skippedTeamIdsDueToGlobalCap)
      ? fetchResult.skippedTeamIdsDueToGlobalCap
      : [];

    const groupPollInfo =
      mode.worldCupPhase === WORLD_CUP_GROUP_PHASE
        ? getNextPollAtMsFromFixtures(dailyWindows[0]?.fixtures || [], nowMs)
        : null;
    const knockoutNextPollAtMs = nowMs + 60 * 60 * 1000;

    const competitionStatePatch =
      mode.worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE
        ? {
            phaseLabel: "Cup",
            currentLabel: roundLabel || "Waiting for knockout fixtures",
            isDone: false,
            weekStatus: "scheduled",
            nextPollAtMs: knockoutNextPollAtMs,
            nextCupPollAtMs: knockoutNextPollAtMs,
            nextKickoffMs: null,
          }
        : {
            phaseLabel: "WorldCupGroup",
            currentLabel: dailyWindows[0]?.label || roundLabel,
            isDone: false,
            weekStatus: "scheduled",
            nextPollAtMs: groupPollInfo?.nextPollAtMs || nowMs + 60 * 60 * 1000,
            nextKickoffMs: groupPollInfo?.nextKickoffMs || null,
          };

    const worldCupGlobalPipeline =
      mode.worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE
        ? {
            ...buildDefaultGlobalPipeline("global"),
            mode: "global",
            playerPool: true,
            liveFixtureCache: true,
            roomAggregator: true,
            cupGlobalAutoApply: true,
            cupGlobalCurrentWindowApply: true,
            cupAggregator: true,
            cupGlobalFinalize: true,
          }
        : buildDefaultGlobalPipeline("global");
    const seededAtMs = Date.now();

    await roomRef.set(
      {
        competition,
        competitionMeta: {
          ...(room?.competitionMeta || {}),
          name: competitionName,
          country: request.data?.competitionCountry || room?.competitionMeta?.country || "",
          type: "World Cup",
          logo: request.data?.competitionLogo || room?.competitionMeta?.logo || "",
        },
        seedFilter: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),

        seasonKey: mode.seasonKey,
        competitionKey: mode.competitionKey,
        competitionType: mode.competitionType,
        worldCupPhase: mode.worldCupPhase,
        engineType: mode.engineType,
        globalPipeline: worldCupGlobalPipeline,
        worldCup: {
          requestedPhase: requestedWorldCupPhase,
          phase: mode.worldCupPhase,
          engineType: mode.engineType,
          seasonKey: mode.seasonKey,
          nextRoundLabel: roundLabel,
          dayCount: dailyWindows.length || 0,
          currentDayIndex: dailyWindows[0]?.dayIndex || null,
          currentDayLabel: dailyWindows[0]?.label || null,
          currentDayStartAtMs: dailyWindows[0]?.startAtMs || null,
          currentDayEndAtMs: dailyWindows[0]?.endAtMs || null,
          firstKickoffMs: dailyWindows[0]?.firstKickoffMs || null,
          lastKickoffMs: dailyWindows[dailyWindows.length - 1]?.lastKickoffMs || null,
          firstWindowStartAtMs: dailyWindows[0]?.startAtMs || null,
          lastWindowEndAtMs: dailyWindows[dailyWindows.length - 1]?.endAtMs || null,
          nextFixtureIds: [],
          qualifiedTeamsDocPath:
            mode.worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE
              ? getWorldCupQualifiedTeamsDocPath(mode.seasonKey)
              : null,
        },

        competitionLocked: true,
        worldCupPhaseLocked: true,
        status: "ready_to_draft",
        playerCount: written,
        playersFrom,
        playersFromLabel,
        usedGlobalSeasonPlayers,
        globalPlayerPoolEnabledAtSeed: true,
        seedSeasonKey: mode.seasonKey || "",
        seededAtMs,
        seededAt: admin.firestore.FieldValue.serverTimestamp(),
        seedPagesFetched: fetchResult.pagesFetched,
        seedGlobalBootstrapWritten: globalBootstrapWritten,
        seedGlobalBootstrapError: globalBootstrapError || null,
        worldCupPlayerPoolIncomplete,
        worldCupPlayerPoolWarning,
        worldCupPlayerPoolCount: written,
        worldCupPlayerPoolTeamCount: worldCupTeamIds.length,
        worldCupPlayerPoolTeamIds: worldCupTeamIds,
        worldCupPlayerPoolTeams: worldCupTeams,
        worldCupTeamFetchSummary,
        worldCupGlobalPlayerPoolMin: WORLD_CUP_GLOBAL_PLAYER_POOL_MIN,
        worldCupMaxPlayers,
        worldCupProcessedTeamCount,
        worldCupExpectedTeamCount,
        worldCupMissingFetchTeamIds,
        worldCupMissingFetchTeamNames,
        worldCupAllTeamsProcessed,
        worldCupHitGlobalCap,
        worldCupSkippedTeamIdsDueToGlobalCap,
        ignoredIncompleteGlobalWorldCupPoolCount,
        globalPoolWasStale: Boolean(globalPoolResult.wasStale),
        globalPoolRefreshed: Boolean(globalPoolResult.refreshed),
        globalPoolLastApiRefreshAtMs:
          globalPoolResult.lastApiRefreshAtMs || null,
        globalPoolBeforeCount: Number(globalPoolResult.beforeCount || 0),
        globalPoolAfterCount: Number(globalPoolResult.afterCount || 0),
        globalPoolAddedCount: Number(globalPoolResult.addedCount || 0),
        globalPoolLatestFetchedCount: Number(
          globalPoolResult.latestFetchedCount || 0
        ),
        globalPoolRefreshReason: globalPoolResult.refreshReason || "",
        globalPoolWarnings: globalPoolResult.warnings || [],
        globalPoolErrors: globalPoolResult.errors || [],
        qualifiedTeamsError: qualifiedTeamsError || null,
      },
      { merge: true }
    );

    const dailyWindowWriteCount =
      mode.worldCupPhase === WORLD_CUP_GROUP_PHASE
        ? await writeWorldCupDailyWindowsForRoom({
            db,
            roomId,
            windows: dailyWindows,
            nowMs,
          })
        : 0;

    await setCompetitionState(roomRef, competitionStatePatch, {
      roomData: room,
      nowMs,
    });

    if (mode.worldCupPhase === WORLD_CUP_GROUP_PHASE) {
      await upsertTournamentPollTask({
        roomId,
        phase: "WorldCupGroup",
        nextPollAtMs: competitionStatePatch.nextPollAtMs,
        reason: groupPollInfo?.reason || "world-cup-group-seeded",
        nowMs,
      });
    } else {
      await upsertTournamentPollTask({
        roomId,
        phase: "Cup",
        nextPollAtMs: competitionStatePatch.nextPollAtMs,
        reason: "world-cup-knockout-waiting-for-fixtures",
        nowMs,
      });
    }

    return {
      ok: true,
      league,
      season,
      seasonKey: mode.seasonKey,
      competitionKey: mode.competitionKey,
      competitionType: mode.competitionType,
      worldCupPhase: mode.worldCupPhase,
      engineType: mode.engineType,
      roundLabel,
      fixtureCount: 0,
      dailyWindowCount: dailyWindows.length || 0,
      dailyWindowWriteCount,
      nextPollAtMs: competitionStatePatch.nextPollAtMs || null,
      nextKickoffMs: competitionStatePatch.nextKickoffMs || null,
      qualifiedTeamsDocPath:
        mode.worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE
          ? getWorldCupQualifiedTeamsDocPath(mode.seasonKey)
          : null,
      qualifiedTeamCount: qualifiedTeams?.teamIds?.length || null,
      pagesFetched: fetchResult.pagesFetched,
      written,
      maxPlayers: worldCupMaxPlayers,
      worldCupMaxPlayers,
      hitCap: fetchResult.hitCap || written >= worldCupMaxPlayers,
      globalPipeline: worldCupGlobalPipeline,
      playersFrom,
      usedGlobalSeasonPlayers,
      source: playersFrom,
      globalBootstrapWritten,
      globalBootstrapError,
      worldCupPlayerPoolIncomplete,
      worldCupPlayerPoolWarning,
      worldCupPlayerPoolCount: written,
      worldCupPlayerPoolTeamCount: worldCupTeamIds.length,
      worldCupPlayerPoolTeamIds: worldCupTeamIds,
      worldCupPlayerPoolTeams: worldCupTeams,
      worldCupTeamFetchSummary,
      worldCupGlobalPlayerPoolMin: WORLD_CUP_GLOBAL_PLAYER_POOL_MIN,
      worldCupProcessedTeamCount,
      worldCupExpectedTeamCount,
      worldCupMissingFetchTeamIds,
      worldCupMissingFetchTeamNames,
      worldCupAllTeamsProcessed,
      worldCupHitGlobalCap,
      worldCupSkippedTeamIdsDueToGlobalCap,
      ignoredIncompleteGlobalWorldCupPoolCount,
      globalPoolWasStale: Boolean(globalPoolResult.wasStale),
      globalPoolRefreshed: Boolean(globalPoolResult.refreshed),
      globalPoolLastApiRefreshAtMs:
        globalPoolResult.lastApiRefreshAtMs || null,
      globalPoolBeforeCount: Number(globalPoolResult.beforeCount || 0),
      globalPoolAfterCount: Number(globalPoolResult.afterCount || 0),
      globalPoolAddedCount: Number(globalPoolResult.addedCount || 0),
      globalPoolLatestFetchedCount: Number(
        globalPoolResult.latestFetchedCount || 0
      ),
      globalPoolRefreshReason: globalPoolResult.refreshReason || "",
      globalPoolWarnings: globalPoolResult.warnings || [],
      globalPoolErrors: globalPoolResult.errors || [],
      qualifiedTeamsError: qualifiedTeamsError || null,
    };
  }
);

exports.debugRunWorldCupGroupEngine = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
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

    const competitionState = getCompetitionState(room);
    const isWorldCupGroupRoom =
      room?.engineType === "worldCupDaily" ||
      room?.worldCup?.engineType === "worldCupDaily" ||
      room?.competitionState?.phaseLabel === "WorldCupGroup" ||
      competitionState?.phaseLabel === "WorldCupGroup";

    if (!isWorldCupGroupRoom) {
      throw new HttpsError("failed-precondition", "Room is not a World Cup group room.");
    }

    const requestedNowMs = Number(request.data?.nowMs || Date.now());
    const debugNowMs = Number.isFinite(requestedNowMs) ? requestedNowMs : Date.now();
    const engineType = room.engineType || room.worldCup?.engineType || "";
    const worldCupPhase = room.worldCupPhase || room.worldCup?.phase || "";

    console.log("[debugRunWorldCupGroupEngine] manual run", {
      roomId,
      uid,
      debugNowMs,
      engineType,
      worldCupPhase,
    });

    const result = await runWorldCupGroupEngine({
      db,
      roomId,
      room,
      apiKey: APIFOOTBALL_KEY.value(),
      nowMs: debugNowMs,
      getFixtureStatusMap,
      getFixturePlayersStatsMapCached,
      setCompetitionState,
      ensureDefaultLineupsForRoom,
    });

    return {
      ok: true,
      roomId,
      nowMs: debugNowMs,
      engineType,
      worldCupPhase,
      result,
      currentDayIndex: result?.dayIndex ?? result?.currentDayIndex ?? null,
      status: result?.status ?? null,
      weekStatus: result?.weekStatus ?? null,
      isDone: Boolean(result?.isDone),
      nextPollAtMs: result?.nextPollAtMs ?? null,
      nextKickoffMs: result?.nextKickoffMs ?? null,
      fixtureCoverage: result?.fixtureCoverage || [],
      teamScoresByUserId: result?.teamScoresByUserId || {},
      dailyLeaderboard: result?.dailyLeaderboard || [],
      standingsPreview: result?.standingsPreview || result?.leaderboard || [],
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

async function writeInitialWeekResultsPlaceholder({
  roomId,
  weekIndex,
  weekDoc,
  memberUids,
  nowMs = Date.now(),
}) {
  const users = await loadRoomUsersLineupsForGlobalAggregation({ db, roomId });
  const usersByUid = new Map(
    users.map((user) => [String(user.uid), user])
  );
  const orderedUids = (Array.isArray(memberUids) && memberUids.length
    ? memberUids
    : users.map((user) => String(user.uid))
  ).map(String).filter(Boolean).sort();

  const teamScoresByUserId = {};
  const breakdownByUserId = {};
  const startersByUserId = {};
  const benchByUserId = {};
  const weekLeaderboard = [];

  for (const uid of orderedUids) {
    const user = usersByUid.get(uid) || { uid, displayName: uid, starters: [], bench: [] };
    const starters = Array.isArray(user.starters) ? user.starters : [];
    const bench = Array.isArray(user.bench) ? user.bench : [];
    const displayName = user.displayName || user.name || uid;

    teamScoresByUserId[uid] = 0;
    startersByUserId[uid] = starters;
    benchByUserId[uid] = bench;
    breakdownByUserId[uid] = {
      total: 0,
      benchTotal: 0,
      perPlayer: {},
      starters,
      bench,
    };
    weekLeaderboard.push({
      rank: weekLeaderboard.length + 1,
      userId: uid,
      uid,
      name: displayName,
      displayName,
      teamName: user.teamName || "",
      result: "-",
      matchPoints: 0,
      fantasyPoints: 0,
      totalFantasyPoints: 0,
      points: 0,
    });
  }

  const matchupPairs = Array.isArray(weekDoc?.matchups) ? weekDoc.matchups : [];
  const matchups = matchupPairs.map((pair) => ({
    weekIndex,
    homeUserId: pair.homeUserId,
    awayUserId: pair.awayUserId,
    homeTotal: 0,
    awayTotal: 0,
    homeResult: "D",
    awayResult: "D",
    winnerUserId: null,
    status: "SCHEDULED",
  }));

  await db.doc(`rooms/${roomId}/weekResults/${String(weekIndex)}`).set(
    {
      roomId,
      weekIndex,
      startAtMs: Number(weekDoc?.startAtMs || 0) || null,
      endAtMs: Number(weekDoc?.endAtMs || 0) || null,
      roundLabel: weekDoc?.roundLabel || null,
      status: "scheduled",
      source: "week-created-placeholder",
      teamScoresByUserId,
      breakdownByUserId,
      startersByUserId,
      benchByUserId,
      matchups,
      weekLeaderboard,
      updatedAtMs: nowMs,
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
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

function normalizeApiFixtureForWeek(m) {
  const id = String(m?.fixture?.id || "").trim();
  const kickoffMs = m?.fixture?.timestamp
    ? Number(m.fixture.timestamp) * 1000
    : Date.parse(m?.fixture?.date);
  const round = m?.league?.round || null;
  const statusShort = m?.fixture?.status?.short || null;
  const statusLong = m?.fixture?.status?.long || null;
  const homeTeam = m?.teams?.home || {};
  const awayTeam = m?.teams?.away || {};

  if (!id || !Number.isFinite(kickoffMs)) return null;

  return {
    id,
    fixtureId: id,
    kickoffMs,
    round,
    roundLabel: round,
    statusShort,
    statusLong,
    homeTeamId: homeTeam?.id != null ? String(homeTeam.id) : "",
    homeTeamName: homeTeam?.name || "",
    homeTeamLogo: homeTeam?.logo || "",
    awayTeamId: awayTeam?.id != null ? String(awayTeam.id) : "",
    awayTeamName: awayTeam?.name || "",
    awayTeamLogo: awayTeam?.logo || "",
    teams: {
      home: {
        id: homeTeam?.id ?? null,
        name: homeTeam?.name || "",
        logo: homeTeam?.logo || "",
      },
      away: {
        id: awayTeam?.id ?? null,
        name: awayTeam?.name || "",
        logo: awayTeam?.logo || "",
      },
    },
  };
}

function buildWindowFromApiFixtures(fixtures, { gapHours = 36 } = {}) {
  const normalized = (Array.isArray(fixtures) ? fixtures : [])
    .map(normalizeApiFixtureForWeek)
    .filter(Boolean)
    .sort((a, b) => a.kickoffMs - b.kickoffMs);

  if (!normalized.length) return null;

  const first = normalized[0];

  if (first.roundLabel) {
    const sameRound = normalized.filter((f) => f.roundLabel === first.roundLabel);
    return {
      roundLabel: first.roundLabel,
      windowMode: "round",
      startAtMs: sameRound[0].kickoffMs,
      endAtMs: sameRound[sameRound.length - 1].kickoffMs,
      fixtures: sameRound.map((f) => ({
        id: f.id,
        fixtureId: f.fixtureId,
        kickoffMs: f.kickoffMs,
        round: f.roundLabel || null,
        statusShort: f.statusShort || null,
        statusLong: f.statusLong || null,
        homeTeamId: f.homeTeamId || "",
        homeTeamName: f.homeTeamName || "",
        homeTeamLogo: f.homeTeamLogo || "",
        awayTeamId: f.awayTeamId || "",
        awayTeamName: f.awayTeamName || "",
        awayTeamLogo: f.awayTeamLogo || "",
        teams: f.teams || null,
      })),
    };
  }

  const gapMs = gapHours * 60 * 60 * 1000;
  const cluster = [first];

  for (let i = 1; i < normalized.length; i++) {
    const prev = normalized[i - 1];
    const cur = normalized[i];
    if (cur.kickoffMs - prev.kickoffMs > gapMs) break;
    cluster.push(cur);
  }

  return {
    roundLabel: null,
    windowMode: "fixture-cluster",
    startAtMs: cluster[0].kickoffMs,
    endAtMs: cluster[cluster.length - 1].kickoffMs,
    fixtures: cluster.map((f) => ({
      id: f.id,
      fixtureId: f.fixtureId,
      kickoffMs: f.kickoffMs,
      round: null,
      statusShort: f.statusShort || null,
      statusLong: f.statusLong || null,
      homeTeamId: f.homeTeamId || "",
      homeTeamName: f.homeTeamName || "",
      homeTeamLogo: f.homeTeamLogo || "",
      awayTeamId: f.awayTeamId || "",
      awayTeamName: f.awayTeamName || "",
      awayTeamLogo: f.awayTeamLogo || "",
      teams: f.teams || null,
    })),
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


  function mergeFixtureLists(...lists) {
    const byId = new Map();
    for (const item of lists.flat()) {
      const id = String(item?.fixture?.id || "").trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, item);
    }
    return Array.from(byId.values());
  }

  // 1) Try normal upcoming fixtures
  let fx = await apiFootballGet("fixtures", { league, season, next: 100, timezone }, apiKey);
  let list = Array.isArray(fx?.response) ? fx.response : [];

  // ✅ If we’re advancing after a finished week, ignore fixtures at/before that week’s end
  if (Number.isFinite(minKickoffMs)) {
    const from = isoDateInTZ(timezone, new Date(minKickoffMs));
    const to = addDaysISO(from, 90);
    const windowFx = await apiFootballGet("fixtures", { league, season, from, to, timezone }, apiKey);
    const windowList = Array.isArray(windowFx?.response) ? windowFx.response : [];
    list = applyMinKickoff(mergeFixtureLists(list, windowList));
  } else {
    list = applyMinKickoff(list);
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

  const firstWindow = buildWindowFromApiFixtures(list, { gapHours: 36 });
  const firstRoundLabel = firstWindow?.roundLabel || null;

  if (firstRoundLabel) {
    const fxAll = await apiFootballGet("fixtures", {
      league,
      season,
      round: firstRoundLabel,
      timezone,
    }, apiKey);
    const allList = applyMinKickoff(Array.isArray(fxAll?.response) ? fxAll.response : []);
    return buildWindowFromApiFixtures(allList.length ? allList : list, { gapHours: 36 });
  }

  console.log("[fetchNextRoundWindow] no round label; using fixture-cluster window", {
    league,
    season,
    fixtureCount: Array.isArray(list) ? list.length : 0,
  });
  return firstWindow;
/*
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
*/
}

async function ensureDefaultLineupsForRoom(roomId, memberUids, options = {}) {
  const preloadedPlayersById =
    options?.preloadedPlayersById instanceof Map
      ? options.preloadedPlayersById
      : null;
  const preloadedLineupsByUid =
    options?.preloadedLineupsByUid instanceof Map
      ? options.preloadedLineupsByUid
      : null;
  const preloadedPicks = Array.isArray(options?.preloadedPicks)
    ? options.preloadedPicks
    : null;

  // Legacy callers still load the room pool. World Cup group polling passes
  // targeted player metadata so it never scans the full player collection.
  const posById = new Map();
  if (preloadedPlayersById) {
    for (const [playerId, player] of preloadedPlayersById.entries()) {
      const pid = String(player?.id ?? player?.playerId ?? playerId ?? "");
      if (!pid) continue;
      posById.set(pid, toPos(player?.position || player?.pos || player?.role));
    }
  } else {
    const playersSnap = await db.collection(`rooms/${roomId}/players`).get();
    playersSnap.forEach((doc) => {
      const d = doc.data() || {};
      const pid = String(d.id ?? d.playerId ?? doc.id);
      posById.set(pid, toPos(d.position || d.pos || d.role));
    });
  }

  // Load picks to build roster per user (in pick order if available)
  const pickRows = preloadedPicks || (
    await db.collection(`rooms/${roomId}/picks`).get()
  ).docs.map((doc) => ({
    id: doc.id,
    data: doc.data() || {},
  }));
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

  for (const row of pickRows) {
    const d = row?.data || row || {};
    const uid = inferOwnerUid(d);
    const pid = String(d.playerId ?? d.pid ?? d.apiPlayerId ?? d.player?.id ?? d.player?.playerId ?? "");
    if (!uid || !pid) continue;

    const arr = rosterByUid.get(uid) || [];
    arr.push({ pid, order: pickOrder(d), pos: posById.get(pid) || "MID" });
    rosterByUid.set(uid, arr);
  }

  const batch = db.batch();
  let writes = 0;
  const initializedLineupsByUid = {};

  for (const uid of memberUids) {
    const lineupRef = db.doc(`rooms/${roomId}/lineups/${uid}`);
    let existing = null;
    let lineupExists = false;

    if (preloadedLineupsByUid) {
      lineupExists = preloadedLineupsByUid.has(uid);
      existing = lineupExists
        ? preloadedLineupsByUid.get(uid) || {}
        : null;
    } else {
      const snap = await lineupRef.get();
      lineupExists = snap.exists;
      existing = snap.exists ? (snap.data() || {}) : null;
    }

    // Only create if missing or no starters. Check raw arrays so legacy
    // numeric/string IDs and newer nested lineup shapes are both preserved.
    const hasExistingStarters = [
      existing?.starters,
      existing?.startingXI,
      existing?.starting11,
      existing?.starterIds,
      existing?.startingIds,
      existing?.lineup?.starters,
      existing?.lineup?.startingXI,
      existing?.lineup?.starting11,
      existing?.currentLineup?.starters,
      existing?.currentLineup?.startingXI,
      existing?.currentLineup?.starting11,
    ].some((candidate) => Array.isArray(candidate) && candidate.length > 0);
    if (lineupExists && hasExistingStarters) continue;

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

    const initializedLineup = {
      starters,
      bench,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      autoInit: true,
    };

    batch.set(lineupRef, initializedLineup, { merge: true });
    initializedLineupsByUid[uid] = {
      ...(existing || {}),
      starters,
      bench,
      autoInit: true,
    };
    writes++;
  }

  if (writes > 0) await batch.commit();
  return {
    writes,
    initializedLineupsByUid,
    usedPreloadedData: Boolean(
      preloadedPlayersById &&
      preloadedLineupsByUid &&
      preloadedPicks
    ),
  };
}

function lineupEntryId(entry) {
  if (entry == null) return "";
  if (typeof entry === "string" || typeof entry === "number") {
    return String(entry).trim();
  }

  return String(
    entry.id ??
      entry.playerId ??
      entry.apiPlayerId ??
      entry.pid ??
      entry.player?.id ??
      ""
  ).trim();
}

function inferLineupPickOwnerUid(d = {}) {
  const v =
    d.ownerUid ??
    d.ownerId ??
    d.ownedBy ??
    d.managerUid ??
    d.userId ??
    d.uid ??
    d.pickedByUid ??
    d.pickedBy ??
    d.owner?.uid ??
    d.owner?.id;

  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.uid || v.id || null;
  return String(v);
}

function inferLineupPickPlayerId(d = {}) {
  const v =
    d.playerId ??
    d.pid ??
    d.apiPlayerId ??
    d.id ??
    d.player?.id ??
    d.player?.playerId;

  return v == null ? "" : String(v).trim();
}

async function loadOwnedLineupPlayerIdsForUser({ roomId, targetUid }) {
  const picksSnap = await db.collection(`rooms/${roomId}/picks`).get();
  const ownedPicks = [];

  for (const pickDoc of picksSnap.docs || []) {
    const data = pickDoc.data() || {};
    const ownerUid = inferLineupPickOwnerUid(data);
    if (String(ownerUid || "") !== String(targetUid)) continue;

    const playerId = inferLineupPickPlayerId(data);
    if (!playerId) continue;

    ownedPicks.push({
      pickDocId: pickDoc.id,
      playerId,
      data,
    });
  }

  ownedPicks.sort((a, b) => {
    const aOrder = Number(
      a.data?.turn ??
        a.data?.pickIndex ??
        a.data?.overallPick ??
        a.data?.pickNumber ??
        a.data?.createdAtMs
    );
    const bOrder = Number(
      b.data?.turn ??
        b.data?.pickIndex ??
        b.data?.overallPick ??
        b.data?.pickNumber ??
        b.data?.createdAtMs
    );
    const safeA = Number.isFinite(aOrder) ? aOrder : Number.MAX_SAFE_INTEGER;
    const safeB = Number.isFinite(bOrder) ? bOrder : Number.MAX_SAFE_INTEGER;

    return safeA - safeB || String(a.playerId).localeCompare(String(b.playerId));
  });

  const ownedPlayerIds = Array.from(
    new Set(ownedPicks.map((pick) => String(pick.playerId)).filter(Boolean))
  );

  return {
    ownedPicks,
    ownedPlayerIds,
    ownedPlayerIdSet: new Set(ownedPlayerIds),
  };
}

function sanitizeLineupIdsAgainstOwnedRoster({
  starters = [],
  bench = [],
  ownedPlayerIds = [],
}) {
  const ownedSet = new Set((ownedPlayerIds || []).map(String).filter(Boolean));
  const used = new Set();
  const removedInvalidPlayerIds = [];

  const cleanStarters = [];
  for (const rawId of starters || []) {
    const id = String(rawId || "").trim();
    if (!id) continue;

    if (!ownedSet.has(id)) {
      removedInvalidPlayerIds.push(id);
      continue;
    }

    if (used.has(id)) continue;
    if (cleanStarters.length >= 11) continue;
    cleanStarters.push(id);
    used.add(id);
  }

  const cleanBench = [];
  for (const rawId of bench || []) {
    const id = String(rawId || "").trim();
    if (!id) continue;

    if (!ownedSet.has(id)) {
      removedInvalidPlayerIds.push(id);
      continue;
    }

    if (used.has(id)) continue;
    cleanBench.push(id);
    used.add(id);
  }

  const addedMissingOwnedPlayerIdsToBench = [];
  for (const id of ownedPlayerIds || []) {
    const cleanId = String(id || "").trim();
    if (!cleanId || used.has(cleanId)) continue;

    cleanBench.push(cleanId);
    addedMissingOwnedPlayerIdsToBench.push(cleanId);
    used.add(cleanId);
  }

  return {
    starters: cleanStarters,
    bench: cleanBench,
    removedInvalidPlayerIds: Array.from(new Set(removedInvalidPlayerIds)),
    addedMissingOwnedPlayerIdsToBench,
  };
}

async function assertLineupPlayersOwnedByUser({
  roomId,
  targetUid,
  starters = [],
  bench = [],
}) {
  const submittedIds = Array.from(
    new Set([...(starters || []), ...(bench || [])].map(String).filter(Boolean))
  );

  if (!submittedIds.length) return;

  const picksSnap = await db.collection(`rooms/${roomId}/picks`).get();
  const ownedPlayerIds = new Set();

  for (const pickDoc of picksSnap.docs || []) {
    const data = pickDoc.data() || {};
    const ownerUid = inferLineupPickOwnerUid(data);
    if (String(ownerUid || "") !== String(targetUid)) continue;

    const playerId = inferLineupPickPlayerId(data);
    if (playerId) ownedPlayerIds.add(playerId);
  }

  const missingIds = submittedIds.filter((playerId) => !ownedPlayerIds.has(playerId));

  if (missingIds.length > 0) {
    throw new HttpsError(
      "failed-precondition",
      "Lineup contains players that are not on this manager's drafted roster.",
      {
        roomId,
        targetUid,
        missingIds,
        submittedIds,
        ownedPlayerIds: Array.from(ownedPlayerIds),
      }
    );
  }
}

function normalizeCanonicalLineupPlayer(d = {}, fallbackId = "") {
  const playerId = String(
    d.playerId ??
      d.pid ??
      d.apiPlayerId ??
      d.id ??
      d.player?.id ??
      d.player?.playerId ??
      fallbackId ??
      ""
  ).trim();

  if (!playerId) return null;

  const apiPlayerId = d.apiPlayerId ?? d.api_player_id ?? d.player?.id ?? null;
  const teamId = d.teamId ?? d.apiTeamId ?? d.team?.id ?? null;

  return {
    id: playerId,
    playerId,
    apiPlayerId: apiPlayerId != null ? String(apiPlayerId) : null,
    name:
      d.playerName ||
      d.name ||
      d.fullName ||
      d.displayName ||
      d.player?.name ||
      "Unknown",
    position: toPos(d.position || d.pos || d.role || d.player?.position || "MID"),
    teamId: teamId != null ? String(teamId) : null,
    apiTeamId: teamId != null ? String(teamId) : null,
    teamName: d.teamName || d.team?.name || "",
    teamLogo: d.teamLogo || d.team?.logo || "",
    nationality: d.nationality || d.country || d.player?.nationality || "",
  };
}

async function buildCanonicalLineupObjectsForUser({
  roomId,
  targetUid,
  starters = [],
  bench = [],
}) {
  const neededIds = Array.from(
    new Set([...(starters || []), ...(bench || [])].map(String).filter(Boolean))
  );

  const byId = new Map();

  const picksSnap = await db.collection(`rooms/${roomId}/picks`).get();

  for (const pickDoc of picksSnap.docs || []) {
    const data = pickDoc.data() || {};
    const ownerUid = inferLineupPickOwnerUid(data);
    if (String(ownerUid || "") !== String(targetUid)) continue;

    const playerId = inferLineupPickPlayerId(data);
    if (!playerId) continue;

    const canonical = normalizeCanonicalLineupPlayer(data, playerId);
    if (canonical) byId.set(playerId, canonical);
  }

  // Optional fallback: if a pick doc is light/missing metadata, enrich from rooms/{roomId}/players/{playerId}
  const missingMetaIds = neededIds.filter((playerId) => {
    const player = byId.get(playerId);
    return (
      !player ||
      !player.name ||
      player.name === "Unknown" ||
      !player.position ||
      !player.teamId
    );
  });

  if (missingMetaIds.length > 0) {
    const playerRefs = missingMetaIds.map((playerId) =>
      db.doc(`rooms/${roomId}/players/${playerId}`)
    );
    const playerSnaps = await db.getAll(...playerRefs);

    for (let i = 0; i < playerSnaps.length; i += 1) {
      const snap = playerSnaps[i];
      if (!snap.exists) continue;

      const playerId = missingMetaIds[i];
      const existing = byId.get(playerId) || {};
      const fromPlayerDoc = normalizeCanonicalLineupPlayer(snap.data() || {}, playerId);

      byId.set(playerId, {
        ...existing,
        ...fromPlayerDoc,
        id: playerId,
        playerId,
        name:
          existing.name && existing.name !== "Unknown"
            ? existing.name
            : fromPlayerDoc?.name || "Unknown",
        position: toPos(existing.position || fromPlayerDoc?.position || "MID"),
        teamId: existing.teamId || fromPlayerDoc?.teamId || null,
        apiTeamId: existing.apiTeamId || fromPlayerDoc?.apiTeamId || null,
        teamName: existing.teamName || fromPlayerDoc?.teamName || "",
        teamLogo: existing.teamLogo || fromPlayerDoc?.teamLogo || "",
        nationality: existing.nationality || fromPlayerDoc?.nationality || "",
      });
    }
  }

  const toCanonicalList = (ids = []) =>
    ids.map((playerId) => {
      const id = String(playerId);
      return (
        byId.get(id) || {
          id,
          playerId: id,
          name: "Unknown",
          position: "MID",
        }
      );
    });

  return {
    startingXI: toCanonicalList(starters),
    benchXI: toCanonicalList(bench),
  };
}

async function repairUserLineupFromCurrentPicks({
  db: firestoreDb,
  roomId,
  targetUid,
  nowMs = Date.now(),
  dryRun = false,
  reason = "manual-repair",
}) {
  const cleanRoomId = String(roomId || "").trim();
  const cleanTargetUid = String(targetUid || "").trim();
  if (!cleanRoomId || !cleanTargetUid) {
    throw new HttpsError(
      "invalid-argument",
      "roomId and targetUid are required."
    );
  }

  const roomRef = firestoreDb.doc(`rooms/${cleanRoomId}`);
  const lineupRef = roomRef.collection("lineups").doc(cleanTargetUid);
  const [roomSnap, picksSnap, lineupSnap] = await Promise.all([
    roomRef.get(),
    roomRef.collection("picks").get(),
    lineupRef.get(),
  ]);

  if (!roomSnap.exists) {
    throw new HttpsError("not-found", "Room not found.");
  }

  const ownedPicks = [];
  for (const pickDoc of picksSnap.docs || []) {
    const data = pickDoc.data() || {};
    const ownerUid = String(inferLineupPickOwnerUid(data) || "").trim();
    if (ownerUid !== cleanTargetUid) continue;

    const playerId = inferLineupPickPlayerId(data);
    if (!playerId) continue;
    ownedPicks.push({
      pickDocId: pickDoc.id,
      playerId,
      data,
    });
  }

  ownedPicks.sort((a, b) => {
    const aOrder = Number(
      a.data?.turn ??
        a.data?.pickIndex ??
        a.data?.overallPick ??
        a.data?.pickNumber ??
        a.data?.createdAtMs
    );
    const bOrder = Number(
      b.data?.turn ??
        b.data?.pickIndex ??
        b.data?.overallPick ??
        b.data?.pickNumber ??
        b.data?.createdAtMs
    );
    const safeA = Number.isFinite(aOrder) ? aOrder : Number.MAX_SAFE_INTEGER;
    const safeB = Number.isFinite(bOrder) ? bOrder : Number.MAX_SAFE_INTEGER;
    return safeA - safeB || a.playerId.localeCompare(b.playerId);
  });

  const ownedPlayerIds = Array.from(
    new Set(ownedPicks.map((pick) => pick.playerId).filter(Boolean))
  );
  const ownedPlayerIdSet = new Set(ownedPlayerIds);
  const pickByPlayerId = new Map(
    ownedPicks.map((pick) => [pick.playerId, pick.data])
  );
  const lineup = lineupSnap.exists ? lineupSnap.data() || {} : {};
  const currentStarters = (
    Array.isArray(lineup.starters)
      ? lineup.starters
      : Array.isArray(lineup.startingXI)
        ? lineup.startingXI
        : []
  )
    .map(lineupEntryId)
    .filter(Boolean);
  const currentBench = (
    Array.isArray(lineup.bench)
      ? lineup.bench
      : Array.isArray(lineup.benchXI)
        ? lineup.benchXI
        : []
  )
    .map(lineupEntryId)
    .filter(Boolean);
  const currentIds = Array.from(
    new Set([...currentStarters, ...currentBench])
  );
  const invalidCurrentIds = currentIds.filter(
    (playerId) => !ownedPlayerIdSet.has(playerId)
  );

  const nextStarters = [];
  const usedIds = new Set();
  for (const playerId of currentStarters) {
    if (
      ownedPlayerIdSet.has(playerId) &&
      !usedIds.has(playerId) &&
      nextStarters.length < 11
    ) {
      nextStarters.push(playerId);
      usedIds.add(playerId);
    }
  }

  const benchCandidates = [];
  for (const playerId of currentBench) {
    if (ownedPlayerIdSet.has(playerId) && !usedIds.has(playerId)) {
      benchCandidates.push(playerId);
      usedIds.add(playerId);
    }
  }

  const addedNewPlayerIdsToBench = [];
  for (const playerId of ownedPlayerIds) {
    if (usedIds.has(playerId)) continue;
    benchCandidates.push(playerId);
    addedNewPlayerIdsToBench.push(playerId);
    usedIds.add(playerId);
  }

  if (nextStarters.length === 0 && benchCandidates.length > 0) {
    const goalkeeperIndex = benchCandidates.findIndex(
      (playerId) =>
        toPos(pickByPlayerId.get(playerId)?.position || "") === "GK"
    );
    if (goalkeeperIndex > 0) {
      const [goalkeeperId] = benchCandidates.splice(goalkeeperIndex, 1);
      benchCandidates.unshift(goalkeeperId);
    }
  }

  while (nextStarters.length < 11 && benchCandidates.length > 0) {
    nextStarters.push(benchCandidates.shift());
  }
  const nextBench = benchCandidates;
  const canonicalLineup = await buildCanonicalLineupObjectsForUser({
    roomId: cleanRoomId,
    targetUid: cleanTargetUid,
    starters: nextStarters,
    bench: nextBench,
  });

  const result = {
    ok: true,
    dryRun: Boolean(dryRun),
    roomId: cleanRoomId,
    targetUid: cleanTargetUid,
    reason,
    currentStarters,
    currentBench,
    ownedPlayerIds,
    invalidCurrentIds,
    removedInvalidPlayerIds: invalidCurrentIds,
    addedNewPlayerIdsToBench,
    nextStarters,
    nextBench,
    starterCount: nextStarters.length,
    benchCount: nextBench.length,
  };

  if (!dryRun) {
    await lineupRef.set(
      {
        uid: cleanTargetUid,
        starters: nextStarters,
        bench: nextBench,
        startingXI: canonicalLineup.startingXI,
        benchXI: canonicalLineup.benchXI,
        updatedAt: FieldValue.serverTimestamp(),
        updatedAtMs: nowMs,
        lineupSyncedAfterRosterChangeAtMs: nowMs,
        lineupSyncedAfterRosterChangeReason: reason,
        removedInvalidPlayerIds: invalidCurrentIds,
        addedNewPlayerIdsToBench,
      },
      { merge: true }
    );
  }

  return result;
}

function assertPlayerRemovalNotWorldCupLocked({
  room,
  lineup,
  playerId,
  nowMs = Date.now(),
}) {
  if (!isWorldCupDailyLineupRoom(room)) return;
  const cleanPlayerId = String(playerId || "").trim();
  const lock = getActiveWorldCupDailyLocks(lineup || {}, nowMs)[cleanPlayerId];
  if (!lock) return;

  throw new HttpsError(
    "failed-precondition",
    `Player is locked by World Cup Group Stage lineup lock until ${formatWorldCupDailyLockDate(lock)}.`,
    {
      playerId: cleanPlayerId,
      lockedUntilMs: Number(lock.lockedUntilMs || 0),
    }
  );
}

exports.repairUserLineupFromPicks = onCall(
  { region: "us-west2", timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }

    const roomId = String(request.data?.roomId || "").trim();
    const targetUid = String(request.data?.targetUid || "").trim();
    const dryRun = request.data?.dryRun !== false;
    if (!roomId || !targetUid) {
      throw new HttpsError(
        "invalid-argument",
        "roomId and targetUid are required."
      );
    }

    const roomSnap = await db.doc(`rooms/${roomId}`).get();
    if (!roomSnap.exists) {
      throw new HttpsError("not-found", "Room not found.");
    }
    const room = roomSnap.data() || {};
    if (!isHost(room, uid) && !ADMIN_UIDS.has(String(uid))) {
      throw new HttpsError(
        "permission-denied",
        "Only the room host or owner can repair another user's lineup."
      );
    }

    return repairUserLineupFromCurrentPicks({
      db,
      roomId,
      targetUid,
      nowMs: Date.now(),
      dryRun,
      reason: dryRun ? "manual-repair-dry-run" : "manual-repair",
    });
  }
);

exports.applyAcceptedTrade = onCall(
  { region: "us-west2", timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }

    const roomId = String(request.data?.roomId || "").trim();
    const tradeId = String(request.data?.tradeId || "").trim();
    if (!roomId || !tradeId) {
      throw new HttpsError(
        "invalid-argument",
        "roomId and tradeId are required."
      );
    }

    const roomRef = db.doc(`rooms/${roomId}`);
    const tradeRef = roomRef.collection("trades").doc(tradeId);
    const [roomSnap, tradeSnap, picksSnap] = await Promise.all([
      roomRef.get(),
      tradeRef.get(),
      roomRef.collection("picks").get(),
    ]);

    if (!roomSnap.exists) {
      throw new HttpsError("not-found", "Room not found.");
    }
    const room = roomSnap.data() || {};
    if (!isHost(room, uid)) {
      throw new HttpsError("permission-denied", "Only host can apply trades.");
    }
    if (!tradeSnap.exists) {
      throw new HttpsError("not-found", "Trade not found.");
    }

    const trade = tradeSnap.data() || {};
    if (trade.status !== "accepted") {
      return { ok: true, roomId, tradeId, status: trade.status };
    }
    if (trade.appliedAt) {
      return { ok: true, roomId, tradeId, status: "completed" };
    }

    const normalizeTradeEntry = (entry = {}) => ({
      pickId: String(
        entry.pickId || entry.pickDocId || entry.docId || ""
      ).trim(),
      playerId: inferLineupPickPlayerId(entry),
      name:
        entry.playerName ||
        entry.name ||
        entry.fullName ||
        entry.displayName ||
        entry.player?.name ||
        "Unknown",
      position: entry.position || entry.pos || "SUB",
      teamId: entry.teamId || entry.apiTeamId || entry.team?.id || null,
      teamName: entry.teamName || entry.team?.name || "",
      teamLogo: entry.teamLogo || entry.team?.logo || "",
      nationality: entry.nationality || entry.country || "",
      apiPlayerId:
        entry.apiPlayerId || entry.player?.id || entry.playerId || null,
    });
    const give = (Array.isArray(trade.give) ? trade.give : [])
      .map(normalizeTradeEntry);
    const receive = (Array.isArray(trade.receive) ? trade.receive : [])
      .map(normalizeTradeEntry);
    if (give.length < 1 || give.length > 2 || receive.length !== give.length) {
      throw new HttpsError("failed-precondition", "Invalid trade player count.");
    }

    const pickDocs = picksSnap.docs.map((pickDoc) => ({
      id: pickDoc.id,
      ref: pickDoc.ref,
      ...(pickDoc.data() || {}),
    }));
    const findTradePick = (entry, expectedOwnerUid) => {
      if (entry.pickId) {
        const exact = pickDocs.find((pick) => pick.id === entry.pickId);
        if (exact) return exact;
      }
      return pickDocs.find(
        (pick) =>
          String(inferLineupPickOwnerUid(pick) || "") ===
            String(expectedOwnerUid || "") &&
          inferLineupPickPlayerId(pick) === String(entry.playerId || "")
      );
    };
    const fromPicks = give.map((entry) =>
      findTradePick(entry, trade.fromUid)
    );
    const toPicks = receive.map((entry) =>
      findTradePick(entry, trade.toUid)
    );
    if (fromPicks.some((pick) => !pick) || toPicks.some((pick) => !pick)) {
      await tradeRef.set(
        {
          status: "rejected",
          failureReason: "TRADE_PICK_NOT_OWNED",
          respondedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: Date.now(),
        },
        { merge: true }
      );
      return { ok: true, roomId, tradeId, status: "rejected" };
    }

    const nowMs = Date.now();
    const fromLineupRef = roomRef.collection("lineups").doc(String(trade.fromUid));
    const toLineupRef = roomRef.collection("lineups").doc(String(trade.toUid));
    const transactionResult = await db.runTransaction(async (tx) => {
      const freshRoomSnap = await tx.get(roomRef);
      const freshTradeSnap = await tx.get(tradeRef);
      const freshFromLineupSnap = await tx.get(fromLineupRef);
      const freshToLineupSnap = await tx.get(toLineupRef);
      const freshFromPickSnaps = [];
      const freshToPickSnaps = [];

      for (const pick of fromPicks) {
        freshFromPickSnaps.push(await tx.get(pick.ref));
      }
      for (const pick of toPicks) {
        freshToPickSnaps.push(await tx.get(pick.ref));
      }

      if (!freshRoomSnap.exists) {
        throw new HttpsError("not-found", "Room not found.");
      }
      const freshRoom = freshRoomSnap.data() || {};
      if (!isHost(freshRoom, uid)) {
        throw new HttpsError(
          "permission-denied",
          "Only host can apply trades."
        );
      }
      if (!freshTradeSnap.exists) {
        throw new HttpsError("not-found", "Trade not found.");
      }
      const freshTrade = freshTradeSnap.data() || {};
      if (freshTrade.status !== "accepted" || freshTrade.appliedAt) {
        return {
          applied: false,
          status: freshTrade.appliedAt ? "completed" : freshTrade.status,
        };
      }

      freshFromPickSnaps.forEach((snap, index) => {
        const data = snap.exists ? snap.data() || {} : {};
        if (
          !snap.exists ||
          String(inferLineupPickOwnerUid(data) || "") !==
            String(freshTrade.fromUid || "") ||
          inferLineupPickPlayerId(data) !== give[index].playerId
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Sender no longer owns an offered player."
          );
        }
      });
      freshToPickSnaps.forEach((snap, index) => {
        const data = snap.exists ? snap.data() || {} : {};
        if (
          !snap.exists ||
          String(inferLineupPickOwnerUid(data) || "") !==
            String(freshTrade.toUid || "") ||
          inferLineupPickPlayerId(data) !== receive[index].playerId
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Receiver no longer owns a requested player."
          );
        }
      });

      const fromLineup = freshFromLineupSnap.exists
        ? freshFromLineupSnap.data() || {}
        : {};
      const toLineup = freshToLineupSnap.exists
        ? freshToLineupSnap.data() || {}
        : {};
      for (const entry of give) {
        assertPlayerRemovalNotWorldCupLocked({
          room: freshRoom,
          lineup: fromLineup,
          playerId: entry.playerId,
          nowMs,
        });
      }
      for (const entry of receive) {
        assertPlayerRemovalNotWorldCupLocked({
          room: freshRoom,
          lineup: toLineup,
          playerId: entry.playerId,
          nowMs,
        });
      }

      for (let index = 0; index < give.length; index += 1) {
        tx.update(fromPicks[index].ref, {
          playerId: String(receive[index].playerId),
          apiPlayerId:
            receive[index].apiPlayerId != null
              ? String(receive[index].apiPlayerId)
              : null,
          name: receive[index].name,
          playerName: receive[index].name,
          position: receive[index].position || "SUB",
          teamId: receive[index].teamId,
          teamName: receive[index].teamName,
          teamLogo: receive[index].teamLogo,
          nationality: receive[index].nationality,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: nowMs,
        });
        tx.update(toPicks[index].ref, {
          playerId: String(give[index].playerId),
          apiPlayerId:
            give[index].apiPlayerId != null
              ? String(give[index].apiPlayerId)
              : null,
          name: give[index].name,
          playerName: give[index].name,
          position: give[index].position || "SUB",
          teamId: give[index].teamId,
          teamName: give[index].teamName,
          teamLogo: give[index].teamLogo,
          nationality: give[index].nationality,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: nowMs,
        });
      }

      tx.set(
        tradeRef,
        {
          status: "completed",
          appliedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: nowMs,
        },
        { merge: true }
      );
      return { applied: true, status: "completed" };
    });

    const lineupRepairs = [];
    const lineupRepairErrors = [];
    if (transactionResult.applied) {
      for (const targetUid of [trade.fromUid, trade.toUid]) {
        try {
          lineupRepairs.push(
            await repairUserLineupFromCurrentPicks({
              db,
              roomId,
              targetUid,
              nowMs,
              dryRun: false,
              reason: "direct-trade-completed",
            })
          );
        } catch (error) {
          console.error("[applyAcceptedTrade] lineup repair failed", {
            roomId,
            tradeId,
            targetUid,
            code: error?.code,
            message: error?.message,
          });
          lineupRepairErrors.push({
            targetUid,
            code: error?.code || "unknown",
            message: error?.message || String(error),
          });
        }
      }

      if (lineupRepairErrors.length > 0) {
        await tradeRef.set(
          {
            lineupRepairErrors,
            lineupRepairFailedAtMs: Date.now(),
          },
          { merge: true }
        );
      } else {
        await tradeRef.set(
          {
            lineupRepairErrors: FieldValue.delete(),
            lineupRepairFailedAtMs: FieldValue.delete(),
          },
          { merge: true }
        );
      }
    }

    return {
      ok: true,
      roomId,
      tradeId,
      status: transactionResult.status,
      lineupRepairs,
      lineupRepairErrors,
    };
  }
);

function assertWorldCupDailyLineupLocks({
  room,
  lineup,
  nextStarters,
  nowMs = Date.now(),
}) {
  if (!isWorldCupDailyLineupRoom(room)) return;

  const violation = findWorldCupDailyLockViolation({
    lineup,
    nextStarters,
    nowMs,
  });
  if (!violation) return;

  const playerName = violation.playerName || "This player";
  const unlockLabel = formatWorldCupDailyLockDate(violation);
  throw new HttpsError(
    "failed-precondition",
    `${playerName} is locked until ${unlockLabel} because they appeared in a World Cup Group Stage match.`
  );
}

function assertWorldCupDailyRoomIsNotLive(room = {}) {
  if (!isWorldCupDailyLineupRoom(room)) return;
  const status = String(
    getCompetitionState(room)?.weekStatus ||
      room?.competitionState?.weekStatus ||
      room?.status ||
      ""
  ).toLowerCase();

  if (status === "live" || status === "resolving") {
    throw new HttpsError(
      "failed-precondition",
      "World Cup Group Stage lineups cannot be changed while matches are live or resolving."
    );
  }
}

async function assertWorldCupDailySubstitutionPlayersNotStarted({
  roomId,
  room,
  playerIds = [],
  nowMs = Date.now(),
}) {
  if (!isWorldCupDailyLineupRoom(room)) return;

  const cleanPlayerIds = Array.from(
    new Set(
      (Array.isArray(playerIds) ? playerIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )
  );
  if (!cleanPlayerIds.length) return;

  const currentDayIndex = Number(
    room?.worldCup?.currentDayIndex ||
      room?.currentDayIndex ||
      room?.competitionState?.currentDayIndex ||
      0
  );
  if (!Number.isFinite(currentDayIndex) || currentDayIndex <= 0) return;

  const daySnap = await db
    .doc(`rooms/${roomId}/days/${String(currentDayIndex)}`)
    .get();
  if (!daySnap.exists) return;

  const day = daySnap.data() || {};
  const fixtures = Array.isArray(day.fixtures) ? day.fixtures : [];
  if (!fixtures.length) return;

  const playerRefs = cleanPlayerIds.map((playerId) =>
    db.doc(`rooms/${roomId}/players/${playerId}`)
  );
  const playerSnaps = await db.getAll(...playerRefs);
  const playerTeamById = new Map();

  for (let index = 0; index < playerSnaps.length; index += 1) {
    const data = playerSnaps[index]?.exists
      ? playerSnaps[index].data() || {}
      : {};
    const teamId = String(
      data.teamId ??
        data.apiTeamId ??
        data.team?.id ??
        ""
    ).trim();

    if (teamId) {
      playerTeamById.set(cleanPlayerIds[index], teamId);
    }
  }

  const lockedPlayers = [];

  for (const playerId of cleanPlayerIds) {
    const teamId = playerTeamById.get(playerId);
    if (!teamId) continue;

    for (const fixture of fixtures) {
      const homeTeamId = String(
        fixture?.homeTeamId ??
          fixture?.teams?.home?.id ??
          fixture?.home?.id ??
          ""
      ).trim();
      const awayTeamId = String(
        fixture?.awayTeamId ??
          fixture?.teams?.away?.id ??
          fixture?.away?.id ??
          ""
      ).trim();

      if (teamId !== homeTeamId && teamId !== awayTeamId) continue;

      const fixtureId = String(
        fixture?.fixtureId ??
          fixture?.id ??
          fixture?.fixture?.id ??
          ""
      ).trim();
      const kickoffMsRaw =
        fixture?.kickoffMs ??
        fixture?.startAtMs ??
        fixture?.fixture?.timestamp ??
        fixture?.timestamp ??
        null;
      const kickoffMsNumber = Number(kickoffMsRaw);
      const parsedKickoffMs = Date.parse(
        fixture?.fixture?.date ||
          fixture?.date ||
          fixture?.kickoff ||
          fixture?.startAt ||
          ""
      );
      const kickoffMs =
        Number.isFinite(kickoffMsNumber) && kickoffMsNumber > 0
          ? kickoffMsNumber < 100000000000
            ? kickoffMsNumber * 1000
            : kickoffMsNumber
          : Number.isFinite(parsedKickoffMs)
            ? parsedKickoffMs
            : null;
      const statusShort = String(
        day?.fixtureStatusById?.[fixtureId] ||
          fixture?.statusShort ||
          fixture?.fixtureStatus ||
          fixture?.matchStatus ||
          fixture?.fixture?.status?.short ||
          ""
      )
        .trim()
        .toUpperCase();
      const hasFixtureKickedOff =
        (Number.isFinite(kickoffMs) && kickoffMs > 0 && nowMs >= kickoffMs) ||
        (
          statusShort &&
          !["NS", "TBD", "PST", "CANC"].includes(statusShort)
        );

      if (hasFixtureKickedOff) {
        lockedPlayers.push({
          playerId,
          teamId,
          fixtureId,
          statusShort,
          kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : null,
        });
        break;
      }
    }
  }

  if (lockedPlayers.length > 0) {
    throw new HttpsError(
      "failed-precondition",
      "This player cannot be moved because their World Cup Group Stage match has already kicked off.",
      {
        roomId,
        currentDayIndex,
        lockedPlayers,
      }
    );
  }
}

exports.saveWorldCupDailyLineup = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

    const roomId = String(request.data?.roomId || "").trim();
    const targetUid = String(request.data?.targetUid || uid).trim() || uid;
    if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (!isWorldCupDailyLineupRoom(room)) {
      throw new HttpsError(
        "failed-precondition",
        "This lineup save is only for World Cup Group Stage rooms."
      );
    }
    if (uid !== targetUid && !isHost(room, uid)) {
      throw new HttpsError("permission-denied", "Not allowed to edit this lineup.");
    }
    assertWorldCupDailyRoomIsNotLive(room);

    const starters = (Array.isArray(request.data?.starters) ? request.data.starters : [])
      .map(lineupEntryId)
      .filter(Boolean);
    const bench = (Array.isArray(request.data?.bench) ? request.data.bench : [])
      .map(lineupEntryId)
      .filter(Boolean);

    if (starters.length > 11) {
      throw new HttpsError("invalid-argument", "A starting lineup cannot exceed 11 players.");
    }
    if (new Set(starters).size !== starters.length || new Set(bench).size !== bench.length) {
      throw new HttpsError("invalid-argument", "Lineup player IDs must be unique.");
    }
    if (starters.some((playerId) => bench.includes(playerId))) {
      throw new HttpsError(
        "invalid-argument",
        "A player cannot be both a starter and a bench player."
      );
    }

    await assertLineupPlayersOwnedByUser({
      roomId,
      targetUid,
      starters,
      bench,
    });

    const canonicalLineup = await buildCanonicalLineupObjectsForUser({
      roomId,
      targetUid,
      starters,
      bench,
    });

    const lineupRef = db.doc(`rooms/${roomId}/lineups/${targetUid}`);
    const lineupSnap = await lineupRef.get();
    const lineup = lineupSnap.exists ? lineupSnap.data() || {} : {};
    const nowMs = Date.now();

    assertWorldCupDailyLineupLocks({
      room,
      lineup,
      nextStarters: starters,
      nowMs,
    });

    const lineupPatch = {
      uid: targetUid,
      starters,
      bench,
      startingXI: canonicalLineup.startingXI,
      benchXI: canonicalLineup.benchXI,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: uid,
    };

    await lineupRef.set(lineupPatch, { merge: true });

    return {
      ok: true,
      roomId,
      targetUid,
      starters,
      bench,
    };
  }
);

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
    const nowMs = Date.now();

    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

    const room = roomSnap.data() || {};
    if (uid !== targetUid && !isHost(room, uid)) {
      throw new HttpsError("permission-denied", "Not allowed to edit this lineup.");
    }
    if (!isWorldCupDailyLineupRoom(room)) {
      assertWorldCupDailyRoomIsNotLive(room);
    }

    const lineupRef = db.doc(`rooms/${roomId}/lineups/${targetUid}`);
    let lineupSnap = await lineupRef.get();

    if (!lineupSnap.exists) {
      await ensureDefaultLineupsForRoom(roomId, [targetUid]);
      lineupSnap = await lineupRef.get();
    }

    const lineup = lineupSnap.exists ? (lineupSnap.data() || {}) : {};
    const savedStarterEntries = Array.isArray(lineup?.starters)
      ? lineup.starters
      : Array.isArray(lineup?.startingXI)
        ? lineup.startingXI
        : [];
    const savedBenchEntries = Array.isArray(lineup?.bench)
      ? lineup.bench
      : Array.isArray(lineup?.benchXI)
        ? lineup.benchXI
        : [];
    let starters = savedStarterEntries.map(lineupEntryId).filter(Boolean);
    let bench = savedBenchEntries.map(lineupEntryId).filter(Boolean);
    const startingXI = Array.isArray(lineup?.startingXI) ? lineup.startingXI : null;
    const benchXI = Array.isArray(lineup?.benchXI) ? lineup.benchXI : null;
    let repairedBeforeSubstitution = false;
    let removedInvalidPlayerIds = [];
    let addedMissingOwnedPlayerIdsToBench = [];

    if (isWorldCupDailyLineupRoom(room)) {
      const {
        ownedPlayerIds,
        ownedPlayerIdSet,
      } = await loadOwnedLineupPlayerIdsForUser({
        roomId,
        targetUid,
      });

      if (!ownedPlayerIdSet.has(starterOutId)) {
        throw new HttpsError(
          "failed-precondition",
          "starterOutId is not on this manager's drafted roster.",
          {
            roomId,
            targetUid,
            starterOutId,
            ownedPlayerIds,
          }
        );
      }

      if (!ownedPlayerIdSet.has(benchInId)) {
        throw new HttpsError(
          "failed-precondition",
          "benchInId is not on this manager's drafted roster.",
          {
            roomId,
            targetUid,
            benchInId,
            ownedPlayerIds,
          }
        );
      }

      await assertWorldCupDailySubstitutionPlayersNotStarted({
        roomId,
        room,
        playerIds: [starterOutId, benchInId],
        nowMs,
      });

      const sanitized = sanitizeLineupIdsAgainstOwnedRoster({
        starters,
        bench,
        ownedPlayerIds,
      });

      starters = sanitized.starters;
      bench = sanitized.bench;
      removedInvalidPlayerIds = sanitized.removedInvalidPlayerIds;
      addedMissingOwnedPlayerIdsToBench =
        sanitized.addedMissingOwnedPlayerIdsToBench;
      repairedBeforeSubstitution =
        removedInvalidPlayerIds.length > 0 ||
        addedMissingOwnedPlayerIdsToBench.length > 0 ||
        starters.length !== savedStarterEntries.length ||
        bench.length !== savedBenchEntries.length;
    }

    if (!starters.includes(starterOutId)) {
      throw new HttpsError(
        "failed-precondition",
        "Your lineup changed or is still syncing. Refresh the roster and try that substitution again.",
        {
          reason: "starter-out-not-in-starters",
          roomId,
          targetUid,
          starterOutId,
          benchInId,
          savedStarters: savedStarterEntries.map(lineupEntryId).filter(Boolean),
          savedBench: savedBenchEntries.map(lineupEntryId).filter(Boolean),
          starters,
          bench,
          repairedBeforeSubstitution,
          removedInvalidPlayerIds,
          addedMissingOwnedPlayerIdsToBench,
        }
      );
    }

    if (!bench.includes(benchInId)) {
      throw new HttpsError(
        "failed-precondition",
        "Your lineup changed or is still syncing. Refresh the roster and try that substitution again.",
        {
          reason: "bench-in-not-in-bench",
          roomId,
          targetUid,
          starterOutId,
          benchInId,
          savedStarters: savedStarterEntries.map(lineupEntryId).filter(Boolean),
          savedBench: savedBenchEntries.map(lineupEntryId).filter(Boolean),
          starters,
          bench,
          repairedBeforeSubstitution,
          removedInvalidPlayerIds,
          addedMissingOwnedPlayerIdsToBench,
        }
      );
    }

    const nextStarters = starters.map((id) =>
      id === starterOutId ? benchInId : id
    );
    const nextBench = bench.map((id) =>
      id === benchInId ? starterOutId : id
    );
    if (isWorldCupDailyLineupRoom(room)) {
      await assertLineupPlayersOwnedByUser({
        roomId,
        targetUid,
        starters: nextStarters,
        bench: nextBench,
      });
    }

    const canonicalLineup = isWorldCupDailyLineupRoom(room)
      ? await buildCanonicalLineupObjectsForUser({
          roomId,
          targetUid,
          starters: nextStarters,
          bench: nextBench,
        })
      : null;

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
    let nextStartingXI = canonicalLineup?.startingXI || startingXI;
    let nextBenchXI = canonicalLineup?.benchXI || benchXI;

    if (!canonicalLineup && Array.isArray(startingXI) && Array.isArray(benchXI)) {
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
    const scoringNextStarters = Array.isArray(nextStartingXI)
      ? nextStartingXI.map(lineupEntryId)
      : nextStarters;
    if (
      isWorldCupDailyLineupRoom(room) &&
      (
        scoringNextStarters.length !== nextStarters.length ||
        scoringNextStarters.some((playerId, index) => playerId !== nextStarters[index])
      )
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Lineup starter fields are out of sync. Refresh the roster and try again."
      );
    }

    assertWorldCupDailyLineupLocks({
      room,
      lineup,
      nextStarters: scoringNextStarters,
      nowMs,
    });

    const lineupPatch = {
      uid: targetUid,
      starters: nextStarters,
      bench: nextBench,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAtMs: nowMs,
      updatedBy: uid,
    };

    if (canonicalLineup) {
      lineupPatch.startingXI = canonicalLineup.startingXI;
      lineupPatch.benchXI = canonicalLineup.benchXI;
    } else {
      if (Array.isArray(nextStartingXI)) {
        lineupPatch.startingXI = nextStartingXI;
      }

      if (Array.isArray(nextBenchXI)) {
        lineupPatch.benchXI = nextBenchXI;
      }
    }

    await lineupRef.set(lineupPatch, { merge: true });

    return {
      ok: true,
      starters: nextStarters,
      bench: nextBench,
      repairedBeforeSubstitution,
      removedInvalidPlayerIds,
      addedMissingOwnedPlayerIdsToBench,
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
      windowMode: window.windowMode || (window.roundLabel ? "round" : "fixture-cluster"),

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
    await writeInitialWeekResultsPlaceholder({
      roomId,
      weekIndex,
      weekDoc,
      memberUids,
      nowMs,
    });

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
  const statusShort = String(fixtureMeta?.statusShort || fixtureMeta?.fixtureStatus || "").trim().toUpperCase() || null;
  const homeTeamId = fixtureMeta?.homeTeamId ?? null;
  const awayTeamId = fixtureMeta?.awayTeamId ?? null;
  const homeTeamName = fixtureMeta?.homeTeamName || "";
  const awayTeamName = fixtureMeta?.awayTeamName || "";
  const homeTeamLogo = fixtureMeta?.homeTeamLogo || "";
  const awayTeamLogo = fixtureMeta?.awayTeamLogo || "";
  const isLive = statusShort ? isInPlay(statusShort) && !isFinalStatusCode(statusShort) : false;

  for (const t of teams) {
    const teamId = t.team?.id;
    const teamName = t.team?.name || "";
    
    // Find Opponent
    const opponent = teams.find(x => x.team?.id !== teamId);
    let opponentName = opponent?.team?.name || "";
    
    const players = Array.isArray(t?.players) ? t.players : [];
    
    for (const row of players) {
      const pid = row?.player?.id;
      if (!pid) continue;

      const st = Array.isArray(row?.statistics) ? row.statistics[0] : null;
      if (!st) continue;

      // ... (Keep your existing minutes/goals/passes logic here) ...
      const minutes = toNum(st?.games?.minutes);
      const goalsTotal = toNum(st?.goals?.total);
      const pensScored = toNum(st?.penalty?.scored);
      // API-Football can report a live penalty before goals.total catches up.
      // Math.max recovers that goal without double-counting once total includes it.
      const goals = Math.max(goalsTotal, pensScored);
      const assists = toNum(st?.goals?.assists);
      const passesCompleted = toNum(st?.passes?.total); // Using Total Passes as discussed
      
      const saves = toNum(st?.goals?.saves);
      const yellow = toNum(st?.cards?.yellow);
      const red = toNum(st?.cards?.red);
      const pensSaved = toNum(st?.penalty?.saved);
      const pensMissed = toNum(st?.penalty?.missed);
      const rating = toNum(st?.games?.rating);

      const tackles = toNum(st?.tackles?.total);
      const duelsWon = toNum(st?.duels?.won);
      const dribblesSuccess = toNum(st?.dribbles?.success);

      const foulsCommitted = toNum(st?.fouls?.committed);
      const offsides = toNum(st?.offsides);
      const shotsOnTarget = toNum(st?.shots?.on);
      const pensCommitted = toNum(st?.penalty?.commited ?? st?.penalty?.committed);
      const rawApiPositionOriginal =
        st?.games?.position === undefined || st?.games?.position === null || String(st.games.position).trim() === ""
          ? null
          : String(st.games.position).trim();
      // Preserve API truth: missing API position should stay empty, not become a fake MID.
      const rawApiPosition = rawApiPositionOriginal ? toPos(rawApiPositionOriginal) : null;

      // raw from API (mostly only useful for GK)
      const rawConceded = toNum(st?.goals?.conceded);

      // fixture-based score/conceded
      let teamConceded = rawConceded;
      let teamScore = null;
      let opponentScore = null;

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
          if (!opponentName && awayTeamName) opponentName = awayTeamName;
        } else if (teamIdStr === awayTeamIdStr) {
          teamConceded = goalsHome;
          teamScore = goalsAway;
          opponentScore = goalsHome;
          if (!opponentName && homeTeamName) opponentName = homeTeamName;
        }
      }

      // Use teamConceded for clean sheet + conceded scoring
      const goalsConceded = teamConceded;          // store real conceded
      const cleanSheet = minutes > 0 && teamConceded === 0;

      const ownGoals = 0; 

      out[String(pid)] = { 
        fixtureId: fixtureMeta?.fixtureId ? String(fixtureMeta.fixtureId) : "",
        teamId: teamId ? String(teamId) : "",
        teamName,
        opponentName,
        homeTeamId: homeTeamId != null ? String(homeTeamId) : "",
        awayTeamId: awayTeamId != null ? String(awayTeamId) : "",
        homeTeamName,
        awayTeamName,
        homeTeamLogo,
        awayTeamLogo,

        teamScore,
        opponentScore,
        teamGoals: teamScore,
        opponentGoals: opponentScore,
        goalsHome,
        goalsAway,
        fixtureStatus: fixtureMeta?.fixtureStatus || statusShort,
        matchStatus: statusShort || fixtureMeta?.fixtureStatus || null,
        statusShort,
        statusLong: fixtureMeta?.statusLong || null,
        elapsed: fixtureMeta?.elapsed ?? null,
        extra: fixtureMeta?.extra ?? null,
        statusUpdatedAtMs: fixtureMeta?.statusUpdatedAtMs ?? null,
        kickoffMs: fixtureMeta?.kickoffMs ?? null,
        isLive,
        minutes, 
        goals, 
        assists, 
        pensScored,

        passesCompleted,
        saves,
        goalsConceded,
        yellow,
        red,
        pensSaved,
        pensMissed,
        cleanSheet,
        ownGoals,
        rawApiPositionOriginal,
        rawApiPosition,
        position: rawApiPosition,
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

function patchPlayerStatsWithFixtureMeta(playerStats = {}, fixtureMeta = {}) {
  const statusShort = String(
    fixtureMeta?.statusShort ||
    fixtureMeta?.fixtureStatus ||
    fixtureMeta?.matchStatus ||
    ""
  ).trim().toUpperCase();
  const hasCurrentStatus = Boolean(statusShort);
  const isLiveNow = hasCurrentStatus ? isInPlay(statusShort) && !isFinalStatusCode(statusShort) : null;
  const patched = {};

  for (const [pid, stats] of Object.entries(playerStats || {})) {
    patched[pid] = {
      ...(stats || {}),
      fixtureId: fixtureMeta?.fixtureId ? String(fixtureMeta.fixtureId) : stats?.fixtureId || "",
      statusShort: statusShort || stats?.statusShort || null,
      fixtureStatus: statusShort || stats?.fixtureStatus || null,
      matchStatus: statusShort || stats?.matchStatus || null,
      statusLong: fixtureMeta?.statusLong || stats?.statusLong || null,
      elapsed: fixtureMeta?.elapsed ?? stats?.elapsed ?? null,
      extra: fixtureMeta?.extra ?? stats?.extra ?? null,
      statusUpdatedAtMs: fixtureMeta?.statusUpdatedAtMs ?? stats?.statusUpdatedAtMs ?? null,
      kickoffMs: fixtureMeta?.kickoffMs ?? stats?.kickoffMs ?? null,
      isLive: isLiveNow == null ? Boolean(stats?.isLive) : isLiveNow,
      homeTeamId: fixtureMeta?.homeTeamId != null ? String(fixtureMeta.homeTeamId) : stats?.homeTeamId || "",
      awayTeamId: fixtureMeta?.awayTeamId != null ? String(fixtureMeta.awayTeamId) : stats?.awayTeamId || "",
      homeTeamName: fixtureMeta?.homeTeamName || stats?.homeTeamName || "",
      awayTeamName: fixtureMeta?.awayTeamName || stats?.awayTeamName || "",
      homeTeamLogo: fixtureMeta?.homeTeamLogo || stats?.homeTeamLogo || "",
      awayTeamLogo: fixtureMeta?.awayTeamLogo || stats?.awayTeamLogo || "",
      goalsHome: fixtureMeta?.goalsHome ?? stats?.goalsHome ?? null,
      goalsAway: fixtureMeta?.goalsAway ?? stats?.goalsAway ?? null,
    };
  }

  return patched;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function incrementFixtureStatsDebug(statsDebug, key) {
  if (!statsDebug || typeof statsDebug !== "object") return;
  statsDebug[key] = Number(statsDebug[key] || 0) + 1;
}

function getFixturePlayersCacheStats(cacheDoc = {}) {
  return cacheDoc?.playerStats && typeof cacheDoc.playerStats === "object"
    ? cacheDoc.playerStats
    : {};
}

function shouldUseFixturePlayersCache(cacheDoc = {}, fixtureMeta = {}, nowMs, ttlMs, forceRefresh) {
  if (forceRefresh) return false;

  const updatedAtMs = Number(cacheDoc?.updatedAtMs || 0);
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return false;
  if (nowMs - updatedAtMs >= Number(ttlMs || 0)) return false;
  if (!cacheDoc || !cacheDoc.playerStats || typeof cacheDoc.playerStats !== "object") return false;

  const cachedStats = getFixturePlayersCacheStats(cacheDoc);
  const sample = Object.values(cachedStats)[0] || {};
  const cachedShort = String(
    sample?.statusShort ||
      sample?.fixtureStatus ||
      sample?.matchStatus ||
      cacheDoc?.statusShort ||
      ""
  ).trim().toUpperCase();
  const currentShort = String(
    fixtureMeta?.statusShort ||
      fixtureMeta?.fixtureStatus ||
      fixtureMeta?.matchStatus ||
      ""
  ).trim().toUpperCase();
  const statusChanged = Boolean(currentShort && cachedShort && currentShort !== cachedShort);
  const becameFinal = isFinalStatusCode(currentShort) && cachedShort !== currentShort;

  return !statusChanged && !becameFinal;
}

function hasNonEmptyFixturePlayersCache(cacheDoc = {}) {
  return Object.keys(getFixturePlayersCacheStats(cacheDoc)).length > 0;
}

function patchFixturePlayersCache(cacheDoc = {}, fixtureMeta = {}) {
  return patchPlayerStatsWithFixtureMeta(
    getFixturePlayersCacheStats(cacheDoc),
    fixtureMeta
  );
}

function logFixturePlayersCacheDecision({
  fixtureId,
  source,
  cacheHit = false,
  staleCacheReturned = false,
  lockAcquired = false,
  skippedDueToFreshLock = false,
  forceRefresh = false,
  apiCallMade = false,
  playerCount = 0,
} = {}) {
  console.log("[fixturePlayersCache]", {
    fixtureId: String(fixtureId || ""),
    source: source || "",
    cacheHit,
    staleCacheReturned,
    lockAcquired,
    skippedDueToFreshLock,
    forceRefresh,
    apiCallMade,
    playerCount: Number(playerCount || 0),
  });
}

async function getFixturePlayersStatsMapCached({
  fixtureId,
  apiKey,
  ttlMs,
  timeZone,
  forceRefresh = false,
  source = "",
  statsDebug = null,
}) {
  const safeFixtureId = String(fixtureId || "").trim();
  if (!safeFixtureId) return {};

  //const ref = db.collection("apiCache").doc(`fixturePlayers_${safeFixtureId}`);
  const ref = db.doc(`apiCache/fixturePlayers_${safeFixtureId}`);
  const now = Date.now();
  const metaSnap = await db.doc(`apiCache/fixtureStatus_${safeFixtureId}`).get();
  const metaDoc = metaSnap.exists ? (metaSnap.data() || {}) : {};

  const fixtureMeta = {
    fixtureId: safeFixtureId,
    homeTeamId: metaDoc.homeTeamId ?? null,
    awayTeamId: metaDoc.awayTeamId ?? null,
    homeTeamName: metaDoc.homeTeamName || "",
    awayTeamName: metaDoc.awayTeamName || "",
    homeTeamLogo: metaDoc.homeTeamLogo || "",
    awayTeamLogo: metaDoc.awayTeamLogo || "",
    goalsHome: toNum(metaDoc.goalsHome),
    goalsAway: toNum(metaDoc.goalsAway),

    // Timer/status info for Cup + Regular player stat cards
    statusShort: metaDoc.short || metaDoc.statusShort || null,
    fixtureStatus: metaDoc.short || metaDoc.statusShort || null,
    matchStatus: metaDoc.short || metaDoc.statusShort || null,
    statusLong: metaDoc.statusLong || null,
    elapsed: Number.isFinite(Number(metaDoc.elapsed)) ? Number(metaDoc.elapsed) : null,
    extra: Number.isFinite(Number(metaDoc.extra)) ? Number(metaDoc.extra) : null,
    statusUpdatedAtMs: Number.isFinite(Number(metaDoc.updatedAtMs)) ? Number(metaDoc.updatedAtMs) : null,
    kickoffMs: Number.isFinite(Number(metaDoc.kickoffMs)) ? Number(metaDoc.kickoffMs) : null,
  };
  fixtureMeta.isLive = isInPlay(fixtureMeta.statusShort || fixtureMeta.fixtureStatus);

  try {
    const snap = await ref.get();
    if (snap.exists) {
      const d = snap.data() || {};

      if (shouldUseFixturePlayersCache(d, fixtureMeta, now, ttlMs, forceRefresh)) {
        const cached = patchFixturePlayersCache(d, fixtureMeta);
        incrementFixtureStatsDebug(statsDebug, "fixturePlayerStatsCacheHits");
        logFixturePlayersCacheDecision({
          fixtureId: safeFixtureId,
          source,
          cacheHit: true,
          forceRefresh,
          playerCount: Object.keys(cached || {}).length,
        });
        return cached;
      }
    }
  } catch (_) {}

  const lockOwner = [
    "fixturePlayers",
    safeFixtureId,
    Date.now(),
    Math.random().toString(16).slice(2),
  ].join(":");
  let decision = { type: "unknown", cacheDoc: null };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cacheDoc = snap.exists ? (snap.data() || {}) : {};
    const refreshStartedAtMs = Number(cacheDoc?.refreshStartedAtMs || 0);
    const lockFresh =
      cacheDoc?.refreshInProgress === true &&
      Number.isFinite(refreshStartedAtMs) &&
      now - refreshStartedAtMs < FIXTURE_PLAYERS_REFRESH_LOCK_MS;

    if (shouldUseFixturePlayersCache(cacheDoc, fixtureMeta, now, ttlMs, forceRefresh)) {
      decision = { type: "fresh-cache", cacheDoc };
      return;
    }

    if (lockFresh) {
      decision = { type: "fresh-lock", cacheDoc };
      return;
    }

    tx.set(
      ref,
      {
        refreshInProgress: true,
        refreshStartedAtMs: now,
        refreshOwner: lockOwner,
        refreshSource: source || "",
        refreshForceRefresh: Boolean(forceRefresh),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    decision = { type: "lock-acquired", cacheDoc };
  });

  if (decision.type === "fresh-cache") {
    const cached = patchFixturePlayersCache(decision.cacheDoc, fixtureMeta);
    incrementFixtureStatsDebug(statsDebug, "fixturePlayerStatsCacheHits");
    logFixturePlayersCacheDecision({
      fixtureId: safeFixtureId,
      source,
      cacheHit: true,
      forceRefresh,
      playerCount: Object.keys(cached || {}).length,
    });
    return cached;
  }

  if (decision.type === "fresh-lock") {
    incrementFixtureStatsDebug(statsDebug, "fixturePlayerStatsLockSkips");
    await waitMs(FIXTURE_PLAYERS_LOCK_WAIT_MS);

    let rereadDoc = null;
    try {
      const rereadSnap = await ref.get();
      rereadDoc = rereadSnap.exists ? (rereadSnap.data() || {}) : null;
    } catch (_) {}

    if (
      rereadDoc &&
      shouldUseFixturePlayersCache(rereadDoc, fixtureMeta, Date.now(), ttlMs, false)
    ) {
      const cached = patchFixturePlayersCache(rereadDoc, fixtureMeta);
      incrementFixtureStatsDebug(statsDebug, "fixturePlayerStatsCacheHits");
      logFixturePlayersCacheDecision({
        fixtureId: safeFixtureId,
        source,
        cacheHit: true,
        skippedDueToFreshLock: true,
        forceRefresh,
        playerCount: Object.keys(cached || {}).length,
      });
      return cached;
    }

    const staleDoc = hasNonEmptyFixturePlayersCache(rereadDoc || {})
      ? rereadDoc
      : decision.cacheDoc;

    if (hasNonEmptyFixturePlayersCache(staleDoc || {})) {
      const stale = patchFixturePlayersCache(staleDoc, fixtureMeta);
      incrementFixtureStatsDebug(statsDebug, "fixturePlayerStatsStaleReturns");
      logFixturePlayersCacheDecision({
        fixtureId: safeFixtureId,
        source,
        staleCacheReturned: true,
        skippedDueToFreshLock: true,
        forceRefresh,
        playerCount: Object.keys(stale || {}).length,
      });
      return stale;
    }

    logFixturePlayersCacheDecision({
      fixtureId: safeFixtureId,
      source,
      skippedDueToFreshLock: true,
      forceRefresh,
      playerCount: 0,
    });
    return {};
  }

  let lockReleased = false;
  try {
    incrementFixtureStatsDebug(statsDebug, "fixturePlayerStatsApiCalls");
    logFixturePlayersCacheDecision({
      fixtureId: safeFixtureId,
      source,
      lockAcquired: true,
      forceRefresh,
      apiCallMade: true,
    });

    // If fixture hasn't started yet, this can return 204 No Content (handled in apiFootballGet)
    const json = await apiFootballGet(
      "fixtures/players",
      { fixture: safeFixtureId },
      apiKey,
      {
        source: source || "getFixturePlayersStatsMapCached",
        fixtureId: safeFixtureId,
        forceRefresh,
        cacheMiss: true,
        lockAcquired: true,
      }
    );
    const fresh = buildPlayerStatsMapFromFixturePlayersResponse(json?.response || [], fixtureMeta);

    // Sometimes the API returns 204/empty even when a fixture should have stats.
    // Do NOT overwrite a previously cached non-empty map with an empty one.
    if (!fresh || Object.keys(fresh).length === 0) {
      const snap2 = await ref.get().catch(() => null);
      const d2 = snap2?.exists ? (snap2.data() || {}) : {};
      const prev = d2.playerStats;

      if (prev && Object.keys(prev).length > 0) {
        const patchedPrev = patchPlayerStatsWithFixtureMeta(prev, fixtureMeta);
        await ref.set(
          {
            updatedAtMs: Date.now(),
            playerStats: patchedPrev,
            statusShort: fixtureMeta.statusShort || null,
            lastApiResponseEmpty: true,
            refreshInProgress: false,
            refreshCompletedAtMs: Date.now(),
            refreshOwner: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        lockReleased = true;
        return patchedPrev;
      }
    }

    const patchedFresh = patchPlayerStatsWithFixtureMeta(fresh, fixtureMeta);
    await ref.set(
      {
        updatedAtMs: Date.now(),
        playerStats: patchedFresh,
        statusShort: fixtureMeta.statusShort || null,
        lastApiResponseEmpty: Object.keys(patchedFresh || {}).length === 0,
        refreshInProgress: false,
        refreshCompletedAtMs: Date.now(),
        refreshOwner: FieldValue.delete(),
        refreshError: FieldValue.delete(),
        refreshErrorAtMs: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    lockReleased = true;

    return patchedFresh;
  } catch (error) {
    await ref.set(
      {
        refreshInProgress: false,
        refreshError: String(error?.message || error).slice(0, 500),
        refreshErrorCode: error?.code || null,
        refreshErrorAtMs: Date.now(),
        refreshOwner: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    ).catch(() => {});
    lockReleased = true;
    throw error;
  } finally {
    if (!lockReleased) {
      await ref.set(
        {
          refreshInProgress: false,
          refreshOwner: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      ).catch(() => {});
    }
  }
}

function fixtureStatusSoftTtlMs(short) {
  const s = String(short || "").trim().toUpperCase();
  if (!s) return 5 * 60 * 1000;
  if (isInPlay(s)) return 60 * 1000;
  if (s === "NS") return 10 * 60 * 1000;
  if (isFinished(s)) return 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

function fixtureStatusHardMinTtlMs({ short, kickoffMs, nowMs }) {
  const s = String(short || "").trim().toUpperCase();
  const safeKickoffMs = Number(kickoffMs || 0);
  const kickoffPassed =
    Number.isFinite(safeKickoffMs) &&
    safeKickoffMs > 0 &&
    Number(nowMs || 0) >= safeKickoffMs;

  if (isFinished(s)) return FIXTURE_STATUS_FINAL_MIN_TTL_MS;
  if (s === "NS" && kickoffPassed) return FIXTURE_STATUS_STALE_NS_MIN_TTL_MS;
  if (isInPlay(s) || (kickoffPassed && !isCancelledOrAbandonedStatus(s))) {
    return FIXTURE_STATUS_LIVE_MIN_TTL_MS;
  }
  return FIXTURE_STATUS_SCHEDULED_MIN_TTL_MS;
}

function getFixtureStatusCacheDecision(cacheDoc = {}, nowMs = Date.now(), { forceRefresh = false } = {}) {
  const short = String(cacheDoc?.short || cacheDoc?.statusShort || "").trim().toUpperCase();
  const updatedAtMs = Number(cacheDoc?.updatedAtMs || 0);
  const lastStatusFetchAtMs = Number(
    cacheDoc?.lastStatusFetchAtMs ||
      cacheDoc?.refreshCompletedAtMs ||
      cacheDoc?.lastStatusFetchStartedAtMs ||
      0
  );
  const kickoffMs = Number(cacheDoc?.kickoffMs || 0);
  const hasFixtureDetails =
    cacheDoc?.fixtureId &&
    cacheDoc?.homeTeamName &&
    cacheDoc?.awayTeamName &&
    cacheDoc?.kickoffMs !== undefined;
  const staleNsAfterKickoff =
    short === "NS" &&
    Number.isFinite(kickoffMs) &&
    kickoffMs > 0 &&
    nowMs >= kickoffMs;

  if (forceRefresh) {
    return {
      useCache: false,
      reason: "force-refresh",
      short,
      updatedAtMs,
      lastStatusFetchAtMs,
      kickoffMs,
      staleNsAfterKickoff,
    };
  }

  const hardReferenceAtMs = Math.max(updatedAtMs || 0, lastStatusFetchAtMs || 0);
  const hardMinTtlMs = fixtureStatusHardMinTtlMs({ short, kickoffMs, nowMs });
  if (short && hardReferenceAtMs > 0 && nowMs - hardReferenceAtMs < hardMinTtlMs) {
    return {
      useCache: true,
      reason: "hard-min-ttl",
      short,
      updatedAtMs,
      lastStatusFetchAtMs,
      kickoffMs,
      staleNsAfterKickoff,
    };
  }

  const softTtlMs = fixtureStatusSoftTtlMs(short);
  if (
    short &&
    updatedAtMs > 0 &&
    nowMs - updatedAtMs < softTtlMs &&
    hasFixtureDetails &&
    !staleNsAfterKickoff
  ) {
    return {
      useCache: true,
      reason: "soft-ttl",
      short,
      updatedAtMs,
      lastStatusFetchAtMs,
      kickoffMs,
      staleNsAfterKickoff,
    };
  }

  return {
    useCache: false,
    reason: !short ? "missing-status" : staleNsAfterKickoff ? "stale-ns-after-kickoff" : "expired",
    short,
    updatedAtMs,
    lastStatusFetchAtMs,
    kickoffMs,
    staleNsAfterKickoff,
  };
}

function logFixtureStatusCacheDecision({
  fixtureId,
  source = "getFixtureStatusMap",
  reason = "",
  cacheHit = false,
  cacheMiss = false,
  lockAcquired = false,
  lockSkipped = false,
  forceRefresh = false,
} = {}) {
  console.log("[fixtureStatusCache]", {
    fixtureId: String(fixtureId || ""),
    source,
    reason,
    cacheHit,
    cacheMiss,
    lockAcquired,
    lockSkipped,
    forceRefresh,
  });
}

async function releaseFixtureStatusLocks({
  fixtureIds = [],
  nowMs = Date.now(),
  error = null,
} = {}) {
  const writes = [];
  for (const fixtureId of fixtureIds) {
    const safeFixtureId = String(fixtureId || "").trim();
    if (!safeFixtureId) continue;
    writes.push(
      db.doc(`apiCache/fixtureStatus_${safeFixtureId}`).set(
        {
          refreshInProgress: false,
          refreshOwner: FieldValue.delete(),
          refreshSource: FieldValue.delete(),
          refreshForceRefresh: FieldValue.delete(),
          refreshCompletedAtMs: nowMs,
          lastStatusFetchAtMs: nowMs,
          ...(error
            ? {
                lastStatusFetchErrorAtMs: nowMs,
                lastStatusFetchError: String(error?.message || error).slice(0, 500),
              }
            : {
                lastStatusFetchEmptyAtMs: nowMs,
                lastStatusFetchError: FieldValue.delete(),
              }),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    );
  }

  await Promise.all(writes).catch(() => {});
}

async function getFixtureStatusMap({
  fixtureIds,
  timezone,
  apiKey,
  forceRefresh = false,
  source = "getFixtureStatusMap",
}) {
  const ids = [...new Set((fixtureIds || []).map((x) => String(x)).filter(Boolean))];
  const out = {};
  if (!ids.length) return out;

  const now = Date.now();
  const missing = [];

  await Promise.all(
    ids.map(async (id) => {
      try {
        if (forceRefresh) {
          missing.push(id);
          return;
        }

        const ref = db.doc(`apiCache/fixtureStatus_${id}`);
        const snap = await ref.get();
        if (!snap.exists) {
          missing.push(id);
          logFixtureStatusCacheDecision({
            fixtureId: id,
            source,
            reason: "missing-doc",
            cacheMiss: true,
            forceRefresh,
          });
          return;
        }

        const d = snap.data() || {};
        const decision = getFixtureStatusCacheDecision(d, now, { forceRefresh });
        if (decision.useCache) {
          out[id] = decision.short;
          logFixtureStatusCacheDecision({
            fixtureId: id,
            source,
            reason: decision.reason,
            cacheHit: true,
            forceRefresh,
          });
        } else {
          missing.push(id);
          logFixtureStatusCacheDecision({
            fixtureId: id,
            source,
            reason: decision.reason,
            cacheMiss: true,
            forceRefresh,
          });
        }
      } catch (_) {
        missing.push(id);
      }
    })
  );

  const refreshIds = [];
  await Promise.all(
    missing.map(async (id) => {
      const ref = db.doc(`apiCache/fixtureStatus_${id}`);
      const lockOwner = [
        "fixtureStatus",
        id,
        now,
        Math.random().toString(16).slice(2),
      ].join(":");
      let txDecision = { type: "unknown", cacheDoc: null, reason: "" };

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const cacheDoc = snap.exists ? (snap.data() || {}) : {};
        const cacheDecision = getFixtureStatusCacheDecision(cacheDoc, now, { forceRefresh });
        const refreshStartedAtMs = Number(cacheDoc?.refreshStartedAtMs || 0);
        const lockFresh =
          cacheDoc?.refreshInProgress === true &&
          Number.isFinite(refreshStartedAtMs) &&
          now - refreshStartedAtMs < FIXTURE_STATUS_REFRESH_LOCK_MS;

        if (cacheDecision.useCache) {
          txDecision = { type: "fresh-cache", cacheDoc, reason: cacheDecision.reason };
          return;
        }

        if (lockFresh) {
          txDecision = { type: "fresh-lock", cacheDoc, reason: "fresh-lock" };
          return;
        }

        tx.set(
          ref,
          {
            refreshInProgress: true,
            refreshStartedAtMs: now,
            refreshOwner: lockOwner,
            refreshSource: source || "",
            refreshForceRefresh: Boolean(forceRefresh),
            lastStatusFetchStartedAtMs: now,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        txDecision = { type: "lock-acquired", cacheDoc, reason: "lock-acquired" };
      });

      if (txDecision.type === "fresh-cache") {
        const decision = getFixtureStatusCacheDecision(txDecision.cacheDoc, now, { forceRefresh: false });
        if (decision.short) out[id] = decision.short;
        logFixtureStatusCacheDecision({
          fixtureId: id,
          source,
          reason: txDecision.reason,
          cacheHit: true,
          lockSkipped: true,
          forceRefresh,
        });
        return;
      }

      if (txDecision.type === "fresh-lock") {
        await waitMs(FIXTURE_STATUS_LOCK_WAIT_MS);
        const rereadSnap = await ref.get().catch(() => null);
        const rereadDoc = rereadSnap?.exists ? (rereadSnap.data() || {}) : null;
        const rereadDecision = getFixtureStatusCacheDecision(rereadDoc || {}, Date.now(), {
          forceRefresh: false,
        });
        if (rereadDecision.short) out[id] = rereadDecision.short;
        logFixtureStatusCacheDecision({
          fixtureId: id,
          source,
          reason: rereadDecision.useCache ? rereadDecision.reason : "fresh-lock-stale-cache",
          cacheHit: Boolean(rereadDecision.short),
          lockSkipped: true,
          forceRefresh,
        });
        return;
      }

      refreshIds.push(id);
      logFixtureStatusCacheDecision({
        fixtureId: id,
        source,
        reason: "lock-acquired",
        cacheMiss: true,
        lockAcquired: true,
        forceRefresh,
      });
    })
  );

  const fetchList = async (params) => {
    const r = await apiFootballGet(
      "fixtures",
      { ...params, timezone },
      apiKey,
      {
        source,
        fixtureId: params?.id,
        fixtureIds: params?.ids ? String(params.ids).split(/[-,]/).filter(Boolean) : refreshIds,
        forceRefresh,
        cacheMiss: true,
        lockAcquired: true,
      }
    );
    return Array.isArray(r?.response) ? r.response : [];
  };

  let list = [];

  if (refreshIds.length) {
    try {
      if (refreshIds.length > 1) {
        list = await fetchList({ ids: refreshIds.join("-") });
        if (!list.length) list = await fetchList({ ids: refreshIds.join(",") });
      } else {
        list = await fetchList({ id: refreshIds[0] });
      }

      // Fallback per-id if still empty. This is now protected by the per-fixture
      // Firestore lock above, so parallel function instances do not all retry.
      if (!list.length) {
        for (const id of refreshIds) {
          const one = await fetchList({ id });
          if (one?.[0]) list.push(one[0]);
        }
      }
    } catch (error) {
      await releaseFixtureStatusLocks({ fixtureIds: refreshIds, nowMs: now, error });
      throw error;
    }
  }

  const receivedIds = new Set();
  if (list.length) {
    const writes = [];

    for (const f of list) {
      const fixtureId = String(f?.fixture?.id ?? "");
      const short = f?.fixture?.status?.short ?? null;
      if (!fixtureId || !short) continue;
      receivedIds.add(fixtureId);

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
            statusShort: short,
            statusLong,
            elapsed,
            extra,
            kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : null,
            updatedAtMs: now,
            lastStatusFetchAtMs: now,
            refreshInProgress: false,
            refreshOwner: FieldValue.delete(),
            refreshSource: FieldValue.delete(),
            refreshForceRefresh: FieldValue.delete(),
            refreshCompletedAtMs: now,
            lastStatusFetchError: FieldValue.delete(),
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

  const notReceivedIds = refreshIds.filter((id) => !receivedIds.has(String(id)));
  if (notReceivedIds.length) {
    await releaseFixtureStatusLocks({ fixtureIds: notReceivedIds, nowMs: now });
  }

  return out;
}

function isInPlay(short) {
  return ["1H", "HT", "2H", "ET", "BT", "P"].includes(String(short || "").trim().toUpperCase());
}
function isFinalStatusCode(short) {
  return ["FT", "AET", "PEN"].includes(String(short || "").trim().toUpperCase());
}
function isFinished(short) {
  return isFinalStatusCode(short);
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

function buildFixtureMetaFromSummaryOrLive({ fixtureId, summary = {}, live = {} }) {
  const statusShort = String(
    summary?.statusShort ||
    summary?.short ||
    live?.statusShort ||
    live?.short ||
    ""
  ).trim().toUpperCase();

  const summaryElapsed = Number(summary?.elapsed);
  const summaryExtra = Number(summary?.extra);
  const summaryKickoffMs = Number(summary?.kickoffMs);

  return {
    fixtureId: String(fixtureId),
    statusShort,
    fixtureStatus: statusShort,
    matchStatus: statusShort,
    statusLong: summary?.statusLong || live?.statusLong || null,
    elapsed: Number.isFinite(summaryElapsed) ? summaryElapsed : live?.elapsed ?? null,
    extra: Number.isFinite(summaryExtra) ? summaryExtra : live?.extra ?? null,
    statusUpdatedAtMs: summary?.updatedAtMs ?? live?.updatedAtMs ?? null,
    kickoffMs: Number.isFinite(summaryKickoffMs) ? summaryKickoffMs : live?.kickoffMs ?? null,
    homeTeamId: summary?.homeTeamId ?? live?.homeTeamId ?? null,
    awayTeamId: summary?.awayTeamId ?? live?.awayTeamId ?? null,
    homeTeamName: summary?.homeTeamName || live?.homeTeamName || "",
    awayTeamName: summary?.awayTeamName || live?.awayTeamName || "",
    homeTeamLogo: summary?.homeTeamLogo || live?.homeTeamLogo || "",
    awayTeamLogo: summary?.awayTeamLogo || live?.awayTeamLogo || "",
    goalsHome: summary?.goalsHome ?? live?.goalsHome ?? null,
    goalsAway: summary?.goalsAway ?? live?.goalsAway ?? null,
  };
}

function patchGlobalLiveFixturesWithSummaries(liveFixturesById = {}, fixtureSummariesById = {}) {
  const patched = {};

  for (const [fixtureId, live] of Object.entries(liveFixturesById || {})) {
    const summary = fixtureSummariesById[String(fixtureId)] || {};
    const fixtureMeta = buildFixtureMetaFromSummaryOrLive({
      fixtureId,
      summary,
      live,
    });

    const rawStatsByPlayerId =
      live?.rawStatsByPlayerId && typeof live.rawStatsByPlayerId === "object"
        ? live.rawStatsByPlayerId
        : {};
    const patchedRawStats = patchPlayerStatsWithFixtureMeta(rawStatsByPlayerId, fixtureMeta);

    const fantasyByPlayerId =
      live?.fantasyByPlayerId && typeof live.fantasyByPlayerId === "object"
        ? live.fantasyByPlayerId
        : {};
    const patchedFantasy = {};

    for (const [pid, fantasy] of Object.entries(fantasyByPlayerId)) {
      patchedFantasy[pid] = {
        ...(fantasy || {}),
        stats: patchedRawStats[pid] || fantasy?.stats || {},
      };
    }

    const isLiveNow = fixtureMeta.statusShort
      ? isInPlay(fixtureMeta.statusShort) && !isFinalStatusCode(fixtureMeta.statusShort)
      : Boolean(live?.isLive);

    patched[fixtureId] = {
      ...(live || {}),
      statusShort: fixtureMeta.statusShort || live?.statusShort || null,
      fixtureStatus: fixtureMeta.fixtureStatus || live?.fixtureStatus || null,
      matchStatus: fixtureMeta.matchStatus || live?.matchStatus || null,
      statusLong: fixtureMeta.statusLong || live?.statusLong || null,
      elapsed: fixtureMeta.elapsed ?? live?.elapsed ?? null,
      extra: fixtureMeta.extra ?? live?.extra ?? null,
      kickoffMs: fixtureMeta.kickoffMs ?? live?.kickoffMs ?? null,
      statusUpdatedAtMs: fixtureMeta.statusUpdatedAtMs ?? live?.statusUpdatedAtMs ?? null,
      goalsHome: fixtureMeta.goalsHome ?? live?.goalsHome ?? null,
      goalsAway: fixtureMeta.goalsAway ?? live?.goalsAway ?? null,
      homeScore: fixtureMeta.goalsHome ?? live?.homeScore ?? live?.goalsHome ?? null,
      awayScore: fixtureMeta.goalsAway ?? live?.awayScore ?? live?.goalsAway ?? null,
      homeTeamId: fixtureMeta.homeTeamId ?? live?.homeTeamId ?? null,
      awayTeamId: fixtureMeta.awayTeamId ?? live?.awayTeamId ?? null,
      homeTeamName: fixtureMeta.homeTeamName || live?.homeTeamName || "",
      awayTeamName: fixtureMeta.awayTeamName || live?.awayTeamName || "",
      homeTeamLogo: fixtureMeta.homeTeamLogo || live?.homeTeamLogo || "",
      awayTeamLogo: fixtureMeta.awayTeamLogo || live?.awayTeamLogo || "",
      isLive: isLiveNow,
      isFinished: isFinalStatusCode(fixtureMeta.statusShort || live?.statusShort || ""),
      rawStatsByPlayerId: patchedRawStats,
      fantasyByPlayerId: patchedFantasy,
    };
  }

  return patched;
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

  function inferPlayerId(d, fallback = "") {
    return String(
      d?.playerId ??
        d?.pid ??
        d?.apiPlayerId ??
        d?.id ??
        d?.player?.id ??
        d?.player?.playerId ??
        fallback ??
        ""
    ).trim();
  }

  function normalizePlayerMeta(d = {}, fallbackId = "") {
    const pid = inferPlayerId(d, fallbackId);
    if (!pid) return null;

    return {
      id: pid,
      playerId: pid,
      name: d.name || d.playerName || d.fullName || d.displayName || d.player?.name || "Unknown",
      position: toPos(d.position || d.pos || d.role || d.player?.position || ""),
      teamName: d.teamName || d.team?.name || d.clubName || d.club || "",
      nationality: d.nationality || d.country || d.playerCountry || "",
      teamLogo: d.teamLogo || d.team?.logo || "",
    };
  }

  function mergePlayerMeta(existing = null, incoming = null) {
    if (!existing) return incoming;
    if (!incoming) return existing;

    return {
      ...existing,
      ...incoming,
      id: incoming.id || existing.id,
      playerId: incoming.playerId || existing.playerId || incoming.id || existing.id,
      name:
        incoming.name && incoming.name !== "Unknown"
          ? incoming.name
          : existing.name || "Unknown",
      position: toPos(incoming.position || existing.position || ""),
      teamName: incoming.teamName || existing.teamName || "",
      nationality: incoming.nationality || existing.nationality || "",
      teamLogo: incoming.teamLogo || existing.teamLogo || "",
    };
  }

  function hasUsefulPlayerMeta(player = {}) {
    return Boolean(
      player?.name &&
        player.name !== "Unknown" &&
        (player.position || player.teamName || player.nationality || player.teamLogo)
    );
  }

  function rememberPlayer(playersById, player) {
    if (!player?.id) return null;
    const pid = String(player.id);
    const merged = mergePlayerMeta(playersById.get(pid), player);
    playersById.set(pid, merged);
    return merged;
  }

  function rawLineupEntryId(entry) {
    return String(
      entry?.id ??
        entry?.playerId ??
        entry?.pid ??
        entry?.apiPlayerId ??
        entry?.player?.id ??
        entry ??
        ""
    ).trim();
  }

  async function fetchNeededPlayerDocs(playersById, neededIds) {
    const neededIdList =
      neededIds == null
        ? []
        : Array.isArray(neededIds)
          ? neededIds
          : neededIds instanceof Set
            ? Array.from(neededIds)
            : typeof neededIds === "string" || typeof neededIds === "number"
              ? [neededIds]
              : typeof neededIds?.[Symbol.iterator] === "function"
                ? Array.from(neededIds)
                : [];

    const ids = [...new Set(neededIdList.map(String).filter(Boolean))]
      .filter((id) => !hasUsefulPlayerMeta(playersById.get(id)));

    let docsRead = 0;
    const chunkSize = 300;

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      if (!chunk.length) continue;

      const snaps = await db.getAll(
        ...chunk.map((id) => db.doc(`rooms/${roomId}/players/${id}`))
      );

      for (let j = 0; j < snaps.length; j += 1) {
        const snap = snaps[j];
        if (!snap.exists) continue;
        docsRead += 1;
        rememberPlayer(playersById, normalizePlayerMeta(snap.data() || {}, snap.id));
      }
    }

    return { requested: ids.length, docsRead };
  }

  const [membersSnap, lineupsSnap, picksSnap] = await Promise.all([
    db.collection(`rooms/${roomId}/members`).get(),
    db.collection(`rooms/${roomId}/lineups`).get(),
    db.collection(`rooms/${roomId}/picks`).get(),
  ]);

  const membersByUid = new Map();
  membersSnap.forEach((doc) => {
    const data = doc.data() || {};
    const uid = String(doc.id || data.uid || "").trim();
    if (!uid) return;
    membersByUid.set(uid, {
      uid,
      displayName: String(data.displayName || data.name || uid),
      teamName: String(data.teamName || data.team || ""),
    });
  });

  const playersById = new Map();
  const pickDocToPlayer = new Map();
  const pickRows = [];
  const neededPlayerIds = new Set();

  picksSnap.forEach((doc) => {
    const d = doc.data() || {};
    const owner = inferOwnerUid(d);
    const pid = inferPlayerId(d);
    if (!owner || !pid) return;

    const player = rememberPlayer(playersById, normalizePlayerMeta(d, pid));
    if (!hasUsefulPlayerMeta(player)) neededPlayerIds.add(pid);
    pickDocToPlayer.set(doc.id, player);
    pickDocToPlayer.set(pid, player);
    pickRows.push({ owner: String(owner), pid, pickDocId: doc.id });
  });

  const lineupsByUid = new Map();
  lineupsSnap.forEach((doc) => {
    const lineup = doc.data() || {};
    lineupsByUid.set(String(doc.id), lineup);

    for (const entry of [...extractStarters(lineup), ...extractBench(lineup)]) {
      const raw = rawLineupEntryId(entry);
      const embedded = normalizePlayerMeta(entry, raw);
      if (embedded) rememberPlayer(playersById, embedded);
      if (raw && !pickDocToPlayer.has(raw)) neededPlayerIds.add(raw);
    }
  });

  const playerDocFetch = await fetchNeededPlayerDocs(playersById, neededPlayerIds);

  for (const row of pickRows) {
    const merged = mergePlayerMeta(
      playersById.get(row.pid),
      pickDocToPlayer.get(row.pickDocId)
    );
    if (!merged) continue;
    playersById.set(row.pid, merged);
    pickDocToPlayer.set(row.pid, merged);
    pickDocToPlayer.set(row.pickDocId, merged);
  }

  const rosterByUid = {};
  for (const row of pickRows) {
    const player =
      playersById.get(row.pid) ||
      pickDocToPlayer.get(row.pickDocId) ||
      { id: row.pid, playerId: row.pid, name: "Unknown", position: "MID" };
    (rosterByUid[row.owner] ||= []).push(player);
  }

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
      const known = mergePlayerMeta(playersById.get(pid), fromPick) || normalizePlayerMeta(entry, pid);

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
      teamName: membersByUid.get(uid)?.teamName || "",
      starters,
      bench,
    });
  }

  console.log("[loadRoomUsersLineupsForGlobalAggregation] read counts", {
    roomId,
    membersRead: membersSnap.size,
    lineupDocsRead: lineupsSnap.size,
    picksRead: picksSnap.size,
    playerDocsRequested: playerDocFetch.requested,
    playerDocsRead: playerDocFetch.docsRead,
    playersResolved: playersById.size,
  });

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
    "pensScored",
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
  const nextStatus = String(next?.statusShort || next?.fixtureStatus || next?.matchStatus || "").trim().toUpperCase();
  if (isFinalStatusCode(nextStatus)) {
    out.isLive = false;
  } else if (nextStatus) {
    out.isLive = isInPlay(nextStatus);
  } else {
    out.isLive = Boolean(out.isLive) || Boolean(next?.isLive);
  }
  out.rating = Math.max(toNum(out.rating), toNum(next?.rating));

  const preferNextKeys = [
    "fixtureId",
    "teamId",
    "teamName",
    "opponentName",
    "homeTeamId",
    "awayTeamId",
    "homeTeamName",
    "awayTeamName",
    "homeTeamLogo",
    "awayTeamLogo",
    "teamScore",
    "opponentScore",
    "teamGoals",
    "opponentGoals",
    "goalsHome",
    "goalsAway",
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
  out.rawApiPositionOriginal = out.rawApiPositionOriginal || next?.rawApiPositionOriginal || null;
  out.rawApiPosition = out.rawApiPosition || next?.rawApiPosition || null;
  out.position = out.position || next?.rawApiPosition || next?.position || "";

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
        position: mergedStats.rawApiPosition || mergedStats.position || current.position || "",
      };
    }
  }

  return aggregated;
}


const {
  armNextCupGlobalWindowFromCache,
  loadLatestCupHistoryWindow,
  computeGlobalCupShadowResults,
  buildCupGlobalWriteRehearsalPayload,
  computeCupCurrentWindowFromGlobalCache,
  buildCupGlobalFinalizationPayload,
  finalizeCupGlobalCurrentWindow,
  isCupGlobalAutoApplyEnabled,
  isCupGlobalFinalizationEnabled,
} = createCupGlobalEngine({
  FieldValue,
  HttpsError,
  scorePlayer,
  toPos,
  safeId,
  hashToUint32,
  getRoomPhaseLabel,
  deriveRoomSeasonContext,
  getGlobalPipelineMode,
  isGlobalLiveFixtureCacheEnabled,
  isGlobalRoomAggregatorEnabled,
  getSeasonFixturesCollectionRef,
  pickCupWindow,
  setCompetitionState,
  loadGlobalLiveFixturesForSeason,
  loadGlobalFixtureSummariesForSeason,
  patchGlobalLiveFixturesWithSummaries,
  buildAggregatedGlobalRawStatsByPlayerId,
  loadRoomUsersLineupsForGlobalAggregation,
  hasFixtureStarted,
  isInPlay,
  isFinished,
});
async function computeRegularWeekFromGlobalCache({
  db,
  roomId,
  weekIndex,
  nowMs = Date.now(),
  writeMode = "shadow",
  dryRun = true,
}) {
  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = roomSnap.data() || {};
  const phase = getRoomPhaseLabel(room);
  if (phase === "Cup") {
    throw new HttpsError("failed-precondition", "Room is Cup phase. Use Cup shadow test instead.");
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

  const normalizedWriteMode =
    String(writeMode || "").trim().toLowerCase() === "global" ? "global" : "shadow";
  const realWriteRequested = normalizedWriteMode === "global" && !dryRun;
  const realWriteAllowed =
    realWriteRequested &&
    pipelineMode === "global" &&
    isGlobalRoomAggregatorEnabled(room);

  if (realWriteRequested && !realWriteAllowed) {
    throw new HttpsError(
      "failed-precondition",
      "Room global roomAggregator is not enabled."
    );
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
  const endAtMs = Number(week.endAtMs || 0);
  const pastPostWindow =
    Number.isFinite(endAtMs) &&
    endAtMs > 0 &&
    nowMs >= endAtMs + TOURNAMENT_POST_MS;
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
  if (missingFixtureIds.length) {
    console.warn("[computeRegularWeekFromGlobalCache] missing global live fixture docs", {
      roomId,
      weekIndex: resolvedWeekIndex,
      missingFixtureCount: missingFixtureIds.length,
      missingFixtureIds: missingFixtureIds.slice(0, 5),
    });
  }
  const fixtureSummariesById = await loadGlobalFixtureSummariesForSeason({
    db,
    seasonKey: seasonContext.seasonKey,
    fixtureIds,
  });
  const patchedLiveFixturesById = patchGlobalLiveFixturesWithSummaries(
    liveFixturesById,
    fixtureSummariesById
  );
  const weekFixtureMetaById = new Map(
    (Array.isArray(week?.fixtures) ? week.fixtures : [])
      .map((fixture) => [
        String(fixture?.fixtureId || fixture?.id || fixture?.fixture?.id || "").trim(),
        fixture || {},
      ])
      .filter(([fixtureId]) => Boolean(fixtureId))
  );

  const fixtureCoverage = fixtureIds.map((fixtureId) => {
    const live = patchedLiveFixturesById[String(fixtureId)] || null;
    const summary = fixtureSummariesById[String(fixtureId)] || null;
    const weekFixture = weekFixtureMetaById.get(String(fixtureId)) || {};
    const fantasyByPlayerId =
      live?.fantasyByPlayerId && typeof live.fantasyByPlayerId === "object"
        ? live.fantasyByPlayerId
        : {};
    const rawStatsByPlayerId =
      live?.rawStatsByPlayerId && typeof live.rawStatsByPlayerId === "object"
        ? live.rawStatsByPlayerId
        : {};
    const rawSample =
      Object.values(rawStatsByPlayerId).find((value) => value && typeof value === "object") || {};

    return {
      fixtureId: String(fixtureId),
      hasLivePayload: Boolean(live),
      hasSummary: Boolean(summary),
      statusShort:
        live?.statusShort ||
        summary?.short ||
        summary?.statusShort ||
        statusShortFromFixture(weekFixture) ||
        rawSample?.statusShort ||
        rawSample?.fixtureStatus ||
        rawSample?.matchStatus ||
        null,
      statusLong: live?.statusLong || summary?.statusLong || weekFixture?.statusLong || rawSample?.statusLong || null,
      kickoffMs: Number(
        live?.kickoffMs ??
          summary?.kickoffMs ??
          weekFixture?.kickoffMs ??
          weekFixture?.startAtMs ??
          (weekFixture?.fixture?.timestamp ? Number(weekFixture.fixture.timestamp) * 1000 : undefined) ??
          rawSample?.kickoffMs ??
          0
      ) || null,
      fantasyPlayerCount: Object.keys(fantasyByPlayerId).length,
      rawStatsPlayerCount: Object.keys(rawStatsByPlayerId).length,
    };
  });

  const fixtureStatusById = {};
  for (const coverage of fixtureCoverage) {
    if (coverage.statusShort) {
      fixtureStatusById[String(coverage.fixtureId)] = coverage.statusShort;
    }
  }

  const anyInPlay = fixtureCoverage.some((coverage) =>
    isInPlay(coverage.statusShort || null) &&
    !isCoverageStalePastPostTail(coverage, nowMs)
  );
  const hasStartedOrResolvingFixture = fixtureCoverage.some((coverage) => {
    const kickoffMs = coverageKickoffMs(coverage);
    const short = coverageStatusShort(coverage);
    return (
      (hasFixtureStarted(short) && !isFinished(short) && !isCancelledOrAbandonedStatus(short)) ||
      (kickoffMs != null && nowMs >= kickoffMs && nowMs <= kickoffMs + TOURNAMENT_POST_MS)
    );
  });
  const allFinished = fixtureIds.length > 0 && fixtureCoverage.every((coverage) =>
    isFinished(coverage.statusShort || "") ||
    isCancelledOrAbandonedStatus(coverage.statusShort || "") ||
    isCoverageStalePastPostTail(coverage, nowMs)
  );
  const forcedFinalByExpiredWindow = pastPostWindow && !anyInPlay;
  const statusValue =
    allFinished || forcedFinalByExpiredWindow
      ? "final"
      : anyInPlay
        ? "live"
        : "idle";

  let nextKickoffMs = null;
  for (const coverage of fixtureCoverage) {
    const ko = Number(coverage.kickoffMs);
    if (!Number.isFinite(ko) || ko <= nowMs) continue;
    if (nextKickoffMs == null || ko < nextKickoffMs) nextKickoffMs = ko;
  }

  const inActiveWakeWindow = fixtureCoverage.some((coverage) =>
    isCoverageInActiveWakeWindow(coverage, nowMs)
  );

  if (!hasStartedOrResolvingFixture && !allFinished && !forcedFinalByExpiredWindow) {
    let skippedReason = "regular-week-not-due";
    let nextPollAtMs = nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS;

    if (nextKickoffMs) {
      if (nowMs < nextKickoffMs - TOURNAMENT_PRE_MS) {
        nextPollAtMs = nextKickoffMs - TOURNAMENT_PRE_MS;
      } else if (nowMs < nextKickoffMs) {
        nextPollAtMs = Math.min(nowMs + TOURNAMENT_PREGAME_POLL_MS, nextKickoffMs);
        skippedReason = "regular-week-pregame-5min-check";
      }
    }

    return {
      mode: realWriteAllowed ? "regular-global-aggregator" : "regular-shadow-aggregator",
      source: "global-live-fixtures",
      compareScope: "current-regular-week",
      writeMode: normalizedWriteMode,
      dryRun: Boolean(dryRun),
      realWriteApplied: false,
      skippedReason,
      roomId,
      weekIndex: resolvedWeekIndex,
      seasonKey: seasonContext.seasonKey,
      fixtureIds,
      fixtureCount: fixtureIds.length,
      missingFixtureCount: missingFixtureIds.length,
      userCount: 0,
      globalTotalsByUid: {},
      globalBenchTotalsByUid: {},
      globalBreakdownByUserId: {},
      legacyTotalsByUid: {},
      diffsByUid: {},
      maxAbsDiff: 0,
      fixtureCoverage,
      playerMismatches: [],
      statMismatches: [],
      missingFixtureIds,
      missingPlayerIdsByUid: {},
      activeScorers: {},
      benchByUserId: {},
      startersByUserId: {},
      matchups: [],
      weekLeaderboard: [],
      weekResultPayload: null,
      weekStatus: statusValue,
      nextKickoffMs,
      nextPollAtMs,
      roundLabel: week.roundLabel || null,
      updatedAtMs: nowMs,
    };
  }

  const users = await loadRoomUsersLineupsForGlobalAggregation({ db, roomId });
  const scoreUsers = users.map((user) => ({
    ...user,
    userId: String(user.uid),
    name: user.displayName || String(user.uid),
  }));
  const memberUids = scoreUsers.map((user) => String(user.userId)).filter(Boolean).sort();
  const globalRawStatsByPlayerId = buildAggregatedGlobalRawStatsByPlayerId(patchedLiveFixturesById);

  const weekResultsRef = roomRef.collection("weekResults").doc(String(resolvedWeekIndex));
  const weekResultsSnap = await weekResultsRef.get();
  const prevResults = weekResultsSnap.exists ? (weekResultsSnap.data() || {}) : {};
  const legacyBreakdownByUserId =
    prevResults?.breakdownByUserId && typeof prevResults.breakdownByUserId === "object"
      ? prevResults.breakdownByUserId
      : {};
  const legacyTotalsByUid =
    prevResults?.teamScoresByUserId && typeof prevResults.teamScoresByUserId === "object"
      ? prevResults.teamScoresByUserId
      : {};

  const playersById = new Map();
  const rememberPlayer = (player) => {
    const pid = String(player?.id ?? player?.playerId ?? player?.apiPlayerId ?? "").trim();
    if (!pid || playersById.has(pid)) return;
    playersById.set(pid, {
      id: pid,
      name: player?.name || player?.playerName || player?.fullName || "Unknown",
      position: toPos(player?.position || player?.pos || player?.role || "MID"),
      teamName: player?.teamName || "",
      nationality: player?.nationality || "",
      teamLogo: player?.teamLogo || "",
    });
  };

  for (const user of scoreUsers) {
    for (const player of [...(user.starters || []), ...(user.bench || [])]) {
      rememberPlayer(player);
    }
  }

  for (const mapName of ["startersByUserId", "benchByUserId"]) {
    const byUser = prevResults?.[mapName] && typeof prevResults[mapName] === "object"
      ? prevResults[mapName]
      : {};
    for (const list of Object.values(byUser)) {
      for (const player of Array.isArray(list) ? list : []) {
        rememberPlayer(player);
      }
    }
  }

  function rawStatsForPlayer(playerId) {
    return globalRawStatsByPlayerId[String(playerId)]?.stats || null;
  }

  function globalMatchStartedForPlayer(playerId) {
    const rawStats = rawStatsForPlayer(playerId);
    if (!rawStats) return false;
    const short = rawStats.statusShort || rawStats.fixtureStatus || rawStats.matchStatus || null;
    return !short || short !== "NS";
  }

  function scoreGlobalPlayer(player, counted) {
    const pid = String(player?.id || "").trim();
    const aggregated = globalRawStatsByPlayerId[pid] || null;
    const rawStats = aggregated?.stats || null;

    // Room/fantasy position wins. API position is only a fallback/debug hint.
    const scorePosition = toPos(
      player?.position ||
      playersById.get(pid)?.position ||
      aggregated?.position ||
      rawStats?.rawApiPosition ||
      rawStats?.position ||
      "MID"
    );

    const scored = rawStats
      ? scorePlayer(rawStats, scorePosition)
      : { points: 0, breakdown: {} };

    return {
      id: pid,
      name: player?.name || playersById.get(pid)?.name || "Unknown",
      position: scorePosition,
      teamName: rawStats?.teamName || aggregated?.teamName || player?.teamName || "",
      nationality: player?.nationality || playersById.get(pid)?.nationality || "",
      opponentName: rawStats?.opponentName || aggregated?.opponentName || "",
      points: Number(scored?.points ?? scored?.total ?? 0),
      breakdown: scored?.breakdown || scored?.parts || scored?.pointsBreakdown || {},
      stats: rawStats || {},
      counted,
    };
  }

  const totalsByUid = {};
  const benchTotalsByUid = {};
  const breakdownByUserId = {};
  const missingPlayerIdsByUid = {};
  const newActiveScorers = {};
  const finalStartersByUserId = {};
  const finalBenchByUserId = {};

  for (const user of scoreUsers) {
    const uid = String(user.userId);
    const activeSet = new Set(
      Array.isArray(prevResults?.activeScorers?.[uid])
        ? prevResults.activeScorers[uid].map(String)
        : []
    );

    for (const player of Array.isArray(user.starters) ? user.starters : []) {
      const pid = String(player?.id || "").trim();
      if (pid && globalMatchStartedForPlayer(pid)) {
        activeSet.add(pid);
      }
    }

    const effectiveStarters = [];
    const addedIds = new Set();

    for (const pid of activeSet) {
      const player = playersById.get(String(pid)) || {
        id: String(pid),
        name: "Unknown",
        position: "MID",
      };
      effectiveStarters.push(player);
      addedIds.add(String(pid));
    }

    for (const player of Array.isArray(user.starters) ? user.starters : []) {
      const pid = String(player?.id || "").trim();
      if (!pid || addedIds.has(pid)) continue;
      effectiveStarters.push(player);
      addedIds.add(pid);
    }

    const effectiveBench = [];
    for (const player of Array.isArray(user.bench) ? user.bench : []) {
      const pid = String(player?.id || "").trim();
      if (pid && !addedIds.has(pid)) effectiveBench.push(player);
    }

    const perPlayer = {};
    const startersOut = [];
    const benchOut = [];
    const missing = new Set();
    let starterTotal = 0;
    let benchTotal = 0;

    for (const player of effectiveStarters) {
      const entry = scoreGlobalPlayer(player, true);
      if (!entry.id) continue;
      perPlayer[entry.id] = entry;
      startersOut.push(entry);
      starterTotal += Number(entry.points || 0);
      if (!globalRawStatsByPlayerId[entry.id]) missing.add(entry.id);
    }

    for (const player of effectiveBench) {
      const entry = scoreGlobalPlayer(player, false);
      if (!entry.id) continue;
      perPlayer[entry.id] = entry;
      benchOut.push(entry);
      benchTotal += Number(entry.points || 0);
      if (!globalRawStatsByPlayerId[entry.id]) missing.add(entry.id);
    }

    totalsByUid[uid] = starterTotal;
    benchTotalsByUid[uid] = benchTotal;
    newActiveScorers[uid] = Array.from(activeSet);
    finalStartersByUserId[uid] = effectiveStarters;
    finalBenchByUserId[uid] = effectiveBench;
    missingPlayerIdsByUid[uid] = Array.from(missing);
    breakdownByUserId[uid] = {
      total: starterTotal,
      benchTotal,
      perPlayer,
      starters: startersOut,
      bench: benchOut,
    };
  }

  const matchupPairs = Array.isArray(week.matchups) && week.matchups.length
    ? week.matchups
    : roundRobinPairings(memberUids, resolvedWeekIndex);

  const matchups = matchupPairs.map((pair) => {
    const homeTotal = totalsByUid[pair.homeUserId] ?? 0;
    const awayTotal = totalsByUid[pair.awayUserId] ?? 0;

    let homeResult = "L";
    let awayResult = "W";
    let winnerUserId = pair.awayUserId;

    if (homeTotal > awayTotal) {
      homeResult = "W";
      awayResult = "L";
      winnerUserId = pair.homeUserId;
    } else if (homeTotal === awayTotal) {
      homeResult = "D";
      awayResult = "D";
      winnerUserId = null;
    }

    return {
      weekIndex: resolvedWeekIndex,
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

  const weekLeaderboard = buildLeaderboard(scoreUsers, matchups, totalsByUid);

  const diffsByUid = {};
  const allUids = new Set([
    ...Object.keys(totalsByUid || {}),
    ...Object.keys(legacyTotalsByUid || {}),
  ]);

  for (const uid of allUids) {
    diffsByUid[uid] =
      Number(totalsByUid[uid] || 0) -
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
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, val]) => {
      if (["teamName", "opponentName", "fixtureId", "fixtureIds"].includes(key)) return false;
      return val !== undefined && val !== null && val !== "" && val !== 0 && val !== false;
    });
  }

  const playerMismatches = [];
  const statMismatches = [];

  for (const uid of allUids) {
    const legacyUserBreakdown = legacyBreakdownByUserId?.[uid] || {};
    const legacyPerPlayer = flattenLegacyPerPlayer(legacyUserBreakdown);
    const globalPerPlayer =
      breakdownByUserId?.[uid]?.perPlayer &&
      typeof breakdownByUserId[uid].perPlayer === "object"
        ? breakdownByUserId[uid].perPlayer
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

  const diffValues = Object.values(diffsByUid || {}).map((value) =>
    Math.abs(Number(value || 0))
  );
  const maxAbsDiff = diffValues.length ? Math.max(...diffValues) : 0;
  const nextPollAtMs =
    statusValue === "final"
      ? null
      : nowMs + TOURNAMENT_ACTIVE_POLL_MS;

  const weekResultPayload = {
    roomId,
    weekIndex: resolvedWeekIndex,
    startAtMs: Number(week.startAtMs || 0) || null,
    endAtMs: Number(week.endAtMs || 0) || null,
    roundLabel: week.roundLabel || null,
    status: statusValue,
    nextKickoffMs: nextKickoffMs ?? null,
    nextPollAtMs,
    forcedFinalByExpiredWindow,
    pastPostWindow,
    allFinished,
    anyInPlay,
    fixtureStatusById,
    teamScoresByUserId: totalsByUid,
    breakdownByUserId,
    matchups,
    weekLeaderboard,
    updatedAtMs: nowMs,
    computedAtMs: nowMs,
    source: "global-live-fixtures",
    activeScorers: newActiveScorers,
    benchByUserId: finalBenchByUserId,
    startersByUserId: finalStartersByUserId,
  };

  const weekResultWritePayload = {
    ...weekResultPayload,
    computedAt: FieldValue.serverTimestamp(),
  };

  const payload = {
    mode: realWriteAllowed ? "regular-global-aggregator" : "regular-shadow-aggregator",
    source: "global-live-fixtures",
    compareScope: "current-regular-week",
    writeMode: normalizedWriteMode,
    dryRun: Boolean(dryRun),
    realWriteApplied: Boolean(realWriteAllowed),

    roomId,
    weekIndex: resolvedWeekIndex,
    seasonKey: seasonContext.seasonKey,
    fixtureIds,
    fixtureCount: fixtureIds.length,
    missingFixtureCount: missingFixtureIds.length,
    userCount: scoreUsers.length,

    globalTotalsByUid: totalsByUid,
    globalBenchTotalsByUid: benchTotalsByUid,
    globalBreakdownByUserId: breakdownByUserId,

    legacyTotalsByUid,
    diffsByUid,
    maxAbsDiff,
    fixtureCoverage,
    playerMismatches,
    statMismatches,

    missingFixtureIds,
    missingPlayerIdsByUid,
    activeScorers: newActiveScorers,
    benchByUserId: finalBenchByUserId,
    startersByUserId: finalStartersByUserId,
    matchups,
    weekLeaderboard,

    weekResultPayload,
    weekStatus: statusValue,
    nextPollAtMs,
    roundLabel: week.roundLabel || null,

    updatedAtMs: nowMs,
  };

  if (realWriteAllowed) {
    await weekResultsRef.set(weekResultWritePayload, { merge: true });

    if (statusValue === "final") {
      const effectiveFinalizedAtMs =
        pastPostWindow && endAtMs > 0
          ? Math.min(nowMs, endAtMs + TOURNAMENT_POST_MS)
          : nowMs;

      await weekRef.set(
        {
          status: "final",
          finalizedAt: FieldValue.serverTimestamp(),
          finalizedAtMs: effectiveFinalizedAtMs,
        },
        { merge: true }
      );

      await recomputeRegularSeasonStandings({ roomId, users: scoreUsers });
    }
  } else {
    await roomRef
      .collection("globalShadowResults")
      .doc(`week-${resolvedWeekIndex}`)
      .set(
        {
          ...payload,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );
  }

  return payload;
}

async function collectActiveSeasonFixtureTargets(nowMs = Date.now(), roomDocs = null, options = {}) {
  const docs = Array.isArray(roomDocs)
    ? roomDocs
    : (await db.collection("rooms")
      .where("competitionState.weekStatus", "in", ["scheduled", "live", "resolving"])
      .get()).docs;
  const queueDueRoomIds = options?.queueDueRoomIds instanceof Set
    ? options.queueDueRoomIds
    : new Set();
  const runSweep = options?.runSweep === true;

  const stats = {
    roomsInput: docs.length,
    activeRoomCount: 0,
    sleepingRoomCount: 0,
    skippedDoneCount: 0,
    skippedFuturePollCount: 0,
    seasonTargetCount: 0,
  };

  const roomTargets = await Promise.all(
    docs.map(async (roomDoc) => {
      const roomId = roomDoc.id;
      const room = roomDoc.data() || {};
      const competitionState = getCompetitionState(room);
      if (roomLooksCompleteForPolling(room, competitionState)) {
        stats.skippedDoneCount += 1;
        return null;
      }

      if (!runSweep) {
        const sleepGuard = buildDeepPollingSkip(room, competitionState, nowMs, {
          isQueuedDue: queueDueRoomIds.has(roomId),
          enforceGlobalDue: true,
        });
        if (sleepGuard.skip) {
          stats.skippedFuturePollCount += 1;
          stats.sleepingRoomCount += 1;
          return null;
        }
      }

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
      const isWorldCupGroupRoom =
        room?.engineType === "worldCupDaily" ||
        room?.worldCup?.engineType === "worldCupDaily" ||
        room?.worldCupPhase === WORLD_CUP_GROUP_PHASE ||
        room?.worldCup?.phase === WORLD_CUP_GROUP_PHASE ||
        phaseLabel === "WorldCupGroup";

      if (isWorldCupGroupRoom) {
        const target = await buildWorldCupGroupSeasonTargetForRoom({
          db,
          roomId,
          room,
          nowMs,
          preMs: TOURNAMENT_PRE_MS,
          postMs: TOURNAMENT_POST_MS,
        });

        if (target?.skipped || target?.sleeping) {
          stats.sleepingRoomCount += 1;
          return null;
        }

        if (Array.isArray(target?.fixtureIds) && target.fixtureIds.length) {
          stats.activeRoomCount += 1;
          console.log("[collectActiveSeasonFixtureTargets] world cup group target", {
            roomId,
            seasonKey: target.seasonKey,
            dayIndex: target.dayIndex,
            dayLabel: target.dayLabel,
            fixtureIds: target.fixtureIds,
          });
          return target;
        }

        return null;
      }

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
        const cupStatus = String(cup?.status || cup?.globalApplyStatus || "").trim().toLowerCase();
        const cupNextPollAtMs = Number(
          cup?.nextPollAtMs ||
            competitionState?.nextCupPollAtMs ||
            competitionState?.nextPollAtMs ||
            0
        );

        if (
          ["final", "complete", "completed"].includes(cupStatus) &&
          !(Number.isFinite(cupNextPollAtMs) && cupNextPollAtMs <= nowMs)
        ) {
          stats.skippedDoneCount += 1;
          return null;
        }

        fixtureIds = buildCupGlobalRefreshFixtureIds(cup, nowMs);
        if (!fixtureIds.length) {
          stats.sleepingRoomCount += 1;
          return null;
        }
      } else {
        const weekIndex = Number(room?.currentWeekIndex);
        if (!Number.isFinite(weekIndex)) {
          return null;
        }

        const weekSnap = await db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`).get();
        if (!weekSnap.exists) {
          return null;
        }

        const week = weekSnap.data() || {};
        const weekFixtures = Array.isArray(week.fixtures) ? week.fixtures : [];
        const activeFixtures = getActivePollingFixtures(weekFixtures, nowMs);

        if (!activeFixtures.length) {
          stats.sleepingRoomCount += 1;
          return null;
        }

        fixtureIds = extractFixtureIdsFromWeekDoc({
          fixtures: activeFixtures,
          fixtureIds: [],
        });
      }

      if (!fixtureIds.length) {
        return null;
      }

      stats.activeRoomCount += 1;

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

  const targets = Array.from(grouped.values()).map((entry) => ({
    ...entry,
    fixtureIds: Array.from(entry.fixtureIds),
    roomIds: Array.from(entry.roomIds),
  }));

  stats.seasonTargetCount = targets.length;
  return { targets, stats };
}

function buildRegularSeasonTargetForRoom({ roomId, room, week, nowMs, includeAllWeekFixtures = false }) {
  const competition = room?.competition || {};
  const league = Number(competition?.league);
  const season = Number(competition?.season);

  if (!roomId || !Number.isFinite(league) || !Number.isFinite(season)) {
    return null;
  }

  const phaseLabel = getRoomPhaseLabel(room);
  if (phaseLabel === "Cup" || phaseLabel === "WorldCupGroup") {
    return null;
  }

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

  if (!seasonContext?.seasonKey) return null;

  const weekFixtures = Array.isArray(week?.fixtures) ? week.fixtures : [];
  const activeFixtures = includeAllWeekFixtures
    ? weekFixtures
    : getActivePollingFixtures(weekFixtures, nowMs);

  const fixtureIds = extractFixtureIdsFromWeekDoc({
    fixtures: activeFixtures,
    fixtureIds: [],
  });

  if (!fixtureIds.length) return null;

  return {
    roomId: String(roomId),
    seasonKey: seasonContext.seasonKey,
    competitionKey: seasonContext.competitionKey || "",
    competitionType: seasonContext.competitionType || "",
    league,
    season,
    timezone: String(competition?.timezone || "America/Los_Angeles"),
    fixtureIds,
    roomIds: [String(roomId)],
  };
}

async function refreshRegularGlobalCacheForRoom({
  roomId,
  room,
  week,
  apiKey,
  nowMs,
  reason = "",
  includeAllWeekFixtures = false,
}) {
  const seasonTarget = buildRegularSeasonTargetForRoom({
    roomId,
    room,
    week,
    nowMs,
    includeAllWeekFixtures,
  });

  if (!seasonTarget) {
    console.warn("[pollLiveTournamentWeeks] skipped global cache refresh before aggregation", {
      roomId,
      reason,
      fixtureCount: Array.isArray(week?.fixtures) ? week.fixtures.length : 0,
    });
    return { fixtureCount: 0, payloadCount: 0, skipped: true };
  }

  const result = await pollGlobalSeasonLiveFixturesOnce({
    seasonTarget,
    apiKey,
    nowMs,
  });

  console.log("[pollLiveTournamentWeeks] refreshed global cache before room aggregation", {
    roomId,
    seasonKey: seasonTarget.seasonKey,
    fixtureCount: result.fixtureCount,
    payloadCount: result.payloadCount,
    reason,
  });

  return result;
}

function buildGlobalFantasyByPlayerId(rawStatsByPlayerId = {}) {
  const fantasyByPlayerId = {};

  for (const [playerId, stats] of Object.entries(rawStatsByPlayerId || {})) {
    const rawPosition =
      stats?.rawApiPosition || stats?.position || stats?.pos || stats?.role || "";
    const position = rawPosition ? toPos(rawPosition) : "";
    // This shared cache value is a fixture-level preview/debug aid. Room scoring
    // paths recompute points with saved room/fantasy positions before using raw API position.
    const scorePosition = position || "MID";

    const scored = scorePlayer(stats || {}, scorePosition);

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

function normalizeApiFootballFixtureDetail(fixture = {}, nowMs = Date.now()) {
  const fixtureId = String(fixture?.fixture?.id ?? "").trim();
  const kickoffMs = fixture?.fixture?.timestamp
    ? Number(fixture.fixture.timestamp) * 1000
    : Date.parse(fixture?.fixture?.date);
  const statusShort = fixture?.fixture?.status?.short ?? null;

  return {
    fixtureId,
    statusShort,
    short: statusShort,
    fixtureStatus: statusShort,
    matchStatus: statusShort,
    statusLong: fixture?.fixture?.status?.long ?? null,
    elapsed: Number.isFinite(Number(fixture?.fixture?.status?.elapsed))
      ? Number(fixture.fixture.status.elapsed)
      : null,
    extra: Number.isFinite(Number(fixture?.fixture?.status?.extra))
      ? Number(fixture.fixture.status.extra)
      : null,
    kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : null,
    homeTeamId: fixture?.teams?.home?.id ?? null,
    homeTeamName: fixture?.teams?.home?.name || "",
    homeTeamLogo: fixture?.teams?.home?.logo || "",
    awayTeamId: fixture?.teams?.away?.id ?? null,
    awayTeamName: fixture?.teams?.away?.name || "",
    awayTeamLogo: fixture?.teams?.away?.logo || "",
    goalsHome: toNum(fixture?.goals?.home),
    goalsAway: toNum(fixture?.goals?.away),
    leagueId: fixture?.league?.id ?? null,
    leagueName: fixture?.league?.name || "",
    leagueRound: fixture?.league?.round || null,
    statusUpdatedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

async function fetchFixtureDetailsMapFromApiFootball({
  fixtureIds = [],
  timezone = "America/Los_Angeles",
  apiKey,
  nowMs = Date.now(),
}) {
  const ids = [...new Set((fixtureIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const detailsByFixtureId = {};
  if (!ids.length) return { detailsByFixtureId, missingFixtureIds: [] };

  const fetchList = async (params) => {
    const response = await apiFootballGet("fixtures", { ...params, timezone }, apiKey);
    return Array.isArray(response?.response) ? response.response : [];
  };

  let list = [];
  if (ids.length > 1) {
    list = await fetchList({ ids: ids.join("-") });
    if (!list.length) list = await fetchList({ ids: ids.join(",") });
  } else {
    list = await fetchList({ id: ids[0] });
  }

  const seen = new Set();
  for (const fixture of list || []) {
    const detail = normalizeApiFootballFixtureDetail(fixture, nowMs);
    if (!detail.fixtureId) continue;
    detailsByFixtureId[detail.fixtureId] = detail;
    seen.add(detail.fixtureId);
  }

  for (const id of ids) {
    if (seen.has(id)) continue;
    const one = await fetchList({ id });
    for (const fixture of one || []) {
      const detail = normalizeApiFootballFixtureDetail(fixture, nowMs);
      if (!detail.fixtureId) continue;
      detailsByFixtureId[detail.fixtureId] = detail;
      seen.add(detail.fixtureId);
    }
  }

  return {
    detailsByFixtureId,
    missingFixtureIds: ids.filter((id) => !detailsByFixtureId[id]),
  };
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
  const statusByFixtureId = await getFixtureStatusMap({
    fixtureIds,
    timezone,
    apiKey,
    source: "pollGlobalSeasonLiveFixturesOnce",
  });
  const detailsByFixtureId = await loadFixtureStatusDetailsMap(fixtureIds);

  let payloadCount = 0;
  const fixtureStatsDebug = {
    uniqueFixtureStatsChecked: 0,
    fixturePlayerStatsCacheHits: 0,
    fixturePlayerStatsApiCalls: 0,
    fixturePlayerStatsLockSkips: 0,
    fixturePlayerStatsStaleReturns: 0,
  };

  for (const fixtureId of fixtureIds) {
    const detail = detailsByFixtureId[fixtureId] || {};
    const short = statusByFixtureId[fixtureId] || detail?.short || null;
    const kickoffMs = Number(detail?.kickoffMs || 0);
    const kickoffHasPassed =
      Number.isFinite(kickoffMs) && kickoffMs > 0 && nowMs >= kickoffMs;
    const statusUpper = String(short || "").trim().toUpperCase();
    const isNonPlayableStatus = ["CANC", "PST", "TBD", "ABD", "AWD", "WO"].includes(statusUpper);
    const shouldFetchPlayers =
      hasFixtureStarted(short) ||
      (
        kickoffHasPassed &&
        !isFinished(short) &&
        !isNonPlayableStatus
      );

    let rawStatsByPlayerId = {};
    let fantasyByPlayerId = {};
    let payloadBytesEstimate = 0;

    if (shouldFetchPlayers) {
      fixtureStatsDebug.uniqueFixtureStatsChecked += 1;
      const ttlMs = isInPlay(short) || kickoffHasPassed ? 60 * 1000 : 60 * 60 * 1000;
      rawStatsByPlayerId = await getFixturePlayersStatsMapCached({
        fixtureId,
        apiKey,
        ttlMs,
        timeZone: timezone,
        source: "pollGlobalSeasonLiveFixturesOnce",
        statsDebug: fixtureStatsDebug,
      });
      fantasyByPlayerId = buildGlobalFantasyByPlayerId(rawStatsByPlayerId);

      const payloadDoc = {
        fixtureId: String(fixtureId),
        seasonKey,
        updatedAtMs: nowMs,
        computedAt: admin.firestore.FieldValue.serverTimestamp(),
        statusShort: short,
        statusLong: detail?.statusLong || null,
        elapsed: Number.isFinite(Number(detail?.elapsed)) ? Number(detail.elapsed) : null,
        extra: Number.isFinite(Number(detail?.extra)) ? Number(detail.extra) : null,
        kickoffMs: Number.isFinite(kickoffMs) && kickoffMs > 0 ? kickoffMs : null,
        isLive:
          isInPlay(short) ||
          (
            kickoffHasPassed &&
            !isFinished(short) &&
            !isNonPlayableStatus
          ),
        isFinished: isFinished(short),
        homeTeamId: detail?.homeTeamId ?? null,
        homeTeamName: detail?.homeTeamName || "",
        homeTeamLogo: detail?.homeTeamLogo || "",
        awayTeamId: detail?.awayTeamId ?? null,
        awayTeamName: detail?.awayTeamName || "",
        awayTeamLogo: detail?.awayTeamLogo || "",
        goalsHome: toNum(detail?.goalsHome),
        goalsAway: toNum(detail?.goalsAway),
        homeScore: toNum(detail?.goalsHome),
        awayScore: toNum(detail?.goalsAway),
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
        kickoffMs: Number.isFinite(kickoffMs) && kickoffMs > 0 ? kickoffMs : null,
        statusShort: short,
        statusLong: detail?.statusLong || null,
        elapsed: Number.isFinite(Number(detail?.elapsed)) ? Number(detail.elapsed) : null,
        extra: Number.isFinite(Number(detail?.extra)) ? Number(detail.extra) : null,
        isLive:
          isInPlay(short) ||
          (
            kickoffHasPassed &&
            !isFinished(short) &&
            !isNonPlayableStatus
          ),
        isFinished: isFinished(short),
        hasStarted: hasFixtureStarted(short) || kickoffHasPassed,
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
    uniqueFixtureStatsChecked: fixtureStatsDebug.uniqueFixtureStatsChecked,
    fixturePlayerStatsCacheHits: fixtureStatsDebug.fixturePlayerStatsCacheHits,
    fixturePlayerStatsApiCalls: fixtureStatsDebug.fixturePlayerStatsApiCalls,
    fixturePlayerStatsLockSkips: fixtureStatsDebug.fixturePlayerStatsLockSkips,
    fixturePlayerStatsStaleReturns: fixtureStatsDebug.fixturePlayerStatsStaleReturns,
  };
}

function getCupGlobalWindowTiming(cup = {}) {
  const kickoffValues = (Array.isArray(cup?.currentWindowFixtures)
    ? cup.currentWindowFixtures
    : [])
    .map((fixture) => Number(fixture?.kickoffMs || 0))
    .filter((kickoffMs) => Number.isFinite(kickoffMs) && kickoffMs > 0)
    .sort((a, b) => a - b);
  const storedStartAtMs = Number(cup?.currentWindowStartAtMs || 0);
  const storedEndAtMs = Number(cup?.currentWindowEndAtMs || 0);

  return {
    firstKickoffMs:
      Number.isFinite(storedStartAtMs) && storedStartAtMs > 0
        ? storedStartAtMs
        : kickoffValues[0] || null,
    lastKickoffMs:
      Number.isFinite(storedEndAtMs) && storedEndAtMs > 0
        ? storedEndAtMs
        : kickoffValues[kickoffValues.length - 1] || null,
  };
}

function buildCupGlobalSeasonTargetForRoom({ roomId, room = {}, cup = {} }) {
  if (
    getRoomPhaseLabel(room) !== "Cup" ||
    !isGlobalLiveFixtureCacheEnabled(room)
  ) {
    return null;
  }

  const competition = room?.competition || {};
  const league = Number(competition?.league);
  const season = Number(competition?.season);
  const fixtureIds = [...new Set(
    (Array.isArray(cup?.currentWindowFixtureIds) ? cup.currentWindowFixtureIds : [])
      .map((fixtureId) => String(fixtureId || "").trim())
      .filter(Boolean)
  )];
  const seasonContext = deriveRoomSeasonContext(room);

  if (
    !fixtureIds.length ||
    !seasonContext?.seasonKey ||
    !Number.isFinite(league) ||
    !Number.isFinite(season)
  ) {
    return null;
  }

  return {
    roomId: String(roomId),
    seasonKey: seasonContext.seasonKey,
    competitionKey: seasonContext.competitionKey || "",
    competitionType: seasonContext.competitionType || "",
    league,
    season,
    timezone: String(competition?.timezone || "America/Los_Angeles"),
    fixtureIds,
    roomIds: [String(roomId)],
  };
}

function fixtureIdFromCupFixture(fixture = {}) {
  return String(
    fixture?.fixtureId ||
      fixture?.id ||
      fixture?.fixture?.id ||
      ""
  ).trim();
}

function buildCupGlobalRefreshFixtureIds(cup = {}, nowMs = Date.now()) {
  const ids = [...new Set(
    (Array.isArray(cup?.currentWindowFixtureIds) ? cup.currentWindowFixtureIds : [])
      .map((fixtureId) => String(fixtureId || "").trim())
      .filter(Boolean)
  )];
  if (!ids.length) return [];

  const fixturesById = new Map();
  for (const fixture of Array.isArray(cup?.currentWindowFixtures) ? cup.currentWindowFixtures : []) {
    const fixtureId = fixtureIdFromCupFixture(fixture);
    if (fixtureId) fixturesById.set(fixtureId, { ...(fixture || {}) });
  }
  for (const coverage of Array.isArray(cup?.fixtureCoverage) ? cup.fixtureCoverage : []) {
    const fixtureId = fixtureIdFromCupFixture(coverage);
    if (!fixtureId) continue;
    fixturesById.set(fixtureId, {
      ...(fixturesById.get(fixtureId) || {}),
      ...(coverage || {}),
    });
  }

  const fixtureStatusById =
    cup?.fixtureStatusById && typeof cup.fixtureStatusById === "object"
      ? cup.fixtureStatusById
      : {};

  return ids.filter((fixtureId) => {
    const fixture = fixturesById.get(fixtureId) || { fixtureId };
    const statusShort = String(
      statusShortFromFixture(fixture) ||
        fixtureStatusById[fixtureId] ||
        ""
    ).trim().toUpperCase();
    const kickoffMs = kickoffMsFromFixture(fixture);
    const hasKickoff = Number.isFinite(kickoffMs) && kickoffMs > 0;
    const isLiveStatus = isInPlay(statusShort);
    const isFinalOrDead = isFinished(statusShort) || isCancelledOrAbandonedStatus(statusShort);
    const inPregameWindow =
      hasKickoff &&
      nowMs >= kickoffMs - TOURNAMENT_PRE_MS &&
      nowMs < kickoffMs;
    const kickoffPassedUnfinished =
      hasKickoff &&
      nowMs >= kickoffMs &&
      nowMs <= kickoffMs + TOURNAMENT_POST_MS &&
      !isFinalOrDead;
    const recentlyFinished =
      hasKickoff &&
      nowMs >= kickoffMs &&
      nowMs <= kickoffMs + TOURNAMENT_POST_MS &&
      isFinalOrDead;

    return (
      isLiveStatus ||
      inPregameWindow ||
      kickoffPassedUnfinished ||
      recentlyFinished
    );
  });
}

function globalSeasonRefreshDocId(seasonTarget = {}) {
  const seasonKey = String(seasonTarget?.seasonKey || "unknown").trim() || "unknown";
  const fixtureIds = [...new Set(
    (Array.isArray(seasonTarget?.fixtureIds) ? seasonTarget.fixtureIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )].sort();
  const key = `${seasonKey}:${fixtureIds.join("-")}`;
  return `globalSeasonRefresh_${hashToUint32(key).toString(16)}`;
}

async function acquireGlobalSeasonRefreshLock({
  seasonTarget,
  nowMs = Date.now(),
  source = "",
  roomId = "",
}) {
  const fixtureIds = [...new Set(
    (Array.isArray(seasonTarget?.fixtureIds) ? seasonTarget.fixtureIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )].sort();
  if (!seasonTarget?.seasonKey || !fixtureIds.length) {
    return { acquired: false, skippedReason: "global-refresh-target-empty" };
  }

  const ref = db.doc(`apiCache/${globalSeasonRefreshDocId({ ...seasonTarget, fixtureIds })}`);
  const lockOwner = [
    "globalSeasonRefresh",
    seasonTarget.seasonKey,
    nowMs,
    Math.random().toString(16).slice(2),
  ].join(":");
  let decision = { acquired: false, skippedReason: "unknown" };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.exists ? (snap.data() || {}) : {};
    const refreshStartedAtMs = Number(doc?.refreshStartedAtMs || 0);
    const lastRefreshAtMs = Number(doc?.lastRefreshAtMs || 0);
    const lockFresh =
      doc?.refreshInProgress === true &&
      Number.isFinite(refreshStartedAtMs) &&
      nowMs - refreshStartedAtMs < GLOBAL_SEASON_REFRESH_LOCK_MS;
    const recentlyRefreshed =
      Number.isFinite(lastRefreshAtMs) &&
      lastRefreshAtMs > 0 &&
      nowMs - lastRefreshAtMs < GLOBAL_SEASON_REFRESH_DEDUPE_MS;

    if (lockFresh || recentlyRefreshed) {
      decision = {
        acquired: false,
        skippedReason: lockFresh ? "global-refresh-lock-fresh" : "global-refresh-recent",
        lastRefreshAtMs: lastRefreshAtMs || null,
        refreshStartedAtMs: refreshStartedAtMs || null,
      };
      return;
    }

    tx.set(
      ref,
      {
        seasonKey: seasonTarget.seasonKey,
        fixtureIds,
        fixtureCount: fixtureIds.length,
        roomIds: Array.isArray(seasonTarget?.roomIds)
          ? seasonTarget.roomIds.map((id) => String(id || "")).filter(Boolean)
          : [],
        refreshInProgress: true,
        refreshStartedAtMs: nowMs,
        refreshOwner: lockOwner,
        refreshSource: source || "",
        refreshRoomId: roomId || "",
        updatedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    decision = { acquired: true, refPath: ref.path, fixtureIds };
  });

  return {
    ...decision,
    ref,
  };
}

async function finishGlobalSeasonRefreshLock(lock, {
  nowMs = Date.now(),
  result = null,
  error = null,
} = {}) {
  if (!lock?.acquired || !lock?.ref) return;
  await lock.ref.set(
    {
      refreshInProgress: false,
      refreshOwner: FieldValue.delete(),
      refreshCompletedAtMs: nowMs,
      lastRefreshAtMs: nowMs,
      lastFixtureCount: Number(result?.fixtureCount || 0),
      lastPayloadCount: Number(result?.payloadCount || 0),
      ...(error
        ? {
            lastRefreshErrorAtMs: nowMs,
            lastRefreshError: String(error?.message || error).slice(0, 500),
          }
        : {
            lastRefreshError: FieldValue.delete(),
          }),
      updatedAtMs: nowMs,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  ).catch(() => {});
}

async function refreshCupGlobalCacheForRoom({
  roomId,
  room = {},
  cup = {},
  apiKey,
  nowMs,
  reason = "",
}) {
  if (room?.started !== true) {
    return {
      fixtureCount: 0,
      payloadCount: 0,
      skipped: true,
      skippedReason: "cup-global-draft-not-started",
    };
  }

  const competitionState = getCompetitionState(room) || {};
  const cupStatus = String(cup?.status || cup?.globalApplyStatus || "").trim().toLowerCase();
  const cupNextPollAtMs = Number(
    cup?.nextPollAtMs ||
      competitionState?.nextCupPollAtMs ||
      competitionState?.nextPollAtMs ||
      0
  );
  if (
    roomLooksCompleteForPolling(room, competitionState) ||
    (
      ["final", "complete", "completed"].includes(cupStatus) &&
      !(Number.isFinite(cupNextPollAtMs) && cupNextPollAtMs <= nowMs)
    )
  ) {
    return {
      fixtureCount: 0,
      payloadCount: 0,
      skipped: true,
      skippedReason: "cup-global-room-complete",
    };
  }

  const seasonTarget = buildCupGlobalSeasonTargetForRoom({ roomId, room, cup });
  if (!seasonTarget) {
    return {
      fixtureCount: 0,
      payloadCount: 0,
      skipped: true,
      skippedReason: "cup-global-cache-target-missing",
    };
  }

  const refreshFixtureIds = buildCupGlobalRefreshFixtureIds(cup, nowMs);
  if (!refreshFixtureIds.length) {
    return {
      fixtureCount: seasonTarget.fixtureIds.length,
      refreshFixtureCount: 0,
      payloadCount: 0,
      skipped: true,
      skippedReason: "cup-global-cache-no-active-fixtures",
    };
  }

  const activeSeasonTarget = {
    ...seasonTarget,
    fixtureIds: refreshFixtureIds,
  };

  const { firstKickoffMs, lastKickoffMs } = getCupGlobalWindowTiming(cup);
  const activeFromMs = firstKickoffMs
    ? firstKickoffMs - TOURNAMENT_PRE_MS
    : null;
  const activeUntilMs = lastKickoffMs
    ? lastKickoffMs + TOURNAMENT_POST_MS
    : null;

  if (
    !activeFromMs ||
    !activeUntilMs ||
    nowMs < activeFromMs ||
    nowMs > activeUntilMs
  ) {
    return {
      fixtureCount: seasonTarget.fixtureIds.length,
      payloadCount: 0,
      skipped: true,
      skippedReason: "cup-global-cache-outside-active-window",
      activeFromMs,
      activeUntilMs,
    };
  }

  // This refresh writes the shared season cache used by every room. The key
  // prevents rooms on the same fixture window from fetching player stats again.
  const refreshKey = [
    activeSeasonTarget.seasonKey,
    ...activeSeasonTarget.fixtureIds.map(String).sort(),
  ].join(":");
  const previousRefresh = cupGlobalRefreshResultByKey.get(refreshKey);
  if (
    previousRefresh &&
    nowMs - Number(previousRefresh.refreshedAtMs || 0) <
      CUP_GLOBAL_CACHE_REFRESH_DEDUPE_MS
  ) {
    console.log("[pollLiveTournamentWeeks] reused shared Cup global cache refresh", {
      roomId,
      seasonKey: activeSeasonTarget.seasonKey,
      fixtureCount: activeSeasonTarget.fixtureIds.length,
      reason,
    });
    return {
      ...(previousRefresh.result || {}),
      deduped: true,
    };
  }

  const refreshLock = await acquireGlobalSeasonRefreshLock({
    seasonTarget: activeSeasonTarget,
    nowMs,
    source: "refreshCupGlobalCacheForRoom",
    roomId,
  });
  if (!refreshLock.acquired) {
    console.log("[pollLiveTournamentWeeks] skipped Cup global cache refresh due to shared lock", {
      roomId,
      seasonKey: activeSeasonTarget.seasonKey,
      fixtureCount: activeSeasonTarget.fixtureIds.length,
      skippedReason: refreshLock.skippedReason,
      reason,
    });
    return {
      fixtureCount: activeSeasonTarget.fixtureIds.length,
      payloadCount: 0,
      skipped: true,
      deduped: true,
      skippedReason: refreshLock.skippedReason,
    };
  }

  let result = null;
  try {
    result = await pollGlobalSeasonLiveFixturesOnce({
      seasonTarget: activeSeasonTarget,
      apiKey,
      nowMs,
    });
    await finishGlobalSeasonRefreshLock(refreshLock, { nowMs, result });
  } catch (error) {
    await finishGlobalSeasonRefreshLock(refreshLock, { nowMs, error });
    throw error;
  }

  cupGlobalRefreshResultByKey.set(refreshKey, {
    refreshedAtMs: nowMs,
    result,
  });
  for (const [key, value] of cupGlobalRefreshResultByKey.entries()) {
    if (
      nowMs - Number(value?.refreshedAtMs || 0) >
      CUP_GLOBAL_CACHE_REFRESH_DEDUPE_MS * 4
    ) {
      cupGlobalRefreshResultByKey.delete(key);
    }
  }

  console.log("[pollLiveTournamentWeeks] refreshed Cup global cache before aggregation", {
    roomId,
    seasonKey: activeSeasonTarget.seasonKey,
    fixtureCount: result.fixtureCount,
    fullWindowFixtureCount: seasonTarget.fixtureIds.length,
    refreshFixtureCount: activeSeasonTarget.fixtureIds.length,
    payloadCount: result.payloadCount,
    reason,
  });

  return result;
}

function isWorldCupKnockoutCupRoomForDiscovery(room = {}) {
  const phase = String(
    room?.worldCupPhase ||
      room?.worldCup?.phase ||
      room?.worldCup?.requestedPhase ||
      ""
  ).trim().toLowerCase();
  const competitionKey = String(room?.competitionKey || "").trim().toLowerCase();
  const competitionName = String(
    room?.competitionMeta?.name || room?.competition?.name || ""
  ).trim().toLowerCase();

  return (
    phase === WORLD_CUP_KNOCKOUT_PHASE &&
    (
      competitionKey.includes("worldcup") ||
      competitionKey.includes("world-cup") ||
      (competitionName.includes("world cup") &&
        !competitionName.includes("club world cup"))
    )
  );
}

async function keepCupGlobalWaitingForDiscovery({
  roomId,
  room,
  nowMs,
  retryAtMs,
  lastGlobalDiscoveryAtMs,
  afterMs = null,
  error = null,
}) {
  const roomRef = db.doc(`rooms/${roomId}`);
  const cupRef = roomRef.collection("cup").doc("current");
  const nextPollAtMs =
    Number.isFinite(Number(retryAtMs)) && Number(retryAtMs) > nowMs
      ? Number(retryAtMs)
      : nowMs + CUP_GLOBAL_DISCOVERY_RETRY_MS;

  await cupRef.set(
    {
      roomId,
      status: "scheduled",
      source: "global-live-fixtures",
      currentWindowId: null,
      currentWindowLabel: isWorldCupKnockoutCupRoomForDiscovery(room)
        ? "Waiting for knockout fixtures"
        : "Waiting for next round",
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
      globalApplyStatus: "waiting-for-global-window",
      nextGlobalDiscoveryAtMs: nextPollAtMs,
      lastGlobalDiscoveryAtMs: lastGlobalDiscoveryAtMs || nowMs,
      nextGlobalDiscoveryAfterMs:
        Number.isFinite(Number(afterMs)) && Number(afterMs) > 0
          ? Number(afterMs)
          : null,
      nextPollAtMs,
      ...(error
        ? {
            globalDiscoveryError: String(error?.message || error),
            globalDiscoveryErrorAtMs: nowMs,
          }
        : {}),
      updatedAtMs: nowMs,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await setCompetitionState(
    roomRef,
    {
      phaseLabel: "Cup",
      currentLabel: isWorldCupKnockoutCupRoomForDiscovery(room)
        ? "Waiting for knockout fixtures"
        : "Waiting for next round",
      weekStatus: "scheduled",
      nextPollAtMs,
      nextCupPollAtMs: nextPollAtMs,
      nextKickoffMs: null,
      isDone: false,
    },
    { roomData: room, nowMs }
  );

  await upsertTournamentPollTask({
    roomId,
    phase: "Cup",
    nextPollAtMs,
    reason: "cup-global-waiting-for-next-round",
    nowMs,
  });

  return {
    armed: false,
    nextPollAtMs,
    skippedReason: error
      ? "cup-global-next-window-discovery-error"
      : "cup-global-next-window-not-found",
  };
}

async function discoverAndArmNextCupGlobalWindow({
  roomId,
  room = {},
  cup = {},
  nowMs,
  afterMs = null,
  reason = "",
}) {
  const existingNextDiscoveryAtMs = Number(cup?.nextGlobalDiscoveryAtMs || 0);
  if (
    Number.isFinite(existingNextDiscoveryAtMs) &&
    existingNextDiscoveryAtMs > nowMs
  ) {
    await upsertTournamentPollTask({
      roomId,
      phase: "Cup",
      nextPollAtMs: existingNextDiscoveryAtMs,
      reason: "cup-global-waiting-for-next-round",
      nowMs,
    });
    return {
      armed: false,
      nextPollAtMs: existingNextDiscoveryAtMs,
      skippedReason: "cup-global-next-window-discovery-throttled",
    };
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const cupRef = roomRef.collection("cup").doc("current");
  const retryAtMs = nowMs + CUP_GLOBAL_DISCOVERY_RETRY_MS;
  const competition = room?.competition || {};
  const seasonContext = deriveRoomSeasonContext(room);
  const league = Number(competition?.league);
  const season = Number(competition?.season);
  const explicitAfterMs = Number(afterMs);
  const storedAfterMs = Number(cup?.nextGlobalDiscoveryAfterMs || 0);
  const resolvedAfterMs =
    Number.isFinite(explicitAfterMs) && explicitAfterMs > 0
      ? explicitAfterMs
      : Number.isFinite(storedAfterMs) && storedAfterMs > 0
        ? storedAfterMs
        : null;

  await cupRef.set(
    {
      lastGlobalDiscoveryAtMs: nowMs,
      nextGlobalDiscoveryAtMs: retryAtMs,
      updatedAtMs: nowMs,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  try {
    if (
      !seasonContext?.seasonKey ||
      !Number.isFinite(league) ||
      !Number.isFinite(season)
    ) {
      throw new Error("Cup global discovery is missing season context.");
    }

    const discoveryOptions = {
      fallbackDate: room?.seedFilter?.fixtureDate || null,
      ...(resolvedAfterMs ? { minKickoffMs: resolvedAfterMs } : {}),
    };
    const window = await fetchNextRoundWindow(competition, discoveryOptions);
    const worldCupKnockoutWindowIsValid =
      !isWorldCupKnockoutCupRoomForDiscovery(room) ||
      (
        window?.roundLabel &&
        buildWorldCupRoomMode({
          roundLabel: window.roundLabel,
          season,
        }).worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE
      );

    if (!window || !worldCupKnockoutWindowIsValid) {
      return keepCupGlobalWaitingForDiscovery({
        roomId,
        room,
        nowMs,
        retryAtMs,
        lastGlobalDiscoveryAtMs: nowMs,
        afterMs: resolvedAfterMs,
      });
    }

    const bootstrap = buildCupGlobalSeedBootstrap({
      roomId,
      window,
      league,
      season,
      nowMs,
    });
    if (!bootstrap?.cupCurrent?.currentWindowFixtureIds?.length) {
      return keepCupGlobalWaitingForDiscovery({
        roomId,
        room,
        nowMs,
        retryAtMs,
        lastGlobalDiscoveryAtMs: nowMs,
        afterMs: resolvedAfterMs,
      });
    }

    await Promise.all(
      bootstrap.fixtureSummaries.map((summary) =>
        writeSeasonFixtureSummary({
          db,
          seasonKey: seasonContext.seasonKey,
          fixtureId: summary.fixtureId,
          summary,
        })
      )
    );

    await cupRef.set(
      {
        ...bootstrap.cupCurrent,
        lastGlobalDiscoveryAtMs: nowMs,
        nextGlobalDiscoveryAtMs: FieldValue.delete(),
        nextGlobalDiscoveryAfterMs: FieldValue.delete(),
        globalDiscoveryError: FieldValue.delete(),
        globalDiscoveryErrorAtMs: FieldValue.delete(),
      },
      { merge: true }
    );
    await setCompetitionState(
      roomRef,
      bootstrap.competitionState,
      { roomData: room, nowMs }
    );
    await upsertTournamentPollTask({
      roomId,
      phase: "Cup",
      nextPollAtMs: bootstrap.cupCurrent.nextPollAtMs,
      reason: "cup-global-next-window-discovered",
      nowMs,
    });

    console.log("[pollLiveTournamentWeeks] discovered Cup global next window", {
      roomId,
      reason,
      seasonKey: seasonContext.seasonKey,
      windowId: bootstrap.cupCurrent.currentWindowId,
      windowLabel: bootstrap.cupCurrent.currentWindowLabel,
      fixtureCount: bootstrap.cupCurrent.currentWindowFixtureIds.length,
      nextPollAtMs: bootstrap.cupCurrent.nextPollAtMs,
    });

    return {
      armed: true,
      ...bootstrap.cupCurrent,
      nextKickoffMs: bootstrap.competitionState.nextKickoffMs,
    };
  } catch (error) {
    console.warn("[pollLiveTournamentWeeks] Cup global next-window discovery failed", {
      roomId,
      reason,
      code: error?.code,
      message: error?.message,
      retryAtMs,
    });
    return keepCupGlobalWaitingForDiscovery({
      roomId,
      room,
      nowMs,
      retryAtMs,
      lastGlobalDiscoveryAtMs: nowMs,
      afterMs: resolvedAfterMs,
      error,
    });
  }
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

function getWeekFinalizedAtMs(week = {}) {
  return (
    Number(week.finalizedAtMs || 0) ||
    (week.finalizedAt?.toMillis ? week.finalizedAt.toMillis() : 0)
  );
}

function getRegularFinalHoldPollAtMs(week = {}, nowMs = Date.now()) {
  const finalizedAtMs = getWeekFinalizedAtMs(week);
  return finalizedAtMs
    ? finalizedAtMs + REGULAR_FINAL_HOLD_MS
    : nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS;
}

async function putRegularRoomToFinalHold({ roomId, finalizedAtMs, roomData = null }) {
  const nowMs = Number(finalizedAtMs || Date.now());
  const nextPollAtMs = Number(finalizedAtMs || 0)
    ? Number(finalizedAtMs) + REGULAR_FINAL_HOLD_MS
    : nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS;
  const roomRef = db.doc(`rooms/${roomId}`);

  await Promise.all([
    setCompetitionState(
      roomRef,
      {
        weekStatus: "scheduled",
        nextKickoffMs: null,
        nextPollAtMs,
      },
      {
        ...(roomData ? { roomData } : {}),
        nowMs,
      }
    ),
    upsertTournamentPollTask({
      roomId,
      phase: "RegularSeason",
      nextPollAtMs,
      reason: "regular-final-hold",
      nowMs,
    }),
  ]);

  return nextPollAtMs;
}

async function putRegularFinalWeekToHoldIfNeeded({
  roomId,
  roomRef,
  weekRef,
  roomData,
  competitionState,
  phase = "RegularSeason",
  nowMs = Date.now(),
}) {
  const freshWeekSnap = await weekRef.get();
  const freshWeek = freshWeekSnap.exists ? (freshWeekSnap.data() || {}) : {};
  if (freshWeek.status !== "final") return false;

  const nextPollAtMs = getRegularFinalHoldPollAtMs(freshWeek, nowMs);

  await Promise.all([
    setCompetitionState(
      roomRef,
      {
        weekStatus: "scheduled",
        nextKickoffMs: null,
        nextPollAtMs,
      },
      {
        roomData: { ...roomData, competitionState },
        nowMs,
      }
    ),
    upsertTournamentPollTask({
      roomId,
      phase,
      nextPollAtMs,
      reason: "regular-final-hold",
      nowMs,
    }),
  ]);

  return true;
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
    const map = await getFixturePlayersStatsMapCached({
      fixtureId: fid,
      apiKey,
      ttlMs,
      timeZone: timezone,
      source: "computeAndWriteLiveWeek",
    });

    for (const [pidRaw, st] of Object.entries(map || {})) {
      const pid = String(pidRaw);
      if (!trackedIds.has(pid)) continue;

      const prev = aggStatsByPlayerId[pid] || {
        minutes: 0, passesCompleted: 0, goals: 0, assists: 0,
        saves: 0, goalsConceded: 0, yellow: 0, red: 0,
        pensScored: 0, pensSaved: 0, pensMissed: 0, pensCommitted: 0,
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

        pensScored: (prev.pensScored || 0) + (st.pensScored || 0),
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
      const finalizedAtMs = Date.now();
      await weekRef.set(
        {
          status: "final",
          finalizedAt: admin.firestore.FieldValue.serverTimestamp(),
          finalizedAtMs,
        },
        { merge: true }
      );

      await putRegularRoomToFinalHold({ roomId, finalizedAtMs });
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
    const finalizedAtMs = Date.now();
    await weekRef.set(
      {
        status: "final",
        finalizedAt: admin.firestore.FieldValue.serverTimestamp(),
        finalizedAtMs,
      },
      { merge: true }
    );

    await putRegularRoomToFinalHold({ roomId, finalizedAtMs });
    await recomputeRegularSeasonStandings({ roomId, users });
  }

  // Clear force flag if it was set
  if (prevResults.forceRecompute) {
    await weekResultsRef.set({ forceRecompute: admin.firestore.FieldValue.delete() }, { merge: true });
  }
}

async function completeRegularSeasonRoom({ roomId, room, nowMs = Date.now() }) {
  const users = await loadRegularStandingUsersForRoom(roomId).catch((e) => {
    console.warn("[completeRegularSeasonRoom] failed to load user names for standings", {
      roomId,
      error: String(e?.message || e),
    });
    return [];
  });

  if (users.length) {
    await recomputeRegularSeasonStandings({ roomId, users });
  } else {
    console.warn("[completeRegularSeasonRoom] skipping final standings recompute without user names", {
      roomId,
    });
  }
  await writeFinalResultsSnapshot({ roomId });

  const roomRef = db.doc(`rooms/${roomId}`);
  await roomRef.set(
    {
      seasonPhase: "COMPLETE",
      currentWeekIndex: null,
      completedAtMs: nowMs,
      completedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await setCompetitionState(
    roomRef,
    {
      phaseLabel: "RegularSeason",
      isDone: true,
      weekStatus: "complete",
      nextKickoffMs: null,
      nextPollAtMs: null,
    },
    {
      roomData: room,
      nowMs,
    }
  );

  await deleteTournamentPollTask(roomId);
  return "COMPLETE";
}

async function loadRegularStandingUsersForRoom(roomId) {
  const [membersSnap, standingsSnap] = await Promise.all([
    db.collection(`rooms/${roomId}/members`).get(),
    db.doc(`rooms/${roomId}/standings/current`).get(),
  ]);

  const existingNamesByUid = new Map();
  const standings = standingsSnap.exists ? (standingsSnap.data() || {}) : {};
  const rows = Array.isArray(standings.standings) ? standings.standings : [];

  for (const row of rows) {
    const uid = String(row?.userId || row?.uid || "").trim();
    if (!uid) continue;
    const name = String(row?.name || row?.displayName || "").trim();
    if (name) existingNamesByUid.set(uid, name);
  }

  const memberDataByUid = new Map();
  membersSnap.forEach((doc) => {
    const data = doc.data() || {};
    const uid = String(doc.id || data.uid || "").trim();
    if (!uid) return;
    memberDataByUid.set(uid, data);
  });

  const uids = Array.from(
    new Set([...memberDataByUid.keys(), ...existingNamesByUid.keys()])
  ).filter(Boolean).sort();

  if (!uids.length) return [];

  const refs = [];
  for (const uid of uids) {
    refs.push(db.doc(`users/${uid}`));
    refs.push(db.doc(`rooms/${roomId}/teamNames/${uid}`));
  }

  const snaps = await db.getAll(...refs);
  const out = [];

  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i];
    const userSnap = snaps[i * 2];
    const teamSnap = snaps[i * 2 + 1];
    const member = memberDataByUid.get(uid) || {};
    const profile = userSnap?.exists ? (userSnap.data() || {}) : {};
    const teamDoc = teamSnap?.exists ? (teamSnap.data() || {}) : {};
    const displayName =
      profile.displayName ||
      profile.name ||
      member.displayName ||
      member.name ||
      existingNamesByUid.get(uid) ||
      uid;
    const teamName = String(teamDoc.teamName || member.teamName || "").trim();

    out.push({
      userId: uid,
      uid,
      name: teamName ? `${displayName} - ${teamName}` : String(displayName),
      displayName: String(displayName),
    });
  }

  return out;
}

async function autoAdvanceWeekIfFinal({ roomId, room, currentWeekIndex, apiKey }) {
  const nowMs = Date.now();

  // Load current week (must be final to advance)
  const curRef = db.doc(`rooms/${roomId}/weeks/${String(currentWeekIndex)}`);
  const curSnap = await curRef.get();
  if (!curSnap.exists) return null;

  const curWeek = curSnap.data() || {};
  if (curWeek.status !== "final") return null;

  const finalizedAtMs = getWeekFinalizedAtMs(curWeek);

  if (finalizedAtMs && nowMs < finalizedAtMs + REGULAR_FINAL_HOLD_MS) {
    return null; // stay on FINAL for 24h
  }

  const endAtMs = Number(curWeek.endAtMs || 0);

  // Determine competition + total rounds
  const competition = room.competition;
  if (!competition?.league || !competition?.season) {
    console.warn(`[autoAdvanceWeekIfFinal] Missing room.competition for room ${roomId}`);
    return null; // or throw, depending on your preference
  }

  const curRound = parseRoundNumber(curWeek.roundLabel);
  const totalRounds = Number.isFinite(curRound)
    ? await ensureRoomTotalRounds({ roomId, room, competition, apiKey })
    : null;

  // If this was the LAST matchday, finalize season instead of creating next week
  // If this was the LAST matchday, finalize season instead of creating next week
  if (Number.isFinite(totalRounds) && Number.isFinite(curRound) && curRound >= totalRounds) {
    return completeRegularSeasonRoom({ roomId, room, nowMs });
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
  await ensureDefaultLineupsForRoom(roomId, memberUids);

  const nextWeekIndex = (indices.length ? Math.max(...indices) : Number(currentWeekIndex)) + 1;

  const fallbackDate = room?.seedFilter?.fixtureDate || null;

  // ✅ This is the key: skip anything at/before last week end kickoff
  const window = await fetchNextRoundWindow(competition, {
    fallbackDate,
    minKickoffMs: endAtMs + 60 * 1000, // +1 minute
  });

  if (!window) {
    if (!curWeek.roundLabel || !Number.isFinite(curRound)) {
      console.log("[autoAdvanceWeekIfFinal] no next fixture window; marking complete", {
        roomId,
        currentWeekIndex,
      });
      return completeRegularSeasonRoom({ roomId, room, nowMs });
    }

    return null;
  }

  const pairs = roundRobinPairings(memberUids, nextWeekIndex);

  const weekDoc = {
    index: nextWeekIndex,
    startAtMs: window.startAtMs,
    endAtMs: window.endAtMs,
    roundLabel: window.roundLabel || null,
    windowMode: window.windowMode || (window.roundLabel ? "round" : "fixture-cluster"),
    fixtures: window.fixtures,
    fixtureIds: window.fixtures.map((f) => f.id),
    competition,
    matchups: pairs,
    status: "scheduled",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.doc(`rooms/${roomId}/weeks/${String(nextWeekIndex)}`).set(weekDoc, { merge: true });
  await writeInitialWeekResultsPlaceholder({
    roomId,
    weekIndex: nextWeekIndex,
    weekDoc,
    memberUids,
    nowMs,
  });

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

  console.log("[autoAdvanceWeekIfFinal] created next week", {
    roomId,
    previousWeekIndex: currentWeekIndex,
    nextWeekIndex,
    roundLabel: window.roundLabel || null,
    startAtMs: window.startAtMs,
    endAtMs: window.endAtMs,
    fixtureCount: Array.isArray(window.fixtures) ? window.fixtures.length : 0,
  });

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
  await ensureDefaultLineupsForRoom(roomId, memberUids);

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
    windowMode: window.windowMode || (window.roundLabel ? "round" : "fixture-cluster"),
    fixtures: window.fixtures,
    fixtureIds: window.fixtures.map((f) => f.id),
    competition,
    matchups: pairs,
    status: "scheduled",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.doc(`rooms/${roomId}/weeks/${String(weekIndex)}`).set(weekDoc, { merge: true });
  await writeInitialWeekResultsPlaceholder({
    roomId,
    weekIndex,
    weekDoc,
    memberUids,
    nowMs,
  });

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
        timeZone: timezone,
        source: "fetchAggregatedStats"
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
                pensScored: 0, pensSaved: 0, pensMissed: 0, cleanSheet: false, ownGoals: 0,
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
            pensScored: (prev.pensScored || 0) + (st.pensScored || 0),
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

    const result = await computeRegularWeekFromGlobalCache({
      db,
      roomId,
      weekIndex: weekIndexRaw,
      nowMs: Date.now(),
      writeMode: "shadow",
      dryRun: true,
    });

    return {
      ok: true,
      roomId,
      weekIndex: result.weekIndex,
      seasonKey: result.seasonKey,
      fixtureCount: Number(result.fixtureCount || 0),
      missingFixtureCount: Number(result.missingFixtureCount || 0),
      userCount: Number(result.userCount || 0),
      maxAbsDiff: Number(result.maxAbsDiff || 0),
      diffsByUid: result.diffsByUid || {},
      globalTotalsByUid: result.globalTotalsByUid || {},
      legacyTotalsByUid: result.legacyTotalsByUid || {},
      fixtureCoverage: result.fixtureCoverage || [],
      playerMismatches: result.playerMismatches || [],
      statMismatches: result.statMismatches || [],
      matchups: result.matchups || [],
      weekLeaderboard: result.weekLeaderboard || [],
      compareScope: "current-regular-week",
      source: "global-live-fixtures",
    };
  }
);

exports.debugRunRegularGlobalAggregatorDryRun = onCall(
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
      throw new HttpsError("failed-precondition", "Room is Cup phase. This dry run is regular-season only.");
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

    const result = await computeRegularWeekFromGlobalCache({
      db,
      roomId,
      weekIndex: weekIndexRaw,
      nowMs: Date.now(),
      writeMode: "shadow",
      dryRun: true,
    });

    return {
      ok: true,
      dryRun: true,
      roomId,
      weekIndex: result.weekIndex,
      seasonKey: result.seasonKey,
      fixtureCount: Number(result.fixtureCount || 0),
      missingFixtureCount: Number(result.missingFixtureCount || 0),
      userCount: Number(result.userCount || 0),
      maxAbsDiff: Number(result.maxAbsDiff || 0),
      diffsByUid: result.diffsByUid || {},
      globalTotalsByUid: result.globalTotalsByUid || {},
      legacyTotalsByUid: result.legacyTotalsByUid || {},
      fixtureCoverage: result.fixtureCoverage || [],
      playerMismatches: result.playerMismatches || [],
      statMismatches: result.statMismatches || [],
      matchups: result.matchups || [],
      weekLeaderboard: result.weekLeaderboard || [],
      compareScope: "current-regular-week",
      source: "global-live-fixtures",
    };
  }
);

exports.debugApplyRegularGlobalAggregatorOnce = onCall(
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
      throw new HttpsError("failed-precondition", "Room is Cup phase. This callable is regular-season only.");
    }

    const pipelineMode = getGlobalPipelineMode(room);
    if (pipelineMode !== "global" || !isGlobalRoomAggregatorEnabled(room)) {
      throw new HttpsError(
        "failed-precondition",
        "Regular global aggregator is disabled. Set globalPipeline.mode='global' and globalPipeline.roomAggregator=true first."
      );
    }

    const result = await computeRegularWeekFromGlobalCache({
      db,
      roomId,
      weekIndex: weekIndexRaw,
      nowMs: Date.now(),
      writeMode: "global",
      dryRun: false,
    });

    return {
      ok: true,
      realWriteApplied: Boolean(result.realWriteApplied),
      roomId,
      weekIndex: result.weekIndex,
      seasonKey: result.seasonKey,
      fixtureCount: Number(result.fixtureCount || 0),
      missingFixtureCount: Number(result.missingFixtureCount || 0),
      userCount: Number(result.userCount || 0),
      maxAbsDiff: Number(result.maxAbsDiff || 0),
      diffsByUid: result.diffsByUid || {},
      matchups: result.matchups || [],
      weekLeaderboard: result.weekLeaderboard || [],
      weekStatus: result.weekStatus || null,
      source: result.source || "global-live-fixtures",
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

    return {
      ok: true,
      roomId,
      seasonKey: result.seasonKey,
      shadowSource: result.shadowSource || "cup-current",
      historyId: result.historyId || null,
      historyLabel: result.historyLabel || null,
      historyFixtureCount: result.historyFixtureCount || null,
      noFixtureIdsReason: result.noFixtureIdsReason || null,
      fixtureIds: result.fixtureIds || [],
      fixtureCount: Number(result.fixtureCount || 0),
      missingFixtureCount: Number(result.missingFixtureCount || 0),
      userCount: Number(result.userCount || 0),
      maxAbsDiff: Number(result.maxAbsDiff || 0),
      diffsByUid: result.diffsByUid || {},
      globalTotalsByUid: result.globalTotalsByUid || {},
      globalBenchTotalsByUid: result.globalBenchTotalsByUid || {},
      globalBreakdownByUserId: result.globalBreakdownByUserId || {},
      legacyWindowPointsByUid: result.legacyWindowPointsByUid || {},
      legacyLivePointsByUid: result.legacyLivePointsByUid || {},
      legacyCurrentWindowTotalsByUid: result.legacyCurrentWindowTotalsByUid || {},
      legacyCurrentWindowBreakdownByUserId: result.legacyCurrentWindowBreakdownByUserId || {},
      fixtureCoverage: result.fixtureCoverage || [],
      playerMismatches: result.playerMismatches || [],
      statMismatches: result.statMismatches || [],
      missingFixtureIds: result.missingFixtureIds || [],
      missingPlayerIdsByUid: result.missingPlayerIdsByUid || {},
      compareScope: result.compareScope || "current-cup-window",
      source: "global-live-fixtures",
    };
  }
);

function requireOwnerActionUid(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
  requireAdminUid(uid);
  return String(uid);
}

function getOwnerActionRoomId(request) {
  const roomId = String(request.data?.roomId || "").trim();
  if (!roomId) throw new HttpsError("invalid-argument", "roomId is required.");
  return roomId;
}

async function loadOwnerActionRoom(roomId) {
  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) throw new HttpsError("not-found", "Room not found.");
  return { roomRef, room: roomSnap.data() || {} };
}

function isOwnerWorldCupGroupRoom(room) {
  const competitionState = getCompetitionState(room);
  const worldCupPhase = String(
    room?.worldCupPhase || room?.worldCup?.phase || ""
  ).trim().toLowerCase();

  return (
    room?.engineType === "worldCupDaily" ||
    room?.worldCup?.engineType === "worldCupDaily" ||
    worldCupPhase === WORLD_CUP_GROUP_PHASE ||
    room?.competitionState?.phaseLabel === "WorldCupGroup" ||
    competitionState?.phaseLabel === "WorldCupGroup"
  );
}

function isOwnerWorldCupRoom(room = {}) {
  const worldCupPhase = String(
    room?.worldCupPhase || room?.worldCup?.phase || ""
  ).trim().toLowerCase();
  const engineType = String(
    room?.engineType || room?.worldCup?.engineType || ""
  ).trim();

  return (
    isOwnerWorldCupGroupRoom(room) ||
    worldCupPhase === WORLD_CUP_GROUP_PHASE ||
    worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE ||
    engineType === WORLD_CUP_GROUP_ENGINE ||
    (
      engineType === WORLD_CUP_KNOCKOUT_ENGINE &&
      isWorldCupCompetition({
        competitionKey: room?.competitionKey,
        competitionName:
          room?.competitionMeta?.name ||
          room?.competition?.name ||
          "",
      })
    ) ||
    isWorldCupCompetition({
      competitionKey: room?.competitionKey,
      competitionName:
        room?.competitionMeta?.name ||
        room?.competition?.name ||
        "",
    })
  );
}

function isOwnerWorldCupKnockoutRoom(room = {}) {
  const worldCupPhase = String(
    room?.worldCupPhase || room?.worldCup?.phase || ""
  ).trim().toLowerCase();
  const engineType = String(
    room?.engineType || room?.worldCup?.engineType || ""
  ).trim();

  return (
    worldCupPhase === WORLD_CUP_KNOCKOUT_PHASE ||
    (
      engineType === WORLD_CUP_KNOCKOUT_ENGINE &&
      isWorldCupCompetition({
        competitionKey: room?.competitionKey,
        competitionName:
          room?.competitionMeta?.name ||
          room?.competition?.name ||
          "",
      })
    )
  );
}

function isOwnerCupGlobalPipelineRoom(room = {}) {
  const pipeline = room?.globalPipeline || {};

  return (
    getGlobalPipelineMode(room) === "global" ||
    isOwnerWorldCupKnockoutRoom(room) ||
    pipeline?.roomAggregator === true ||
    pipeline?.liveFixtureCache === true ||
    pipeline?.globalLiveFixtureCache === true ||
    pipeline?.cupGlobalAutoApply === true ||
    pipeline?.cupAggregator === true ||
    pipeline?.cupGlobalCurrentWindowApply === true
  );
}

function assertOwnerLegacyCupRoom(room = {}) {
  assertOwnerCupRoom(room);

  if (isOwnerCupGlobalPipelineRoom(room)) {
    throw new HttpsError(
      "failed-precondition",
      "This room uses the Cup global pipeline. Use Force Global Cup Engine Now instead."
    );
  }
}

function assertOwnerCupGlobalPipelineRoom(room = {}) {
  assertOwnerCupRoom(room);

  if (!isOwnerCupGlobalPipelineRoom(room)) {
    throw new HttpsError(
      "failed-precondition",
      "This room is not configured for the Cup global pipeline."
    );
  }
}

function ownerNumberMap(map = {}) {
  const out = {};
  if (!map || typeof map !== "object") return out;

  for (const [uid, value] of Object.entries(map)) {
    const key = String(uid || "").trim();
    const n = Number(value || 0);
    if (!key || !Number.isFinite(n)) continue;
    out[key] = n;
  }

  return out;
}

function ownerHasNumberMapValues(map = {}) {
  return Object.values(ownerNumberMap(map)).some(
    (value) => Number(value || 0) !== 0
  );
}

function ownerAddNumberMaps(base = {}, add = {}) {
  const out = ownerNumberMap(base);

  for (const [uid, value] of Object.entries(ownerNumberMap(add))) {
    out[uid] = Number(out[uid] || 0) + Number(value || 0);
  }

  return out;
}

function ownerSubtractNumberMaps(base = {}, minus = {}) {
  const out = ownerNumberMap(base);

  for (const [uid, value] of Object.entries(ownerNumberMap(minus))) {
    out[uid] = Number(out[uid] || 0) - Number(value || 0);
  }

  return out;
}

function ownerTotalsFromBreakdownMap(breakdownByUserId = {}) {
  const out = {};
  if (!breakdownByUserId || typeof breakdownByUserId !== "object") return out;

  for (const [uid, breakdown] of Object.entries(breakdownByUserId)) {
    const key = String(uid || "").trim();
    if (!key || !breakdown || typeof breakdown !== "object") continue;

    const explicitTotal = Number(breakdown.total);
    if (Number.isFinite(explicitTotal)) {
      out[key] = explicitTotal;
      continue;
    }

    const starterTotal = Array.isArray(breakdown.starters)
      ? breakdown.starters.reduce(
          (sum, player) => sum + Number(player?.points || 0),
          0
        )
      : Object.values(breakdown.perPlayer || {}).reduce((sum, player) => {
          if (player?.counted === false) return sum;
          return sum + Number(player?.points || 0);
        }, 0);

    out[key] = Number.isFinite(starterTotal) ? starterTotal : 0;
  }

  return out;
}

function worldCupRepairPlayerIds(player = {}, fallbackId = "") {
  return Array.from(
    new Set(
      [
        fallbackId,
        player?.id,
        player?.playerId,
        player?.apiPlayerId,
        player?.pid,
        player?.player?.id,
      ]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeWorldCupRepairPlayer(player = {}, nowMs = Date.now()) {
  const playerId = worldCupRepairPlayerIds(player)[0];
  if (!playerId) return null;

  const teamId = String(
    player?.teamId ??
      player?.apiTeamId ??
      player?.team?.id ??
      ""
  ).trim();

  return {
    id: playerId,
    playerId,
    apiPlayerId: String(player?.apiPlayerId ?? playerId),
    name:
      player?.name ||
      player?.fullName ||
      player?.displayName ||
      player?.playerName ||
      player?.player?.name ||
      "Unknown",
    position: player?.position || player?.pos || "MID",
    teamId,
    apiTeamId: teamId,
    teamName: player?.teamName || player?.team?.name || "",
    teamLogo: player?.teamLogo || player?.team?.logo || "",
    nationality:
      player?.nationality ||
      player?.country ||
      player?.player?.nationality ||
      "",
    provider: player?.provider || "api-football",
    updatedAt: FieldValue.serverTimestamp(),
    addedByRepair: true,
    repairedAtMs: nowMs,
  };
}

async function writeMissingWorldCupRoomPlayers({
  roomRef,
  players = [],
}) {
  if (!players.length) return 0;

  let batch = db.batch();
  let operations = 0;
  let written = 0;

  const commitBatch = async () => {
    if (!operations) return;
    const currentBatch = batch;
    batch = db.batch();
    operations = 0;
    await currentBatch.commit();
  };

  for (const player of players) {
    batch.set(roomRef.collection("players").doc(player.id), player, {
      merge: true,
    });
    operations += 1;
    written += 1;

    if (operations >= 450) {
      await commitBatch();
    }
  }

  await commitBatch();
  return written;
}

function assertOwnerRegularRoom(room) {
  const phase = getRoomPhaseLabel(room);
  if (phase === "Cup" || isOwnerWorldCupGroupRoom(room)) {
    throw new HttpsError(
      "failed-precondition",
      "This owner action is only for regular season rooms."
    );
  }
}

function assertOwnerCupRoom(room) {
  const phase = getRoomPhaseLabel(room);
  if (phase !== "Cup") {
    throw new HttpsError("failed-precondition", "Room is not in Cup phase.");
  }
}

function resolveOwnerWeekIndex(room, weekIndexRaw) {
  const resolved = Number(
    Number.isFinite(Number(weekIndexRaw)) && Number(weekIndexRaw) > 0
      ? weekIndexRaw
      : room?.currentWeekIndex
  );

  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new HttpsError("failed-precondition", "Room does not have a valid currentWeekIndex.");
  }

  return resolved;
}

function logOwnerAction(functionName, data = {}) {
  console.log(`[${functionName}] owner action`, data);
}

function handleOwnerActionError(functionName, err) {
  console.error(`[${functionName}] failed`, {
    code: err?.code,
    message: err?.message,
    stack: err?.stack,
  });

  if (err instanceof HttpsError) throw err;
  if (isApiFootballCooldownError(err)) {
    throw createApiFootballCooldownError({
      reason: apiFootballCooldownReason(err),
      cooldownUntilMs: getApiFootballCooldownRetryAtMs(err, Date.now()),
      safeMode: err?.safeMode === true,
    });
  }
  throw new HttpsError("internal", err?.message || `${functionName} failed.`);
}

exports.ownerGetApiFootballRuntimeStatus = onCall(
  { region: "us-west2" },
  async (request) => {
    const functionName = "ownerGetApiFootballRuntimeStatus";
    try {
      requireOwnerActionUid(request);
      return {
        ok: true,
        path: API_FOOTBALL_RUNTIME_PATH,
        runtime: await readApiFootballRuntimeStatus(Date.now()),
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerSetApiFootballSafeMode = onCall(
  { region: "us-west2" },
  async (request) => {
    const functionName = "ownerSetApiFootballSafeMode";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const enabled = request.data?.enabled;
      if (typeof enabled !== "boolean") {
        throw new HttpsError(
          "invalid-argument",
          "enabled must be true or false."
        );
      }

      const reason = String(request.data?.reason || "").trim().slice(0, 240);
      const cooldownMinutesRaw = Number(request.data?.cooldownMinutes);
      const hasCooldownMinutes =
        Number.isFinite(cooldownMinutesRaw) && cooldownMinutesRaw > 0;
      const clearCooldown = request.data?.clearCooldown === true;
      const payload = {
        safeMode: enabled,
        safeModeReason:
          reason || (enabled ? "Owner enabled safe mode." : "Owner disabled safe mode."),
        safeModeUpdatedByUid: uid,
        safeModeUpdatedAtMs: nowMs,
        updatedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (enabled && hasCooldownMinutes) {
        payload.cooldownUntilMs =
          nowMs + Math.round(cooldownMinutesRaw * 60 * 1000);
        payload.cooldownReason =
          reason || "Owner enabled API-Football safe mode cooldown.";
      } else if (!enabled && clearCooldown) {
        payload.cooldownUntilMs = FieldValue.delete();
        payload.cooldownReason = FieldValue.delete();
      }

      await db.doc(API_FOOTBALL_RUNTIME_PATH).set(payload, { merge: true });

      return {
        ok: true,
        path: API_FOOTBALL_RUNTIME_PATH,
        runtime: await readApiFootballRuntimeStatus(nowMs),
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

function summarizeRegularGlobalResult(result, extras = {}) {
  return {
    ok: true,
    ...extras,
    roomId: result.roomId,
    weekIndex: result.weekIndex,
    seasonKey: result.seasonKey,
    fixtureCount: Number(result.fixtureCount || 0),
    missingFixtureCount: Number(result.missingFixtureCount || 0),
    userCount: Number(result.userCount || 0),
    maxAbsDiff: Number(result.maxAbsDiff || 0),
    diffsByUid: result.diffsByUid || {},
    matchups: result.matchups || [],
    weekLeaderboard: result.weekLeaderboard || [],
    weekStatus: result.weekStatus || null,
    source: result.source || "global-live-fixtures",
  };
}

async function buildRegularStandingsUsersForRoom({ roomId, roomRef, room }) {
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
      name: teamName ? `${displayName} - ${teamName}` : displayName,
    });
  }

  return users;
}

exports.ownerForceRegularWeekUpdate = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerForceRegularWeekUpdate";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { roomRef, room } = await loadOwnerActionRoom(roomId);
      assertOwnerRegularRoom(room);

      const weekIndex = resolveOwnerWeekIndex(room, request.data?.weekIndex);
      logOwnerAction(functionName, { functionName, uid, roomId, weekIndex, nowMs });

      const weekSnap = await roomRef.collection("weeks").doc(String(weekIndex)).get();
      if (!weekSnap.exists) {
        throw new HttpsError("failed-precondition", `Week ${weekIndex} not found.`);
      }

      await db.doc(`rooms/${roomId}/weekResults/${String(weekIndex)}`).set(
        { forceRecompute: true },
        { merge: true }
      );

      await computeAndWriteLiveWeek({
        roomId,
        weekIndex,
        apiKey: APIFOOTBALL_KEY.value(),
      });

      await db.doc(`rooms/${roomId}/weekResults/${String(weekIndex)}`).set(
        { forceRecompute: FieldValue.delete() },
        { merge: true }
      );

      await roomRef.collection("weeks").doc(String(weekIndex)).set(
        { forceRecompute: FieldValue.delete() },
        { merge: true }
      );

      const [resultSnap, freshRoomSnap] = await Promise.all([
        db.doc(`rooms/${roomId}/weekResults/${String(weekIndex)}`).get(),
        roomRef.get(),
      ]);
      const weekResult = resultSnap.exists ? resultSnap.data() || {} : null;
      const freshRoom = freshRoomSnap.exists ? freshRoomSnap.data() || {} : {};

      return {
        ok: true,
        roomId,
        weekIndex,
        message: "Owner force week update complete.",
        weekResult,
        status: weekResult?.status || null,
        weekStatus: weekResult?.status || null,
        competitionState: getCompetitionState(freshRoom),
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRepairRegularWeekFixtures = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRepairRegularWeekFixtures";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room, roomRef } = await loadOwnerActionRoom(roomId);
      assertOwnerRegularRoom(room);

      const weekIndex = resolveOwnerWeekIndex(room, request.data?.weekIndex);
      logOwnerAction(functionName, { functionName, uid, roomId, weekIndex, nowMs });

      const weekRef = roomRef.collection("weeks").doc(String(weekIndex));
      const weekSnap = await weekRef.get();
      if (!weekSnap.exists) {
        throw new HttpsError("failed-precondition", `Week ${weekIndex} not found.`);
      }

      const week = weekSnap.data() || {};
      const competition = week.competition || room.competition || {};
      const league = Number(competition.league);
      const season = Number(competition.season);
      if (!Number.isFinite(league) || !Number.isFinite(season)) {
        throw new HttpsError("failed-precondition", "Week is missing competition league/season.");
      }

      const startAtMs = Number(week.startAtMs || 0);
      const endAtMs = Number(week.endAtMs || 0);
      if (!Number.isFinite(startAtMs) || !Number.isFinite(endAtMs) || startAtMs <= 0 || endAtMs <= 0) {
        throw new HttpsError("failed-precondition", "Week is missing a valid fixture window.");
      }

      const fromStr = new Date(startAtMs - 86400000).toISOString().split("T")[0];
      const toStr = new Date(endAtMs + 86400000).toISOString().split("T")[0];
      const timezone = competition.timezone || room?.competition?.timezone || "America/Los_Angeles";

      const res = await apiFootballGet("fixtures", {
        league,
        season,
        from: fromStr,
        to: toStr,
        timezone,
      }, APIFOOTBALL_KEY.value());

      const games = Array.isArray(res?.response) ? res.response : [];
      if (!games.length) {
        return {
          ok: false,
          roomId,
          weekIndex,
          fixtureCount: 0,
          fixtureIds: [],
          roundLabel: week.roundLabel || null,
          nextPollAtMs: null,
          nextKickoffMs: null,
          message: "No games found in API for this week window.",
        };
      }

      const fixtures = games
        .map((m) => {
          const id = m?.fixture?.id;
          const kickoffMs =
            m?.fixture?.timestamp ? Number(m.fixture.timestamp) * 1000 : Date.parse(m?.fixture?.date);
          return {
            id: id ? String(id) : null,
            fixtureId: id ? String(id) : null,
            kickoffMs,
            round: m?.league?.round || null,
            roundLabel: m?.league?.round || null,
            homeTeamId: m?.teams?.home?.id != null ? String(m.teams.home.id) : "",
            homeTeamName: m?.teams?.home?.name || "",
            homeTeamLogo: m?.teams?.home?.logo || "",
            awayTeamId: m?.teams?.away?.id != null ? String(m.teams.away.id) : "",
            awayTeamName: m?.teams?.away?.name || "",
            awayTeamLogo: m?.teams?.away?.logo || "",
          };
        })
        .filter((fixture) => fixture.id && Number.isFinite(fixture.kickoffMs))
        .sort((a, b) => a.kickoffMs - b.kickoffMs);

      const fixtureIds = fixtures.map((fixture) => String(fixture.id));
      const roundLabel = fixtures.find((fixture) => fixture.roundLabel)?.roundLabel || week.roundLabel || null;
      const sleepInfo = getNextPollAtMsFromFixtures(fixtures, nowMs);

      await weekRef.set(
        {
          fixtures,
          fixtureIds,
          fixturesRaw: games,
          roundLabel,
        },
        { merge: true }
      );

      await setCompetitionState(
        roomRef,
        {
          weekStatus: "scheduled",
          nextPollAtMs: sleepInfo.nextPollAtMs ?? null,
          nextKickoffMs: sleepInfo.nextKickoffMs ?? null,
        },
        {
          roomData: room,
          nowMs,
        }
      );

      if (sleepInfo.nextPollAtMs) {
        await upsertTournamentPollTask({
          roomId,
          phase: "RegularSeason",
          nextPollAtMs: sleepInfo.nextPollAtMs,
          reason: "owner-repair-week-fixtures",
          nowMs,
        });
      }

      return {
        ok: true,
        roomId,
        weekIndex,
        fixtureCount: fixtures.length,
        fixtureIds,
        roundLabel,
        queueRepaired: Boolean(sleepInfo.nextPollAtMs),
        nextPollAtMs: sleepInfo.nextPollAtMs ?? null,
        nextKickoffMs: sleepInfo.nextKickoffMs ?? null,
        message: `Updated Week ${weekIndex} with ${fixtures.length} fixtures.`,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRebuildRegularStandings = onCall(
  { region: "us-west2" },
  async (request) => {
    const functionName = "ownerRebuildRegularStandings";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { roomRef, room } = await loadOwnerActionRoom(roomId);
      assertOwnerRegularRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const users = await buildRegularStandingsUsersForRoom({ roomId, roomRef, room });
      const standings = await recomputeRegularSeasonStandings({ roomId, users });
      const standingsSnap = await db.doc(`rooms/${roomId}/standings/current`).get();

      return {
        ok: true,
        roomId,
        userCount: users.length,
        standingsCount: standings.length,
        standingsDoc: standingsSnap.exists ? standingsSnap.data() || null : null,
        standings,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRunCupEngineNow = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRunCupEngineNow";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { roomRef, room } = await loadOwnerActionRoom(roomId);
      assertOwnerLegacyCupRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

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
        apiKey: APIFOOTBALL_KEY.value(),
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
        roomId,
        message: "Owner Cup engine run complete.",
        cup: cupSnap.exists ? cupSnap.data() : null,
        competitionState: freshRoomSnap.exists
          ? getCompetitionState(freshRoomSnap.data() || {})
          : null,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRunCupGlobalEngineNow = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRunCupGlobalEngineNow";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { roomRef, room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupGlobalPipelineRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const cupRef = db.doc(`rooms/${roomId}/cup/current`);
      let cupSnap = await cupRef.get();
      let cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
      let fixtureIds = Array.isArray(cup?.currentWindowFixtureIds)
        ? cup.currentWindowFixtureIds.map(String).filter(Boolean)
        : [];

      if (!fixtureIds.length) {
        await armNextCupGlobalWindowFromCache({
          db,
          roomId,
          room,
          nowMs,
        });

        cupSnap = await cupRef.get();
        cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
        fixtureIds = Array.isArray(cup?.currentWindowFixtureIds)
          ? cup.currentWindowFixtureIds.map(String).filter(Boolean)
          : [];
      }

      if (!fixtureIds.length) {
        throw new HttpsError(
          "failed-precondition",
          "Cup global engine requires cup/current.currentWindowFixtureIds."
        );
      }

      let refreshResult = null;
      try {
        refreshResult = await refreshCupGlobalCacheForRoom({
          roomId,
          room,
          cup,
          apiKey: APIFOOTBALL_KEY.value(),
          nowMs,
          reason: "owner-run-cup-global-engine-now",
        });
      } catch (refreshError) {
        if (isApiFootballCooldownError(refreshError)) {
          throw refreshError;
        }

        console.warn("[ownerRunCupGlobalEngineNow] cache refresh failed; using existing global cache", {
          roomId,
          code: refreshError?.code,
          message: refreshError?.message,
        });
        refreshResult = {
          skipped: true,
          skippedReason: "refresh-failed-existing-cache",
          errorMessage: refreshError?.message || String(refreshError),
        };
      }

      const result = await computeCupCurrentWindowFromGlobalCache({
        db,
        roomId,
        nowMs,
        writeMode: "global",
        dryRun: false,
      });

      const statusValue = String(result?.statusValue || result?.status || "").toLowerCase();
      const nextKickoffMsRaw = Number(result?.nextKickoffMs || 0);
      const resultNextPollAtMsRaw = Number(result?.nextPollAtMs || 0);
      const nextKickoffMs =
        Number.isFinite(nextKickoffMsRaw) && nextKickoffMsRaw > 0
          ? nextKickoffMsRaw
          : null;
      const nextPollAtMs =
        Number.isFinite(resultNextPollAtMsRaw) && resultNextPollAtMsRaw > nowMs
          ? resultNextPollAtMsRaw
          : statusValue === "live" || statusValue === "resolving"
            ? nowMs + TOURNAMENT_ACTIVE_POLL_MS
            : statusValue === "final" || result?.allFinished === true
              ? null
              : nextKickoffMs
                ? getNextPollAtMsFromFixtures(
                    [{ fixtureId: "cup-window", kickoffMs: nextKickoffMs }],
                    nowMs
                  ).nextPollAtMs
                : nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS;
      const nextWeekStatus =
        statusValue === "live"
          ? "live"
          : statusValue === "resolving"
            ? "resolving"
            : statusValue === "final"
              ? "resolving"
              : "scheduled";

      if (Number.isFinite(Number(nextPollAtMs)) && Number(nextPollAtMs) > nowMs) {
        await setCompetitionState(
          roomRef,
          {
            phaseLabel: "Cup",
            weekStatus: nextWeekStatus,
            nextPollAtMs,
            nextCupPollAtMs: nextPollAtMs,
            nextKickoffMs,
            isDone: false,
            ...buildTournamentPollDebugLabels(room, nextPollAtMs, nextKickoffMs),
          },
          { roomData: room, nowMs }
        );
        await upsertTournamentPollTask({
          roomId,
          phase: "Cup",
          nextPollAtMs,
          reason: "owner-run-cup-global-engine-now",
          nowMs,
        });
      } else {
        await deleteTournamentPollTask(roomId);
      }

      const [freshCupSnap, freshRoomSnap] = await Promise.all([
        cupRef.get(),
        roomRef.get(),
      ]);
      const freshCup = freshCupSnap.exists ? (freshCupSnap.data() || {}) : {};
      const freshRoom = freshRoomSnap.exists ? (freshRoomSnap.data() || {}) : {};

      return {
        ok: true,
        roomId,
        mode: "cup-global-engine-now",
        refreshSkipped: Boolean(refreshResult?.skipped),
        refreshSkippedReason: refreshResult?.skippedReason || null,
        refreshFixtureCount: Number(refreshResult?.refreshFixtureCount || 0),
        fullWindowFixtureCount: Number(
          Array.isArray(freshCup?.currentWindowFixtureIds)
            ? freshCup.currentWindowFixtureIds.length
            : fixtureIds.length
        ),
        payloadCount: Number(refreshResult?.payloadCount || 0),
        realWriteApplied: Boolean(result.realWriteApplied),
        fixtureCount: Number(result.fixtureCount || 0),
        missingFixtureCount: Number(result.missingFixtureCount || 0),
        statusValue: result.statusValue || null,
        allFinished: Boolean(result.allFinished),
        anyInPlay: Boolean(result.anyInPlay),
        nextPollAtMs: nextPollAtMs || null,
        nextKickoffMs,
        queueUpdated:
          Number.isFinite(Number(nextPollAtMs)) && Number(nextPollAtMs) > nowMs,
        queueDeleted:
          !(Number.isFinite(Number(nextPollAtMs)) && Number(nextPollAtMs) > nowMs),
        cupSummary: {
          status: freshCup?.status || null,
          globalApplyStatus: freshCup?.globalApplyStatus || null,
          currentWindowLabel: freshCup?.currentWindowLabel || null,
          currentWindowFixtureIds: Array.isArray(freshCup?.currentWindowFixtureIds)
            ? freshCup.currentWindowFixtureIds
            : [],
          projectedTotalsByUid: freshCup?.projectedTotalsByUid || {},
          livePointsByUid: freshCup?.livePointsByUid || {},
        },
        competitionState: getCompetitionState(freshRoom) || null,
        writtenPath: `rooms/${roomId}/cup/current`,
        auditPath: `rooms/${roomId}/globalShadowResults/cup-apply-current-window`,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRepairCupGlobalDuplicateCurrentWindow = onCall(
  { region: "us-west2", timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const functionName = "ownerRepairCupGlobalDuplicateCurrentWindow";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      if (request.data?.confirm !== "REPAIR_CUP_GLOBAL_DUPLICATE_WINDOW") {
        throw new HttpsError(
          "failed-precondition",
          "Cup global duplicate-window repair requires confirm='REPAIR_CUP_GLOBAL_DUPLICATE_WINDOW'."
        );
      }

      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupGlobalPipelineRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const cupRef = db.doc(`rooms/${roomId}/cup/current`);
      const cupSnap = await cupRef.get();
      if (!cupSnap.exists) {
        throw new HttpsError("not-found", "cup/current was not found.");
      }

      const cup = cupSnap.data() || {};
      const fixtureIds = [...new Set(
        (Array.isArray(cup?.currentWindowFixtureIds)
          ? cup.currentWindowFixtureIds
          : [])
          .map((fixtureId) => String(fixtureId || "").trim())
          .filter(Boolean)
      )];
      const creditedFixtures =
        cup?.creditedFixtures && typeof cup.creditedFixtures === "object"
          ? cup.creditedFixtures
          : {};
      const creditedCurrentWindowFixtureIds = fixtureIds.filter((fixtureId) =>
        Boolean(creditedFixtures[fixtureId])
      );
      const currentGlobalBreakdownByUserId =
        cup?.globalCurrentWindowBreakdownByUserId &&
        typeof cup.globalCurrentWindowBreakdownByUserId === "object" &&
        Object.keys(cup.globalCurrentWindowBreakdownByUserId).length
          ? cup.globalCurrentWindowBreakdownByUserId
          : cup?.liveBreakdownByUserId &&
            typeof cup.liveBreakdownByUserId === "object"
            ? cup.liveBreakdownByUserId
            : {};
      const currentGlobalPointsByUid = ownerHasNumberMapValues(
        cup?.globalCurrentWindowPointsByUid
      )
        ? ownerNumberMap(cup.globalCurrentWindowPointsByUid)
        : ownerHasNumberMapValues(cup?.livePointsByUid)
          ? ownerNumberMap(cup.livePointsByUid)
          : ownerTotalsFromBreakdownMap(currentGlobalBreakdownByUserId);
      const legacyBreakdownByUserId =
        cup?.windowBreakdownByUserId &&
        typeof cup.windowBreakdownByUserId === "object" &&
        Object.keys(cup.windowBreakdownByUserId).length
          ? cup.windowBreakdownByUserId
          : cup?.breakdownByUserId &&
            typeof cup.breakdownByUserId === "object"
            ? cup.breakdownByUserId
            : {};
      const legacyWindowPointsByUid = ownerHasNumberMapValues(cup?.windowPointsByUid)
        ? ownerNumberMap(cup.windowPointsByUid)
        : ownerTotalsFromBreakdownMap(legacyBreakdownByUserId);
      const duplicateDetected =
        ownerHasNumberMapValues(legacyWindowPointsByUid) ||
        creditedCurrentWindowFixtureIds.length > 0 ||
        (
          Object.keys(legacyBreakdownByUserId || {}).length > 0 &&
          Object.keys(currentGlobalBreakdownByUserId || {}).length > 0
        );
      const storedGlobalBaseTotalsByUid =
        cup?.globalBaseTotalsByUid &&
        typeof cup.globalBaseTotalsByUid === "object" &&
        Object.keys(cup.globalBaseTotalsByUid).length
          ? ownerNumberMap(cup.globalBaseTotalsByUid)
          : null;
      const previousPublicTotalsByUid = ownerHasNumberMapValues(cup?.projectedTotalsByUid)
        ? ownerNumberMap(cup.projectedTotalsByUid)
        : ownerAddNumberMaps(
            cup?.creditedTotalsByUid || cup?.cupTotalsByUid || {},
            cup?.livePointsByUid || {}
          );
      const baseSourceTotalsByUid = ownerHasNumberMapValues(cup?.cupTotalsByUid)
        ? ownerNumberMap(cup.cupTotalsByUid)
        : ownerNumberMap(cup?.creditedTotalsByUid || {});
      const baseTotalsByUid = storedGlobalBaseTotalsByUid ||
        (duplicateDetected && ownerHasNumberMapValues(legacyWindowPointsByUid)
          ? ownerSubtractNumberMaps(baseSourceTotalsByUid, legacyWindowPointsByUid)
          : ownerNumberMap(cup?.creditedTotalsByUid || baseSourceTotalsByUid));
      const projectedTotalsByUid = ownerAddNumberMaps(
        baseTotalsByUid,
        currentGlobalPointsByUid
      );
      const affectedUids = [...new Set([
        ...Object.keys(previousPublicTotalsByUid),
        ...Object.keys(projectedTotalsByUid),
        ...Object.keys(legacyWindowPointsByUid),
      ])].filter((uid) =>
        Number(previousPublicTotalsByUid[uid] || 0) !==
          Number(projectedTotalsByUid[uid] || 0) ||
        Number(legacyWindowPointsByUid[uid] || 0) !== 0
      );
      const backupPath = `rooms/${roomId}/globalShadowResults/cup-global-duplicate-window-backup-${nowMs}`;
      const currentWindowFixtureIdSet = new Set(fixtureIds);
      const fixtureLedgerSnap = await cupRef.collection("fixtures").get();
      const legacyFixtureLedgerDocs = fixtureLedgerSnap.docs
        .map((docSnap) => {
          const data = docSnap.data() || {};
          const fixtureId = String(data.fixtureId || docSnap.id || "").trim();
          return {
            ref: docSnap.ref,
            id: docSnap.id,
            fixtureId,
            data,
          };
        })
        .filter((row) =>
          fixtureIds.length > 0 &&
          currentWindowFixtureIdSet.has(String(row.fixtureId || row.id))
        );

      await db.doc(backupPath).set(
        {
          roomId,
          mode: "cup-global-duplicate-window-backup",
          originalCupCurrent: cup,
          originalCupFixtureLedgerDocs: legacyFixtureLedgerDocs.map((row) => ({
            id: row.id,
            fixtureId: row.fixtureId,
            data: row.data,
          })),
          duplicateDetected,
          affectedUids,
          backedUpAtMs: nowMs,
          backedUpAt: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );

      if (legacyFixtureLedgerDocs.length) {
        const batch = db.batch();
        legacyFixtureLedgerDocs.forEach((row) => batch.delete(row.ref));
        await batch.commit();
      }

      const standingsRows = Object.entries(projectedTotalsByUid)
        .map(([rowUid, total]) => {
          const breakdown = currentGlobalBreakdownByUserId[rowUid] || {};
          const displayName =
            breakdown.displayName ||
            breakdown.name ||
            rowUid;
          return {
            rank: 0,
            uid: rowUid,
            userId: rowUid,
            name: displayName,
            displayName,
            teamName: breakdown.teamName || "",
            totalFantasyPoints: Number(total || 0),
          };
        })
        .sort((a, b) =>
          Number(b.totalFantasyPoints || 0) - Number(a.totalFantasyPoints || 0)
        )
        .map((row, index) => ({ ...row, rank: index + 1 }));

      await cupRef.set(
        {
          creditedTotalsByUid: baseTotalsByUid,
          cupTotalsByUid: baseTotalsByUid,
          globalBaseTotalsByUid: baseTotalsByUid,
          globalBaseAdjustedForCurrentWindow: duplicateDetected,
          removedLegacyWindowPointsByUid: legacyWindowPointsByUid,
          creditedCurrentWindowFixtureIds,
          projectedTotalsByUid,
          projectedStandingsRows: standingsRows,
          standingsRows,
          standings: standingsRows,
          leaderboard: standingsRows,
          rows: standingsRows,
          projectedIncludesLivePoints: Object.values(currentGlobalPointsByUid)
            .some((value) => Number(value || 0) !== 0),
          globalCurrentWindowPointsByUid: currentGlobalPointsByUid,
          globalCurrentWindowBreakdownByUserId: currentGlobalBreakdownByUserId,
          livePointsByUid: currentGlobalPointsByUid,
          liveBreakdownByUserId: currentGlobalBreakdownByUserId,
          windowPointsByUid: {},
          windowBenchPointsByUid: {},
          windowBreakdownByUserId: {},
          breakdownByUserId: {},
          creditedFixtures: {},
          duplicateGlobalRepairAtMs: nowMs,
          duplicateGlobalRepairBackupPath: backupPath,
          updatedAtMs: nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      await db.doc(`rooms/${roomId}/standings/current`).set(
        {
          roomId,
          mode: "cup",
          source: "global-live-fixtures",
          projectionOnly: true,
          creditedTotalsByUid: baseTotalsByUid,
          globalBaseTotalsByUid: baseTotalsByUid,
          globalBaseAdjustedForCurrentWindow: duplicateDetected,
          removedLegacyWindowPointsByUid: legacyWindowPointsByUid,
          projectedTotalsByUid,
          livePointsByUid: currentGlobalPointsByUid,
          includesLivePoints: Object.values(currentGlobalPointsByUid)
            .some((value) => Number(value || 0) !== 0),
          standings: standingsRows,
          projectedStandingsRows: standingsRows,
          leaderboard: standingsRows,
          rows: standingsRows,
          standingsRows,
          cupTotalsByUid: FieldValue.delete(),
          windowPointsByUid: FieldValue.delete(),
          windowBreakdownByUserId: FieldValue.delete(),
          breakdownByUserId: FieldValue.delete(),
          legacyWindowPointsByUid: FieldValue.delete(),
          legacyLivePointsByUid: FieldValue.delete(),
          totalFantasyPointsByUid: FieldValue.delete(),
          repairedDuplicateCurrentWindowAtMs: nowMs,
          updatedAtMs: nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return {
        ok: true,
        roomId,
        mode: "cup-global-duplicate-current-window-repair",
        duplicateDetected,
        affectedUids,
        beforeTotalsByUid: previousPublicTotalsByUid,
        afterTotalsByUid: projectedTotalsByUid,
        baseTotalsByUid,
        currentGlobalPointsByUid,
        removedLegacyWindowPointsByUid: legacyWindowPointsByUid,
        creditedCurrentWindowFixtureIds,
        deletedFixtureLedgerCount: legacyFixtureLedgerDocs.length,
        deletedFixtureLedgerIds: legacyFixtureLedgerDocs.map((row) => row.id),
        backupPath,
        writtenPath: `rooms/${roomId}/cup/current`,
        standingsPath: `rooms/${roomId}/standings/current`,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRunCupShadowTest = onCall(
  { region: "us-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRunCupShadowTest";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const result = await computeGlobalCupShadowResults({ db, roomId, nowMs });

      return {
        ok: true,
        roomId,
        seasonKey: result.seasonKey,
        shadowSource: result.shadowSource || "cup-current",
        historyId: result.historyId || null,
        historyLabel: result.historyLabel || null,
        historyFixtureCount: result.historyFixtureCount || null,
        noFixtureIdsReason: result.noFixtureIdsReason || null,
        fixtureIds: result.fixtureIds || [],
        missingFixtureIds: result.missingFixtureIds || [],
        fixtureCount: Number(result.fixtureCount || 0),
        missingFixtureCount: Number(result.missingFixtureCount || 0),
        userCount: Number(result.userCount || 0),
        maxAbsDiff: Number(result.maxAbsDiff || 0),
        diffsByUid: result.diffsByUid || {},
        globalTotalsByUid: result.globalTotalsByUid || {},
        legacyWindowPointsByUid: result.legacyWindowPointsByUid || {},
        legacyLivePointsByUid: result.legacyLivePointsByUid || {},
        legacyCurrentWindowTotalsByUid: result.legacyCurrentWindowTotalsByUid || {},
        globalBreakdownByUserId: result.globalBreakdownByUserId || {},
        legacyCurrentWindowBreakdownByUserId: result.legacyCurrentWindowBreakdownByUserId || {},
        fixtureCoverage: result.fixtureCoverage || [],
        playerMismatches: result.playerMismatches || [],
        statMismatches: result.statMismatches || [],
        compareScope: result.compareScope || "current-cup-window",
        source: "global-live-fixtures",
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerEnableRoomGlobalPipeline = onCall(
  { region: "us-west2", timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const functionName = "ownerEnableRoomGlobalPipeline";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);

      if (request.data?.confirm !== "ENABLE_GLOBAL_PIPELINE") {
        throw new HttpsError(
          "failed-precondition",
          "Enable global pipeline requires confirm='ENABLE_GLOBAL_PIPELINE'."
        );
      }

      const { roomRef, room } = await loadOwnerActionRoom(roomId);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const backupPath = `rooms/${roomId}/globalShadowResults/global-pipeline-before-owner-enable`;
      const globalPipeline = buildDefaultGlobalPipeline("global");

      await db.doc(backupPath).set(
        {
          roomId,
          mode: "global-pipeline-backup",
          originalGlobalPipeline: room.globalPipeline || null,
          backedUpAtMs: nowMs,
          backedUpAt: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );

      await roomRef.set(
        {
          globalPipeline,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: nowMs,
        },
        { merge: true }
      );

      return {
        ok: true,
        roomId,
        mode: "owner-enable-global-pipeline",
        pipelineMode: "global",
        globalPipeline,
        backupPath,
        writtenPath: `rooms/${roomId}`,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerSetCupGlobalAutoApply = onCall(
  { region: "us-west2", timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const functionName = "ownerSetCupGlobalAutoApply";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const enabled = request.data?.enabled === true;

      if (request.data?.enabled !== true && request.data?.enabled !== false) {
        throw new HttpsError("invalid-argument", "enabled must be true or false.");
      }

      const expectedConfirm = enabled ? "CUP_GLOBAL_AUTO_ON" : "CUP_GLOBAL_AUTO_OFF";
      if (request.data?.confirm !== expectedConfirm) {
        throw new HttpsError(
          "failed-precondition",
          `Cup global auto apply requires confirm='${expectedConfirm}'.`
        );
      }

      const { roomRef, room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, enabled, nowMs });

      const backupPath = `rooms/${roomId}/globalShadowResults/cup-global-auto-before-toggle`;
      const previousPipeline =
        room.globalPipeline && typeof room.globalPipeline === "object"
          ? room.globalPipeline
          : {};
      const nextGlobalPipeline = {
        ...buildDefaultGlobalPipeline("global"),
        ...previousPipeline,
        mode: "global",
        liveFixtureCache: true,
        roomAggregator: true,
        cupGlobalAutoApply: enabled,
        cupGlobalAutoApplyUpdatedAtMs: nowMs,
      };

      await db.doc(backupPath).set(
        {
          roomId,
          mode: "cup-global-auto-backup",
          originalGlobalPipeline: previousPipeline,
          backedUpAtMs: nowMs,
          backedUpAt: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );

      await roomRef.set(
        {
          globalPipeline: nextGlobalPipeline,
          updatedAtMs: nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const verifySnap = await roomRef.get();
      const verifyRoom = verifySnap.exists ? (verifySnap.data() || {}) : {};
      const autoApplyEnabled = isCupGlobalAutoApplyEnabled(verifyRoom);

      if (enabled === true && autoApplyEnabled !== true) {
        throw new HttpsError(
          "failed-precondition",
          "Cup global auto apply write did not verify."
        );
      }

      return {
        ok: true,
        roomId,
        mode: "owner-set-cup-global-auto-apply",
        enabled,
        autoApplyEnabled,
        pipelineMode: getGlobalPipelineMode(verifyRoom),
        globalPipeline: verifyRoom.globalPipeline || nextGlobalPipeline,
        backupPath,
        writtenPath: `rooms/${roomId}`,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRunCupGlobalAutoOnce = onCall(
  { region: "us-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRunCupGlobalAutoOnce";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);

      if (!isCupGlobalAutoApplyEnabled(room)) {
        throw new HttpsError(
          "failed-precondition",
          "Cup global auto apply is not enabled for this room."
        );
      }

      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const result = await computeCupCurrentWindowFromGlobalCache({
        db,
        roomId,
        nowMs,
        writeMode: "global",
        dryRun: false,
      });

      return {
        ok: true,
        roomId,
        mode: "cup-global-auto-once",
        realWriteApplied: Boolean(result.realWriteApplied),
        projectionOnly: true,
        fixtureCount: Number(result.fixtureCount || 0),
        missingFixtureCount: Number(result.missingFixtureCount || 0),
        statusValue: result.statusValue || null,
        allFinished: Boolean(result.allFinished),
        anyInPlay: Boolean(result.anyInPlay),
        hasStaleInPlayFixtures: Boolean(result.hasStaleInPlayFixtures),
        staleInPlayFixtureIds: result.staleInPlayFixtureIds || [],
        nextPollAtMs: result.nextPollAtMs || null,
        projectedUserCount: Array.isArray(result.projectedStandingsRows)
          ? result.projectedStandingsRows.length
          : 0,
        writtenPath: `rooms/${roomId}/cup/current`,
        auditPath: `rooms/${roomId}/globalShadowResults/cup-apply-current-window`,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerSetCupGlobalFinalize = onCall(
  { region: "us-west2", timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const functionName = "ownerSetCupGlobalFinalize";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const enabled = request.data?.enabled === true;

      if (request.data?.enabled !== true && request.data?.enabled !== false) {
        throw new HttpsError("invalid-argument", "enabled must be true or false.");
      }

      const expectedConfirm = enabled ? "CUP_GLOBAL_FINALIZE_ON" : "CUP_GLOBAL_FINALIZE_OFF";
      if (request.data?.confirm !== expectedConfirm) {
        throw new HttpsError(
          "failed-precondition",
          `Cup global finalization requires confirm='${expectedConfirm}'.`
        );
      }

      const { roomRef, room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, enabled, nowMs });

      const backupPath = `rooms/${roomId}/globalShadowResults/cup-global-finalize-before-toggle`;
      const previousPipeline =
        room.globalPipeline && typeof room.globalPipeline === "object"
          ? room.globalPipeline
          : {};
      const previousAutoApply =
        previousPipeline.cupGlobalAutoApply === true ||
        previousPipeline.cupAggregator === true ||
        previousPipeline.cupGlobalCurrentWindowApply === true;
      const nextGlobalPipeline = {
        ...buildDefaultGlobalPipeline("global"),
        ...previousPipeline,
        mode: "global",
        liveFixtureCache: true,
        roomAggregator: true,
        cupGlobalAutoApply: enabled ? true : previousAutoApply,
        cupGlobalFinalize: enabled,
        cupGlobalFinalizeUpdatedAtMs: nowMs,
      };

      await db.doc(backupPath).set(
        {
          roomId,
          mode: "cup-global-finalize-backup",
          originalGlobalPipeline: previousPipeline,
          backedUpAtMs: nowMs,
          backedUpAt: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );

      await roomRef.set(
        {
          globalPipeline: nextGlobalPipeline,
          updatedAtMs: nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const verifySnap = await roomRef.get();
      const verifyRoom = verifySnap.exists ? (verifySnap.data() || {}) : {};
      const finalizeEnabled = isCupGlobalFinalizationEnabled(verifyRoom);
      const autoApplyEnabled = isCupGlobalAutoApplyEnabled(verifyRoom);

      if (finalizeEnabled !== enabled) {
        throw new HttpsError(
          "failed-precondition",
          "Cup global finalization write did not verify."
        );
      }

      return {
        ok: true,
        roomId,
        mode: "owner-set-cup-global-finalize",
        enabled,
        finalizeEnabled,
        autoApplyEnabled,
        pipelineMode: getGlobalPipelineMode(verifyRoom),
        backupPath,
        writtenPath: `rooms/${roomId}`,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRehearseCupGlobalFinalizeCurrentWindow = onCall(
  { region: "us-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRehearseCupGlobalFinalizeCurrentWindow";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const cupSnap = await db.doc(`rooms/${roomId}/cup/current`).get();
      const cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
      const applyResult = await computeCupCurrentWindowFromGlobalCache({
        db,
        roomId,
        nowMs,
        writeMode: "shadow",
        dryRun: true,
      });
      const finalization = buildCupGlobalFinalizationPayload({
        roomId,
        room,
        cup,
        applyResult,
        nowMs,
      });
      const writtenPath = `rooms/${roomId}/globalShadowResults/cup-finalize-rehearsal`;

      await db.doc(writtenPath).set(
        {
          mode: "cup-global-finalize-rehearsal",
          roomId,
          windowKey: finalization.windowKey,
          historyDocId: finalization.historyDocId,
          fixtureCount: finalization.fixtureCount,
          statusValue: finalization.statusValue,
          allFinished: finalization.allFinished,
          projectedUserCount: finalization.standingsRows.length,
          historyPayload: finalization.historyPayload,
          builtAtMs: nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );

      return {
        ok: true,
        roomId,
        mode: "cup-global-finalize-rehearsal",
        windowKey: finalization.windowKey,
        historyDocId: finalization.historyDocId,
        fixtureCount: finalization.fixtureCount,
        statusValue: finalization.statusValue,
        allFinished: finalization.allFinished,
        projectedUserCount: finalization.standingsRows.length,
        writtenPath,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerFinalizeCupGlobalCurrentWindowOnce = onCall(
  { region: "us-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerFinalizeCupGlobalCurrentWindowOnce";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);

      const cupSnap = await db.doc(`rooms/${roomId}/cup/current`).get();
      const cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
      if (cup?.replayTestMode === true) {
        throw new HttpsError(
          "failed-precondition",
          "Real Cup global finalization is blocked in replayTestMode. Use rehearsal for replay testing."
        );
      }

      if (!isCupGlobalFinalizationEnabled(room)) {
        throw new HttpsError(
          "failed-precondition",
          "Cup global finalization is not enabled for this room."
        );
      }

      if (request.data?.confirm !== "FINALIZE_CUP_GLOBAL_WINDOW") {
        throw new HttpsError(
          "failed-precondition",
          "Cup global finalization requires confirm='FINALIZE_CUP_GLOBAL_WINDOW'."
        );
      }

      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const applyResult = await computeCupCurrentWindowFromGlobalCache({
        db,
        roomId,
        nowMs,
        writeMode: "global",
        dryRun: false,
      });

      if (
        applyResult?.realWriteApplied !== true ||
        applyResult?.allFinished !== true ||
        String(applyResult?.statusValue || "").toLowerCase() !== "final" ||
        Number(applyResult?.missingFixtureCount || 0) !== 0
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Cup global finalization requires a successful final global apply."
        );
      }

      const finalization = await finalizeCupGlobalCurrentWindow({
        db,
        roomId,
        room,
        cup,
        applyResult,
        nowMs,
      });

      return {
        ok: true,
        roomId,
        mode: "cup-global-finalized-window",
        windowKey: finalization.windowKey,
        historyDocId: finalization.historyDocId,
        fixtureCount: finalization.fixtureCount,
        statusValue: finalization.statusValue,
        allFinished: finalization.allFinished,
        finalizedUserCount: finalization.finalizedUserCount,
        wroteFinalResults: finalization.wroteFinalResults,
        historyPath: finalization.historyPath,
        cupCurrentPath: finalization.cupCurrentPath,
        standingsPath: finalization.standingsPath,
        finalResultsPath: finalization.finalResultsPath,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRefreshCupGlobalFixtureCache = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRefreshCupGlobalFixtureCache";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const cupSnap = await db.doc(`rooms/${roomId}/cup/current`).get();
      const cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
      const fixtureIds = [...new Set((Array.isArray(cup?.currentWindowFixtureIds) ? cup.currentWindowFixtureIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean))];

      if (!fixtureIds.length) {
        throw new HttpsError(
          "failed-precondition",
          "Refresh requires cup/current.currentWindowFixtureIds."
        );
      }

      const seasonContext = deriveRoomSeasonContext(room);
      if (!seasonContext?.seasonKey) {
        throw new HttpsError("failed-precondition", "Could not resolve seasonKey for room.");
      }

      const competition = room.competition || {};
      const timezone = String(
        competition?.timezone ||
          room?.timezone ||
          "America/Los_Angeles"
      );
      const apiKey = APIFOOTBALL_KEY.value();
      const { detailsByFixtureId, missingFixtureIds } = await fetchFixtureDetailsMapFromApiFootball({
        fixtureIds,
        timezone,
        apiKey,
        nowMs,
      });

      let refreshedCount = 0;
      let writtenSummaryCount = 0;
      let writtenLiveFixtureCount = 0;
      const statusByFixtureId = {};
      const fixtureStatsDebug = {
        uniqueFixtureStatsChecked: 0,
        fixturePlayerStatsCacheHits: 0,
        fixturePlayerStatsApiCalls: 0,
        fixturePlayerStatsLockSkips: 0,
        fixturePlayerStatsStaleReturns: 0,
      };

      for (const fixtureId of fixtureIds) {
        const detail = detailsByFixtureId[String(fixtureId)] || null;
        if (!detail) continue;

        const statusShort = detail.statusShort || null;
        statusByFixtureId[String(fixtureId)] = statusShort;

        await db.doc(`apiCache/fixtureStatus_${fixtureId}`).set(
          {
            ...detail,
            short: statusShort,
            statusShort,
            updatedAtMs: nowMs,
          },
          { merge: true }
        );

        const fixtureMeta = {
          ...detail,
          fixtureId: String(fixtureId),
          fixtureStatus: statusShort,
          matchStatus: statusShort,
          statusUpdatedAtMs: nowMs,
        };

        fixtureStatsDebug.uniqueFixtureStatsChecked += 1;
        let rawStatsByPlayerId = await getFixturePlayersStatsMapCached({
          fixtureId,
          apiKey,
          ttlMs: isInPlay(statusShort) ? 60 * 1000 : 60 * 60 * 1000,
          timeZone: timezone,
          forceRefresh: true,
          source: functionName,
          statsDebug: fixtureStatsDebug,
        });
        rawStatsByPlayerId = patchPlayerStatsWithFixtureMeta(
          rawStatsByPlayerId || {},
          fixtureMeta
        );
        let rawStatsSource = "api-football-cache";

        if (!rawStatsByPlayerId || Object.keys(rawStatsByPlayerId).length === 0) {
          const existingLiveSnap = await getSeasonLiveFixtureRef(
            db,
            seasonContext.seasonKey,
            fixtureId
          ).get();
          const existingLive = existingLiveSnap.exists ? (existingLiveSnap.data() || {}) : {};
          const existingRawStats =
            existingLive?.rawStatsByPlayerId && typeof existingLive.rawStatsByPlayerId === "object"
              ? existingLive.rawStatsByPlayerId
              : {};

          if (Object.keys(existingRawStats).length > 0) {
            rawStatsByPlayerId = patchPlayerStatsWithFixtureMeta(existingRawStats, fixtureMeta);
            rawStatsSource = "existing-global-live-fixture";
          }
        }

        const fantasyByPlayerId = buildGlobalFantasyByPlayerId(rawStatsByPlayerId);
        const livePayload = {
          fixtureId: String(fixtureId),
          seasonKey: seasonContext.seasonKey,
          source: "owner-cup-global-fixture-cache-refresh",
          rawStatsSource,
          updatedAtMs: nowMs,
          computedAt: FieldValue.serverTimestamp(),
          statusShort,
          statusLong: detail.statusLong || null,
          elapsed: detail.elapsed ?? null,
          extra: detail.extra ?? null,
          kickoffMs: detail.kickoffMs ?? null,
          isLive: isInPlay(statusShort),
          isFinished: isFinished(statusShort),
          homeTeamId: detail.homeTeamId ?? null,
          homeTeamName: detail.homeTeamName || "",
          homeTeamLogo: detail.homeTeamLogo || "",
          awayTeamId: detail.awayTeamId ?? null,
          awayTeamName: detail.awayTeamName || "",
          awayTeamLogo: detail.awayTeamLogo || "",
          goalsHome: toNum(detail.goalsHome),
          goalsAway: toNum(detail.goalsAway),
          homeScore: toNum(detail.goalsHome),
          awayScore: toNum(detail.goalsAway),
          rawStatsByPlayerId,
          fantasyByPlayerId,
          rawStatsPlayerCount: Object.keys(rawStatsByPlayerId || {}).length,
          fantasyPlayerCount: Object.keys(fantasyByPlayerId || {}).length,
        };
        const payloadBytesEstimate = estimateDocBytes(livePayload);

        await writeSeasonLiveFixture({
          db,
          seasonKey: seasonContext.seasonKey,
          fixtureId,
          payload: {
            ...livePayload,
            payloadBytesEstimate,
          },
        });
        writtenLiveFixtureCount += 1;

        await db.doc(`apiCache/fixturePlayers_${fixtureId}`).set(
          {
            updatedAtMs: nowMs,
            playerStats: rawStatsByPlayerId,
          },
          { merge: true }
        );

        await writeSeasonFixtureSummary({
          db,
          seasonKey: seasonContext.seasonKey,
          fixtureId,
          summary: {
            fixtureId: String(fixtureId),
            seasonKey: seasonContext.seasonKey,
            competitionKey: seasonContext.competitionKey || room.competitionKey || "",
            competitionType: seasonContext.competitionType || room.competitionType || "",
            league: String(competition?.league || ""),
            season: String(competition?.season || ""),
            timezone,
            source: "owner-cup-global-fixture-cache-refresh",
            updatedAtMs: nowMs,
            computedAt: FieldValue.serverTimestamp(),
            kickoffMs: detail.kickoffMs ?? null,
            statusShort,
            statusLong: detail.statusLong || null,
            elapsed: detail.elapsed ?? null,
            extra: detail.extra ?? null,
            isLive: isInPlay(statusShort),
            isFinished: isFinished(statusShort),
            hasStarted: hasFixtureStarted(statusShort),
            homeTeamId: detail.homeTeamId ?? null,
            homeTeamName: detail.homeTeamName || "",
            homeTeamLogo: detail.homeTeamLogo || "",
            awayTeamId: detail.awayTeamId ?? null,
            awayTeamName: detail.awayTeamName || "",
            awayTeamLogo: detail.awayTeamLogo || "",
            goalsHome: toNum(detail.goalsHome),
            goalsAway: toNum(detail.goalsAway),
            leagueId: detail.leagueId ?? null,
            leagueName: detail.leagueName || "",
            leagueRound: detail.leagueRound || null,
            roundLabel: detail.leagueRound || null,
            rawStatsPlayerCount: Object.keys(rawStatsByPlayerId || {}).length,
            fantasyPlayerCount: Object.keys(fantasyByPlayerId || {}).length,
            payloadBytesEstimate,
            sourceRoomCount: 1,
          },
        });
        writtenSummaryCount += 1;
        refreshedCount += 1;
      }

      return {
        ok: true,
        roomId,
        mode: "cup-global-fixture-cache-refresh",
        seasonKey: seasonContext.seasonKey,
        fixtureIds,
        fixtureCount: fixtureIds.length,
        refreshedCount,
        statusByFixtureId,
        missingCount: missingFixtureIds.length,
        missingFixtureIds,
        writtenSummaryCount,
        writtenLiveFixtureCount,
        uniqueFixtureStatsChecked: fixtureStatsDebug.uniqueFixtureStatsChecked,
        fixturePlayerStatsCacheHits: fixtureStatsDebug.fixturePlayerStatsCacheHits,
        fixturePlayerStatsApiCalls: fixtureStatsDebug.fixturePlayerStatsApiCalls,
        fixturePlayerStatsLockSkips: fixtureStatsDebug.fixturePlayerStatsLockSkips,
        fixturePlayerStatsStaleReturns: fixtureStatsDebug.fixturePlayerStatsStaleReturns,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRehearseCupGlobalWriteFromHistory = onCall(
  { region: "us-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRehearseCupGlobalWriteFromHistory";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const shadowResult = await computeGlobalCupShadowResults({
        db,
        roomId,
        nowMs,
      });

      if (shadowResult.shadowSource !== "cup-history-latest") {
        throw new HttpsError(
          "failed-precondition",
          "Cup global rehearsal requires a completed cupHistory window."
        );
      }

      if (
        Number(shadowResult.fixtureCount || 0) <= 0 ||
        Number(shadowResult.missingFixtureCount || 0) !== 0 ||
        Number(shadowResult.maxAbsDiff || 0) !== 0 ||
        (Array.isArray(shadowResult.playerMismatches) && shadowResult.playerMismatches.length > 0) ||
        (Array.isArray(shadowResult.statMismatches) && shadowResult.statMismatches.length > 0)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Cannot rehearse Cup global write until Cup shadow result is clean."
        );
      }

      const rehearsalPayload = buildCupGlobalWriteRehearsalPayload(shadowResult, nowMs);
      const writtenPath = `rooms/${roomId}/globalShadowResults/cup-write-rehearsal`;

      await db
        .doc(writtenPath)
        .set(
          {
            ...rehearsalPayload,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: false }
        );

      return {
        ok: true,
        roomId,
        mode: "cup-global-write-rehearsal",
        shadowSource: rehearsalPayload.shadowSource,
        compareScope: rehearsalPayload.compareScope,
        historyId: rehearsalPayload.historyId,
        historyLabel: rehearsalPayload.historyLabel,
        historyFixtureCount: rehearsalPayload.historyFixtureCount,
        fixtureCount: rehearsalPayload.fixtureCount,
        missingFixtureCount: rehearsalPayload.missingFixtureCount,
        maxAbsDiff: rehearsalPayload.maxAbsDiff,
        playerMismatchCount: rehearsalPayload.playerMismatchCount,
        statMismatchCount: rehearsalPayload.statMismatchCount,
        projectedUserCount: rehearsalPayload.projectedStandingsRows.length,
        writtenPath,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerPrepareCupGlobalReplayFromHistory = onCall(
  { region: "us-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerPrepareCupGlobalReplayFromHistory";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);

      if (request.data?.confirm !== "PREPARE_CUP_REPLAY") {
        throw new HttpsError(
          "failed-precondition",
          "Cup replay preparation requires confirm='PREPARE_CUP_REPLAY'."
        );
      }

      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const cupCurrentRef = db.doc(`rooms/${roomId}/cup/current`);
      const backupPath = `rooms/${roomId}/globalShadowResults/cup-current-before-replay`;
      const backupRef = db.doc(backupPath);

      const [cupCurrentSnap, backupSnap] = await Promise.all([
        cupCurrentRef.get(),
        backupRef.get(),
      ]);

      if (backupSnap.exists) {
        const backupData = backupSnap.data() || {};
        if (backupData.originalCupCurrent && typeof backupData.originalCupCurrent === "object") {
          throw new HttpsError(
            "failed-precondition",
            "Cup replay backup already exists. Restore it before preparing another replay."
          );
        }
      }

      const originalCupCurrent = cupCurrentSnap.exists ? (cupCurrentSnap.data() || {}) : {};
      const historyWindow = await loadLatestCupHistoryWindow({ db, roomId });
      const fixtureIds = [...new Set((Array.isArray(historyWindow?.fixtureIds) ? historyWindow.fixtureIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean))];

      if (!fixtureIds.length) {
        throw new HttpsError("failed-precondition", "No cupHistory fixture IDs found for replay.");
      }

      const historyId = historyWindow?.historyId || historyWindow?.id || null;
      const historyLabel = historyWindow?.label || historyWindow?.currentWindowLabel || null;
      const writtenPath = `rooms/${roomId}/cup/current`;

      await backupRef.set(
        {
          roomId,
          mode: "cup-global-replay-backup",
          originalCupCurrent,
          backedUpAtMs: nowMs,
          backedUpAt: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );

      await cupCurrentRef.set(
        {
          replayTestMode: true,
          replaySource: "cup-history-latest",
          replayHistoryId: historyId,
          replayHistoryLabel: historyLabel,
          replayPreparedAtMs: nowMs,
          status: "replay",
          completed: false,
          completedAtMs: FieldValue.delete(),
          currentWindowLabel: historyLabel || "Replay Window",
          currentWindowFixtureIds: fixtureIds,
          currentWindowFixtures: Array.isArray(historyWindow?.fixtures)
            ? historyWindow.fixtures
            : [],
          currentWindowStartAtMs: Number(historyWindow?.startAtMs || 0) || null,
          currentWindowEndAtMs: Number(historyWindow?.endAtMs || 0) || null,
          replayBaselineTotalsByUid: {},
          updatedAtMs: nowMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return {
        ok: true,
        roomId,
        mode: "cup-global-replay-prepared",
        replayTestMode: true,
        replaySource: "cup-history-latest",
        historyId,
        historyLabel,
        replayHistoryLabel: historyLabel,
        fixtureIds,
        fixtureCount: fixtureIds.length,
        backupPath,
        writtenPath,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRestoreCupCurrentFromReplayBackup = onCall(
  { region: "us-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRestoreCupCurrentFromReplayBackup";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);

      if (request.data?.confirm !== "RESTORE_CUP_REPLAY") {
        throw new HttpsError(
          "failed-precondition",
          "Cup replay restore requires confirm='RESTORE_CUP_REPLAY'."
        );
      }

      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const backupPath = `rooms/${roomId}/globalShadowResults/cup-current-before-replay`;
      const restoredPath = `rooms/${roomId}/cup/current`;
      const backupRef = db.doc(backupPath);
      const backupSnap = await backupRef.get();
      const backup = backupSnap.exists ? (backupSnap.data() || {}) : {};
      const originalCupCurrent = backup.originalCupCurrent;

      if (!originalCupCurrent || typeof originalCupCurrent !== "object") {
        throw new HttpsError(
          "failed-precondition",
          "Cup replay backup is missing original cup/current data."
        );
      }

      await db.doc(restoredPath).set(
        {
          ...originalCupCurrent,
          restoredFromReplayAtMs: nowMs,
          restoredFromReplayAt: FieldValue.serverTimestamp(),
        },
        { merge: false }
      );
      await backupRef.delete();

      return {
        ok: true,
        roomId,
        mode: "cup-global-replay-restored",
        restoredPath,
        backupPath,
        backupDeleted: true,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerApplyCupGlobalCurrentWindowOnce = onCall(
  { region: "us-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerApplyCupGlobalCurrentWindowOnce";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerCupRoom(room);
      logOwnerAction(functionName, { functionName, uid, roomId, nowMs });

      const result = await computeCupCurrentWindowFromGlobalCache({
        db,
        roomId,
        nowMs,
        writeMode: "global",
        dryRun: false,
      });

      return {
        ok: true,
        roomId,
        mode: "cup-global-current-window-apply",
        realWriteApplied: true,
        projectionOnly: true,
        replayTestMode: Boolean(result.replayTestMode),
        replaySource: result.replaySource || null,
        replayHistoryId: result.replayHistoryId || null,
        replayHistoryLabel: result.replayHistoryLabel || null,
        fixtureCount: Number(result.fixtureCount || 0),
        missingFixtureCount: Number(result.missingFixtureCount || 0),
        statusValue: result.statusValue || null,
        allFinished: Boolean(result.allFinished),
        anyInPlay: Boolean(result.anyInPlay),
        projectedUserCount: Array.isArray(result.projectedStandingsRows)
          ? result.projectedStandingsRows.length
          : 0,
        writtenPath: `rooms/${roomId}/cup/current`,
        auditPath: `rooms/${roomId}/globalShadowResults/cup-apply-current-window`,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRunRegularShadowTest = onCall(
  { region: "us-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRunRegularShadowTest";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerRegularRoom(room);
      const weekIndex = resolveOwnerWeekIndex(room, request.data?.weekIndex);
      logOwnerAction(functionName, { functionName, uid, roomId, weekIndex, nowMs });

      const result = await computeRegularWeekFromGlobalCache({
        db,
        roomId,
        weekIndex,
        nowMs,
        writeMode: "shadow",
        dryRun: true,
      });

      return {
        ...summarizeRegularGlobalResult(result, {
          compareScope: "current-regular-week",
        }),
        globalTotalsByUid: result.globalTotalsByUid || {},
        legacyTotalsByUid: result.legacyTotalsByUid || {},
        fixtureCoverage: result.fixtureCoverage || [],
        playerMismatches: result.playerMismatches || [],
        statMismatches: result.statMismatches || [],
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerApplyRegularGlobalAggregatorOnce = onCall(
  { region: "us-west2", timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerApplyRegularGlobalAggregatorOnce";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room } = await loadOwnerActionRoom(roomId);
      assertOwnerRegularRoom(room);
      const weekIndex = resolveOwnerWeekIndex(room, request.data?.weekIndex);

      const pipelineMode = getGlobalPipelineMode(room);
      if (pipelineMode !== "global" || !isGlobalRoomAggregatorEnabled(room)) {
        throw new HttpsError(
          "failed-precondition",
          "Regular global aggregator is disabled. Set globalPipeline.mode='global' and globalPipeline.roomAggregator=true first."
        );
      }

      logOwnerAction(functionName, { functionName, uid, roomId, weekIndex, nowMs });

      const result = await computeRegularWeekFromGlobalCache({
        db,
        roomId,
        weekIndex,
        nowMs,
        writeMode: "global",
        dryRun: false,
      });

      return summarizeRegularGlobalResult(result, {
        realWriteApplied: Boolean(result.realWriteApplied),
      });
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.ownerRunWorldCupGroupEngineNow = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRunWorldCupGroupEngineNow";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const { room } = await loadOwnerActionRoom(roomId);

      if (!isOwnerWorldCupGroupRoom(room)) {
        throw new HttpsError("failed-precondition", "Room is not a World Cup group room.");
      }

      const requestedNowMs = Number(request.data?.nowMs || nowMs);
      const debugNowMs = Number.isFinite(requestedNowMs) ? requestedNowMs : nowMs;
      const engineType = room.engineType || room.worldCup?.engineType || "";
      const worldCupPhase = room.worldCupPhase || room.worldCup?.phase || "";
      const dayIndex = room?.worldCup?.currentDayIndex ?? room?.currentDayIndex ?? null;

      logOwnerAction(functionName, {
        functionName,
        uid,
        roomId,
        dayIndex,
        nowMs: debugNowMs,
        engineType,
        worldCupPhase,
      });

      const result = await runWorldCupGroupEngine({
        db,
        roomId,
        room,
        apiKey: APIFOOTBALL_KEY.value(),
        nowMs: debugNowMs,
        getFixtureStatusMap,
        getFixturePlayersStatsMapCached,
        setCompetitionState,
        ensureDefaultLineupsForRoom,
      });

      const resultWeekStatus = String(
        result?.weekStatus || result?.status || ""
      ).toLowerCase();
      const resultNextPollAtMs = Number(result?.nextPollAtMs || 0);
      const manualQueueUpdated = ["scheduled", "live", "resolving"].includes(
        resultWeekStatus
      );
      const manualQueueDeleted =
        !manualQueueUpdated &&
        (["final", "complete", "completed"].includes(resultWeekStatus) ||
          result?.isDone === true);
      const manualQueueNextPollAtMs = manualQueueUpdated
        ? Number.isFinite(resultNextPollAtMs) &&
          resultNextPollAtMs > debugNowMs
          ? resultNextPollAtMs
          : debugNowMs + 60 * 1000
        : null;

      if (manualQueueUpdated) {
        await upsertTournamentPollTask({
          roomId,
          phase: "WorldCupGroup",
          nextPollAtMs: manualQueueNextPollAtMs,
          reason: "owner-run-world-cup-engine-now",
          nowMs: debugNowMs,
        });
      } else if (manualQueueDeleted) {
        await deleteTournamentPollTask(roomId);
      }

      return {
        ok: true,
        roomId,
        nowMs: debugNowMs,
        engineType,
        worldCupPhase,
        result,
        currentDayIndex: result?.dayIndex ?? result?.currentDayIndex ?? null,
        status: result?.status ?? null,
        weekStatus: result?.weekStatus ?? null,
        isDone: Boolean(result?.isDone),
        pollReason: result?.pollReason ?? result?.skippedReason ?? null,
        skippedReason: result?.skippedReason ?? null,
        nextPollAtMs: result?.nextPollAtMs ?? null,
        nextKickoffMs: result?.nextKickoffMs ?? null,
        fixtureCoverage: result?.fixtureCoverage || [],
        statusByFixtureId:
          result?.statusByFixtureId ||
          result?.fixtureStatusById ||
          {},
        manualQueueUpdated,
        manualQueueDeleted,
        manualQueueReason: "owner-run-world-cup-engine-now",
        manualQueueNextPollAtMs,
        teamScoresByUserId: result?.teamScoresByUserId || {},
        dailyLeaderboard: result?.dailyLeaderboard || [],
        standingsPreview: result?.standingsPreview || result?.leaderboard || [],
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

function ownerRepairStringList(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
}

function ownerSavedWorldCupDayFixtureIds(day = {}) {
  const ids = [
    ...(Array.isArray(day.fixtureIds) ? day.fixtureIds : []),
    ...(Array.isArray(day.fixtures)
      ? day.fixtures.map((fixture) =>
          fixture?.fixtureId ?? fixture?.id ?? fixture?.fixture?.id
        )
      : []),
  ];

  return ownerRepairStringList(ids);
}

function ownerWorldCupDayHasStarterSnapshots(day = {}) {
  const snapshots =
    day?.starterSnapshotsByFixtureId &&
    typeof day.starterSnapshotsByFixtureId === "object"
      ? day.starterSnapshotsByFixtureId
      : {};

  for (const snapshot of Object.values(snapshots)) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const startersByUserId =
      snapshot.startersByUserId &&
      typeof snapshot.startersByUserId === "object"
        ? snapshot.startersByUserId
        : {};

    if (Object.values(startersByUserId).some((starters) =>
      Array.isArray(starters) && starters.length > 0
    )) {
      return true;
    }
  }

  return false;
}

function ownerWorldCupDayHasScoringEvidence(day = {}) {
  const fixtureStatusById =
    day?.fixtureStatusById && typeof day.fixtureStatusById === "object"
      ? day.fixtureStatusById
      : {};
  const dayStatusDecision =
    day?.dayStatusDecision && typeof day.dayStatusDecision === "object"
      ? day.dayStatusDecision
      : {};

  return (
    Boolean(day.scoredAtMs || day.lastScoredAtMs || day.repairedAtMs) ||
    Boolean(day.allFixturesFinalSeenAtMs || day.finalStatusFirstSeenAtMs) ||
    Boolean(dayStatusDecision.reason || dayStatusDecision.repairMode) ||
    Object.values(fixtureStatusById).some((status) => {
      const short = String(status || "").trim();
      return hasFixtureStarted(short) || isFinished(short);
    })
  );
}

function ownerWorldCupDayRepairEligibility({ day = {}, dayResult = null }) {
  const dayIndex = Number(day.dayIndex || day.id || 0);
  const fixtureIds = ownerSavedWorldCupDayFixtureIds(day);
  const dayResultExists = Boolean(dayResult);
  const hasStarterSnapshots = ownerWorldCupDayHasStarterSnapshots(day);
  const status = String(day.status || "").toLowerCase();
  const statusLooksScored = ["live", "resolving", "final"].includes(status);
  const hasScoringEvidence =
    statusLooksScored && ownerWorldCupDayHasScoringEvidence(day);
  const eligible =
    fixtureIds.length > 0 &&
    (dayResultExists || hasStarterSnapshots || hasScoringEvidence);

  return {
    dayIndex,
    fixtureIds,
    eligible,
    dayResultExists,
    hasStarterSnapshots,
    statusLooksScored,
    hasScoringEvidence,
    skippedReason: eligible
      ? ""
      : fixtureIds.length
        ? "no-prior-result-or-starter-snapshot"
        : "no-saved-fixture-ids",
  };
}

function ownerRepairRoomSeasonContext(room = {}) {
  const context = deriveRoomSeasonContext(room) || {};
  const competition = room?.competition || {};

  return {
    seasonKey: String(context.seasonKey || room?.seasonKey || "").trim(),
    competitionKey: String(
      context.competitionKey || room?.competitionKey || ""
    ).trim(),
    competitionType: String(
      context.competitionType || room?.competitionType || ""
    ).trim(),
    league: String(context.league || competition.league || "").trim(),
    season: String(context.season || competition.season || "").trim(),
    timezone: String(
      competition.timezone ||
        room?.worldCup?.timezone ||
        room?.competitionState?.timezone ||
        room?.timezone ||
        "America/Los_Angeles"
    ),
  };
}

function ownerRepairRequestedFilters(requestData = {}) {
  return {
    seasonKey: String(requestData.seasonKey || "").trim(),
    competitionKey: String(requestData.competitionKey || "").trim(),
    competitionType: String(requestData.competitionType || "").trim(),
    league: String(requestData.league || "").trim(),
    season: String(requestData.season || "").trim(),
  };
}

function ownerRepairRoomRejectReason(room = {}, requestData = {}) {
  if (!isOwnerWorldCupGroupRoom(room)) return "not-world-cup-group";

  const context = ownerRepairRoomSeasonContext(room);
  const expected = ownerRepairRequestedFilters(requestData);

  // For World Cup Group repair, competitionKey/competitionType/seasonKey are
  // helpful discovery hints only. Older rooms can be missing or use slightly
  // different values, so only league/season reject when both sides are present.
  for (const key of ["league", "season"]) {
    const expectedValue = String(expected[key] || "").trim().toLowerCase();
    const actualValue = String(context[key] || "").trim().toLowerCase();
    if (expectedValue && actualValue && expectedValue !== actualValue) {
      return `${key}-mismatch`;
    }
  }

  return "";
}

function ownerRepairRoomMatchesCompetition(room = {}, requestData = {}) {
  return !ownerRepairRoomRejectReason(room, requestData);
}

function ownerCreateRepairMatchDebug(requestData = {}, requestedRoomIds = []) {
  return {
    requestedFilters: ownerRepairRequestedFilters(requestData),
    requestedRoomCount: requestedRoomIds.length,
    roomsScanned: 0,
    worldCupGroupCandidates: 0,
    matchedRoomCount: 0,
    rejectCountsByReason: {},
    scanSources: {},
    missingRequestedRoomIds: [],
    sampleRejectedRooms: [],
  };
}

function ownerRecordRepairRoomMatchDebug({
  debug,
  roomId,
  room = {},
  source = "unknown",
  rejectReason = "",
}) {
  if (!debug) return;
  debug.roomsScanned += 1;
  debug.scanSources[source] = Number(debug.scanSources[source] || 0) + 1;

  if (isOwnerWorldCupGroupRoom(room)) {
    debug.worldCupGroupCandidates += 1;
  }

  if (!rejectReason) {
    debug.matchedRoomCount += 1;
    return;
  }

  debug.rejectCountsByReason[rejectReason] =
    Number(debug.rejectCountsByReason[rejectReason] || 0) + 1;

  if (debug.sampleRejectedRooms.length < 12) {
    const context = ownerRepairRoomSeasonContext(room);
    debug.sampleRejectedRooms.push({
      roomId,
      reason: rejectReason,
      engineType: room?.engineType || "",
      worldCupPhase: room?.worldCupPhase || room?.worldCup?.phase || "",
      phaseLabel:
        room?.competitionState?.phaseLabel ||
        getCompetitionState(room)?.phaseLabel ||
        "",
      league: context.league || "",
      season: context.season || "",
      seasonKey: context.seasonKey || "",
      competitionKey: context.competitionKey || "",
      competitionType: context.competitionType || "",
    });
  }
}

async function ownerLoadWorldCupRepairRooms(requestData = {}) {
  const requestedRoomIds = ownerRepairStringList(requestData.roomIds);
  const rooms = [];
  const debug = ownerCreateRepairMatchDebug(requestData, requestedRoomIds);

  function considerRoom(roomId, room, source) {
    const rejectReason = ownerRepairRoomRejectReason(room, requestData);
    ownerRecordRepairRoomMatchDebug({
      debug,
      roomId,
      room,
      source,
      rejectReason,
    });

    if (rejectReason) return;
    rooms.push({ roomId, room });
  }

  if (requestedRoomIds.length) {
    const chunkSize = 300;
    for (let index = 0; index < requestedRoomIds.length; index += chunkSize) {
      const chunk = requestedRoomIds.slice(index, index + chunkSize);
      const snaps = await db.getAll(
        ...chunk.map((roomId) => db.doc(`rooms/${roomId}`))
      );

      for (let i = 0; i < snaps.length; i += 1) {
        const snap = snaps[i];
        if (!snap.exists) {
          debug.missingRequestedRoomIds.push(chunk[i]);
          continue;
        }
        const room = snap.data() || {};
        considerRoom(snap.id, room, "requested-roomIds");
      }
    }

    return { rooms, debug };
  }

  const seasonKey = String(requestData.seasonKey || "").trim();
  const scannedRoomIds = new Set();

  async function scanRoomsSnapshot(snapshotPromise, source) {
    const roomsSnap = await snapshotPromise;
    for (const roomDoc of roomsSnap.docs || []) {
      if (scannedRoomIds.has(roomDoc.id)) continue;
      scannedRoomIds.add(roomDoc.id);
      const room = roomDoc.data() || {};
      considerRoom(roomDoc.id, room, source);
    }
  }

  if (seasonKey) {
    await scanRoomsSnapshot(
      db.collection("rooms").where("seasonKey", "==", seasonKey).limit(300).get(),
      "seasonKey"
    );
  }

  if (!rooms.length) {
    await scanRoomsSnapshot(
      db.collection("rooms").limit(1000).get(),
      seasonKey ? "fallback-all-rooms" : "all-rooms"
    );
  }

  return { rooms, debug };
}

async function ownerLoadWorldCupRepairDaysForRooms(roomEntries = []) {
  const roomsWithDays = [];
  const uniqueFixtureIds = new Set();

  for (const entry of roomEntries) {
    const [daysSnap, dayResultsSnap] = await Promise.all([
      db
        .collection(`rooms/${entry.roomId}/days`)
        .get()
        .catch(() => ({ docs: [] })),
      db
        .collection(`rooms/${entry.roomId}/dayResults`)
        .get()
        .catch(() => ({ docs: [] })),
    ]);
    const dayResultsByIndex = new Map();
    for (const resultDoc of dayResultsSnap.docs || []) {
      const result = resultDoc.data() || {};
      const dayIndex = Number(result.dayIndex || resultDoc.id);
      if (!Number.isFinite(dayIndex) || dayIndex <= 0) continue;
      dayResultsByIndex.set(String(dayIndex), {
        id: resultDoc.id,
        ...result,
      });
    }

    const days = (daysSnap.docs || [])
      .map((dayDoc) => ({ id: dayDoc.id, ...(dayDoc.data() || {}) }))
      .sort((a, b) => Number(a.dayIndex || a.id || 0) - Number(b.dayIndex || b.id || 0));
    const eligibleDays = [];
    const skippedDayIndexes = [];

    for (const day of days) {
      const dayIndex = Number(day.dayIndex || day.id || 0);
      const eligibility = ownerWorldCupDayRepairEligibility({
        day,
        dayResult: dayResultsByIndex.get(String(dayIndex)) || null,
      });

      if (!eligibility.eligible) {
        if (eligibility.fixtureIds.length) {
          skippedDayIndexes.push(dayIndex || day.id);
        }
        continue;
      }

      eligibleDays.push({
        ...day,
        repairEligibility: eligibility,
      });

      for (const fixtureId of eligibility.fixtureIds) {
        uniqueFixtureIds.add(fixtureId);
      }
    }

    roomsWithDays.push({
      ...entry,
      days: eligibleDays,
      daysFound: days.length,
      daysEligible: eligibleDays.length,
      daysSkippedNoPriorResult: skippedDayIndexes.length,
      skippedDayIndexes,
      savedFixtureCount: eligibleDays.reduce(
        (sum, day) => sum + ownerSavedWorldCupDayFixtureIds(day).length,
        0
      ),
    });
  }

  return {
    roomsWithDays,
    fixtureIds: [...uniqueFixtureIds],
  };
}

async function ownerRefreshWorldCupRepairFixtureCache({
  fixtureIds,
  roomEntries,
  requestData,
  apiKey,
  nowMs,
}) {
  const ids = ownerRepairStringList(fixtureIds);
  const firstContext = ownerRepairRoomSeasonContext(roomEntries?.[0]?.room || {});
  const timezone = String(
    requestData.timezone ||
      firstContext.timezone ||
      "America/Los_Angeles"
  );
  const seasonKey = String(
    requestData.seasonKey ||
      firstContext.seasonKey ||
      ""
  ).trim();
  const statusByFixtureId = ids.length
    ? await getFixtureStatusMap({
        fixtureIds: ids,
        timezone,
        apiKey,
        forceRefresh: true,
      })
    : {};
  const globalPlayerStatsByFixtureId = {};
  let refreshedStatsCount = 0;

  for (const fixtureId of ids) {
    const short = statusByFixtureId[fixtureId] || "";
    if (!hasFixtureStarted(short) && !isFinished(short)) {
      globalPlayerStatsByFixtureId[fixtureId] = {};
      continue;
    }

    const rawStatsByPlayerId = await getFixturePlayersStatsMapCached({
      fixtureId,
      apiKey,
      ttlMs: isInPlay(short) ? 60 * 1000 : 60 * 60 * 1000,
      timeZone: timezone,
      forceRefresh: true,
      source: "ownerRefreshWorldCupRepairFixtureCache",
    });
    globalPlayerStatsByFixtureId[fixtureId] = rawStatsByPlayerId || {};
    refreshedStatsCount += 1;
  }

  let globalLiveRefresh = null;
  if (seasonKey && ids.length) {
    globalLiveRefresh = await pollGlobalSeasonLiveFixturesOnce({
      seasonTarget: {
        seasonKey,
        competitionKey:
          requestData.competitionKey || firstContext.competitionKey || "",
        competitionType:
          requestData.competitionType || firstContext.competitionType || "",
        league: requestData.league || firstContext.league || "",
        season: requestData.season || firstContext.season || "",
        timezone,
        fixtureIds: ids,
        roomIds: roomEntries.map((entry) => entry.roomId),
      },
      apiKey,
      nowMs,
    });
  }

  return {
    fixtureCount: ids.length,
    statusByFixtureId,
    globalPlayerStatsByFixtureId,
    refreshedStatusCount: Object.keys(statusByFixtureId || {}).length,
    refreshedStatsCount,
    seasonKey,
    timezone,
    globalLiveRefresh,
  };
}

exports.ownerRepairCompetitionWorldCupGroupPoints = onCall(
  { region: "us-west2", secrets: [APIFOOTBALL_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const functionName = "ownerRepairCompetitionWorldCupGroupPoints";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const dryRun = request.data?.dryRun !== false;
      const forceRefresh = request.data?.forceRefresh === true;
      const requestData = {
        competitionKey: request.data?.competitionKey,
        competitionType: request.data?.competitionType,
        league: request.data?.league,
        season: request.data?.season,
        seasonKey: request.data?.seasonKey,
        timezone: request.data?.timezone,
        roomIds: request.data?.roomIds,
      };
      const {
        rooms: roomEntries,
        debug: roomMatchDebug,
      } = await ownerLoadWorldCupRepairRooms(requestData);

      if (!roomEntries.length) {
        throw new HttpsError(
          "failed-precondition",
          "No World Cup group rooms matched this repair request.",
          {
            repairRoomMatchDebug: roomMatchDebug,
          }
        );
      }

      const { roomsWithDays, fixtureIds } =
        await ownerLoadWorldCupRepairDaysForRooms(roomEntries);
      const daysFound = roomsWithDays.reduce(
        (sum, entry) => sum + Number(entry.daysFound || 0),
        0
      );
      const daysEligible = roomsWithDays.reduce(
        (sum, entry) => sum + Number(entry.daysEligible || 0),
        0
      );
      const daysSkippedNoPriorResult = roomsWithDays.reduce(
        (sum, entry) => sum + Number(entry.daysSkippedNoPriorResult || 0),
        0
      );
      const skippedDayIndexes = roomsWithDays.flatMap((entry) =>
        (entry.skippedDayIndexes || []).map((dayIndex) =>
          `${entry.roomId}:${dayIndex}`
        )
      );

      if (!fixtureIds.length) {
        return {
          ok: true,
          mode: "world-cup-group-points-repair",
          dryRun,
          forceRefresh,
          competitionKey: String(requestData.competitionKey || ""),
          competitionType: String(requestData.competitionType || ""),
          league: String(requestData.league || ""),
          season: String(requestData.season || ""),
          seasonKey: String(requestData.seasonKey || ""),
          checkedRoomCount: roomEntries.length,
          repairRoomMatchDebug: roomMatchDebug,
          eligibleRoomCount: roomsWithDays.length,
          repairedRoomCount: 0,
          changedRoomCount: 0,
          changedDayCount: 0,
          changedUserCount: 0,
          totalPointDelta: 0,
          totalAbsPointDelta: 0,
          fixtureCount: 0,
          refreshedFixtureCount: 0,
          refreshedStatusCount: 0,
          refreshedStatsCount: 0,
          daysFound,
          daysEligible,
          daysSkippedNoPriorResult,
          skippedDayIndexes,
          skippedReason: "no-repair-eligible-world-cup-days",
          errors: [],
          roomSummaries: roomsWithDays.map((entry) => ({
            roomId: entry.roomId,
            name: entry.room?.name || entry.room?.roomName || "",
            code: entry.room?.code || entry.room?.roomCode || "",
            daysFound: entry.daysFound,
            daysEligible: entry.daysEligible,
            daysSkippedNoPriorResult: entry.daysSkippedNoPriorResult,
            skippedDayIndexes: entry.skippedDayIndexes || [],
            checkedDayCount: 0,
            changedDayCount: 0,
            changedUserCount: 0,
            totalPointDelta: 0,
            totalAbsPointDelta: 0,
            days: [],
          })),
        };
      }

      logOwnerAction(functionName, {
        uid,
        dryRun,
        forceRefresh,
        roomCount: roomEntries.length,
        fixtureCount: fixtureIds.length,
        daysFound,
        daysEligible,
        daysSkippedNoPriorResult,
        seasonKey: requestData.seasonKey || "",
        repairRoomMatchDebug: roomMatchDebug,
      });

      const refreshResult = forceRefresh
        ? await ownerRefreshWorldCupRepairFixtureCache({
            fixtureIds,
            roomEntries,
            requestData,
            apiKey: APIFOOTBALL_KEY.value(),
            nowMs,
          })
        : {
            fixtureCount: fixtureIds.length,
            statusByFixtureId: {},
            globalPlayerStatsByFixtureId: {},
            refreshedStatusCount: 0,
            refreshedStatsCount: 0,
            seasonKey: String(requestData.seasonKey || "").trim(),
            timezone: String(requestData.timezone || "America/Los_Angeles"),
            globalLiveRefresh: null,
          };
      const roomSummaries = [];
      const daySummaries = [];
      const errors = [];

      for (const entry of roomsWithDays) {
        const roomDaySummaries = [];

        try {
          for (const day of entry.days) {
            const dayFixtureIds = ownerSavedWorldCupDayFixtureIds(day);
            if (!dayFixtureIds.length) continue;

            const result = await recomputeWorldCupGroupDayFromSavedFixtures({
              db,
              roomId: entry.roomId,
              room: entry.room,
              dayIndex: Number(day.dayIndex || day.id || 0),
              dayDoc: day,
              apiKey: APIFOOTBALL_KEY.value(),
              nowMs,
              dryRun,
              statusOverrideByFixtureId: refreshResult.statusByFixtureId,
              globalPlayerStatsOverrideByFixtureId:
                refreshResult.globalPlayerStatsByFixtureId,
              getFixtureStatusMap,
              getFixturePlayersStatsMapCached,
              setCompetitionState,
            });

            roomDaySummaries.push(result);
            daySummaries.push(result);
          }

          const repairSummary = summarizeWorldCupRepairDiffs(roomDaySummaries);
          roomSummaries.push({
            roomId: entry.roomId,
            name: entry.room?.name || entry.room?.roomName || "",
            code: entry.room?.code || entry.room?.roomCode || "",
            dayCount: entry.daysFound,
            daysFound: entry.daysFound,
            daysEligible: entry.daysEligible,
            daysSkippedNoPriorResult: entry.daysSkippedNoPriorResult,
            skippedDayIndexes: entry.skippedDayIndexes || [],
            checkedDayCount: roomDaySummaries.length,
            changedDayCount: repairSummary.changedDayCount,
            changedUserCount: repairSummary.changedUserCount,
            totalPointDelta: repairSummary.totalPointDelta,
            totalAbsPointDelta: repairSummary.totalAbsPointDelta,
            finalResultsUpdated: roomDaySummaries.some(
              (day) => day.finalResultsUpdated
            ),
            days: roomDaySummaries.map((day) => ({
              dayIndex: day.dayIndex,
              label: day.label,
              status: day.status,
              fixtureCount: day.fixtureCount,
              userCount: day.userCount,
              changed: day.changed,
              scoreDiffs: day.scoreDiffs || [],
              readCounts: day.readCounts || {},
            })),
          });
        } catch (err) {
          errors.push({
            roomId: entry.roomId,
            message: err?.message || String(err),
            code: err?.code || "",
          });
          console.error(`[${functionName}] room repair failed`, {
            roomId: entry.roomId,
            code: err?.code,
            message: err?.message,
            stack: err?.stack,
          });
        }
      }

      const summary = summarizeWorldCupRepairDiffs(daySummaries);
      const auditPayload = {
        mode: "world-cup-group-points-repair",
        uid,
        dryRun,
        forceRefresh,
        competitionKey: String(requestData.competitionKey || ""),
        competitionType: String(requestData.competitionType || ""),
        league: String(requestData.league || ""),
        season: String(requestData.season || ""),
        seasonKey: String(
          requestData.seasonKey || refreshResult.seasonKey || ""
        ),
        requestedRoomIds: ownerRepairStringList(requestData.roomIds),
        checkedRoomCount: roomEntries.length,
        repairRoomMatchDebug: roomMatchDebug,
        eligibleRoomCount: roomsWithDays.length,
        fixtureCount: fixtureIds.length,
        daysFound,
        daysEligible,
        daysSkippedNoPriorResult,
        skippedDayIndexes,
        refreshedStatusCount: refreshResult.refreshedStatusCount,
        refreshedStatsCount: refreshResult.refreshedStatsCount,
        changedRoomCount: summary.changedRoomCount,
        changedDayCount: summary.changedDayCount,
        changedUserCount: summary.changedUserCount,
        totalPointDelta: summary.totalPointDelta,
        totalAbsPointDelta: summary.totalAbsPointDelta,
        errors,
        roomSummaries,
        createdAtMs: nowMs,
        createdAt: FieldValue.serverTimestamp(),
      };
      let auditPath = "";

      if (!dryRun) {
        const auditRef = await db.collection("adminRepairs").add(auditPayload);
        auditPath = `adminRepairs/${auditRef.id}`;
      }

      return {
        ok: true,
        mode: "world-cup-group-points-repair",
        dryRun,
        forceRefresh,
        competitionKey: auditPayload.competitionKey,
        competitionType: auditPayload.competitionType,
        league: auditPayload.league,
        season: auditPayload.season,
        seasonKey: auditPayload.seasonKey,
        checkedRoomCount: roomEntries.length,
        repairRoomMatchDebug: roomMatchDebug,
        eligibleRoomCount: roomsWithDays.length,
        repairedRoomCount: dryRun ? 0 : summary.changedRoomCount,
        changedRoomCount: summary.changedRoomCount,
        changedDayCount: summary.changedDayCount,
        changedUserCount: summary.changedUserCount,
        totalPointDelta: summary.totalPointDelta,
        totalAbsPointDelta: summary.totalAbsPointDelta,
        fixtureCount: fixtureIds.length,
        daysFound,
        daysEligible,
        daysSkippedNoPriorResult,
        skippedDayIndexes,
        refreshedFixtureCount: forceRefresh ? fixtureIds.length : 0,
        refreshedStatusCount: refreshResult.refreshedStatusCount,
        refreshedStatsCount: refreshResult.refreshedStatsCount,
        writtenSummaryCount:
          refreshResult.globalLiveRefresh?.fixtureCount ?? null,
        writtenLiveFixtureCount:
          refreshResult.globalLiveRefresh?.payloadCount ?? null,
        auditPath,
        errors,
        roomSummaries,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.refreshWorldCupGlobalPlayerPool = onCall(
  {
    region: "us-west2",
    secrets: [APIFOOTBALL_KEY],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (request) => {
    const functionName = "refreshWorldCupGlobalPlayerPool";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const league = Number(request.data?.league);
      const season = Number(request.data?.season);
      const timezone = String(
        request.data?.timezone || "America/Los_Angeles"
      );
      const worldCupPhase = String(
        request.data?.worldCupPhase || WORLD_CUP_GROUP_PHASE
      )
        .trim()
        .toLowerCase();
      const requestedSeasonKey = String(
        request.data?.seasonKey || ""
      ).trim();
      const seasonKey =
        requestedSeasonKey || buildWorldCupSeasonKey(season);
      const forceRefresh = request.data?.forceRefresh !== false;
      const dryRun = request.data?.dryRun !== false;

      if (!Number.isFinite(league) || !Number.isFinite(season)) {
        throw new HttpsError(
          "invalid-argument",
          "league and season are required."
        );
      }
      if (!seasonKey) {
        throw new HttpsError(
          "invalid-argument",
          "seasonKey is required."
        );
      }
      if (
        worldCupPhase !== WORLD_CUP_GROUP_PHASE &&
        worldCupPhase !== WORLD_CUP_KNOCKOUT_PHASE
      ) {
        throw new HttpsError(
          "invalid-argument",
          "worldCupPhase must be 'group' or 'knockout'."
        );
      }

      logOwnerAction(functionName, {
        functionName,
        uid,
        seasonKey,
        league,
        season,
        worldCupPhase,
        forceRefresh,
        dryRun,
        nowMs,
      });

      const result = await ensureFreshWorldCupGlobalPlayerPool({
        db,
        apiFootballGet,
        apiKey: APIFOOTBALL_KEY.value(),
        seasonKey,
        season,
        worldCupPhase,
        maxPlayers: 5000,
        maxPagesPerTeam: 10,
        forceRefresh,
        dryRun,
        nowMs,
        loadDailyWindows: () =>
          loadWorldCupGroupDailyWindows({
            apiFootballGet,
            apiKey: APIFOOTBALL_KEY.value(),
            league,
            season,
            timezone,
          }),
      });

      return {
        ok: true,
        dryRun,
        mode: "world-cup-global-player-pool-refresh",
        seasonKey,
        beforeCount: result.beforeCount,
        latestFetchedCount: result.latestFetchedCount,
        missingCount: result.missingPlayers.length,
        addedCount: result.addedCount,
        afterCount: result.afterCount,
        sampleMissingPlayers: result.missingPlayers
          .slice(0, 25)
          .map((player) => ({
            id: worldCupRepairPlayerIds(player)[0] || "",
            name:
              player?.name ||
              player?.fullName ||
              player?.displayName ||
              "Unknown",
            position: player?.position || "",
            teamName: player?.teamName || "",
            nationality: player?.nationality || "",
          })),
        teamCount: result.teamCount,
        teamFetchSummary: result.teamFetchSummary,
        refreshed: result.refreshed,
        wasStale: result.wasStale,
        lastApiRefreshAtMs: result.lastApiRefreshAtMs,
        refreshReason: result.refreshReason,
        source: result.source,
        staleMs: WORLD_CUP_GLOBAL_PLAYER_POOL_STALE_MS,
        warnings: result.warnings,
        errors: result.errors,
      };
    } catch (err) {
      if (
        !(err instanceof HttpsError) &&
        ["aborted", "failed-precondition"].includes(err?.code)
      ) {
        err = new HttpsError(
          err.code,
          err?.message || "World Cup refresh failed."
        );
      }
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.repairWorldCupRoomMissingPlayers = onCall(
  {
    region: "us-west2",
    secrets: [APIFOOTBALL_KEY],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (request) => {
    const functionName = "repairWorldCupRoomMissingPlayers";
    const nowMs = Date.now();

    try {
      const uid = requireOwnerActionUid(request);
      const roomId = getOwnerActionRoomId(request);
      const forceApiRefresh = request.data?.forceApiRefresh !== false;
      const dryRun = request.data?.dryRun !== false;
      const { roomRef, room } = await loadOwnerActionRoom(roomId);

      if (!isOwnerWorldCupRoom(room)) {
        throw new HttpsError(
          "failed-precondition",
          "Room is not a World Cup room."
        );
      }

      const competition = room?.competition || {};
      const league = Number(competition?.league);
      const season = Number(competition?.season);
      const timezone = String(
        competition?.timezone || "America/Los_Angeles"
      );
      const seasonContext = deriveRoomSeasonContext(room);
      const seasonKey = String(
        room?.seasonKey ||
          room?.worldCup?.seasonKey ||
          seasonContext?.seasonKey ||
          buildWorldCupSeasonKey(season)
      ).trim();

      if (!Number.isFinite(league) || !Number.isFinite(season)) {
        throw new HttpsError(
          "failed-precondition",
          "World Cup room competition league/season is incomplete."
        );
      }
      if (!seasonKey) {
        throw new HttpsError(
          "failed-precondition",
          "Could not resolve seasonKey for World Cup room."
        );
      }

      logOwnerAction(functionName, {
        functionName,
        uid,
        roomId,
        nowMs,
        forceApiRefresh,
        dryRun,
        league,
        season,
        seasonKey,
      });

      const warnings = [];
      const errors = [];
      const latestPlayersById = new Map();
      let teamCount = Number(
        room?.worldCupPlayerPoolTeamCount ||
          room?.worldCupExpectedTeamCount ||
          0
      );
      let source = "global-season-player-pool";
      let apiFetchResult = null;

      const globalPlayers = await loadSeasonPlayerPool({
        db,
        seasonKey,
      }).catch((error) => {
        errors.push(
          `Global World Cup player pool read failed: ${String(
            error?.message || error
          )}`
        );
        return [];
      });

      for (const player of globalPlayers) {
        const normalized = normalizeWorldCupRepairPlayer(player, nowMs);
        if (normalized) latestPlayersById.set(normalized.id, normalized);
      }

      if (forceApiRefresh) {
        try {
          const dailyWindows = await loadWorldCupGroupDailyWindows({
            apiFootballGet,
            apiKey: APIFOOTBALL_KEY.value(),
            league,
            season,
            timezone,
          });
          const collected = collectWorldCupTeamsFromDailyWindows(dailyWindows);
          teamCount = collected.teamIds.length;

          if (!teamCount) {
            warnings.push(
              "API refresh did not discover World Cup teams; using the global season pool only."
            );
          } else {
            apiFetchResult = await fetchWorldCupTeamPlayerPool({
              apiFootballGet,
              apiKey: APIFOOTBALL_KEY.value(),
              season,
              teamIds: collected.teamIds,
              teamMeta: collected.teamMeta,
              maxPlayers: 5000,
              maxPagesPerTeam: 10,
            });

            for (const player of apiFetchResult.players || []) {
              const normalized = normalizeWorldCupRepairPlayer(player, nowMs);
              if (normalized) latestPlayersById.set(normalized.id, normalized);
            }
            source = globalPlayers.length
              ? "api-football-world-cup-teams+global-season-player-pool"
              : "api-football-world-cup-teams";

            if (apiFetchResult.allTeamsProcessed === false) {
              warnings.push(
                `API refresh did not process every team. Missing teams: ${
                  (apiFetchResult.missingFetchTeamNames || []).join(", ") ||
                  (apiFetchResult.missingFetchTeamIds || []).join(", ") ||
                  "unknown"
                }.`
              );
            }
            if (apiFetchResult.hitCap === true) {
              warnings.push(
                "API refresh hit the 5,000-player emergency cap."
              );
            }
            if ((apiFetchResult.emptyTeamIds || []).length) {
              warnings.push(
                `${apiFetchResult.emptyTeamIds.length} World Cup teams returned no player rows.`
              );
            }
          }
        } catch (error) {
          errors.push(
            `API World Cup player refresh failed: ${String(
              error?.message || error
            )}`
          );
          if (globalPlayers.length) {
            warnings.push(
              "API refresh failed; comparison used the existing global season player pool."
            );
          }
        }
      }

      const latestPlayers = Array.from(latestPlayersById.values());
      if (!latestPlayers.length) {
        throw new HttpsError(
          "failed-precondition",
          errors[0] ||
            "No World Cup players were available from API or global season pool."
        );
      }

      const roomPlayersSnap = await roomRef.collection("players").get();
      const existingPlayerIds = new Set();

      for (const playerDoc of roomPlayersSnap.docs) {
        const data = playerDoc.data() || {};
        for (const id of worldCupRepairPlayerIds(data, playerDoc.id)) {
          existingPlayerIds.add(id);
        }
      }

      const missingPlayers = latestPlayers.filter((player) =>
        worldCupRepairPlayerIds(player).every(
          (id) => !existingPlayerIds.has(id)
        )
      );

      const addedCount = dryRun
        ? 0
        : await writeMissingWorldCupRoomPlayers({
            roomRef,
            players: missingPlayers,
          });
      const repairedRoomPlayerCount = roomPlayersSnap.size + addedCount;

      if (!dryRun) {
        await roomRef.set(
          {
            playerCount: repairedRoomPlayerCount,
            worldCupPlayerPoolCount: repairedRoomPlayerCount,
            lastWorldCupPlayerRepairAtMs: nowMs,
            lastWorldCupPlayerRepairAt: FieldValue.serverTimestamp(),
            lastWorldCupPlayerRepairAddedCount: addedCount,
            lastWorldCupPlayerRepairLatestFetchedCount:
              latestPlayers.length,
          },
          { merge: true }
        );
      }

      return {
        ok: true,
        dryRun,
        roomId,
        mode: "world-cup-room-missing-player-repair",
        source,
        forceApiRefresh,
        seasonKey,
        latestFetchedCount: latestPlayers.length,
        existingRoomPlayerCount: roomPlayersSnap.size,
        repairedRoomPlayerCount,
        missingCount: missingPlayers.length,
        addedCount,
        skippedExistingCount: latestPlayers.length - missingPlayers.length,
        sampleMissingPlayers: missingPlayers.slice(0, 25).map((player) => ({
          id: player.id,
          name: player.name,
          position: player.position,
          teamName: player.teamName,
          nationality: player.nationality,
        })),
        teamCount,
        apiPlayerCount: Number(apiFetchResult?.players?.length || 0),
        globalPlayerCount: globalPlayers.length,
        warnings,
        errors,
      };
    } catch (err) {
      handleOwnerActionError(functionName, err);
    }
  }
);

exports.repairCompetitionStateFields = onCall(
  { region: "us-west2" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
    requireAdminUid(uid);

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

function ownerStatusMs(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (typeof value?.toMillis === "function") {
    const n = Number(value.toMillis());
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (typeof value?.toDate === "function") {
    const n = Number(value.toDate().getTime());
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (value instanceof Date) {
    const n = Number(value.getTime());
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (Number.isFinite(Number(value?.seconds))) {
    const n = Number(value.seconds) * 1000;
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

const LIVE_USER_WINDOW_MS = 3 * 60 * 1000;

async function countFirebaseAuthUsers() {
  let total = 0;
  let pageToken;

  do {
    const result = await admin.auth().listUsers(1000, pageToken);
    total += Array.isArray(result.users) ? result.users.length : 0;
    pageToken = result.pageToken;
  } while (pageToken);

  return total;
}

function ownerCountBy(map, key) {
  const k = String(key || "unknown");
  map[k] = Number(map[k] || 0) + 1;
}

function ownerMemberUid(member) {
  return String(
    typeof member === "string"
      ? member
      : member?.uid ?? member?.userId ?? member?.id ?? ""
  ).trim();
}

function getOwnerRoomManagerCount(room = {}, memberUids = []) {
  const ids = new Set();
  const members = Array.isArray(room?.members) ? room.members : [];

  for (const member of members) {
    const uid = ownerMemberUid(member);
    if (uid) ids.add(uid);
  }

  for (const uid of Array.isArray(memberUids) ? memberUids : []) {
    const clean = String(uid || "").trim();
    if (clean) ids.add(clean);
  }

  if (ids.size > 0) return ids.size;

  const fallback = Number(room?.managerCount ?? room?.memberCount ?? 0);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function buildOwnerDraftStatus(room = {}) {
  const status = String(room?.status || "").toLowerCase();
  const draftStatusRaw = String(room?.draftStatus || "").toLowerCase();

  const started =
    room?.started === true ||
    room?.draftStarted === true ||
    room?.draftComplete === true ||
    status === "drafting" ||
    status === "draft_started" ||
    status === "draft_complete" ||
    status === "ready" ||
    status === "live" ||
    status === "active";

  const complete =
    room?.draftComplete === true ||
    room?.draftCompleted === true ||
    status === "draft_complete" ||
    status === "complete" ||
    status === "ready" ||
    status === "live" ||
    status === "active";

  const scheduled =
    Boolean(room?.draftScheduledAt || room?.scheduledDraftAt || room?.draftStartAtMs || room?.startAt) ||
    status === "draft_scheduled" ||
    draftStatusRaw === "scheduled";

  const active =
    status === "drafting" ||
    status === "draft_started" ||
    draftStatusRaw === "active" ||
    draftStatusRaw === "drafting";

  if (active && !complete) {
    return {
      draftStatus: "active",
      draftStatusLabel: "Draft: Live",
      draftStatusTone: "live",
    };
  }

  if (complete || started) {
    return {
      draftStatus: "complete",
      draftStatusLabel: "Draft: Complete",
      draftStatusTone: "ok",
    };
  }

  if (scheduled) {
    return {
      draftStatus: "scheduled",
      draftStatusLabel: "Draft: Scheduled",
      draftStatusTone: "scheduled",
    };
  }

  return {
    draftStatus: "not_started",
    draftStatusLabel: "Draft: Not started",
    draftStatusTone: "muted",
  };
}

function ownerRoomLooksWorldCupGroup(room = {}, competitionState = null) {
  const state = competitionState || getCompetitionState(room) || {};
  const phaseLabel = String(state?.phaseLabel || room?.phaseLabel || "");

  return (
    room?.engineType === "worldCupDaily" ||
    room?.worldCup?.engineType === "worldCupDaily" ||
    room?.worldCupPhase === "group" ||
    room?.worldCupPhase === "WorldCupGroup" ||
    room?.worldCup?.phase === "group" ||
    phaseLabel === "WorldCupGroup"
  );
}

function buildOwnerProgressStatus(room = {}, cupDoc = null) {
  const competitionState = getCompetitionState(room) || {};
  const phaseLabel = String(
    competitionState?.phaseLabel ||
      room?.phaseLabel ||
      ""
  );

  const isWorldCupGroup = ownerRoomLooksWorldCupGroup(room, competitionState);
  const isCup = phaseLabel === "Cup" && !isWorldCupGroup;
  const draft = buildOwnerDraftStatus(room);
  const draftNotDone =
    draft.draftStatus === "not_started" ||
    draft.draftStatus === "scheduled" ||
    draft.draftStatus === "active";

  if (draftNotDone) {
    return {
      progressLabel: "Progress: Waiting for draft",
      progressTone: "muted",
      progressDetail: "",
    };
  }

  if (isWorldCupGroup) {
    const dayIndex =
      Number(room?.worldCup?.currentDayIndex) ||
      Number(room?.currentDayIndex) ||
      null;

    const dayLabel =
      room?.worldCup?.currentDayLabel ||
      competitionState?.currentLabel ||
      (dayIndex ? `Day ${dayIndex}` : "");

    const dayCount = Number(room?.worldCup?.dayCount || 0) || null;

    return {
      progressLabel: dayLabel
        ? `Progress: ${dayLabel}${dayCount ? ` / ${dayCount}` : ""}`
        : "Progress: World Cup group",
      progressTone: "worldCup",
      progressDetail: phaseLabel || "WorldCupGroup",
    };
  }

  if (isCup) {
    const cupLabel =
      cupDoc?.currentWindowLabel ||
      cupDoc?.roundLabel ||
      cupDoc?.label ||
      competitionState?.currentLabel ||
      room?.cup?.currentWindowLabel ||
      "";

    const cupStatus =
      cupDoc?.status ||
      competitionState?.weekStatus ||
      "";

    const fixtureCount = Array.isArray(cupDoc?.currentWindowFixtureIds)
      ? cupDoc.currentWindowFixtureIds.length
      : Array.isArray(cupDoc?.fixtureIds)
        ? cupDoc.fixtureIds.length
        : null;

    return {
      progressLabel: cupLabel
        ? `Progress: ${cupLabel}`
        : "Progress: Cup",
      progressTone: "cup",
      progressDetail: [
        cupStatus ? `Status: ${cupStatus}` : "",
        fixtureCount != null ? `Fixtures: ${fixtureCount}` : "",
      ].filter(Boolean).join(" · "),
    };
  }

  const weekIndex =
    Number(room?.currentWeekIndex) ||
    Number(room?.weekIndex) ||
    null;

  const totalRounds =
    Number(room?.competitionMeta?.totalRounds) ||
    Number(room?.["competitionMeta.totalRounds"]) ||
    Number(room?.competition?.totalRounds) ||
    null;

  return {
    progressLabel: weekIndex
      ? `Progress: Week ${weekIndex}${totalRounds ? ` / ${totalRounds}` : ""}`
      : "Progress: Regular Season",
    progressTone: "regular",
    progressDetail: competitionState?.currentLabel || "",
  };
}

function ownerMinMs(current, next) {
  const n = ownerStatusMs(next);
  if (!n) return current || null;
  return current ? Math.min(current, n) : n;
}

function ownerMaxMs(current, next) {
  const n = ownerStatusMs(next);
  if (!n) return current || null;
  return current ? Math.max(current, n) : n;
}

function getOwnerCompetitionLabel({ competitionMeta = {}, competition = {}, competitionKey = "" } = {}) {
  const league = competition?.league || "unknown";
  const season = competition?.season || "unknown";
  return (
    competitionMeta?.name ||
    competition?.name ||
    competitionKey ||
    `League ${league} ${season}`
  );
}

function ownerNormalizeKey(value) {
  return (
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[''`]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function ownerHasValue(value) {
  const str = String(value ?? "").trim().toLowerCase();
  return Boolean(str && str !== "unknown" && str !== "null" && str !== "undefined");
}

function getOwnerCompetitionGroupKey(roomStatus) {
  if (ownerHasValue(roomStatus.seasonKey)) {
    return ownerNormalizeKey(roomStatus.seasonKey);
  }
  if (ownerHasValue(roomStatus.league) && ownerHasValue(roomStatus.season)) {
    return `league_${ownerNormalizeKey(roomStatus.league)}_season_${ownerNormalizeKey(roomStatus.season)}`;
  }
  if (ownerHasValue(roomStatus.competitionKey)) {
    return ownerNormalizeKey(roomStatus.competitionKey);
  }
  return ownerNormalizeKey(roomStatus.competitionLabel);
}

function ownerIsWorldCupRoom(roomStatus = {}) {
  return (
    String(roomStatus.competitionLabel || "").toLowerCase().includes("world cup") ||
    String(roomStatus.seasonKey || "").toLowerCase().includes("worldcup") ||
    String(roomStatus.seasonKey || "").toLowerCase().includes("world-cup") ||
    String(roomStatus.engineType || "") === "worldCupDaily" ||
    String(roomStatus.phaseLabel || "") === "WorldCupGroup"
  );
}

function ownerHasRealCompetition(roomStatus = {}) {
  return (
    ownerHasValue(roomStatus.phaseLabel) ||
    ownerHasValue(roomStatus.competitionKey) ||
    ownerHasValue(roomStatus.seasonKey) ||
    ownerHasValue(roomStatus.competitionType) ||
    (ownerHasValue(roomStatus.league) && ownerHasValue(roomStatus.season))
  );
}

function ownerIsComplete(roomStatus = {}) {
  const weekStatus = String(roomStatus.weekStatus || "").toLowerCase();
  return (
    Boolean(roomStatus.isDone) ||
    weekStatus === "complete" ||
    weekStatus === "final" ||
    String(roomStatus.seasonPhase || "").toUpperCase() === "COMPLETE"
  );
}

function ownerIsActionableQueueMissing(roomStatus = {}) {
  const weekStatus = String(roomStatus.weekStatus || "").toLowerCase();
  const status = String(roomStatus.status || "").toLowerCase();
  const isRunnableStatus = ["scheduled", "live", "resolving"].includes(weekStatus);
  const isActiveRoom =
    Boolean(roomStatus.competitionLocked) ||
    status === "ready_to_draft" ||
    Boolean(roomStatus.started);

  return (
    !roomStatus.queue &&
    !ownerIsComplete(roomStatus) &&
    isActiveRoom &&
    isRunnableStatus &&
    (Boolean(roomStatus.nextPollAtMs) || ownerHasValue(roomStatus.phaseLabel)) &&
    ownerHasRealCompetition(roomStatus)
  );
}

function ownerIsIgnoredMissingQueue(roomStatus = {}) {
  if (roomStatus.queue || ownerIsComplete(roomStatus) || ownerIsActionableQueueMissing(roomStatus)) {
    return false;
  }

  return (
    !ownerHasRealCompetition(roomStatus) ||
    !ownerHasValue(roomStatus.phaseLabel) ||
    !["scheduled", "live", "resolving"].includes(String(roomStatus.weekStatus || "").toLowerCase()) ||
    (!roomStatus.competitionLocked && !roomStatus.started && String(roomStatus.status || "").toLowerCase() !== "ready_to_draft")
  );
}

function getOwnerQueueState(roomStatus = {}, nowMs) {
  const nextPollAtMs = ownerStatusMs(roomStatus.queue?.nextPollAtMs || roomStatus.nextPollAtMs);
  if (roomStatus.queue?.dueNow || (nextPollAtMs && nextPollAtMs <= nowMs)) return "due";
  if (nextPollAtMs && nextPollAtMs > nowMs) return "future";
  if (roomStatus.actionableMissingQueue) return "missing";
  if (roomStatus.ignoredMissingQueue) return "ignored missing";
  return "none";
}

function buildOwnerDisplayStatus(roomStatus = {}, nowMs) {
  const raw = String(roomStatus.weekStatus || "").toLowerCase();
  const isDone =
    Boolean(roomStatus.isDone) ||
    raw === "complete" ||
    raw === "final" ||
    String(roomStatus.seasonPhase || "").toUpperCase() === "COMPLETE";
  const nextPollAtMs = ownerStatusMs(roomStatus.queue?.nextPollAtMs || roomStatus.nextPollAtMs);
  const updatedAtMs = ownerStatusMs(roomStatus.updatedAtMs || roomStatus.lastUpdateAtMs);
  const isDueNow = Boolean(nextPollAtMs && nextPollAtMs <= nowMs);
  const staleLive =
    (raw === "live" || raw === "resolving") &&
    updatedAtMs &&
    nowMs - updatedAtMs > 5 * 60 * 1000;

  if (isDone) {
    return { key: "complete", label: "COMPLETE", className: "complete", priority: 20 };
  }
  if (staleLive) {
    return { key: "stale", label: "STALE LIVE", className: "problem", priority: 80 };
  }
  if (raw === "live") {
    return { key: "live", label: "LIVE UPDATING", className: "live", priority: 70 };
  }
  if (raw === "resolving") {
    return { key: "resolving", label: "RESOLVING", className: "resolving", priority: 60 };
  }
  if (isDueNow && ["scheduled", "live", "resolving"].includes(raw)) {
    return { key: "due", label: "DUE NOW", className: "due", priority: 55 };
  }
  // Match tournament pages: scheduled/sleeping rooms display as IDLE.
  if (raw === "scheduled" || raw === "idle") {
    return { key: "idle", label: "IDLE", className: "idle", priority: 40 };
  }
  if (roomStatus.isIgnoredRoom) {
    return { key: "ignored", label: "IGNORED", className: "ignored", priority: 0 };
  }
  if (roomStatus.actionableMissingQueue) {
    return { key: "missing", label: "MISSING POLL", className: "problem", priority: 75 };
  }
  return { key: "unknown", label: "UNKNOWN", className: "idle", priority: 5 };
}

function buildOwnerRoomStatusPill(roomStatus = {}, nowMs) {
  return buildOwnerDisplayStatus(roomStatus, nowMs);
}

function buildOwnerRoomHealth(roomStatus = {}, nowMs) {
  if (roomStatus.isIgnoredRoom) {
    return { key: "ignored", label: "Ignored", priority: 0 };
  }

  const weekStatus = String(roomStatus.weekStatus || "").toLowerCase();
  const nextPollAtMs = ownerStatusMs(roomStatus.queue?.nextPollAtMs || roomStatus.nextPollAtMs);
  const updatedAtMs = ownerStatusMs(roomStatus.updatedAtMs);
  const staleMs = updatedAtMs ? nowMs - updatedAtMs : Infinity;
  const dueMs = nextPollAtMs && nextPollAtMs <= nowMs ? nowMs - nextPollAtMs : 0;
  const isLiveLike = weekStatus === "live" || weekStatus === "resolving";
  const worldCupPoolProblem =
    ownerIsWorldCupRoom(roomStatus) &&
    (Boolean(roomStatus.worldCupPlayerPoolIncomplete) ||
      Boolean(roomStatus.worldCupHitGlobalCap) ||
      roomStatus.worldCupAllTeamsProcessed === false);

  if (worldCupPoolProblem || (isLiveLike && staleMs > 15 * 60 * 1000) || dueMs > 15 * 60 * 1000) {
    return { key: "problem", label: "Problem", priority: 30 };
  }
  if (
    roomStatus.actionableMissingQueue ||
    dueMs > 0 ||
    (isLiveLike && staleMs > 5 * 60 * 1000) ||
    !["idle", "scheduled", "live", "resolving", "complete", "final"].includes(weekStatus)
  ) {
    return { key: "warning", label: "Warning", priority: 20 };
  }
  return { key: "ok", label: "OK", priority: 10 };
}

function buildOwnerRoomStatus({ roomDoc, queueTask, nowMs, memberUids = [], cupDoc = null }) {
  const room = roomDoc.data() || {};
  const competition = room.competition || {};
  const competitionMeta = room.competitionMeta || {};
  const competitionState = getCompetitionState(room) || {};
  const league = competition?.league ?? competitionMeta?.league ?? "";
  const season = competition?.season ?? competitionMeta?.season ?? "";
  const seasonKey = room.seasonKey || room.worldCup?.seasonKey || "";
  const competitionKey = room.competitionKey || "";
  const competitionType = room.competitionType || competitionMeta?.type || "";
  const competitionLabel = getOwnerCompetitionLabel({ competitionMeta, competition, competitionKey });
  const phaseLabel = competitionState?.phaseLabel || "";
  const weekStatus = competitionState?.weekStatus || "";
  const isDone = Boolean(competitionState?.isDone);
  const nextPollAtMs = ownerStatusMs(competitionState?.nextPollAtMs);
  const nextKickoffMs = ownerStatusMs(competitionState?.nextKickoffMs);
  const queueNextPollAtMs = ownerStatusMs(queueTask?.nextPollAtMs);
  const queueUpdatedAtMs = ownerStatusMs(queueTask?.updatedAtMs) || ownerStatusMs(queueTask?.updatedAt);
  const roomUpdatedAtMs = ownerStatusMs(room.updatedAtMs);
  const roomUpdatedAt = ownerStatusMs(room.updatedAt);
  const competitionStateUpdatedAtMs = ownerStatusMs(competitionState?.updatedAtMs);
  const managerCount = getOwnerRoomManagerCount(room, memberUids);
  const managerLimit = 10;
  const requiresEvenManagers = roomRequiresEvenManagers(room);
  const draftStatusInfo = buildOwnerDraftStatus(room);
  const progressStatusInfo = buildOwnerProgressStatus(room, cupDoc);
  let managerCountWarning = "";
  if (managerCount < 2) {
    managerCountWarning = room.started
      ? "Started with fewer than 2 managers; tournament may not work correctly."
      : "Need at least 2 managers before draft start.";
  } else if (requiresEvenManagers && managerCount % 2 !== 0) {
    managerCountWarning = room.started
      ? "Started with an odd number of managers; Regular Season head-to-head pairing may fail."
      : "Regular Season head-to-head rooms need an even number of managers.";
  }
  const lastUpdateAtMs =
    roomUpdatedAtMs ||
    roomUpdatedAt ||
    competitionStateUpdatedAtMs ||
    queueUpdatedAtMs ||
    null;
  const lastUpdateSource =
    roomUpdatedAtMs
      ? "room.updatedAtMs"
      : roomUpdatedAt
        ? "room.updatedAt"
        : competitionStateUpdatedAtMs
          ? "competitionState.updatedAtMs"
          : queueUpdatedAtMs
            ? "queue.updatedAtMs"
            : "none";
  const baseStatus = {
    roomId: roomDoc.id,
    name: room.name || room.roomName || "Untitled room",
    code: room.code || room.roomCode || roomDoc.id,
    league,
    season,
    timezone: competition?.timezone || competitionState?.timezone || room.timezone || DEFAULT_TZ,
    competition: {
      league,
      season,
      timezone: competition?.timezone || "",
      name: competition?.name || "",
    },
    competitionMeta: {
      name: competitionMeta?.name || "",
      type: competitionMeta?.type || "",
      country: competitionMeta?.country || "",
      logo: competitionMeta?.logo || competitionMeta?.leagueLogo || "",
    },
    seasonKey,
    competitionKey,
    competitionType,
    competitionLabel,
    engineType: room.engineType || room.worldCup?.engineType || "",
    worldCupPhase: room.worldCupPhase || room.worldCup?.phase || "",
    pipelineMode: room.globalPipeline?.mode || "",
    phaseLabel,
    weekStatus,
    isDone,
    nextPollAtMs,
    nextKickoffMs,
    status: room.status || "",
    seasonPhase: room.seasonPhase || "",
    currentWeekIndex: room.currentWeekIndex ?? null,
    competitionLocked: Boolean(room.competitionLocked),
    started: Boolean(room.started),
    ...draftStatusInfo,
    ...progressStatusInfo,
    managerCount,
    managerLimit,
    managerCountLabel: `${managerCount}/${managerLimit}`,
    managerCountWarning,
    playerCount: Number(room.playerCount || 0),
    playersFrom: room.playersFrom || "",
    usedGlobalSeasonPlayers: Boolean(room.usedGlobalSeasonPlayers),
    worldCupPlayerPoolIncomplete: Boolean(room.worldCupPlayerPoolIncomplete),
    worldCupAllTeamsProcessed:
      typeof room.worldCupAllTeamsProcessed === "boolean" ? room.worldCupAllTeamsProcessed : null,
    worldCupHitGlobalCap: Boolean(room.worldCupHitGlobalCap),
    updatedAtMs: lastUpdateAtMs,
    lastUpdateAtMs,
    lastUpdateSource,
    queue: queueTask
      ? {
          phase: queueTask.phase || "",
          reason: queueTask.reason || "",
          nextPollAtMs: queueNextPollAtMs,
          updatedAtMs: queueUpdatedAtMs,
          dueNow: Boolean(queueNextPollAtMs && queueNextPollAtMs <= nowMs),
        }
      : null,
  };

  const actionableMissingQueue = ownerIsActionableQueueMissing(baseStatus);
  const ignoredMissingQueue = ownerIsIgnoredMissingQueue(baseStatus);
  const isIgnoredRoom = ignoredMissingQueue || (!ownerHasRealCompetition(baseStatus) && !baseStatus.queue);
  const enrichedStatus = {
    ...baseStatus,
    actionableMissingQueue,
    ignoredMissingQueue,
    queueMissing: actionableMissingQueue,
    isIgnoredRoom,
  };
  const queueState = getOwnerQueueState(enrichedStatus, nowMs);
  const displayStatus = buildOwnerDisplayStatus({ ...enrichedStatus, queueState }, nowMs);
  const roomStatusPill = displayStatus;
  const roomHealth = buildOwnerRoomHealth({ ...enrichedStatus, queueState, roomStatusPill, displayStatus }, nowMs);

  return {
    ...enrichedStatus,
    queueState,
    displayStatus,
    displayStatusLabel: displayStatus.label,
    displayStatusClass: displayStatus.className,
    roomStatusPill,
    roomHealth,
    isWorldCupRoom: ownerIsWorldCupRoom(enrichedStatus),
  };
}

function createOwnerCompetitionGroup(roomStatus) {
  const groupKey = getOwnerCompetitionGroupKey(roomStatus);
  const label = getOwnerCompetitionLabel({
    competitionMeta: roomStatus.competitionMeta,
    competition: roomStatus.competition,
    competitionKey: roomStatus.competitionKey,
  });

  return {
    groupKey,
    label,
    league: roomStatus.league,
    season: roomStatus.season,
    country: roomStatus.competitionMeta?.country || "",
    type: roomStatus.competitionMeta?.type || roomStatus.competitionType || "",
    logo: roomStatus.competitionMeta?.logo || "",
    seasonKey: roomStatus.seasonKey,
    competitionKey: roomStatus.competitionKey,
    competitionType: roomStatus.competitionType,
    roomCount: 0,
    countsByPhaseLabel: {},
    countsByWeekStatus: {},
    countsByEngineType: {},
    countsByWorldCupPhase: {},
    countsByPipelineMode: {},
    scheduledCount: 0,
    liveCount: 0,
    resolvingCount: 0,
    completeCount: 0,
    doneCount: 0,
    dueNowCount: 0,
    futureQueueCount: 0,
    missingQueueCount: 0,
    actionableMissingQueueCount: 0,
    ignoredMissingQueueCount: 0,
    soonestNextPollAtMs: null,
    soonestNextKickoffMs: null,
    latestUpdatedAtMs: null,
    groupStatusPill: { key: "unknown", label: "UNKNOWN", priority: 0 },
    groupHealth: { key: "ok", label: "OK", priority: 10 },
    isWorldCupGroup: ownerIsWorldCupRoom(roomStatus),
    rooms: [],
  };
}

function selectOwnerGroupDisplayStatus(rooms = []) {
  const activeRooms = rooms.filter((room) => !room.isIgnoredRoom);
  const knownStatuses = new Set(["scheduled", "idle", "live", "resolving", "complete", "final"]);
  const actionableRooms = activeRooms.filter((room) =>
    knownStatuses.has(String(room.weekStatus || "").toLowerCase())
  );
  const candidates = actionableRooms.length ? actionableRooms : activeRooms.length ? activeRooms : rooms;

  if (!candidates.length) {
    return { key: "unknown", label: "UNKNOWN", className: "idle", priority: 5 };
  }

  const byKey = (keys) =>
    candidates
      .filter((room) => keys.includes(String(room.displayStatus?.key || room.roomStatusPill?.key || "")))
      .sort((a, b) => Number(b.displayStatus?.priority || b.roomStatusPill?.priority || 0) - Number(a.displayStatus?.priority || a.roomStatusPill?.priority || 0))[0];

  const problem =
    byKey(["stale", "missing", "problem"]) ||
    candidates.find((room) => String(room.displayStatus?.className || room.roomStatusPill?.className || "") === "problem");
  if (problem) return problem.displayStatus || problem.roomStatusPill;

  const live = byKey(["live"]);
  if (live) return live.displayStatus || live.roomStatusPill;

  const resolving = byKey(["resolving"]);
  if (resolving) return resolving.displayStatus || resolving.roomStatusPill;

  const due = byKey(["due"]);
  if (due) return due.displayStatus || due.roomStatusPill;

  const idle = byKey(["idle"]);
  if (idle) return idle.displayStatus || idle.roomStatusPill;

  const complete = byKey(["complete"]);
  if (complete) return complete.displayStatus || complete.roomStatusPill;

  const ignored = rooms.find((room) => room.isIgnoredRoom);
  if (ignored) return ignored.displayStatus || ignored.roomStatusPill;

  return { key: "unknown", label: "UNKNOWN", className: "idle", priority: 5 };
}

exports.getOwnerSiteStatus = onCall(
  {
    region: "us-west2",
    cors: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "https://futbol-fantasy.com",
      "https://www.futbol-fantasy.com",
    ],
  },
  async (request) => {
    try {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
      requireAdminUid(uid);

      const nowMs = Date.now();
      const liveSinceMs = nowMs - LIVE_USER_WINDOW_MS;
      const [
        roomsSnap,
        queueSnap,
        membersSnap,
        livePresenceSnap,
        authUserCount,
        apiFootballRuntime,
      ] = await Promise.all([
        db.collection("rooms").limit(1000).get(),
        db.collection("tournamentPollQueue").limit(1000).get(),
        db.collectionGroup("members").limit(12000).get(),
        db.collection("sitePresence").where("lastSeenAtMs", ">=", liveSinceMs).limit(1000).get(),
        countFirebaseAuthUsers(),
        readApiFootballRuntimeStatus(nowMs),
      ]);
      const liveUserCount = livePresenceSnap.size;

      const queueByRoomId = new Map(
        queueSnap.docs.map((queueDoc) => [queueDoc.id, queueDoc.data() || {}])
      );
      const memberUidsByRoomId = new Map();

      for (const memberDoc of membersSnap.docs) {
        const roomRef = memberDoc.ref.parent.parent;
        const roomId = roomRef?.id;
        if (!roomId) continue;

        const data = memberDoc.data() || {};
        const uid = String(
          memberDoc.id ||
            data.uid ||
            data.userId ||
            data.id ||
            ""
        ).trim();

        if (!uid) continue;

        const set = memberUidsByRoomId.get(roomId) || new Set();
        set.add(uid);
        memberUidsByRoomId.set(roomId, set);
      }

      const cupCurrentRefs = [];
      for (const roomDoc of roomsSnap.docs) {
        const room = roomDoc.data() || {};
        const competitionState = getCompetitionState(room) || {};
        const phaseLabel = String(
          competitionState?.phaseLabel ||
            room?.phaseLabel ||
            ""
        );

        if (phaseLabel === "Cup" && !ownerRoomLooksWorldCupGroup(room, competitionState)) {
          cupCurrentRefs.push(db.doc(`rooms/${roomDoc.id}/cup/current`));
        }
      }

      const cupCurrentSnaps = cupCurrentRefs.length
        ? await db.getAll(...cupCurrentRefs)
        : [];
      const cupCurrentByRoomId = new Map();

      for (const snap of cupCurrentSnaps) {
        const roomRef = snap.ref.parent.parent;
        const roomId = roomRef?.id;
        if (!roomId) continue;
        cupCurrentByRoomId.set(roomId, snap.exists ? (snap.data() || {}) : null);
      }

      const groupsByKey = new Map();
      const totals = {
        roomCount: 0,
        scheduledCount: 0,
        liveCount: 0,
        resolvingCount: 0,
        completeCount: 0,
        doneCount: 0,
        dueNowCount: 0,
        futureQueueCount: 0,
        missingQueueCount: 0,
        actionableMissingQueueCount: 0,
        ignoredMissingQueueCount: 0,
        totalMissingQueueCount: 0,
      };

      for (const roomDoc of roomsSnap.docs) {
        const roomStatus = buildOwnerRoomStatus({
          roomDoc,
          queueTask: queueByRoomId.get(roomDoc.id) || null,
          nowMs,
          memberUids: Array.from(memberUidsByRoomId.get(roomDoc.id) || []),
          cupDoc: cupCurrentByRoomId.get(roomDoc.id) || null,
        });

        const groupKey = getOwnerCompetitionGroupKey(roomStatus);
        if (!groupsByKey.has(groupKey)) {
          groupsByKey.set(groupKey, createOwnerCompetitionGroup(roomStatus));
        }

        const group = groupsByKey.get(groupKey);
        const weekStatus = String(roomStatus.weekStatus || "").toLowerCase();

        group.roomCount += 1;
        totals.roomCount += 1;
        ownerCountBy(group.countsByPhaseLabel, roomStatus.phaseLabel);
        ownerCountBy(group.countsByWeekStatus, roomStatus.weekStatus);
        ownerCountBy(group.countsByEngineType, roomStatus.engineType);
        ownerCountBy(group.countsByWorldCupPhase, roomStatus.worldCupPhase);
        ownerCountBy(group.countsByPipelineMode, roomStatus.pipelineMode);

        if (weekStatus === "scheduled") {
          group.scheduledCount += 1;
          totals.scheduledCount += 1;
        }
        if (weekStatus === "live") {
          group.liveCount += 1;
          totals.liveCount += 1;
        }
        if (weekStatus === "resolving") {
          group.resolvingCount += 1;
          totals.resolvingCount += 1;
        }
        if (weekStatus === "complete" || String(roomStatus.seasonPhase || "").toUpperCase() === "COMPLETE") {
          group.completeCount += 1;
          totals.completeCount += 1;
        }
        if (roomStatus.isDone) {
          group.doneCount += 1;
          totals.doneCount += 1;
        }
        if (roomStatus.queue?.dueNow) {
          group.dueNowCount += 1;
          totals.dueNowCount += 1;
        } else if (roomStatus.queue?.nextPollAtMs && roomStatus.queue.nextPollAtMs > nowMs) {
          group.futureQueueCount += 1;
          totals.futureQueueCount += 1;
        }
        if (roomStatus.actionableMissingQueue) {
          group.missingQueueCount += 1;
          group.actionableMissingQueueCount += 1;
          totals.missingQueueCount += 1;
          totals.actionableMissingQueueCount += 1;
          totals.totalMissingQueueCount += 1;
        }
        if (roomStatus.ignoredMissingQueue) {
          group.ignoredMissingQueueCount += 1;
          totals.ignoredMissingQueueCount += 1;
          totals.totalMissingQueueCount += 1;
        }

        group.soonestNextPollAtMs = ownerMinMs(
          group.soonestNextPollAtMs,
          roomStatus.queue?.nextPollAtMs || roomStatus.nextPollAtMs
        );
        group.soonestNextKickoffMs = ownerMinMs(group.soonestNextKickoffMs, roomStatus.nextKickoffMs);
        group.latestUpdatedAtMs = ownerMaxMs(group.latestUpdatedAtMs, roomStatus.updatedAtMs);
        if (ownerIsWorldCupRoom(roomStatus)) {
          group.isWorldCupGroup = true;
        }

        group.rooms.push(roomStatus);
      }

      const groups = Array.from(groupsByKey.values())
        .map((group) => {
          const sortedRooms = (group.rooms || []).sort((a, b) => {
            if (a.isIgnoredRoom !== b.isIgnoredRoom) return a.isIgnoredRoom ? 1 : -1;
            const aP = Number(a.roomStatusPill?.priority || 0);
            const bP = Number(b.roomStatusPill?.priority || 0);
            if (aP !== bP) return bP - aP;
            const aDue = ownerStatusMs(a.queue?.nextPollAtMs || a.nextPollAtMs) || Number.MAX_SAFE_INTEGER;
            const bDue = ownerStatusMs(b.queue?.nextPollAtMs || b.nextPollAtMs) || Number.MAX_SAFE_INTEGER;
            if (aDue !== bDue) return aDue - bDue;
            return String(a.name || "").localeCompare(String(b.name || ""));
          });
          const healthSource = sortedRooms.reduce(
            (best, room) => {
              const current = room.roomHealth || { key: "ok", label: "OK", priority: 10 };
              return Number(current.priority || 0) > Number(best.priority || 0) ? current : best;
            },
            { key: "ok", label: "OK", priority: 10 }
          );
          const allRoomsIgnored = sortedRooms.length > 0 && sortedRooms.every((room) => room.isIgnoredRoom);
          const groupDisplayStatus = selectOwnerGroupDisplayStatus(sortedRooms);

          return {
            ...group,
            groupStatusPill: groupDisplayStatus,
            groupDisplayStatus,
            groupDisplayStatusLabel: groupDisplayStatus.label,
            groupDisplayStatusClass: groupDisplayStatus.className,
            groupHealth: allRoomsIgnored ? { key: "ignored", label: "Ignored", priority: 0 } : healthSource,
            rooms: sortedRooms.slice(0, 25),
          };
        })
        .sort((a, b) => {
          if (a.isWorldCupGroup !== b.isWorldCupGroup) return a.isWorldCupGroup ? -1 : 1;
          const aProblem = String(a.groupHealth?.key || "") === "problem";
          const bProblem = String(b.groupHealth?.key || "") === "problem";
          if (aProblem !== bProblem) return aProblem ? -1 : 1;
          const aActive = a.liveCount + a.resolvingCount;
          const bActive = b.liveCount + b.resolvingCount;
          if (aActive !== bActive) return bActive - aActive;
          if (a.dueNowCount !== b.dueNowCount) return b.dueNowCount - a.dueNowCount;
          const aWarning = String(a.groupHealth?.key || "") === "warning";
          const bWarning = String(b.groupHealth?.key || "") === "warning";
          if (aWarning !== bWarning) return aWarning ? -1 : 1;
          const aPoll = ownerStatusMs(a.soonestNextPollAtMs) || Number.MAX_SAFE_INTEGER;
          const bPoll = ownerStatusMs(b.soonestNextPollAtMs) || Number.MAX_SAFE_INTEGER;
          if (aPoll !== bPoll) return aPoll - bPoll;
          return String(a.label || "").localeCompare(String(b.label || ""));
        });

      return {
        ok: true,
        ownerActionsEnabled: true,
        nowMs,
        authUserCount,
        liveUserCount,
        liveUserWindowMs: LIVE_USER_WINDOW_MS,
        apiFootballRuntime,
        roomLimit: 1000,
        scannedRoomCount: roomsSnap.size,
        queueTaskCount: queueSnap.size,
        memberDocCount: membersSnap.size,
        competitionGroupCount: groups.length,
        totals,
        groups,
      };
    } catch (err) {
      console.error("[getOwnerSiteStatus] failed", {
        code: err?.code,
        message: err?.message,
        stack: err?.stack,
      });

      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", err?.message || "Owner status failed.");
    }
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
    const runSweep = await shouldRunGlobalSeasonFixtureSweep(nowMs);

    const [queueSnap, sweepSnap] = await Promise.all([
      db.collection("tournamentPollQueue")
        .where("nextPollAtMs", "<=", nowMs)
        .limit(100)
        .get(),

      runSweep
        ? db.collection("rooms")
            .where("competitionState.weekStatus", "in", ["scheduled", "live", "resolving"])
            .limit(100)
            .get()
        : Promise.resolve({ docs: [], size: 0 }),
    ]);

    const roomDocsById = new Map();
    const queueDueRoomIds = new Set();

    for (const taskDoc of queueSnap.docs) {
      const task = taskDoc.data() || {};
      const roomId = String(task.roomId || taskDoc.id || "");
      if (!roomId) continue;
      queueDueRoomIds.add(roomId);

      const roomSnap = await db.doc(`rooms/${roomId}`).get();
      if (!roomSnap.exists) {
        await taskDoc.ref.delete().catch(() => {});
        continue;
      }

      const room = roomSnap.data() || {};
      const competitionState = getCompetitionState(room) || {};
      if (roomLooksCompleteForPolling(room, competitionState)) {
        await taskDoc.ref.delete().catch(() => {});
        continue;
      }

      roomDocsById.set(roomId, roomSnap);
    }

    for (const roomDoc of sweepSnap.docs) {
      roomDocsById.set(roomDoc.id, roomDoc);
    }

    const { targets: seasonTargets, stats } = await collectActiveSeasonFixtureTargets(
      nowMs,
      Array.from(roomDocsById.values()),
      { queueDueRoomIds, runSweep }
    );

    console.log("[pollGlobalSeasonLiveFixtures] summary", {
      seasonTargets: seasonTargets.length,
      queueDue: queueSnap.size,
      sweepRooms: sweepSnap.size || 0,
      roomsRead: roomDocsById.size,
      sleepingRoomCount: stats.sleepingRoomCount,
      skippedFuturePollCount: stats.skippedFuturePollCount,
      activeRoomCount: stats.activeRoomCount,
      skippedDoneCount: stats.skippedDoneCount,
      runSweep,
      nowMs,
    });

    console.log("[pollGlobalSeasonLiveFixtures] target roomIds", {
      seasonTargets: seasonTargets.map((target) => ({
        seasonKey: target.seasonKey,
        fixtureCount: Array.isArray(target.fixtureIds) ? target.fixtureIds.length : 0,
        roomIds: target.roomIds || [],
      })),
    });

    if (!seasonTargets.length) {
      console.log("[pollGlobalSeasonLiveFixtures] no active fixtures", { nowMs });
    }

    for (const seasonTarget of seasonTargets) {
      let refreshLock = null;
      try {
        refreshLock = await acquireGlobalSeasonRefreshLock({
          seasonTarget,
          nowMs,
          source: "pollGlobalSeasonLiveFixtures",
        });
        if (!refreshLock.acquired) {
          console.log("[pollGlobalSeasonLiveFixtures] skipped shared cache refresh", {
            seasonKey: seasonTarget?.seasonKey || "unknown",
            fixtureCount: Array.isArray(seasonTarget?.fixtureIds)
              ? seasonTarget.fixtureIds.length
              : 0,
            skippedReason: refreshLock.skippedReason,
            roomIds: seasonTarget?.roomIds || [],
          });
          continue;
        }

        const result = await pollGlobalSeasonLiveFixturesOnce({
          seasonTarget,
          apiKey,
          nowMs,
        });
        await finishGlobalSeasonRefreshLock(refreshLock, { nowMs, result });

        console.log(
          `[pollGlobalSeasonLiveFixtures] season=${seasonTarget.seasonKey} fixtures=${result.fixtureCount} payloads=${result.payloadCount} statChecks=${result.uniqueFixtureStatsChecked || 0} statApiCalls=${result.fixturePlayerStatsApiCalls || 0} lockSkips=${result.fixturePlayerStatsLockSkips || 0}`
        );
      } catch (e) {
        await finishGlobalSeasonRefreshLock(refreshLock, { nowMs, error: e });

        if (isApiFootballCooldownError(e)) {
          const retryAtMs = getApiFootballCooldownRetryAtMs(e, nowMs);
          const reason = apiFootballCooldownReason(e);
          console.warn("[pollGlobalSeasonLiveFixtures] API-Football guarded; sleeping targets", {
            seasonKey: seasonTarget?.seasonKey || "unknown",
            reason,
            retryAtMs,
            roomIds: seasonTarget?.roomIds || [],
          });

          await Promise.all(
            (Array.isArray(seasonTarget?.roomIds) ? seasonTarget.roomIds : [])
              .map((roomId) =>
                upsertTournamentPollTask({
                  roomId,
                  phase: "GlobalSeason",
                  nextPollAtMs: retryAtMs,
                  reason,
                  nowMs,
                }).catch(() => {})
              )
          );

          continue;
        }

        console.error(
          `[pollGlobalSeasonLiveFixtures] Failed season=${seasonTarget?.seasonKey || "unknown"}`,
          e
        );
      }
    }
  }
);

const TOURNAMENT_PRE_MS = 20 * 60 * 1000;          // wake 20 min before kickoff
const TOURNAMENT_PREGAME_POLL_MS = 5 * 60 * 1000;  // every 5 min before kickoff
const TOURNAMENT_ACTIVE_POLL_MS = 60 * 1000;       // every minute during active window
const TOURNAMENT_UNKNOWN_RECHECK_MS = 60 * 60 * 1000; // check hourly if no kickoff time
const TOURNAMENT_POST_MS = 3 * 60 * 60 * 1000;     // keep your current 3h post-kickoff
const TOURNAMENT_SWEEP_MS = 60 * 60 * 1000;        // hourly safety sweep
const TOURNAMENT_SLEEP_GUARD_GRACE_MS = 30 * 1000;

function pollingNextPollAtMs(competitionState = {}) {
  const direct = Number(competitionState?.nextPollAtMs || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const cup = Number(competitionState?.nextCupPollAtMs || 0);
  if (Number.isFinite(cup) && cup > 0) return cup;

  return null;
}

function roomLooksCompleteForPolling(room = {}, competitionState = {}) {
  const status = String(room?.status || "").trim().toLowerCase();
  const seasonPhase = String(room?.seasonPhase || "").trim().toUpperCase();
  const weekStatus = String(competitionState?.weekStatus || "").trim().toLowerCase();
  const cupCompleted = room?.cup?.completed === true;
  const worldCupCompleted = room?.worldCup?.completed === true;

  return (
    competitionState?.isDone === true ||
    seasonPhase === "COMPLETE" ||
    status === "completed" ||
    status === "complete" ||
    status === "done" ||
    weekStatus === "complete" ||
    weekStatus === "final" ||
    cupCompleted ||
    worldCupCompleted
  );
}

function buildDeepPollingSkip(room = {}, competitionState = {}, nowMs = Date.now(), {
  isQueuedDue = false,
  enforceGlobalDue = false,
} = {}) {
  if (roomLooksCompleteForPolling(room, competitionState)) {
    return { skip: true, reason: "room-complete" };
  }

  const weekStatus = String(competitionState?.weekStatus || "").trim().toLowerCase();
  const isSleepingStatus = weekStatus === "scheduled" || weekStatus === "idle";
  const nextPollAtMs = pollingNextPollAtMs(competitionState);

  if (
    isSleepingStatus &&
    Number.isFinite(Number(nextPollAtMs)) &&
    Number(nextPollAtMs) > nowMs + TOURNAMENT_SLEEP_GUARD_GRACE_MS
  ) {
    return {
      skip: true,
      reason: "sleep-until-next-poll",
      nextPollAtMs: Number(nextPollAtMs),
    };
  }

  if (
    enforceGlobalDue &&
    isSleepingStatus &&
    !isQueuedDue &&
    !(
      Number.isFinite(Number(nextPollAtMs)) &&
      Number(nextPollAtMs) <= nowMs
    )
  ) {
    return {
      skip: true,
      reason: "scheduled-global-room-not-due",
      nextPollAtMs: Number.isFinite(Number(nextPollAtMs)) ? Number(nextPollAtMs) : null,
    };
  }

  return { skip: false, reason: "" };
}

function coverageKickoffMs(coverage = {}) {
  const kickoffMs = Number(coverage?.kickoffMs || coverage?.startAtMs || 0);
  return Number.isFinite(kickoffMs) && kickoffMs > 0 ? kickoffMs : null;
}

function coverageStatusShort(coverage = {}) {
  return String(
    coverage?.statusShort ||
      coverage?.fixtureStatus ||
      coverage?.matchStatus ||
      ""
  ).trim().toUpperCase();
}

function isCancelledOrAbandonedStatus(short = "") {
  return ["CANC", "PST", "ABD", "AWD", "WO"].includes(String(short || "").trim().toUpperCase());
}

function isCoverageInActiveWakeWindow(coverage = {}, nowMs = Date.now()) {
  const kickoffMs = coverageKickoffMs(coverage);
  return (
    Number.isFinite(kickoffMs) &&
    nowMs >= kickoffMs - TOURNAMENT_PRE_MS &&
    nowMs <= kickoffMs + TOURNAMENT_POST_MS
  );
}

function isCoverageStalePastPostTail(coverage = {}, nowMs = Date.now()) {
  const kickoffMs = coverageKickoffMs(coverage);
  return (
    isInPlay(coverageStatusShort(coverage)) &&
    Number.isFinite(kickoffMs) &&
    nowMs > kickoffMs + TOURNAMENT_POST_MS
  );
}

function kickoffMsFromFixture(g) {
  return Number(
    g?.kickoffMs ??
    g?.fixtureId?.kickoffMs ??
    (g?.fixture?.timestamp ? g.fixture.timestamp * 1000 : NaN)
  );
}

function statusShortFromFixture(fixture = {}) {
  return String(
    fixture?.statusShort ||
      fixture?.fixtureStatus ||
      fixture?.matchStatus ||
      fixture?.status?.short ||
      fixture?.fixture?.status?.short ||
      ""
  ).trim().toUpperCase();
}

function isFixtureFinalForPolling(fixture = {}) {
  const short = statusShortFromFixture(fixture);
  return isFinished(short) || isCancelledOrAbandonedStatus(short);
}

function hasFixtureStartedForPolling(fixture = {}, nowMs = Date.now()) {
  const short = statusShortFromFixture(fixture);
  if (isFinished(short)) return true;
  if (isCancelledOrAbandonedStatus(short)) return false;
  if (hasFixtureStarted(short) || isInPlay(short)) return true;

  const koMs = kickoffMsFromFixture(fixture);
  return Number.isFinite(koMs) && nowMs >= koMs && nowMs <= koMs + TOURNAMENT_POST_MS;
}

function shouldPollFixtureNow(fixture, nowMs) {
  const koMs = kickoffMsFromFixture(fixture);
  if (!Number.isFinite(koMs)) return false;

  // "Active" means kickoff has reached.
  // Pregame is handled separately by getNextPollAtMsFromFixtures.
  return nowMs >= koMs && nowMs <= koMs + TOURNAMENT_POST_MS;
}

function filterFixturesForActivePolling(fixtures, nowMs) {
  return (Array.isArray(fixtures) ? fixtures : []).filter((fixture) =>
    shouldPollFixtureNow(fixture, nowMs)
  );
}

function getActivePollingFixtures(fixtures, nowMs) {
  return filterFixturesForActivePolling(fixtures, nowMs);
}

function getActivePollingFixtureIds(fixtures, nowMs) {
  return extractFixtureIdsFromWeekDoc({
    fixtures: getActivePollingFixtures(fixtures, nowMs),
    fixtureIds: [],
  });
}

function hasActivePollingFixture(fixtures, nowMs) {
  return getActivePollingFixtureIds(fixtures, nowMs).length > 0;
}

function getAggregationPollingFixtures(fixtures, nowMs) {
  return (Array.isArray(fixtures) ? fixtures : []).filter((fixture) =>
    hasFixtureStartedForPolling(fixture, nowMs)
  );
}

function getAggregationPollingFixtureIds(fixtures, nowMs) {
  return extractFixtureIdsFromWeekDoc({
    fixtures: getAggregationPollingFixtures(fixtures, nowMs),
    fixtureIds: [],
  });
}

function getFutureKickoffs(fixtures, nowMs) {
  return (Array.isArray(fixtures) ? fixtures : [])
    .map(kickoffMsFromFixture)
    .filter(Number.isFinite)
    .filter((ms) => ms > nowMs)
    .sort((a, b) => a - b);
}

function getNextPollAtMsFromFixtures(fixtures, nowMs) {
  const activeFixtureIds = getActivePollingFixtureIds(fixtures, nowMs);

  // Kickoff reached / live-resolving window.
  // This is the only path that should schedule every 1 minute.
  if (activeFixtureIds.length > 0) {
    return {
      nextKickoffMs: null,
      nextPollAtMs: nowMs + TOURNAMENT_ACTIVE_POLL_MS,
      reason: "live-or-resolving-1min-check",
      activeFixtureIds,
    };
  }

  const futureKickoffs = getFutureKickoffs(fixtures, nowMs);
  const nextKickoffMs = futureKickoffs[0] || null;

  if (!nextKickoffMs) {
    return {
      nextKickoffMs: null,
      nextPollAtMs: nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
      reason: "no-known-kickoff",
      activeFixtureIds: [],
    };
  }

  // Far away: sleep until 20 minutes before kickoff.
  if (nowMs < nextKickoffMs - TOURNAMENT_PRE_MS) {
    return {
      nextKickoffMs,
      nextPollAtMs: nextKickoffMs - TOURNAMENT_PRE_MS,
      reason: "sleep-until-pregame-window",
      activeFixtureIds: [],
    };
  }

  // Pregame: 20 minutes before kickoff until kickoff.
  // This should be every 5 minutes, not every 1 minute.
  if (nowMs < nextKickoffMs) {
    return {
      nextKickoffMs,
      nextPollAtMs: Math.min(nowMs + TOURNAMENT_PREGAME_POLL_MS, nextKickoffMs),
      reason: "pregame-5min-check",
      activeFixtureIds: [],
    };
  }

  return {
    nextKickoffMs: null,
    nextPollAtMs: nowMs + TOURNAMENT_ACTIVE_POLL_MS,
    reason: "live-or-resolving-1min-check",
    activeFixtureIds,
  };
}

function buildTournamentPollDebugLabels(room, nextPollAtMs, nextKickoffMs) {
  const timeZone = getRoomTimeZone(room || {});
  const hasNextPollAtMs = nextPollAtMs != null && nextPollAtMs !== "";
  const hasNextKickoffMs = nextKickoffMs != null && nextKickoffMs !== "";
  const safeNextPollAtMs = hasNextPollAtMs ? Number(nextPollAtMs) : NaN;
  const safeNextKickoffMs = hasNextKickoffMs ? Number(nextKickoffMs) : NaN;

  return {
    nextPollAtLabel: Number.isFinite(safeNextPollAtMs)
      ? formatWhen(safeNextPollAtMs, timeZone)
      : null,
    nextKickoffLabel: Number.isFinite(safeNextKickoffMs)
      ? formatWhen(safeNextKickoffMs, timeZone)
      : null,
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
      nextPollAtLabel: formatWhen(safeNextPollAtMs, "America/Los_Angeles"),
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

async function shouldRunGlobalSeasonFixtureSweep(nowMs) {
  const sweepRef = db.doc("system/globalSeasonFixturePollSweep");
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

    const [queueSnap, sweepSnap] = await Promise.all([
      // ✅ Main cheap path: only rooms whose wake time is due.
      db.collection("tournamentPollQueue")
        .where("nextPollAtMs", "<=", nowMs)
        .limit(100)
        .get(),

      // Hourly repair sweep for scheduled/live/resolving rooms with stale or missing queue tasks.
      runSweep
        ? db.collection("rooms")
            .where("competitionState.weekStatus", "in", ["scheduled", "live", "resolving"])
            .limit(100)
            .get()
        : Promise.resolve({ docs: [], size: 0 }),
    ]);

    const roomDocsById = new Map();
    const queueDueRoomIds = new Set();

    // Queue tasks: read the room doc only when its wake time is due.
    for (const taskDoc of queueSnap.docs) {
      const task = taskDoc.data() || {};
      const roomId = String(task.roomId || taskDoc.id || "");
      if (!roomId) continue;
      queueDueRoomIds.add(roomId);

      const roomSnap = await db.doc(`rooms/${roomId}`).get();
      if (!roomSnap.exists) {
        await taskDoc.ref.delete().catch(() => {});
        continue;
      }

      roomDocsById.set(roomId, roomSnap);
    }

    // Hourly sweep: keeps old/missing queue rooms from being forgotten.
    for (const roomDoc of sweepSnap.docs) {
      roomDocsById.set(roomDoc.id, roomDoc);
    }

    const roomDocs = Array.from(roomDocsById.values());

    console.log("[pollLiveTournamentWeeks] summary", {
      roomsFound: roomDocs.length,
      queueDue: queueSnap.size,
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
        if (roomLooksCompleteForPolling(room, competitionState)) {
          await deleteTournamentPollTask(roomId);
          continue;
        }

        const weekStatus = String(competitionState?.weekStatus || "").toLowerCase();
        const phase = getRoomPhaseLabel(room);
        const engineType = String(room?.engineType || room?.worldCup?.engineType || "").trim();
        const isWorldCupDailyRoom =
          engineType === "worldCupDaily" ||
          phase === "WorldCupGroup" ||
          competitionState?.phaseLabel === "WorldCupGroup";

        // If room is no longer active/scheduled, remove it from the queue.
        if (!["scheduled", "live", "resolving"].includes(weekStatus)) {
          if (!isWorldCupDailyRoom || weekStatus !== "idle") {
            await deleteTournamentPollTask(roomId);
            continue;
          }
        }

        const isQueuedDue = queueDueRoomIds.has(roomId);
        const sleepGuard = runSweep
          ? { skip: false, reason: "" }
          : buildDeepPollingSkip(room, competitionState, nowMs, {
              isQueuedDue,
              enforceGlobalDue: getGlobalPipelineMode(room) === "global",
            });

        if (sleepGuard.skip) {
          console.log("[pollLiveTournamentWeeks] room sleeping before deep reads", {
            roomId,
            weekStatus,
            reason: sleepGuard.reason,
            nextPollAtMs: sleepGuard.nextPollAtMs || null,
            nowMs,
            isQueuedDue,
          });

          continue;
        }

        // -------------------------
        // WORLD CUP GROUP ROOMS
        // -------------------------
        if (isWorldCupDailyRoom) {
          if (weekStatus === "scheduled") {
            console.log("[pollLiveTournamentWeeks] world cup scheduled room checked", {
              roomId,
              engineType: room?.engineType || room?.worldCup?.engineType || "",
              worldCupPhase: room?.worldCupPhase || room?.worldCup?.phase || "",
              weekStatus: competitionState?.weekStatus || null,
            });
          }

          console.log("[pollLiveTournamentWeeks] running world cup daily engine", {
            roomId,
            weekStatus,
            nowMs,
          });

          const result = await runWorldCupGroupEngine({
            db,
            roomId,
            room,
            nowMs,
            apiKey,
            getFixtureStatusMap,
            getFixturePlayersStatsMapCached,
            setCompetitionState,
            ensureDefaultLineupsForRoom,
          });

          const resultWeekStatus = String(result?.weekStatus || result?.status || "").toLowerCase();
          if (!["scheduled", "live", "resolving"].includes(resultWeekStatus)) {
            await deleteTournamentPollTask(roomId);
            continue;
          }

          const nextPollAtMs = Number(result?.nextPollAtMs || 0);
          await upsertTournamentPollTask({
            roomId,
            phase: "WorldCupGroup",
            nextPollAtMs:
              Number.isFinite(nextPollAtMs) && nextPollAtMs > nowMs
                ? nextPollAtMs
                : nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS,
            reason: "world-cup-daily-engine-next",
            nowMs,
          });

          continue;
        }

        // -------------------------
        // CUP ROOMS
        // -------------------------
        if (phase === "Cup") {
          const nextCupPollAtMs = Number(competitionState?.nextCupPollAtMs || 0);
          let cupGlobalWindowStarted = false;

          if (Number.isFinite(nextCupPollAtMs) && nextCupPollAtMs > nowMs && !runSweep) {
            console.log("[pollLiveTournamentWeeks] cup room sleeping until nextCupPollAtMs", {
              roomId,
              nextCupPollAtMs,
              nowMs,
            });
            continue;
          }

          if (isCupGlobalAutoApplyEnabled(room)) {
            try {
              const cupRef = db.doc(`rooms/${roomId}/cup/current`);
              let cupSnap = await cupRef.get();
              let cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
              let currentFixtureIds = Array.isArray(cup?.currentWindowFixtureIds)
                ? cup.currentWindowFixtureIds.map(String).filter(Boolean)
                : [];

              if (!currentFixtureIds.length) {
                const armedWindow = await armNextCupGlobalWindowFromCache({
                  db,
                  roomId,
                  room,
                  nowMs,
                });

                if (!armedWindow) {
                  cupSnap = await cupRef.get();
                  cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
                  const discoveredWindow = await discoverAndArmNextCupGlobalWindow({
                    roomId,
                    room,
                    cup,
                    nowMs,
                    afterMs:
                      Number(
                        cup?.nextGlobalDiscoveryAfterMs ||
                          cup?.lastWindowEndAtMs ||
                          0
                      ) || null,
                    reason: "cup-global-waiting-room-due",
                  });
                  if (!discoveredWindow?.armed) continue;
                }

                cupSnap = await cupRef.get();
                cup = cupSnap.exists ? (cupSnap.data() || {}) : {};
                currentFixtureIds = Array.isArray(cup?.currentWindowFixtureIds)
                  ? cup.currentWindowFixtureIds.map(String).filter(Boolean)
                  : [];
              }

              if (!currentFixtureIds.length) {
                continue;
              }

              const { firstKickoffMs } = getCupGlobalWindowTiming(cup);
              cupGlobalWindowStarted =
                Number.isFinite(Number(firstKickoffMs)) &&
                Number(firstKickoffMs) <= nowMs;

              if (room?.started !== true) {
                const pregameAtMs = firstKickoffMs
                  ? firstKickoffMs - TOURNAMENT_PRE_MS
                  : null;
                const draftNextPollAtMs =
                  pregameAtMs && nowMs < pregameAtMs
                    ? Math.max(nowMs + CUP_GLOBAL_DRAFT_RECHECK_MS, pregameAtMs)
                    : nowMs + CUP_GLOBAL_ACTIVE_RECHECK_MS;

                await cupRef.set(
                  {
                    status: "scheduled",
                    source: "global-live-fixtures",
                    globalApplyStatus: "cup-global-draft-not-started",
                    nextPollAtMs: draftNextPollAtMs,
                    updatedAtMs: nowMs,
                    updatedAt: FieldValue.serverTimestamp(),
                  },
                  { merge: true }
                );
                await setCompetitionState(
                  roomRef,
                  {
                    phaseLabel: "Cup",
                    weekStatus: "scheduled",
                    nextPollAtMs: draftNextPollAtMs,
                    nextCupPollAtMs: draftNextPollAtMs,
                    nextKickoffMs: firstKickoffMs || null,
                    isDone: false,
                  },
                  { roomData: room, nowMs }
                );
                await upsertTournamentPollTask({
                  roomId,
                  phase,
                  nextPollAtMs: draftNextPollAtMs,
                  reason: "cup-global-draft-not-started",
                  nowMs,
                });

                console.log("[pollLiveTournamentWeeks] skipped Cup global room before draft", {
                  roomId,
                  skippedReason: "cup-global-draft-not-started",
                  fixtureCount: currentFixtureIds.length,
                  firstKickoffMs,
                  nextPollAtMs: draftNextPollAtMs,
                });
                continue;
              }

              try {
                await refreshCupGlobalCacheForRoom({
                  roomId,
                  room,
                  cup,
                  apiKey,
                  nowMs,
                  reason: "cup-global-auto-apply",
                });
              } catch (refreshError) {
                if (isApiFootballCooldownError(refreshError)) {
                  throw refreshError;
                }

                console.warn("[pollLiveTournamentWeeks] Cup global cache refresh failed; using existing cache", {
                  roomId,
                  code: refreshError?.code,
                  message: refreshError?.message,
                });
              }

              const result = await computeCupCurrentWindowFromGlobalCache({
                db,
                roomId,
                nowMs,
                writeMode: "global",
                dryRun: false,
              });

              const statusValue = String(result?.statusValue || "").toLowerCase();
              const nextKickoffMsRaw = Number(result?.nextKickoffMs || 0);
              const resultNextPollAtMsRaw = Number(result?.nextPollAtMs || 0);
              const nextKickoffMs =
                Number.isFinite(nextKickoffMsRaw) && nextKickoffMsRaw > nowMs
                  ? nextKickoffMsRaw
                  : null;
              const nextCupPollAtMs =
                Number.isFinite(resultNextPollAtMsRaw) && resultNextPollAtMsRaw > nowMs
                  ? resultNextPollAtMsRaw
                  : statusValue === "live" || statusValue === "resolving"
                    ? nowMs + TOURNAMENT_ACTIVE_POLL_MS
                    : statusValue === "final"
                      ? nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS
                      : nextKickoffMs
                        ? getNextPollAtMsFromFixtures(
                            [{ fixtureId: "cup-window", kickoffMs: nextKickoffMs }],
                            nowMs
                          ).nextPollAtMs
                        : nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS;
              const nextWeekStatus =
                statusValue === "live"
                  ? "live"
                  : statusValue === "resolving"
                    ? "resolving"
                  : statusValue === "final"
                    ? "resolving"
                    : "scheduled";

              if (
                statusValue === "final" &&
                result?.allFinished === true &&
                Number(result?.missingFixtureCount || 0) === 0 &&
                result?.hasStaleInPlayFixtures !== true &&
                (!Array.isArray(result?.staleInPlayFixtureIds) ||
                  result.staleInPlayFixtureIds.length === 0) &&
                cup?.replayTestMode !== true &&
                isCupGlobalFinalizationEnabled(room)
              ) {
                const finalizedFixtureIds = [...currentFixtureIds];
                const afterMs = Number(
                  cup?.currentWindowEndAtMs ||
                    Math.max(
                      ...((Array.isArray(cup?.currentWindowFixtures)
                        ? cup.currentWindowFixtures
                        : [])
                        .map((fixture) => Number(fixture?.kickoffMs || 0))
                        .filter((kickoffMs) => Number.isFinite(kickoffMs) && kickoffMs > 0))
                    ) ||
                    0
                );
                const finalization = await finalizeCupGlobalCurrentWindow({
                  db,
                  roomId,
                  room,
                  cup,
                  applyResult: result,
                  nowMs,
                });

                console.log("[pollLiveTournamentWeeks] Cup global finalization complete", {
                  roomId,
                  windowKey: finalization.windowKey,
                  historyDocId: finalization.historyDocId,
                  finalizedUserCount: finalization.finalizedUserCount,
                  wroteFinalResults: finalization.wroteFinalResults,
                });

                if (finalization.wroteFinalResults) {
                  await setCompetitionState(
                    roomRef,
                    {
                      weekStatus: "final",
                      currentLabel: finalization.label || "Final",
                      isDone: true,
                      nextPollAtMs: null,
                      nextCupPollAtMs: null,
                      nextKickoffMs: null,
                    },
                    { roomData: room, nowMs }
                  );
                  await deleteTournamentPollTask(roomId);
                  continue;
                }

                const armedNextWindow = await armNextCupGlobalWindowFromCache({
                  db,
                  roomId,
                  room,
                  nowMs,
                  afterMs: Number.isFinite(afterMs) && afterMs > 0 ? afterMs : null,
                  excludeFixtureIds: finalizedFixtureIds,
                });
                if (!armedNextWindow) {
                  const waitingCupSnap = await cupRef.get();
                  const waitingCup = waitingCupSnap.exists
                    ? (waitingCupSnap.data() || {})
                    : {};
                  await discoverAndArmNextCupGlobalWindow({
                    roomId,
                    room,
                    cup: waitingCup,
                    nowMs,
                    afterMs: Number.isFinite(afterMs) && afterMs > 0 ? afterMs : null,
                    reason: "cup-global-finalized-window",
                  });
                  continue;
                }

                const nextWindowPollAtMs = Number(
                  armedNextWindow.nextPollAtMs || nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS
                );
                await upsertTournamentPollTask({
                  roomId,
                  phase,
                  nextPollAtMs: nextWindowPollAtMs,
                  reason: "cup-global-next-window-armed",
                  nowMs,
                });
                continue;
              }

              await setCompetitionState(
                roomRef,
                {
                  weekStatus: nextWeekStatus,
                  nextPollAtMs: nextCupPollAtMs,
                  nextCupPollAtMs,
                  nextKickoffMs,
                },
                {
                  roomData: room,
                  nowMs,
                }
              );

              await upsertTournamentPollTask({
                roomId,
                phase,
                nextPollAtMs: nextCupPollAtMs,
                reason: "cup-global-auto-apply-next",
                nowMs,
              });

              console.log("[pollLiveTournamentWeeks] Cup global auto apply complete", {
                roomId,
                statusValue: result?.statusValue || null,
                weekStatus: nextWeekStatus,
                fixtureCount: Number(result?.fixtureCount || 0),
                missingFixtureCount: Number(result?.missingFixtureCount || 0),
                hasStaleInPlayFixtures: Boolean(result?.hasStaleInPlayFixtures),
                staleInPlayFixtureIds: result?.staleInPlayFixtureIds || [],
                realWriteApplied: Boolean(result?.realWriteApplied),
                projectionOnly: true,
                nextCupPollAtMs,
                nextKickoffMs,
              });

              continue;
            } catch (err) {
              const apiFootballGuarded = isApiFootballCooldownError(err);
              const retryAtMs =
                apiFootballGuarded
                  ? getApiFootballCooldownRetryAtMs(err, nowMs)
                  : (
                  cupGlobalWindowStarted ||
                  ["live", "resolving"].includes(weekStatus)
                )
                  ? nowMs + TOURNAMENT_ACTIVE_POLL_MS
                  : nowMs + TOURNAMENT_PREGAME_POLL_MS;
              const retryReason = apiFootballGuarded
                ? apiFootballCooldownReason(err)
                : "cup-global-auto-apply-error";
              console.warn("[pollLiveTournamentWeeks] Cup global auto apply failed", {
                roomId,
                code: err?.code,
                message: err?.message,
                retryAtMs,
                apiFootballGuarded,
              });
              await db.doc(`rooms/${roomId}/cup/current`).set(
                {
                  source: "global-live-fixtures",
                  globalApplyStatus: retryReason,
                  globalApplyError: String(err?.message || err),
                  globalApplyErrorCode: err?.code || null,
                  globalApplyErrorAtMs: nowMs,
                  nextPollAtMs: retryAtMs,
                  updatedAtMs: nowMs,
                  updatedAt: FieldValue.serverTimestamp(),
                },
                { merge: true }
              ).catch(() => {});
              await db.doc(`rooms/${roomId}/globalShadowResults/cup-apply-current-window`).set(
                {
                  roomId,
                  source: "global-live-fixtures",
                  realWriteApplied: false,
                  globalApplyStatus: "error",
                  error: String(err?.message || err),
                  errorCode: err?.code || null,
                  nextPollAtMs: retryAtMs,
                  updatedAtMs: nowMs,
                  updatedAt: FieldValue.serverTimestamp(),
                },
                { merge: true }
              ).catch(() => {});
              await setCompetitionState(
                roomRef,
                {
                  weekStatus: ["live", "resolving"].includes(weekStatus)
                    ? weekStatus
                    : "scheduled",
                  nextPollAtMs: retryAtMs,
                  nextCupPollAtMs: retryAtMs,
                },
                { roomData: room, nowMs }
              ).catch(() => {});
              await upsertTournamentPollTask({
                roomId,
                phase,
                nextPollAtMs: retryAtMs,
                reason: retryReason,
                nowMs,
              }).catch(() => {});

              if (apiFootballGuarded) {
                continue;
              }

              if (room?.globalPipeline?.cupLegacyFallback !== true) {
                continue;
              }

              console.warn("[pollLiveTournamentWeeks] explicit Cup legacy fallback enabled", {
                roomId,
              });
            }
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
            const holdPollAtMs = getRegularFinalHoldPollAtMs(week, nowMs);
            const nextPollAtMs =
              holdPollAtMs > nowMs ? holdPollAtMs : nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS;
            await setCompetitionState(
              roomRef,
              {
                weekStatus: "scheduled",
                nextPollAtMs,
                nextKickoffMs: null,
                ...buildTournamentPollDebugLabels(room, nextPollAtMs, null),
              },
              {
                roomData: { ...room, competitionState },
                nowMs,
              }
            );
            await upsertTournamentPollTask({
              roomId,
              phase: phase || "RegularSeason",
              nextPollAtMs,
              reason: holdPollAtMs > nowMs ? "regular-final-hold" : "final-no-next-week",
              nowMs,
            });
            continue;
          }

          if (nextIdx === "COMPLETE") {
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
          const nextPollAtMs = nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS;
          await upsertTournamentPollTask({
            roomId,
            phase: phase || "RegularSeason",
            nextPollAtMs,
            reason: "no-fixtures",
            nowMs,
          });

          await setCompetitionState(
            roomRef,
            {
              weekStatus: "scheduled",
              nextPollAtMs,
              nextKickoffMs: null,
              ...buildTournamentPollDebugLabels(room, nextPollAtMs, null),
            },
            {
              roomData: { ...room, competitionState },
              nowMs,
            }
          );

          continue;
        }

        const activeFixtureIds = getAggregationPollingFixtureIds(fixtures, nowMs);
        const hasActiveFixture = activeFixtureIds.length > 0;
        const shouldRun = hasActiveFixture;

        const sleepInfo = getNextPollAtMsFromFixtures(fixtures, nowMs);
        const useRegularGlobalAggregator =
          getGlobalPipelineMode(room) === "global" &&
          isGlobalRoomAggregatorEnabled(room);

        console.log("[pollLiveTournamentWeeks] time gate", {
          roomId,
          weekIndex,
          shouldRun,
          hasActiveFixture,
          activeFixtureIds,
          nowMs,
          fixtureCount: fixtures.length,
          nextKickoffMs: sleepInfo.nextKickoffMs,
          nextPollAtMs: sleepInfo.nextPollAtMs,
          reason: sleepInfo.reason,
        });

        if (hasActiveFixture) {
          const nextPollAtMs = nowMs + TOURNAMENT_ACTIVE_POLL_MS;
          console.log("[pollLiveTournamentWeeks] active fixture wake guard", {
            roomId,
            weekIndex,
            weekStatus,
            activeFixtureIds,
            nowMs,
            nextPollAtMs,
          });

          if (useRegularGlobalAggregator && weekStatus === "scheduled") {
            console.log("[pollLiveTournamentWeeks] scheduled global room auto-woke from active fixture window", {
              roomId,
              weekIndex,
              activeFixtureIds,
            });
          }

          await Promise.all([
            upsertTournamentPollTask({
              roomId,
              phase: phase || "RegularSeason",
              nextPollAtMs,
              reason: "active-fixture-window-guard",
              nowMs,
            }),
            setCompetitionState(
              roomRef,
              {
                weekStatus: "live",
                nextPollAtMs,
                nextKickoffMs: null,
                ...buildTournamentPollDebugLabels(room, nextPollAtMs, null),
              },
              {
                roomData: { ...room, competitionState },
                nowMs,
              }
            ),
          ]);
        }

        if (!shouldRun) {
          const endAtMs = Number(week.endAtMs || 0);

          // If we're past the post-window and not final yet, run compute once to finalize + advance.
          if (
            week.status !== "final" &&
            Number.isFinite(endAtMs) &&
            endAtMs > 0 &&
            nowMs >= endAtMs + TOURNAMENT_POST_MS
          ) {
            if (useRegularGlobalAggregator) {
              console.log(`[pollLiveTournamentWeeks] regular global aggregator room=${roomId}`, {
                roomId,
                weekIndex,
                reason: "finalization",
              });

              await refreshRegularGlobalCacheForRoom({
                roomId,
                room,
                week,
                apiKey,
                nowMs,
                reason: "finalization",
                includeAllWeekFixtures: true,
              });

              const result = await computeRegularWeekFromGlobalCache({
                db,
                roomId,
                weekIndex: Number(weekIndex),
                nowMs,
                writeMode: "global",
                dryRun: false,
              });

              const freshAfterComputeSnap = await weekRef.get();
              const freshAfterCompute = freshAfterComputeSnap.exists
                ? (freshAfterComputeSnap.data() || {})
                : {};

              if (freshAfterCompute.status === "final") {
                const holdPollAtMs = getRegularFinalHoldPollAtMs(freshAfterCompute, nowMs);
                console.log("[pollLiveTournamentWeeks] regular global finalization catch-up", {
                  roomId,
                  weekIndex,
                  endAtMs,
                  nowMs,
                  pastPostWindow:
                    Boolean(result?.weekResultPayload?.pastPostWindow) ||
                    (Number.isFinite(endAtMs) && endAtMs > 0 && nowMs >= endAtMs + TOURNAMENT_POST_MS),
                  forcedFinalByExpiredWindow: Boolean(result?.weekResultPayload?.forcedFinalByExpiredWindow),
                  holdPollAtMs,
                });

                if (holdPollAtMs <= nowMs) {
                  const nextIdx = await autoAdvanceWeekIfFinal({
                    roomId,
                    room,
                    currentWeekIndex: weekIndex,
                    apiKey,
                  });

                  if (nextIdx === "COMPLETE") continue;
                  if (nextIdx) continue;
                }

                const finalized = await putRegularFinalWeekToHoldIfNeeded({
                  roomId,
                  roomRef,
                  weekRef,
                  roomData: room,
                  competitionState,
                  phase: phase || "RegularSeason",
                  nowMs,
                });
                if (finalized) continue;
              }
            } else {
              console.log(`[pollLiveTournamentWeeks] regular legacy scorer room=${roomId}`, {
                roomId,
                weekIndex,
                reason: "finalization",
              });

              await computeAndWriteLiveWeek({
                roomId,
                weekIndex: Number(weekIndex),
                apiKey,
              });
            }

            const finalized = await putRegularFinalWeekToHoldIfNeeded({
              roomId,
              roomRef,
              weekRef,
              roomData: room,
              competitionState,
              phase: phase || "RegularSeason",
              nowMs,
            });
            if (finalized) continue;

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
                ...buildTournamentPollDebugLabels(
                  room,
                  sleepInfo.nextPollAtMs,
                  sleepInfo.nextKickoffMs
                ),
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
        let regularGlobalResult = null;
        if (useRegularGlobalAggregator) {
          console.log(`[pollLiveTournamentWeeks] regular global aggregator room=${roomId}`, {
            roomId,
            weekIndex,
            reason: "active-window",
          });

          await refreshRegularGlobalCacheForRoom({
            roomId,
            room,
            week,
            apiKey,
            nowMs,
            reason: "active-window",
          });

          regularGlobalResult = await computeRegularWeekFromGlobalCache({
            db,
            roomId,
            weekIndex: Number(weekIndex),
            nowMs,
            writeMode: "global",
            dryRun: false,
          });
        } else {
          console.log(`[pollLiveTournamentWeeks] regular legacy scorer room=${roomId}`, {
            roomId,
            weekIndex,
            reason: "active-window",
          });

          await computeAndWriteLiveWeek({
            roomId,
            weekIndex: Number(weekIndex),
            apiKey,
          });
        }

        if (useRegularGlobalAggregator && regularGlobalResult) {
          const resultStatus = String(
            regularGlobalResult?.weekStatus ||
            regularGlobalResult?.weekResultPayload?.status ||
            ""
          ).toLowerCase();
          const resultNextKickoffMs = Number(
            regularGlobalResult?.weekResultPayload?.nextKickoffMs ||
            regularGlobalResult?.nextKickoffMs ||
            0
          );
          const resultNextPollAtMs = Number(regularGlobalResult?.nextPollAtMs || 0);
          const resultFixtureCoverage = Array.isArray(regularGlobalResult?.fixtureCoverage)
            ? regularGlobalResult.fixtureCoverage
            : [];
          const resultAnyInPlay = resultFixtureCoverage.some((coverage) =>
            isInPlay(coverage?.statusShort || coverage?.fixtureStatus || coverage?.matchStatus || "")
          );
          const fixtureStatuses = resultFixtureCoverage.map((coverage) => ({
            fixtureId: coverage?.fixtureId || null,
            statusShort:
              coverage?.statusShort ||
              coverage?.fixtureStatus ||
              coverage?.matchStatus ||
              null,
          }));
          const computedNextKickoffMs =
            Number.isFinite(resultNextKickoffMs) && resultNextKickoffMs > nowMs
              ? resultNextKickoffMs
              : null;
          const scheduledNextKickoffMs = computedNextKickoffMs || sleepInfo.nextKickoffMs || null;
          const scheduledNextPollAtMs =
            Number.isFinite(resultNextPollAtMs) && resultNextPollAtMs > nowMs
              ? resultNextPollAtMs
              : scheduledNextKickoffMs
                ? getNextPollAtMsFromFixtures(
                    [{ fixtureId: "regular-week", kickoffMs: scheduledNextKickoffMs }],
                    nowMs
                  ).nextPollAtMs
                : sleepInfo.nextPollAtMs;

          if (resultStatus === "final") {
            const finalized = await putRegularFinalWeekToHoldIfNeeded({
              roomId,
              roomRef,
              weekRef,
              roomData: room,
              competitionState,
              phase: phase || "RegularSeason",
              nowMs,
            });
            const fallbackNextPollAtMs = getRegularFinalHoldPollAtMs(
              { finalizedAtMs: nowMs },
              nowMs
            );

            console.log("[pollLiveTournamentWeeks] global active result scheduling", {
              roomId,
              weekIndex,
              resultStatus,
              nextKickoffMs: null,
              nextPollAtMs: finalized ? null : fallbackNextPollAtMs,
              reason: finalized ? "regular-global-final-hold" : "regular-global-final-hold-fallback",
            });

            if (!finalized) {
              await Promise.all([
                upsertTournamentPollTask({
                  roomId,
                  phase: phase || "RegularSeason",
                  nextPollAtMs: fallbackNextPollAtMs,
                  reason: "regular-global-final-hold-fallback",
                  nowMs,
                }),
                setCompetitionState(
                  roomRef,
                  {
                    weekStatus: "scheduled",
                    nextPollAtMs: fallbackNextPollAtMs,
                    nextKickoffMs: null,
                    ...buildTournamentPollDebugLabels(room, fallbackNextPollAtMs, null),
                  },
                  {
                    roomData: { ...room, competitionState },
                    nowMs,
                  }
                ),
              ]);
            }

            continue;
          }

          if (resultStatus === "idle" && hasActiveFixture) {
            const nextPollAtMs = nowMs + TOURNAMENT_ACTIVE_POLL_MS;
            await Promise.all([
              setCompetitionState(
                roomRef,
                {
                  weekStatus: "live",
                  nextKickoffMs: null,
                  nextPollAtMs,
                  ...buildTournamentPollDebugLabels(room, nextPollAtMs, null),
                },
                {
                  roomData: { ...room, competitionState },
                  nowMs,
                }
              ),
              upsertTournamentPollTask({
                roomId,
                phase: "RegularSeason",
                nextPollAtMs,
                reason: "regular-global-idle-but-active-fixture-window",
                nowMs,
              }),
            ]);

            console.log("[pollLiveTournamentWeeks] regular global idle but active fixture window", {
              roomId,
              weekIndex,
              resultStatus,
              activeFixtureIds,
              nextPollAtMs,
            });

            continue;
          }

          if (resultStatus === "idle" && !hasActiveFixture) {
            console.log("[pollLiveTournamentWeeks] global active result scheduling", {
              roomId,
              weekIndex,
              resultStatus,
              resultAnyInPlay,
              fixtureStatuses,
              nextKickoffMs: scheduledNextKickoffMs,
              nextPollAtMs: scheduledNextPollAtMs,
              reason: "regular-global-idle-after-compute",
            });

            await Promise.all([
              upsertTournamentPollTask({
                roomId,
                phase: phase || "RegularSeason",
                nextPollAtMs: scheduledNextPollAtMs,
                reason: "regular-global-idle-after-compute",
                nowMs,
              }),
              setCompetitionState(
                roomRef,
                {
                  weekStatus: "scheduled",
                  nextPollAtMs: scheduledNextPollAtMs,
                  nextKickoffMs: scheduledNextKickoffMs,
                  ...buildTournamentPollDebugLabels(
                    room,
                    scheduledNextPollAtMs,
                    scheduledNextKickoffMs
                  ),
                },
                {
                  roomData: { ...room, competitionState },
                  nowMs,
                }
              ),
            ]);

            continue;
          }
        }

        const finalized = await putRegularFinalWeekToHoldIfNeeded({
          roomId,
          roomRef,
          weekRef,
          roomData: room,
          competitionState,
          phase: phase || "RegularSeason",
          nowMs,
        });
        if (finalized) continue;

        if (useRegularGlobalAggregator && regularGlobalResult) {
          const resultStatus = String(
            regularGlobalResult?.weekStatus ||
            regularGlobalResult?.weekResultPayload?.status ||
            ""
          ).toLowerCase();
          const resultFixtureCoverage = Array.isArray(regularGlobalResult?.fixtureCoverage)
            ? regularGlobalResult.fixtureCoverage
            : [];
          const resultAnyInPlay = resultFixtureCoverage.some((coverage) =>
            isInPlay(coverage?.statusShort || coverage?.fixtureStatus || coverage?.matchStatus || "")
          );

          console.warn("[pollLiveTournamentWeeks] global result fell through to active polling", {
            roomId,
            weekIndex,
            resultStatus,
            resultAnyInPlay,
          });
        }

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
              nextKickoffMs: null,
              ...buildTournamentPollDebugLabels(
                room,
                nowMs + TOURNAMENT_ACTIVE_POLL_MS,
                null
              ),
            },
            {
              roomData: { ...room, competitionState },
              nowMs,
            }
          ),
        ]);
      } catch (e) {
        const apiFootballGuarded = isApiFootballCooldownError(e);
        const retryAtMs = apiFootballGuarded
          ? getApiFootballCooldownRetryAtMs(e, nowMs)
          : nowMs + TOURNAMENT_UNKNOWN_RECHECK_MS;
        const retryReason = apiFootballGuarded
          ? apiFootballCooldownReason(e)
          : `error: ${String(e?.message || e).slice(0, 120)}`;

        console.error(`Error processing room ${roomId}`, {
          code: e?.code,
          message: e?.message,
          apiFootballGuarded,
          retryAtMs,
        });

        // Avoid hammering a broken room every minute.
        await upsertTournamentPollTask({
          roomId,
          phase: "",
          nextPollAtMs: retryAtMs,
          reason: retryReason,
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
  if (!room.started) {
    requireDraftManagerCount(memberUids, room);
    if (getDraftOrderMode(room) === "custom") {
      validateCustomDraftOrderForMembers(room.customDraftOrder, memberUids);
    }
  }

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

const MARKET_ONE_TIME_MODE = "oneTime";
const MARKET_RECURRING_MODE = "recurring";
const MARKET_RECURRING_TZ = "America/Los_Angeles";
const MARKET_RECURRING_MAX_DURATION_MS =
  (22 * 60 * 60 * 1000) + (59 * 60 * 1000);

const MARKET_WEEKDAY_NAMES = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

function normalizeMarketScheduleMode(value) {
  return value === MARKET_RECURRING_MODE
    ? MARKET_RECURRING_MODE
    : MARKET_ONE_TIME_MODE;
}

function normalizeRecurringDays(value) {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((day) => Number(day))
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    )
  ).sort((a, b) => a - b);
}

function parseRecurringTime(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
    label: `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`,
  };
}

function getZonedParts(ms, timeZone = MARKET_RECURRING_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));

  const byType = {};
  for (const part of parts) {
    byType[part.type] = part.value;
  }

  return {
    weekday: MARKET_WEEKDAY_NAMES[byType.weekday],
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
  };
}

function zonedLocalTimeToUtcMs({
  timeZone = MARKET_RECURRING_TZ,
  year,
  month,
  day,
  hour,
  minute,
}) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  for (let i = 0; i < 3; i += 1) {
    const parts = getZonedParts(utcMs, timeZone);
    const renderedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0
    );
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    utcMs += targetAsUtc - renderedAsUtc;
  }

  return utcMs;
}

function getNextRecurringMarketAtMs({
  days,
  recurringTime,
  afterMs = Date.now(),
  timeZone = MARKET_RECURRING_TZ,
}) {
  const cleanDays = normalizeRecurringDays(days);
  const parsedTime = parseRecurringTime(recurringTime);

  if (!cleanDays.length || !parsedTime) return null;

  const localNow = getZonedParts(afterMs, timeZone);

  for (let offset = 0; offset <= 14; offset += 1) {
    const localNoonUtc = Date.UTC(
      localNow.year,
      localNow.month - 1,
      localNow.day + offset,
      12,
      0,
      0,
      0
    );
    const localDate = getZonedParts(localNoonUtc, timeZone);

    if (!cleanDays.includes(localDate.weekday)) continue;

    const candidateMs = zonedLocalTimeToUtcMs({
      timeZone,
      year: localDate.year,
      month: localDate.month,
      day: localDate.day,
      hour: parsedTime.hour,
      minute: parsedTime.minute,
    });

    if (candidateMs > afterMs + 30 * 1000) {
      return candidateMs;
    }
  }

  return null;
}

function getSafeMarketTimeZone(room = {}, fallback = MARKET_RECURRING_TZ) {
  const candidate = String(getRoomTimeZone(room) || fallback || MARKET_RECURRING_TZ).trim();

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_) {
    return MARKET_RECURRING_TZ;
  }
}

async function deletePendingMarketRemindersForRoom(roomId, batch) {
  const snap = await db
    .collection("reminders")
    .where("roomId", "==", String(roomId))
    .where("type", "==", "market_10min")
    .where("sentAt", "==", null)
    .get();

  snap.forEach((docSnap) => {
    batch.delete(docSnap.ref);
  });

  return snap.size;
}

/**
 * Market scheduling: writes schedule to rooms/{roomId}/market/current
 * + NEW: creates a "market_10min" reminder doc
 */
exports.scheduleMarket = onCall({ region: "us-west2" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");

  const data = request.data || {};
  const roomId = String(data.roomId || "").trim();
  const scheduleMode = normalizeMarketScheduleMode(data.scheduleMode);
  const durationMs = Number(data.durationMs || 0);

  if (!roomId || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw new HttpsError("invalid-argument", "Missing roomId/durationMs.");
  }

  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Room not found.");

  const room = snap.data() || {};
  if (room.hostUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "Only host can schedule.");
  }

  const timezone = getSafeMarketTimeZone(room);

  let scheduledAtMs = Number(data.scheduledAtMs || 0);
  let recurringDays = [];
  let recurringTime = "";

  if (scheduleMode === MARKET_RECURRING_MODE) {
    recurringDays = normalizeRecurringDays(data.recurringDays);
    const parsedTime = parseRecurringTime(data.recurringTime);

    if (!recurringDays.length) {
      throw new HttpsError("invalid-argument", "Pick at least one recurring market day.");
    }

    if (!parsedTime) {
      throw new HttpsError("invalid-argument", "Recurring market time must use HH:mm format.");
    }

    if (durationMs > MARKET_RECURRING_MAX_DURATION_MS) {
      throw new HttpsError(
        "invalid-argument",
        "Recurring market duration cannot be longer than 22 hours and 59 minutes."
      );
    }

    recurringTime = parsedTime.label;
    scheduledAtMs = getNextRecurringMarketAtMs({
      days: recurringDays,
      recurringTime,
      afterMs: Date.now(),
      timeZone: timezone,
    });
  } else if (!Number.isFinite(scheduledAtMs) || scheduledAtMs <= 0) {
    throw new HttpsError("invalid-argument", "Missing scheduledAtMs.");
  }

  if (!Number.isFinite(scheduledAtMs) || scheduledAtMs <= 0) {
    throw new HttpsError("failed-precondition", "Could not calculate the next market opening time.");
  }


  // ✅ NOW it's safe to use room + the input vars
  const tz = timezone;
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

  if (oldMarketReminderId) {
    batch.delete(db.doc(`reminders/${oldMarketReminderId}`));
  }

  // Strong cleanup: delete all old pending market reminders for this room.
  // This prevents old reminder emails from firing after rescheduling.
  await deletePendingMarketRemindersForRoom(roomId, batch);

  batch.set(newMarketReminderRef, {
    type: "market_10min",
    roomId,
    sendAtMs: reminderSendAtMs,
    scheduledAtMs: Number(scheduledAtMs),
    durationMs: Number(durationMs),
    scheduleMode,
    recurringDays,
    recurringTime,
    timezone,
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
      tieBreakSeed: admin.firestore.FieldValue.delete(),
      tieBreakMode: admin.firestore.FieldValue.delete(),
      priorityMode: admin.firestore.FieldValue.delete(),
      marketReminderId: newMarketReminderRef.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      scheduleMode,
      recurringDays,
      recurringTime,
      timezone,
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
      nextAttemptAtMs: Number(scheduledAtMs),
      lastAttemptAtMs: null,
      attemptCount: 0,
      lastError: null,
      lastErrorAtMs: null,
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      scheduleMode,
      recurringDays,
      recurringTime,
      timezone,
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
        const marketSnap = await db
          .doc(`rooms/${r.roomId}/market/current`)
          .get();

        const currentMarket = marketSnap.exists ? marketSnap.data() || {} : {};
        const currentReminderId = String(currentMarket.marketReminderId || "");
        const currentScheduledAt = Number(currentMarket.scheduledAt || 0);
        const reminderScheduledAt = Number(r.scheduledAtMs || 0);

        const reminderStillCurrent =
          currentReminderId === docSnap.id &&
          currentMarket.status === "scheduled" &&
          Number.isFinite(currentScheduledAt) &&
          currentScheduledAt === reminderScheduledAt;

        if (!reminderStillCurrent) {
          await docSnap.ref.update({
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            skippedAtMs: now,
            skippedReason: "stale-market-reminder",
          });
          continue;
        }
        const openStr = formatWhen(
          r.scheduledAtMs,
          currentMarket.timezone || r.timezone || DEFAULT_TZ
        );
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
const MARKET_QUEUE_MAX_ATTEMPTS = 5;
const MARKET_QUEUE_RETRY_DELAYS_MS = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
];

function getMarketQueueRetryDelayMs(attemptCount) {
  const index = Math.max(
    0,
    Math.min(MARKET_QUEUE_RETRY_DELAYS_MS.length - 1, Number(attemptCount || 1) - 1)
  );
  return MARKET_QUEUE_RETRY_DELAYS_MS[index];
}

async function markMarketQueueCompleted(taskDoc, now, reason = "resolved") {
  await taskDoc.ref.set(
    {
      status: "completed",
      completedAtMs: now,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      completionReason: reason,
      nextAttemptAtMs: admin.firestore.FieldValue.delete(),
      lastError: null,
      lastErrorAtMs: null,
      updatedAtMs: now,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function recordMarketQueueFailure({
  taskDoc,
  marketRef,
  task,
  roomId,
  error,
  now,
}) {
  const attemptCount = Number(task?.attemptCount || 0) + 1;
  const paused = attemptCount >= MARKET_QUEUE_MAX_ATTEMPTS;
  const lastError = String(error?.message || error || "Market resolution failed.").slice(0, 1000);
  const nextAttemptAtMs = paused
    ? admin.firestore.FieldValue.delete()
    : now + getMarketQueueRetryDelayMs(attemptCount);

  await Promise.all([
    marketRef.set(
      {
        status: "resolving",
        marketQueueStatus: paused ? "paused_error" : "retry_scheduled",
        resolvingAt: now,
        lastResolveError: lastError,
        lastErrorAtMs: now,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    ),
    taskDoc.ref.set(
      {
        roomId,
        status: paused ? "paused_error" : "resolving",
        attemptCount,
        lastAttemptAtMs: now,
        lastError,
        lastErrorAtMs: now,
        nextAttemptAtMs,
        pausedAtMs: paused ? now : null,
        updatedAtMs: now,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    ),
  ]);

  console.warn("[processMarketSchedule] resolution attempt failed", {
    roomId,
    attemptCount,
    paused,
    nextAttemptAtMs,
    lastError,
  });
}
async function scheduleNextRecurringMarketAfterResolve({
  roomId,
  marketRef,
  taskDoc,
  market,
  task,
  now,
}) {
  const scheduleMode = normalizeMarketScheduleMode(
    market?.scheduleMode || task?.scheduleMode
  );

  if (scheduleMode !== MARKET_RECURRING_MODE) {
    await markMarketQueueCompleted(taskDoc, now, "market-resolved");
    return;
  }

  const recurringDays = normalizeRecurringDays(
    market?.recurringDays || task?.recurringDays
  );
  const recurringTime = String(
    market?.recurringTime || task?.recurringTime || ""
  ).trim();
  const durationMs = Number(market?.durationMs || task?.durationMs || 0);

  const roomRef = db.doc(`rooms/${roomId}`);
  const roomSnap = await roomRef.get();
  const room = roomSnap.exists ? roomSnap.data() || {} : {};

  let timezone = String(market?.timezone || task?.timezone || "").trim();
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    } catch (_) {
      timezone = "";
    }
  }
  if (!timezone) {
    timezone = getSafeMarketTimeZone(room);
  }

  if (
    !recurringDays.length ||
    !parseRecurringTime(recurringTime) ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs > MARKET_RECURRING_MAX_DURATION_MS
  ) {
    await markMarketQueueCompleted(taskDoc, now, "recurring-config-invalid");
    return;
  }

  const nextScheduledAtMs = getNextRecurringMarketAtMs({
    days: recurringDays,
    recurringTime,
    afterMs: now,
    timeZone: timezone,
  });

  if (!Number.isFinite(nextScheduledAtMs) || nextScheduledAtMs <= now) {
    await markMarketQueueCompleted(taskDoc, now, "recurring-next-not-found");
    return;
  }

  const memberUids = await getRoomMemberUids(roomRef, room);

  const reminderSendAtMs = nextScheduledAtMs - 10 * 60 * 1000;
  const newMarketReminderRef = db.collection("reminders").doc();

  const batch = db.batch();
  await deletePendingMarketRemindersForRoom(roomId, batch);

  batch.set(newMarketReminderRef, {
    type: "market_10min",
    roomId,
    sendAtMs: reminderSendAtMs,
    scheduledAtMs: nextScheduledAtMs,
    durationMs,
    scheduleMode: MARKET_RECURRING_MODE,
    recurringDays,
    recurringTime,
    timezone,
    recipientUids: memberUids,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    sentAt: null,
  });

  batch.set(
    marketRef,
    {
      roomId,
      status: "scheduled",
      scheduledAt: nextScheduledAtMs,
      durationMs,
      scheduleMode: MARKET_RECURRING_MODE,
      recurringDays,
      recurringTime,
      timezone,
      openedAt: null,
      closesAt: null,
      resolvedAt: null,
      marketReminderId: newMarketReminderRef.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  batch.set(
    taskDoc.ref,
    {
      roomId,
      status: "scheduled",
      scheduledAt: nextScheduledAtMs,
      durationMs,
      scheduleMode: MARKET_RECURRING_MODE,
      recurringDays,
      recurringTime,
      timezone,
      openedAt: null,
      closesAt: null,
      resolvedAt: null,
      nextAttemptAtMs: nextScheduledAtMs,
      lastAttemptAtMs: null,
      attemptCount: 0,
      lastError: null,
      lastErrorAtMs: null,
      completedAtMs: admin.firestore.FieldValue.delete(),
      completedAt: admin.firestore.FieldValue.delete(),
      completionReason: admin.firestore.FieldValue.delete(),
      updatedAtMs: now,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await batch.commit();
}

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
    const runLegacySweep = new Date(now).getUTCMinutes() === 0;

    // ✅ Only read active market tasks.
    // No more scanning every room.
    const [dueQueueSnap, legacyQueueSnap] = await Promise.all([
      db.collection("marketQueue")
        .where("nextAttemptAtMs", "<=", now)
        .limit(100)
        .get(),
      runLegacySweep
        ? db.collection("marketQueue")
            .where("status", "in", ["scheduled", "open", "resolving"])
            .limit(100)
            .get()
        : Promise.resolve({ docs: [], size: 0 }),
    ]);
    const queueDocsById = new Map();
    for (const taskDoc of dueQueueSnap.docs) queueDocsById.set(taskDoc.id, taskDoc);
    for (const taskDoc of legacyQueueSnap.docs) queueDocsById.set(taskDoc.id, taskDoc);
    const queueDocs = Array.from(queueDocsById.values());

    if (queueDocs.length === 0) {
      console.log("[processMarketSchedule] no active market tasks");
      return;
    }

    console.log("[processMarketSchedule] active market tasks", {
      dueTasks: dueQueueSnap.size,
      legacySweepTasks: legacyQueueSnap.size || 0,
      uniqueTasks: queueDocs.length,
      runLegacySweep,
    });

    for (const taskDoc of queueDocs) {
      const task = taskDoc.data() || {};
      const roomId = String(task.roomId || taskDoc.id || "");
      const taskStatus = String(task.status || "").toLowerCase();
      const taskWakeAtMs = Number(
        task.nextAttemptAtMs ??
          (taskStatus === "scheduled"
            ? task.scheduledAt
            : taskStatus === "open"
              ? task.closesAt
              : 0)
      );

      if (!roomId) {
        console.warn("[processMarketSchedule] queue task missing roomId", taskDoc.id);
        continue;
      }

      if (Number.isFinite(taskWakeAtMs) && taskWakeAtMs > now) {
        continue;
      }

      const marketRef = db.doc(`rooms/${roomId}/market/current`);
      const marketSnap = await marketRef.get();

      if (!marketSnap.exists) {
        console.warn("[processMarketSchedule] market doc missing, pausing queue task", {
          roomId,
          queueId: taskDoc.id,
        });

        await taskDoc.ref.set(
          {
            status: "paused_error",
            attemptCount: MARKET_QUEUE_MAX_ATTEMPTS,
            lastAttemptAtMs: now,
            lastError: "Market document is missing.",
            lastErrorAtMs: now,
            nextAttemptAtMs: admin.firestore.FieldValue.delete(),
            pausedAtMs: now,
            updatedAtMs: now,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        continue;
      }

      const m = marketSnap.data() || {};
      const status = String(m.status || task.status || "idle").toLowerCase();

      if (!["scheduled", "open", "resolving"].includes(status)) {
        await markMarketQueueCompleted(taskDoc, now, `market-status-${status || "idle"}`);
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
              nextAttemptAtMs: computedClosesAt,
              lastAttemptAtMs: now,
              attemptCount: 0,
              lastError: null,
              lastErrorAtMs: null,
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
              nextAttemptAtMs: computedClosesAt,
              lastAttemptAtMs: now,
              attemptCount: 0,
              lastError: null,
              lastErrorAtMs: null,
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
          await taskDoc.ref.set(
            {
              lastAttemptAtMs: now,
              updatedAtMs: now,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          const result = await resolveMarketForRoom(roomId, { trigger: "scheduler" });
          if (result?.ok !== true) {
            throw new Error(`Market resolution did not complete: ${result?.reason || "unknown"}`);
          }

          // ✅ Done. Remove queue task so this room is not checked anymore.
        } catch (e) {
          console.error("resolveMarketForRoom failed", roomId, e);

          await recordMarketQueueFailure({
            taskDoc,
            marketRef,
            task,
            roomId,
            error: e,
            now,
          });
          continue;
        }

        await scheduleNextRecurringMarketAfterResolve({
          roomId,
          marketRef,
          taskDoc,
          market: m,
          task,
          now,
        }).catch((error) => {
          console.error("[processMarketSchedule] failed to schedule next recurring market", {
            roomId,
            message: error?.message,
          });
        });
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
            await taskDoc.ref.set(
              {
                lastAttemptAtMs: now,
                updatedAtMs: now,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            const result = await resolveMarketForRoom(roomId, { trigger: "scheduler-retry" });
            if (result?.ok !== true) {
              throw new Error(`Market retry did not complete: ${result?.reason || "unknown"}`);
            }

            // ✅ Done. Remove queue task.
          } catch (e) {
            console.error("resolveMarketForRoom retry failed", roomId, e);

            await recordMarketQueueFailure({
              taskDoc,
              marketRef,
              task,
              roomId,
              error: e,
              now,
            });
            continue;
          }

          await scheduleNextRecurringMarketAfterResolve({
            roomId,
            marketRef,
            taskDoc,
            market: m,
            task,
            now,
          }).catch((error) => {
            console.error("[processMarketSchedule] failed to schedule next recurring market", {
              roomId,
              message: error?.message,
            });
          });
          continue;
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
  const generatedTieBreakSeed =
    `${roomId}-${now}-${Math.random().toString(16).slice(2)}`;

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

    const tieBreakSeed = String(
      m.tieBreakSeed || generatedTieBreakSeed
    );

    tx.set(
      marketRef,
      {
        status: "resolving",
        resolveLock: lockId,
        resolvingAt: now,
        tieBreakSeed,
        tieBreakMode: "seeded-random",
        priorityMode: "standings-then-random",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true, tieBreakSeed };
  });

  if (!locked.ok) return locked;
  const tieBreakSeed = String(locked.tieBreakSeed || generatedTieBreakSeed);
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

  function buildDecision(r, status, reason, extra = {}) {
    return {
      uid: r.uid,
      wantId: r.wantId,
      swapOutId: r.swapOutId,
      status,
      reason,
      ...extra,
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

    const activeWorldCupLock = isWorldCupDailyLineupRoom(room)
      ? getActiveWorldCupDailyLocks(lineupByUid.get(r.uid) || {}, now)[r.swapOutId]
      : null;
    if (activeWorldCupLock) {
      decisions.push(
        buildDecision(r, "lost", "WORLD_CUP_STARTER_LOCKED", {
          lockedUntilMs: Number(activeWorldCupLock.lockedUntilMs || 0),
          reasonMessage:
            `Player is locked by World Cup Group Stage lineup lock until ${formatWorldCupDailyLockDate(activeWorldCupLock)}.`,
        })
      );
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
    const priorityRows = list.map((request) => {
      const priority = getPriority(standingsByUid, request.uid);
      return {
        ...request,
        priority,
        randomTieValue: seededTieValue(
          `${roomId}:${wantId}:${now}`,
          wantId,
          request.uid
        ),
      };
    });

    priorityRows.sort((a, b) => {
      const cmp = comparePriority(a.priority, b.priority);
      if (cmp !== 0) return cmp;

      // Same priority: random seeded tiebreaker.
      if (a.randomTieValue !== b.randomTieValue) {
        return a.randomTieValue - b.randomTieValue;
      }

      return String(a.uid).localeCompare(String(b.uid));
    });

    const winner = priorityRows[0];
    decisions.push(
      buildDecision(winner, "won", "AWARDED", {
        priority: winner.priority,
        randomTieValue: winner.randomTieValue,
        tieBrokenRandomly:
          priorityRows.length > 1 &&
          comparePriority(priorityRows[0].priority, priorityRows[1].priority) === 0,
      })
    );

    for (let i = 1; i < priorityRows.length; i++) {
      const loser = priorityRows[i];

      const tiedWithWinner =
        comparePriority(loser.priority, winner.priority) === 0;

      decisions.push(
        buildDecision(
          loser,
          "lost",
          tiedWithWinner ? "TIE_RANDOM_LOST" : "WANT_NOT_AVAILABLE",
          {
            priority: loser.priority,
            winnerUid: winner.uid,
            winnerPriority: winner.priority,
            randomTieValue: loser.randomTieValue,
            winnerRandomTieValue: winner.randomTieValue,
            tieBrokenRandomly: tiedWithWinner,
          }
        )
      );
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
      reasonMessage:
        normalizedReason === "TIE_RANDOM_LOST"
          ? "Not awarded — same priority as the winner, but lost the random tiebreaker."
          : null,
      priority: dec.priority || null,
      winnerUid: dec.winnerUid || null,
      winnerPriority: dec.winnerPriority || null,
      randomTieValue: dec.randomTieValue ?? null,
      winnerRandomTieValue: dec.winnerRandomTieValue ?? null,
      tieBrokenRandomly: dec.tieBrokenRandomly === true,
      lockedUntilMs: dec.lockedUntilMs || null,
      tieBreakMode: "seeded-random",
      priorityMode: "standings-then-random",
      tieBreakSeed,
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
      tieBreakSeed,
      tieBreakMode: "seeded-random",
      priorityMode: "standings-then-random",
      lastResolveSummary: {
        interestDocs: interestSnap.size,
        requestCount: requests.length,
        decisionCount: decisions.length,
        wonCount,
        resolvedAtMs: now,
        tieBreakSeed,
        tieBreakMode: "seeded-random",
        priorityMode: "standings-then-random",
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
    tieBreakMode: "seeded-random",
  });
  await batch.commit();

  const affectedUids = new Set(
    decisions
      .filter((decision) => decision.status === "won")
      .map((decision) => String(decision.uid || "").trim())
      .filter(Boolean)
  );
  const lineupRepairs = [];
  const lineupRepairErrors = [];
  for (const targetUid of affectedUids) {
    try {
      lineupRepairs.push(
        await repairUserLineupFromCurrentPicks({
          db,
          roomId,
          targetUid,
          nowMs: now,
          dryRun: false,
          reason: "transfer-market-resolved",
        })
      );
    } catch (error) {
      console.error("[resolveMarketForRoom] lineup repair failed", {
        roomId,
        targetUid,
        code: error?.code,
        message: error?.message,
      });
      lineupRepairErrors.push({
        targetUid,
        code: error?.code || "unknown",
        message: error?.message || String(error),
      });
    }
  }

  return {
    ok: true,
    resolvedCount: decisions.length,
    tieBreakMode: "seeded-random",
    priorityMode: "standings-then-random",
    affectedUidCount: affectedUids.size,
    lineupRepairCount: lineupRepairs.length,
    lineupRepairErrors,
  };
}

exports.resolveMarketNow = onCall({ region: "us-west2" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const roomId = req.data?.roomId;
  if (!roomId) throw new HttpsError("invalid-argument", "roomId required.");
  return await resolveMarketForRoom(roomId, { trigger: "manual" });
});

exports.submitSupportMessage = onCall(
  {
    region: "us-west2",
    secrets: [SUPPORT_EMAIL_USER, SUPPORT_EMAIL_PASS, SUPPORT_TO_EMAIL],
    maxInstances: 5,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "You must be signed in to send feedback."
      );
    }

    const uid = request.auth.uid;
    const email = request.auth.token.email || "";
    const name =
      request.auth.token.name ||
      request.auth.token.email ||
      "Unknown user";

    const {
      type = "other",
      typeLabel = "Other",
      message = "",
      pageUrl = "",
      userAgent = "",
    } = request.data || {};

    const cleanMessage = String(message || "").trim();
    const cleanType = String(type || "other").trim().slice(0, 40);
    const cleanTypeLabel = String(typeLabel || "Other").trim().slice(0, 80);
    const cleanPageUrl = String(pageUrl || "").trim().slice(0, 500);
    const cleanUserAgent = String(userAgent || "").trim().slice(0, 500);

    if (cleanMessage.length < 10) {
      throw new HttpsError(
        "invalid-argument",
        "Message must be at least 10 characters."
      );
    }

    if (cleanMessage.length > 2000) {
      throw new HttpsError(
        "invalid-argument",
        "Message must be under 2,000 characters."
      );
    }

    const now = Date.now();

    const docRef = await db.collection("supportMessages").add({
      uid,
      email,
      name,
      type: cleanType,
      typeLabel: cleanTypeLabel,
      message: cleanMessage,
      pageUrl: cleanPageUrl,
      userAgent: cleanUserAgent,
      status: "new",
      source: "support_page",
      createdAtMs: now,
      createdAt: FieldValue.serverTimestamp(),
    });

    const emailUser = SUPPORT_EMAIL_USER.value();
    const emailPass = SUPPORT_EMAIL_PASS.value();
    const supportToEmail = SUPPORT_TO_EMAIL.value();

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: emailUser,
        pass: emailPass,
      },
    });

    const subject = `Fútbol Fantasy Support: ${cleanTypeLabel}`;

    const text = [
      "New Fútbol Fantasy Support Message",
      "",
      `Type: ${cleanTypeLabel}`,
      `Name: ${name}`,
      `Email: ${email}`,
      `UID: ${uid}`,
      `Message ID: ${docRef.id}`,
      "",
      "Message:",
      cleanMessage,
      "",
      "User Agent:",
      cleanUserAgent || "Not provided",
    ].join("\n");

    try {
      await transporter.sendMail({
        from: `"Fútbol Fantasy Support" <${emailUser}>`,
        to: supportToEmail,
        replyTo: email || emailUser,
        subject,
        text,
      });

      await docRef.update({
        emailStatus: "sent",
        emailedAtMs: Date.now(),
        emailedAt: FieldValue.serverTimestamp(),
      });

      logger.info("Support message sent", {
        messageId: docRef.id,
        uid,
        type: cleanType,
      });

      return {
        ok: true,
        messageId: docRef.id,
      };
    } catch (err) {
      logger.error("Support email failed", err);

      await docRef.update({
        emailStatus: "failed",
        emailError: String(err?.message || err).slice(0, 500),
        emailFailedAtMs: Date.now(),
        emailFailedAt: FieldValue.serverTimestamp(),
      });

      throw new HttpsError(
        "internal",
        "Your message was saved, but the email failed to send."
      );
    }
  }
);
