// web/src/firebase.js
import { initializeApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  onAuthStateChanged,
  updateProfile,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  runTransaction,
  serverTimestamp,
  updateDoc,
  onSnapshot,
} from "firebase/firestore";
import { collection, getDocs, query, where, addDoc } from "firebase/firestore";
import { writeBatch } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getAnalytics , isSupported, logEvent } from "firebase/analytics";
import { setLogLevel } from "firebase/firestore";

//setLogLevel("debug");

//Player pool to FireStore
export async function seedRoomPlayers(roomId, players) {
  if (!roomId) throw new Error("Missing roomId");
  if (!Array.isArray(players) || players.length === 0) return;

  const batch = writeBatch(db);

  for (const p of players) {
    const id = String(p.id);
    const ref = doc(db, "rooms", roomId, "players", id);
    batch.set(ref, { ...p, id }, { merge: true });
  }

  await batch.commit();
}

/* =========================
   Firebase App Config
   =========================
*/
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || undefined,
};

// Dev vs Prod base URL for magic link redirect
const ORIGIN = (typeof window !== "undefined" && window.location.origin) || "";
const IS_LOCAL = ORIGIN.includes("localhost") || ORIGIN.includes("127.0.0.1");
const PROD_URL = "https://futbol-fantasy.com";
export const WEB_BASE_URL = IS_LOCAL ? "http://localhost:5173" : PROD_URL;

// Init
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const functions = getFunctions(app, "us-west2");

//Analytics
export let analytics = null;
isSupported().then((ok) => {
  if (ok) analytics = getAnalytics(app);
});
// Safe wrapper for logging events (works even if analytics isn't ready yet)
export function logAnalyticsEvent(name, params = {}) {
  try {
    if (!analytics) return;
    logEvent(analytics, name, params);
  } catch (e) {
    // ignore analytics errors in production
  }
}

export function logPageView({ page_path, page_title } = {}) {
  try {
    if (!analytics) return;

    const fullPath = page_path || (window.location.pathname + window.location.search);
    const fullUrl = window.location.href;

    logEvent(analytics, "page_view", {
      page_location: fullUrl,
      page_path: fullPath,
      page_title: page_title || document.title || "Futbol Fantasy",
    });
  } catch (e) {
    // ignore
  }
}

//User Pictures
export async function uploadUserAvatar(uid, file) {
  if (!uid) throw new Error("Missing uid");
  if (!file) throw new Error("No file selected");

  const allowed = ["image/png", "image/jpeg", "image/webp"];
  if (!allowed.includes(file.type)) throw new Error("Please upload a PNG, JPG, or WEBP.");
  if (file.size > 2 * 1024 * 1024) throw new Error("Max file size is 2MB.");

  const storage = getStorage(app);

  const ext =
    file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";

  // Overwrite so you don’t store infinite avatars
  const avatarRef = ref(storage, `userAvatars/${uid}/avatar.${ext}`);

  await uploadBytes(avatarRef, file, {
    contentType: file.type,
    cacheControl: "public,max-age=86400",
  });

  const photoURL = await getDownloadURL(avatarRef);

  // Save to Firestore profile doc so your app can show it everywhere
  await setDoc(
    doc(db, "users", uid),
    { photoURL, updatedAt: serverTimestamp() },
    { merge: true }
  );

  return photoURL;
}
/* =========================
   “Remember me” preference
   ========================= */
const REMEMBER_KEY = "remember_me";

export function getRememberMe() {
  try {
    return localStorage.getItem(REMEMBER_KEY) !== "0";
  } catch {
    return true; // default to remember
  }
}
export function setRememberMe(value) {
  try {
    localStorage.setItem(REMEMBER_KEY, value ? "1" : "0");
  } catch {}
}

export async function choosePersistenceFromPref() {
  const remember = getRememberMe();
  await setPersistence(
    auth,
    remember ? browserLocalPersistence : browserSessionPersistence
  );
}

// Google Sign In
const googleProvider = new GoogleAuthProvider();
// optional: forces account chooser each time
googleProvider.setCustomParameters({ prompt: "select_account" });

export async function signInWithGoogleWithPref() {
  await choosePersistenceFromPref();

  const provider = new GoogleAuthProvider();
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

  // iOS Safari: always use redirect (most reliable)
  if (isIOS) {
    await signInWithRedirect(auth, provider);
    return null;
  }

  // Desktop: popup (fallback to redirect if blocked)
  try {
    return await signInWithPopup(auth, provider);
  } catch (e) {
    if (e?.code === "auth/popup-blocked" || e?.code === "auth/popup-closed-by-user") {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw e;
  }
}

// Call this once on app load (e.g., App.jsx useEffect) to complete redirect flow
export async function completeGoogleRedirectIfAny() {
  try {
    //const res = await getRedirectResult(auth);
    //return res || null;
    await getRedirectResult(auth);
  } catch (e) {
    // ignore if no redirect is pending
    if (e?.code === "auth/no-auth-event") return null;
    throw e;
  }
}


/* =========================
   Magic link auth helpers
   ========================= */
export async function sendMagicLinkWithPref(email) {
  await choosePersistenceFromPref();

  // store the email only if remember-me is on
  if (getRememberMe()) {
    localStorage.setItem("magicLinkEmail", email);
  } else {
    localStorage.removeItem("magicLinkEmail");
  }

  const actionCodeSettings = {
    url: `${WEB_BASE_URL}/signin`,
    handleCodeInApp: true,
  };
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
}
export async function sendMagicLink(email) {
  const actionCodeSettings = {
    url: window.location.origin + "/signin",
    handleCodeInApp: true,
  };
  localStorage.setItem("magicLinkEmail", email);
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
}

export async function completeRedirectIfAny() {
  if (isSignInWithEmailLink(auth, window.location.href)) {
    let email = localStorage.getItem("magicLinkEmail");
    if (!email) {
      email = window.prompt("Confirm your email to finish sign-in:");
    }
    await signInWithEmailLink(auth, email, window.location.href);
    if (!getRememberMe()) localStorage.removeItem("magicLinkEmail");
  }
}

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function signOutNow() {
  await signOut(auth);
}

/* =========================
   User profile helpers
   ========================= */
export async function saveDisplayName(uid, displayName) {
  const ref = doc(db, "users", uid);
  await setDoc(
    ref,
    { displayName, updatedAt: serverTimestamp() },
    { merge: true }
  );
  try {
    if (auth.currentUser?.uid === uid) {
      await updateProfile(auth.currentUser, { displayName });
    }
  } catch {
    // non-fatal
  }
}

export async function getUserProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

export function watchUserProfile(uid, cb) {
  if (!uid) return () => {};
  const ref = doc(db, "users", uid);
  return onSnapshot(ref, (s) => cb(s.exists() ? s.data() : null)
);
}

/* =========================
   Room helpers
   ========================= */
export function setLastRoomId(roomId) {
  if (roomId){
    localStorage.setItem("lastRoomId", roomId);
    window.dispatchEvent(new Event("lastRoomIdChanged"));
  } 
}
export function getLastRoomId() {
  return localStorage.getItem("lastRoomId");
}

export async function joinRoom(roomId, { displayName }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  if (!roomId) throw new Error("Missing roomId");

  const roomRef = doc(db, "rooms", roomId);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) throw new Error("Room not found");

  const room = snap.data();
  const members = Array.isArray(room.members) ? room.members : [];

  const name =
    displayName ||
    user.displayName ||
    user.email ||
    "Manager";

  const exists = members.some(m => m.uid === user.uid);
  const nextMembers = exists
    ? members.map(m => m.uid === user.uid ? { ...m, displayName: name } : m)
    : [...members, { uid: user.uid, displayName: name, joinedAt: Date.now() }];

  await updateDoc(roomRef, {
    members: nextMembers,
    updatedAt: serverTimestamp(),
  });

  setLastRoomId(roomId);
  return { ok: true };
}

export async function leaveRoom(roomId) {
  const user = auth.currentUser;
  if (!user) return;

  const roomRef = doc(db, "rooms", roomId);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return;

  const room = snap.data();
  const members = Array.isArray(room.members) ? room.members : [];
  const next = members.filter(m => m.uid !== user.uid);

  await updateDoc(roomRef, {
    members: next,
    updatedAt: serverTimestamp(),
  });
}


export function watchRoom(roomId, cb) {
  if (!roomId) return () => {};
  const roomRef = doc(db, "rooms", roomId);
  return onSnapshot(roomRef, (s) => cb(s.exists() ? s.data() : null));
}

/* =========================
   Draft helpers
   ========================= */
const TURN_SECONDS = 120; // used for deadline; UI can show a small timer
const DEFAULT_DRAFT_PLAN = ["ATT", "ATT", "MID", "MID", "DEF", "DEF", "GK", "SUB", "SUB"];

function requireUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  return user;
}
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}


export async function callMaybeStartDraft({ roomId }) {
  const roomRef = doc(db, "rooms", roomId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const room = snap.data();
    if (room.started) return;

    const now = Date.now();
    const startAtMillis =
      typeof room.startAt === "number"
        ? room.startAt
        : room.startAt?.toDate
        ? room.startAt.toDate().getTime()
        : null;

    if (startAtMillis && now >= startAtMillis) {
      const members = Array.isArray(room.members) ? room.members : [];
      if (members.length === 0) throw new Error("No members to start draft");
      const draftOrder = room.draftOrder?.length ? room.draftOrder : shuffleArray(members);
      const ti = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
      tx.update(roomRef, {
        started: true,
        startedAt: serverTimestamp(),
        draftOrder,
        turnIndex: ti,
        turnDeadlineAt: now + TURN_SECONDS * 1000,
        updatedAt: serverTimestamp(),
      });
    }
  });
  return { ok: true };
}

export async function callStartDraftNow({ roomId }) {
  const user = requireUser();
  const roomRef = doc(db, "rooms", roomId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Room not found");
    const room = snap.data();
    if (room.started) return;
    if (room.hostUid !== user.uid) throw new Error("Only host can start");

    const members = Array.isArray(room.members) ? room.members : [];
    if (members.length === 0) throw new Error("No members to start draft");

    const draftOrder = room.draftOrder?.length ? room.draftOrder : shuffleArray(members);
    const ti = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
    tx.update(roomRef, {
      started: true,
      startedAt: serverTimestamp(),
      draftOrder,
      turnIndex: ti,
      turnDeadlineAt: Date.now() + TURN_SECONDS * 1000,
      updatedAt: serverTimestamp(),
    });
  });
  return { ok: true };
}

function normalizePos(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "FWD") return "ATT";
  return p;
}

export async function callMakePick({
  roomId,
  playerId,
  position,
  playerName,
  apiPlayerId,
  apiTeamId,
  teamName,
  nationality,
}) {
  const user = requireUser();

  const allowedPositions = new Set(["ATT", "MID", "DEF", "GK"]);
  const pos = normalizePos(position);
  if (!allowedPositions.has(pos)) throw new Error("Position must be one of ATT, MID, DEF, GK");

  const pid = String(playerId);
  const roomRef = doc(db, "rooms", roomId);
  const pickRef = doc(db, "rooms", roomId, "picks", pid);

  await runTransaction(db, async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists()) throw new Error("Room not found");
    const room = roomSnap.data();
    if (!room.started) throw new Error("Draft has not started");

    const order =
      (Array.isArray(room.draftOrder) && room.draftOrder.length)
        ? room.draftOrder
        : (Array.isArray(room.members) ? room.members : []);

    const n = order.length;
    if (n === 0) throw new Error("Room has no members");

    const totalRounds = room.totalRounds ?? 9;
    const maxPicks = totalRounds * n;
    const turnIndex = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
    if (turnIndex >= maxPicks) throw new Error("All rounds completed");

    const roundIndex = Math.floor(turnIndex / n);
    const withinRound = turnIndex % n;
    const orderIndex = (roundIndex % 2 === 0) ? withinRound : (n - 1 - withinRound);
    const picker = order[orderIndex];
    if (!picker?.uid) throw new Error("Invalid draft order");
    if (picker.uid !== user.uid) throw new Error("Not your turn");

    const existingPick = await tx.get(pickRef);
    if (existingPick.exists()) throw new Error("Player already picked");

    const pickerName =
      user.displayName ||
      (await getDisplayNameFallback(tx, user.uid)) ||
      "Manager";

    const now = Date.now();
    const nextTurnIndex = turnIndex + 1;
    const nextDeadline = (nextTurnIndex < maxPicks) ? now + TURN_SECONDS * 1000 : null;

    tx.set(pickRef, {
      playerId: pid,
      playerName: String(playerName || playerId),
      position: pos,

      uid: picker.uid,
      displayName: pickerName,

      turn: turnIndex + 1,
      round: roundIndex + 1,
      createdAt: serverTimestamp(),

      ...(apiPlayerId != null ? { apiPlayerId: Number(apiPlayerId) } : {}),
      ...(apiTeamId != null ? { apiTeamId: Number(apiTeamId) } : {}),
      ...(teamName ? { teamName: String(teamName) } : {}),
      ...(nationality ? { nationality: String(nationality) } : {}),
    });

    tx.update(roomRef, {
      turnIndex: nextTurnIndex,
      turnDeadlineAt: nextDeadline,
      updatedAt: serverTimestamp(),
    });
  });

  return { ok: true };
}

export async function callAutoPick({ roomId, candidates }) {
  const user = requireUser();
  const roomRef = doc(db, "rooms", roomId);

  await runTransaction(db, async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists()) throw new Error("Room not found");
    const room = roomSnap.data();

    if (!room.started) throw new Error("Draft not started");
    if (room.hostUid !== user.uid) throw new Error("Only host can auto-pick");

    const order = (Array.isArray(room.draftOrder) && room.draftOrder.length)
      ? room.draftOrder
      : (Array.isArray(room.members) ? room.members : []);
    const n = order.length;
    if (n === 0) throw new Error("Room has no members");

    const totalRounds = room.totalRounds ?? 9;
    const maxPicks = totalRounds * n;
    const turnIndex = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
    if (turnIndex >= maxPicks) throw new Error("Draft complete");

    const deadline = typeof room.turnDeadlineAt === "number" ? room.turnDeadlineAt : null;
    if (!deadline || Date.now() < deadline) throw new Error("Deadline not reached");

    const roundIndex = Math.floor(turnIndex / n);
    const withinRound = turnIndex % n;
    const orderIndex = (roundIndex % 2 === 0) ? withinRound : (n - 1 - withinRound);
    const picker = order[orderIndex];
    if (!picker?.uid) throw new Error("Invalid draft order");

    const pool = Array.isArray(candidates) ? candidates : [];
    if (!pool.length) throw new Error("No candidates available for auto-pick");

    let choice = null;
    for (let safety = 0; safety < 50 && !choice; safety++) {
      const tryOne = pool[Math.floor(Math.random() * pool.length)];
      if (!tryOne) continue;
      const pid = String(tryOne.id);
      const pRef = doc(db, "rooms", roomId, "picks", pid);
      const exists = await tx.get(pRef);
      if (!exists.exists()) choice = tryOne;
    }
    if (!choice) throw new Error("Could not find a free player to auto-pick");

    const pid = String(choice.id);
    const allowed = new Set(["ATT","MID","DEF","GK"]);
    const pos = normalizePos(choice.position);

    const pickRef = doc(db, "rooms", roomId, "picks", pid);

    const pickerName =
      picker.displayName ||
      (await getDisplayNameFallback(tx, picker.uid)) ||
      "Manager";

    const now = Date.now();
    const nextTurnIndex = turnIndex + 1;
    const nextDeadline = (nextTurnIndex < maxPicks) ? now + TURN_SECONDS * 1000 : null;

    tx.set(pickRef, {
      playerId: pid,
      playerName: choice.name || pid,
      position: pos,
      uid: picker.uid,
      displayName: pickerName,
      turn: turnIndex + 1,
      round: roundIndex + 1,
      createdAt: serverTimestamp(),

      ...(choice.apiPlayerId != null ? { apiPlayerId: String(choice.apiPlayerId) } : {}),
      ...(choice.apiTeamId != null ? { apiTeamId: String(choice.apiTeamId) } : {}),
      ...(choice.teamName ? { teamName: String(choice.teamName) } : {}),
      ...(choice.nationality ? { nationality: String(choice.nationality) } : {}),
    });

    tx.update(roomRef, {
      turnIndex: nextTurnIndex,
      turnDeadlineAt: nextDeadline,
      updatedAt: serverTimestamp(),
    });
  });

  return { ok: true };
}

// Save interest (up to two choices), each with a swapOut from your roster
export async function marketSaveInterest({ roomId, choices }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  // Trim to two
  const trimmed = Array.isArray(choices) ? choices.slice(0, 2) : [];

  // Normalize items
  const clean = trimmed
    .filter((c) => c && c.wantId && c.swapOutId)
    .map((c) => ({ wantId: String(c.wantId), swapOutId: String(c.swapOutId) }));

  // ✅ reliable display name
  const profile = await getUserProfile(user.uid).catch(() => null);
  const displayName =
    profile?.displayName ||
    user.displayName ||
    user.email ||
    "Manager";

  await setDoc(doc(db, "rooms", roomId, "marketInterest", user.uid), {
    uid: user.uid,
    displayName,         // ✅ now defined
    choices: clean,      // ✅ save the cleaned version
    updatedAt: serverTimestamp(),
  }, { merge: true });

  return { ok: true };
}


// Resolve the market by priority (lowest total points first)
// Resolve the market by priority (LOWEST standings tablePoints first,
// tie-breaker: LOWEST totalFantasyPoints).
// If swapOut is in starting XI AND is LIVE at close -> treat as loser (skip).
export async function marketResolve({ roomId }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  if (!roomId) throw new Error("Missing roomId");

  const roomRef = doc(db, "rooms", roomId);
  const marketRef = doc(db, "rooms", roomId, "market", "current");

  const roomSnap = await getDoc(roomRef);
  if (!roomSnap.exists()) throw new Error("Room Not Found");

  const room = roomSnap.data();
  if (room.hostUid !== user.uid) {
    throw new Error(`Only host can resolve market (hostUid=${room.hostUid}, you=${user.uid})`);
  }

  const marketSnap = await getDoc(marketRef);
  const market = marketSnap.exists() ? marketSnap.data() : null;

  // You can enforce this if you want:
  // if (market?.status !== "resolving") throw new Error("Market is not resolving");

  const weekIndex = Number(room?.currentWeekIndex);
  const weekResultsRef =
    Number.isFinite(weekIndex) ? doc(db, "rooms", roomId, "weekResults", String(weekIndex)) : null;
  const standingsRef = doc(db, "rooms", roomId, "standings", "current");

  // Load everything outside TX
  const [picksSnap, playersSnap, interestSnap, standingsSnap, weekResultsSnap, lineupsSnap] =
    await Promise.all([
      getDocs(collection(db, "rooms", roomId, "picks")),
      getDocs(collection(db, "rooms", roomId, "players")),
      getDocs(collection(db, "rooms", roomId, "marketInterest")),
      getDoc(standingsRef),
      weekResultsRef ? getDoc(weekResultsRef) : Promise.resolve(null),
      getDocs(collection(db, "rooms", roomId, "lineups")),
    ]);

  // --- helpers ---
  const normPos = (pos) => {
    const p = String(pos || "").toUpperCase();
    if (p === "FWD") return "ATT";
    if (p === "FW") return "ATT";
    if (p === "G") return "GK";
    if (p === "GK" || p === "DEF" || p === "MID" || p === "ATT") return p;
    return "MID";
  };

  const STARTER_RULES = {
    GK: { min: 1, max: 1 },
    DEF: { min: 3, max: 5 },
    MID: { min: 3, max: 5 },
    ATT: { min: 1, max: 3 },
  };
  const STARTING_CAP = 11;

  // players pool
  const byId = new Map(); // playerId -> player meta
  playersSnap.forEach((d) => {
    const pl = d.data();
    byId.set(String(pl.id), { ...pl, id: String(pl.id) });
  });

  // picks
  const pickedIds = new Set();
  const picksByUser = new Map(); // uid -> array of picks
  const pickDocIdByUid = new Map(); // uid -> Map(playerId -> pickDocId)
  picksSnap.forEach((d) => {
    const p = d.data();
    const uid = p.uid;
    const pid = String(p.playerId);

    pickedIds.add(pid);

    const arr = picksByUser.get(uid) || [];
    arr.push({ ...p, _id: d.id, playerId: pid });
    picksByUser.set(uid, arr);

    const inner = pickDocIdByUid.get(uid) || new Map();
    inner.set(pid, d.id);
    pickDocIdByUid.set(uid, inner);
  });

  // Available = undrafted only
  const available = new Set(
    [...byId.keys()].filter((id) => !pickedIds.has(String(id)))
  );

  // interests
  const interests = interestSnap.docs.map((d) => ({ uid: d.id, ...(d.data() || {}) }));
  const interestByUid = new Map(interests.map((i) => [i.uid, i]));

  // standings map for priority
  const standingsData = standingsSnap.exists() ? standingsSnap.data() : null;
  const standingsRows = Array.isArray(standingsData?.standings) ? standingsData.standings : [];
  const standingsByUid = new Map(
    standingsRows.map((r) => [
      String(r.userId),
      {
        tablePoints: Number(r.tablePoints ?? 0),
        totalFantasyPoints: Number(r.totalFantasyPoints ?? 0),
      },
    ])
  );

  // LIVE map (per user, per playerKey) from weekResults breakdown
  const wr = weekResultsSnap && weekResultsSnap.exists ? (weekResultsSnap.exists() ? weekResultsSnap.data() : null) : null;
  const breakdownByUserId = wr?.breakdownByUserId || {};
  const liveSetByUid = new Map(); // uid -> Set(playerKey)
  for (const [uid, bd] of Object.entries(breakdownByUserId)) {
    const perPlayer = bd?.perPlayer || {};
    const liveSet = new Set();
    for (const [playerKey, entry] of Object.entries(perPlayer)) {
      const stats = typeof entry === "object" ? entry?.stats : null;
      if (stats?.isLive) liveSet.add(String(playerKey));
    }
    liveSetByUid.set(String(uid), liveSet);
  }

  // lineups map
  const lineupByUid = new Map();
  lineupsSnap.forEach((d) => {
    lineupByUid.set(String(d.id), d.data() || {});
  });

  const isSwapOutStarterAndLive = (uid, swapOutId) => {
    const lineup = lineupByUid.get(String(uid));
    const starters = new Set(Array.isArray(lineup?.starters) ? lineup.starters.map(String) : []);
    if (!starters.has(String(swapOutId))) return false;
    const liveSet = liveSetByUid.get(String(uid));
    return !!liveSet?.has(String(swapOutId));
  };

  // Priority list = all users who submitted interest
  const uids = interests.map((i) => String(i.uid));

  uids.sort((a, b) => {
    const sa = standingsByUid.get(a) || { tablePoints: 0, totalFantasyPoints: 0 };
    const sb = standingsByUid.get(b) || { tablePoints: 0, totalFantasyPoints: 0 };

    // LOWER standings points first (comeback factor)
    if (sa.tablePoints !== sb.tablePoints) return sa.tablePoints - sb.tablePoints;

    // Tie-breaker: LOWER total fantasy points first
    if (sa.totalFantasyPoints !== sb.totalFantasyPoints) return sa.totalFantasyPoints - sb.totalFantasyPoints;

    // Last tie-breaker: earlier submission wins (updatedAt)
    const ia = interestByUid.get(a);
    const ib = interestByUid.get(b);
    const ta = ia?.updatedAt?.toMillis ? ia.updatedAt.toMillis() : Infinity;
    const tb = ib?.updatedAt?.toMillis ? ib.updatedAt.toMillis() : Infinity;
    if (ta !== tb) return ta - tb;

    // Stable final tie-breaker
    return String(a).localeCompare(String(b));
  });

  // Helper: build a legal XI from roster, preferring current starters
  function buildLegalXI(rosterKeys, preferredKeys) {
    const rosterSet = new Set(rosterKeys.map(String));
    const pref = (preferredKeys || []).map(String).filter((k) => rosterSet.has(k));

    const rest = rosterKeys.map(String).filter((k) => !pref.includes(k));

    const posOf = (k) => normPos(byId.get(String(k))?.position);

    let xi = [...pref];

    // Trim over 11 (we will re-fill correctly)
    if (xi.length > STARTING_CAP) xi = xi.slice(0, STARTING_CAP);

    const count = () => {
      const c = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
      for (const k of xi) c[posOf(k)] = (c[posOf(k)] || 0) + 1;
      return c;
    };

    const removeOne = (pos) => {
      for (let i = xi.length - 1; i >= 0; i--) {
        if (posOf(xi[i]) === pos) {
          xi.splice(i, 1);
          return true;
        }
      }
      return false;
    };

    const takeCandidate = (pos) => {
      const idx = rest.findIndex((k) => posOf(k) === pos);
      if (idx === -1) return null;
      const k = rest[idx];
      rest.splice(idx, 1);
      return k;
    };

    // Enforce max caps
    let c = count();
    for (const pos of ["GK", "DEF", "MID", "ATT"]) {
      const max = STARTER_RULES[pos].max;
      while ((c[pos] || 0) > max) {
        if (!removeOne(pos)) break;
        c = count();
      }
    }

    // Ensure mins
    c = count();
    for (const pos of ["GK", "DEF", "MID", "ATT"]) {
      const min = STARTER_RULES[pos].min;
      while ((c[pos] || 0) < min && xi.length < STARTING_CAP) {
        const k = takeCandidate(pos);
        if (!k) break;
        xi.push(k);
        c = count();
      }
    }

    // Fill remaining slots up to 11 respecting max
    const fillOrder = ["DEF", "MID", "ATT", "DEF", "MID", "ATT"];
    while (xi.length < STARTING_CAP) {
      let added = false;
      c = count();

      for (const pos of fillOrder) {
        if ((c[pos] || 0) >= STARTER_RULES[pos].max) continue;
        const k = takeCandidate(pos);
        if (k) {
          xi.push(k);
          added = true;
          break;
        }
      }

      // If nothing fits caps, just add any leftover to reach 11
      if (!added) {
        const k = rest.shift();
        if (!k) break;
        xi.push(k);
      }
    }

    // If still not exactly 11, force to first 11 of roster
    if (xi.length !== STARTING_CAP) {
      return rosterKeys.slice(0, STARTING_CAP).map(String);
    }

    return xi.map(String);
  }

  // Results + lineup update plans
  const results = [];
  const lineupPlanByUid = new Map(); // uid -> {starters, startingXI}

  const members = Array.isArray(room.members) ? room.members : [];
  const nameByUid = new Map(members.map((m) => [String(m.uid), m.displayName]));

  // Apply in priority order
  for (const uid of uids) {
    const interest = interestByUid.get(uid);
    const displayName = nameByUid.get(uid) || interest?.displayName || uid;
    const choices = Array.isArray(interest?.choices) ? interest.choices.slice(0, 2) : [];
    if (!choices.length) continue;

    const myPickDocMap = pickDocIdByUid.get(uid) || new Map();

    // Build a roster snapshot for lineup planning
    const baseRoster = (picksByUser.get(uid) || []).map((p) => String(p.playerId));
    const swapsForUser = [];

    for (const choice of choices) {
      const wantId = String(choice?.wantId || "");
      const swapOutId = String(choice?.swapOutId || "");

      if (!wantId || !swapOutId) {
        results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "MISSING_FIELDS" });
        continue;
      }
      if (wantId === swapOutId) {
        results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "SAME_PLAYER" });
        continue;
      }

      // Want must still be undrafted
      if (!available.has(wantId)) {
        results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "WANT_NOT_AVAILABLE" });
        continue;
      }

      // swapOut must still be owned
      const pickDocId = myPickDocMap.get(swapOutId);
      if (!pickDocId) {
        results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "SWAPOUT_NOT_OWNED" });
        continue;
      }

      // Rule #5: if swapOut is starter AND LIVE => loser (no changes)
      if (isSwapOutStarterAndLive(uid, swapOutId)) {
        results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "SWAPOUT_STARTER_LIVE" });
        continue;
      }

      const wantPlayer = byId.get(wantId);
      if (!wantPlayer) {
        results.push({ uid, displayName, ok: false, wantId, swapOutId, reason: "WANT_NOT_IN_POOL" });
        continue;
      }

      // Winner consumes wantId
      available.delete(wantId);

      swapsForUser.push({ swapOutId, gotId: wantId });

      results.push({
        uid,
        displayName,
        ok: true,
        pickDocId,
        gotId: wantId,
        gotName: wantPlayer.name,
        releasedId: swapOutId,
        releasedName: byId.get(swapOutId)?.name || swapOutId,
      });
    }

    // --- lineup auto adjust after successful swaps (only if any ok) ---
    if (swapsForUser.length) {
      // Simulate final roster ids
      let roster = [...baseRoster];
      for (const s of swapsForUser) {
        const idx = roster.findIndex((k) => String(k) === String(s.swapOutId));
        if (idx >= 0) roster[idx] = String(s.gotId);
      }

      // Current starters (fallback: first 11 of roster)
      const lineup = lineupByUid.get(uid) || {};
      const currentStartersRaw = Array.isArray(lineup?.starters) ? lineup.starters.map(String) : [];
      let starters = currentStartersRaw.length ? currentStartersRaw : roster.slice(0, STARTING_CAP);

      // Replace any swapped-out starter ids with gotId
      for (const s of swapsForUser) {
        starters = starters.map((k) => (String(k) === String(s.swapOutId) ? String(s.gotId) : String(k)));
      }

      // Remove any starters not in roster (safety)
      const rosterSet = new Set(roster.map(String));
      starters = starters.filter((k) => rosterSet.has(String(k)));

      // Fill up to 11 if needed
      for (const k of roster) {
        if (starters.length >= STARTING_CAP) break;
        if (!starters.includes(String(k))) starters.push(String(k));
      }

      // Build legal XI (auto-fix)
      const fixed = buildLegalXI(roster, starters);

      // Build startingXI objects
      const startingXI = fixed.map((k) => {
        const meta = byId.get(String(k)) || {};
        return {
          id: String(k),
          name: meta.name || "",
          position: normPos(meta.position),
          teamId: meta.teamId ?? meta.apiTeamId ?? null,
          apiPlayerId: meta.apiPlayerId ?? null,
        };
      });

      lineupPlanByUid.set(uid, {
        starters: fixed,
        startingXI,
      });
    }
  }

  // --- Commit atomically ---
  await runTransaction(db, async (tx) => {
    const rs = await tx.get(roomRef);
    if (!rs.exists()) throw new Error("Room not found");
    const roomNow = rs.data();
    if (roomNow.hostUid !== user.uid) throw new Error("Only host can resolve");

    // Write results and apply successful swaps
    for (const r of results) {
      const resDoc = doc(collection(db, "rooms", roomId, "marketResults"));
      tx.set(resDoc, { ...r, resolvedAt: serverTimestamp() });

      if (!r.ok) continue;

      const meta = byId.get(String(r.gotId)) || {};
      tx.update(doc(db, "rooms", roomId, "picks", r.pickDocId), {
        playerId: String(r.gotId),
        playerName: String(r.gotName || meta.name || r.gotId),
        position: normPos(meta.position),
        ...(meta.apiPlayerId != null ? { apiPlayerId: String(meta.apiPlayerId) } : {}),
        ...(meta.apiTeamId != null ? { apiTeamId: String(meta.apiTeamId) } : {}),
        ...(meta.teamName ? { teamName: String(meta.teamName) } : {}),
        ...(meta.nationality ? { nationality: String(meta.nationality) } : {}),
        updatedAt: serverTimestamp(),
      });
    }

    // Apply lineup auto-fix plans
    for (const [uid, plan] of lineupPlanByUid.entries()) {
      tx.set(
        doc(db, "rooms", roomId, "lineups", uid),
        {
          uid,
          starters: plan.starters,
          startingXI: plan.startingXI,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }

    // Mark market resolved (THIS is what Marketplace.jsx listens to)
    if (marketSnap.exists()) {
      tx.set(
        marketRef,
        {
          ...(market || {}),
          status: "resolved",
          resolvedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      tx.set(marketRef, { status: "resolved", resolvedAt: serverTimestamp() }, { merge: true });
    }
  });

  const okCount = results.filter((r) => r.ok).length;
  return { ok: true, resultsCount: okCount };
}


/* =========================
   Internal helper for TX
   ========================= */
async function getDisplayNameFallback(tx, uid) {
  const uref = doc(db, "users", uid);
  const usnap = await tx.get(uref);
  return usnap.exists() ? usnap.data()?.displayName : null;
}

// -------------------------
// Trades (user-to-user)
// -------------------------

export async function createTradeOffer({ roomId, toUid, give, receive }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  if (!roomId || !toUid) throw new Error("Missing roomId/toUid");

  // up to 2 each side, must be equal count (keeps roster sizes consistent)
  const giveArr = Array.isArray(give) ? give.filter(Boolean).slice(0, 2) : [];
  const recvArr = Array.isArray(receive) ? receive.filter(Boolean).slice(0, 2) : [];

  if (giveArr.length < 1) throw new Error("Select at least 1 player you give");
  if (recvArr.length < 1) throw new Error("Select at least 1 player you receive");
  if (giveArr.length !== recvArr.length) throw new Error("Trade must be 1-for-1 or 2-for-2");

  // Resolve names (nice UX)
  const roomRef = doc(db, "rooms", roomId);
  const roomSnap = await getDoc(roomRef);
  if (!roomSnap.exists()) throw new Error("Room not found");
  const room = roomSnap.data();
  const members = Array.isArray(room.members) ? room.members : [];
  const nameByUid = new Map(members.map(m => [m.uid, m.displayName]));

  const profile = await getUserProfile(user.uid).catch(() => null);
  const fromName = profile?.displayName || nameByUid.get(user.uid) || user.displayName || user.email || "Manager";
  const toName = nameByUid.get(toUid) || "Manager";

  const tradesRef = collection(db, "rooms", roomId, "trades");
  const docRef = await addDoc(tradesRef, {
    fromUid: user.uid,
    fromName,
    toUid,
    toName,

    give: giveArr.map(p => ({ playerId: String(p.playerId), playerName: p.playerName, position: p.position || "SUB" })),
    receive: recvArr.map(p => ({ playerId: String(p.playerId), playerName: p.playerName, position: p.position || "SUB" })),

    status: "pending",           // pending | accepted | rejected | canceled | completed
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    respondedAt: null,
    appliedAt: null,
  });

  return { ok: true, tradeId: docRef.id };
}

export async function respondToTradeOffer({ roomId, tradeId, action }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const tradeRef = doc(db, "rooms", roomId, "trades", tradeId);
  const snap = await getDoc(tradeRef);
  if (!snap.exists()) throw new Error("Trade not found");
  const t = snap.data();

  if (t.status !== "pending") return { ok: true, status: t.status };

  if (action === "cancel") {
    if (user.uid !== t.fromUid) throw new Error("Only the sender can cancel");
    await updateDoc(tradeRef, { status: "canceled", updatedAt: serverTimestamp(), respondedAt: serverTimestamp() });
    return { ok: true, status: "canceled" };
  }

  if (action === "reject") {
    if (user.uid !== t.toUid) throw new Error("Only the recipient can reject");
    await updateDoc(tradeRef, { status: "rejected", updatedAt: serverTimestamp(), respondedAt: serverTimestamp() });
    return { ok: true, status: "rejected" };
  }

  if (action === "accept") {
    if (user.uid !== t.toUid) throw new Error("Only the recipient can accept");
    // Host will apply the swap and mark completed
    await updateDoc(tradeRef, { status: "accepted", updatedAt: serverTimestamp(), respondedAt: serverTimestamp() });
    return { ok: true, status: "accepted" };
  }

  throw new Error("Unknown action");
}

// Host-only: apply an accepted trade by swapping pick docs
export async function applyAcceptedTrade({ roomId, tradeId }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const roomRef = doc(db, "rooms", roomId);
  const roomSnap = await getDoc(roomRef);
  if (!roomSnap.exists()) throw new Error("Room not found");
  const room = roomSnap.data();
  if (room.hostUid !== user.uid) throw new Error("Only host can apply trades");

  const tradeRef = doc(db, "rooms", roomId, "trades", tradeId);
  const tradeSnap = await getDoc(tradeRef);
  if (!tradeSnap.exists()) throw new Error("Trade not found");
  const t = tradeSnap.data();

  if (t.status !== "accepted") return { ok: true, status: t.status };
  if (t.appliedAt) return { ok: true, status: "completed" };

  const give = Array.isArray(t.give) ? t.give : [];
  const receive = Array.isArray(t.receive) ? t.receive : [];
  if (give.length < 1 || give.length > 2) throw new Error("Invalid give length");
  if (receive.length !== give.length) throw new Error("Trade must be 1-for-1 or 2-for-2");

  const picksRef = collection(db, "rooms", roomId, "picks");

  // Fetch rosters by uid (single equality filter = easy, no index headaches)
  const [fromRosterSnap, toRosterSnap] = await Promise.all([
    getDocs(query(picksRef, where("uid", "==", t.fromUid))),
    getDocs(query(picksRef, where("uid", "==", t.toUid))),
  ]);

  const fromDocs = fromRosterSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
  const toDocs = toRosterSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));

  // Find pick docs that currently hold the players being traded
  const fromPickRefs = give.map(g =>
    fromDocs.find(p => String(p.playerId) === String(g.playerId))
  );
  const toPickRefs = receive.map(r =>
    toDocs.find(p => String(p.playerId) === String(r.playerId))
  );

  if (fromPickRefs.some(x => !x) || toPickRefs.some(x => !x)) {
    // Someone no longer owns the listed players
    await updateDoc(tradeRef, { status: "rejected", updatedAt: serverTimestamp(), respondedAt: serverTimestamp() });
    return { ok: true, status: "rejected" };
  }

  await runTransaction(db, async (tx) => {
    const freshTrade = await tx.get(tradeRef);
    if (!freshTrade.exists()) throw new Error("Trade missing");
    const ft = freshTrade.data();
    if (ft.status !== "accepted" || ft.appliedAt) return;

    // Pairwise swap: give[i] <-> receive[i]
    for (let i = 0; i < give.length; i++) {
      const fromPick = fromPickRefs[i];
      const toPick = toPickRefs[i];

      // swap fields
      tx.update(fromPick.ref, {
        playerId: String(receive[i].playerId),
        playerName: receive[i].playerName,
        position: receive[i].position || "SUB",
        updatedAt: serverTimestamp(),
      });

      tx.update(toPick.ref, {
        playerId: String(give[i].playerId),
        playerName: give[i].playerName,
        position: give[i].position || "SUB",
        updatedAt: serverTimestamp(),
      });
    }

    tx.update(tradeRef, {
      status: "completed",
      appliedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  return { ok: true, status: "completed" };
}
