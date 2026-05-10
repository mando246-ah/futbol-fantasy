import { useEffect, useMemo, useRef, useState } from "react";
import {
  auth,
  db,
  watchAuth,
  getUserProfile,
  watchRoom,
  joinRoom,
  kickMemberFromRoom,
  getLastRoomId,
  setLastRoomId,
  callMakePick,
  callMaybeStartDraft,
  callStartDraftNow,
  callAutoPick,
  logAnalyticsEvent,
} from "../firebase";
import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  onSnapshot,
  collection,
  serverTimestamp,
  updateDoc,
  query,
  orderBy,
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, Trophy, Medal} from "lucide-react";
import Marketplace from "../components/ui/Marketplace";
import { seedRoomPlayers } from "../firebase";
import { httpsCallable } from "firebase/functions";
import { app, functions } from "../firebase";
import "./Draft.css";
import useUserProfiles from "../lib/useUserProfiles";
import { Avatar, AvatarImage, AvatarFallback } from "../components/ui/avatar";
import FlagIcon from "@/components/FlagIcon";


// ----- Config -----
const TURN_SECONDS = 120;

const NEW_ROOM_GLOBAL_PIPELINE_MODE = "legacy";
// For testing, I may temporarily change this to "shadow".
// For public/stable rooms, it should stay "legacy".

function buildClientGlobalPipeline(mode = "legacy") {
  const normalized = ["legacy", "shadow", "global"].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase()
    : "legacy";

  return {
    mode: normalized,
    playerPool: normalized === "shadow" || normalized === "global",
    liveFixtureCache: normalized === "shadow" || normalized === "global",
    roomAggregator: normalized === "global",
    version: 1,
  };
}

// ----- Mock pool (30 players) -----
const MOCK_PLAYERS = [
  // ATT (10)
  { id: "erling-haaland", name: "Erling Haaland", position: "ATT" },
  { id: "kylian-mbappe", name: "Kylian Mbappé", position: "ATT" },
  { id: "harry-kane", name: "Harry Kane", position: "ATT" },
  { id: "vinicius-junior", name: "Vinícius Júnior", position: "ATT" },
  { id: "lautaro-martinez", name: "Lautaro Martínez", position: "ATT" },
  { id: "robert-lewandowski", name: "Robert Lewandowski", position: "ATT" },
  { id: "mohamed-salah", name: "Mohamed Salah", position: "ATT" },
  { id: "osimhen", name: "Victor Osimhen", position: "ATT" },
  { id: "julian-alvarez", name: "Julián Álvarez", position: "ATT" },
  { id: "rafa-leao", name: "Rafael Leão", position: "ATT" },
  // MID (10)
  { id: "kevin-de-bruyne", name: "Kevin De Bruyne", position: "MID" },
  { id: "jude-bellingham", name: "Jude Bellingham", position: "MID" },
  { id: "bernardo-silva", name: "Bernardo Silva", position: "MID" },
  { id: "rodri", name: "Rodri", position: "MID" },
  { id: "martin-odegaard", name: "Martin Ødegaard", position: "MID" },
  { id: "florian-wirtz", name: "Florian Wirtz", position: "MID" },
  { id: "bukayo-saka", name: "Bukayo Saka", position: "MID" },
  { id: "bruno-fernandes", name: "Bruno Fernandes", position: "MID" },
  { id: "ilkay-gundogan", name: "İlkay Gündoğan", position: "MID" },
  { id: "pedri", name: "Pedri", position: "MID" },
  // DEF (8)
  { id: "ruben-dias", name: "Rúben Dias", position: "DEF" },
  { id: "virgil-van-dijk", name: "Virgil van Dijk", position: "DEF" },
  { id: "alphonso-davies", name: "Alphonso Davies", position: "DEF" },
  { id: "kyle-walker", name: "Kyle Walker", position: "DEF" },
  { id: "achraf-hakimi", name: "Achraf Hakimi", position: "DEF" },
  { id: "theo-hernandez", name: "Theo Hernández", position: "DEF" },
  { id: "kim-min-jae", name: "Kim Min-jae", position: "DEF" },
  { id: "john-stones", name: "John Stones", position: "DEF" },
  // GK (2)
  { id: "thibaut-courtois", name: "Thibaut Courtois", position: "GK" },
  { id: "ederson", name: "Ederson", position: "GK" },
];



const fnScheduleDraft = httpsCallable(functions, "scheduleDraft");

// ----- Helpers -----  
function randomKey(n = 6) {
  return Math.random().toString(36).slice(2, 2 + n).toUpperCase();
}
function roundOrder(order, roundIndex) {
  if (!order?.length) return [];
  return roundIndex % 2 === 0 ? order : [...order].reverse();
}
function displayNameOf(m, fallback = "User") {
  return m?.displayName || m?.uid || fallback;
}


function formatWhen(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function secondsUntil(ms, nowMs) {
  if (!ms) return null;
  return Math.floor((ms - nowMs) / 1000);
}

function countdownStr(sec) {
  if (sec == null) return "";
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// --- All Picks: stable manager colors ---
function hashToHue(str = "") {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

function managerPillStyle(uid, isMine) {
  const hue = hashToHue(String(uid || "unknown"));
  // mine = slightly stronger so it's easier to spot
  return {
    backgroundColor: `hsla(${hue}, 90%, 55%, ${isMine ? 0.35 : 0.18})`,
    borderColor: `hsla(${hue}, 90%, 60%, 0.55)`,
  };
}

// ----- Draft rules (Starting XI formation) ----- and tracker
// Matches the View Roster rules pills: GK:1, DEF:3–5, MID:3–5, ATT:1–3
const STARTING_XI_FORMATION_RULES = [
  { pos: "GK", range: "1" },
  { pos: "DEF", range: "3–5" },
  { pos: "MID", range: "3–5" },
  { pos: "ATT", range: "1–3" },
];

function DraftFormationRules({ compact = false }) {
  return (
    <div className={`draftRulesCard ${compact ? "draftRulesCard--compact" : ""}`}>
      <div className="draftRulesTitle">Starting XI formation</div>
      <div className="draftRulesPills">
        {STARTING_XI_FORMATION_RULES.map((r) => (
          <span key={r.pos} className="draftRulePill">
            {r.pos}: {r.range}
          </span>
        ))}
      </div>
      {!compact && <div className="draftRulesNote">Only the starting XI scores.</div>}
    </div>
  );
}

const DRAFT_POSITION_TRACKER_ORDER = ["GK", "DEF", "MID", "ATT"];

function DraftPositionTracker({ counts = {}, total = 0 }) {
  return (
    <div className="draftPositionTrackerCard">
      <div className="draftPositionTrackerTitle">Your drafted players</div>

      <div className="draftPositionTrackerPills">
        {DRAFT_POSITION_TRACKER_ORDER.map((pos) => (
          <span key={pos} className="draftPositionTrackerPill">
            {pos}: {Number(counts[pos] || 0)}
          </span>
        ))}
      </div>

      <div className="draftPositionTrackerNote">
        Total drafted: <b>{total}</b>
      </div>
    </div>
  );
}


// Returns next occurrence of a weekday as YYYY-MM-DD in a given IANA timezone.
// targetDow: 0=Sun ... 6=Sat
function nextWeekdayISO(targetDow, timeZone = "America/Los_Angeles") {
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const now = new Date();
  let currentDow;

  try {
    const dowStr = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(now);
    currentDow = DOW[dowStr];
  } catch {
    currentDow = now.getDay();
  }
  if (typeof currentDow !== "number") currentDow = now.getDay();

  const t = Number(targetDow);
  const target = Number.isFinite(t) ? ((t % 7) + 7) % 7 : 3;

  let delta = (target - currentDow + 7) % 7;
  const day = new Date(now.getTime() + delta * 24 * 60 * 60 * 1000);

  try {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).format(day);
  } catch {
    const y = day.getFullYear();
    const m = String(day.getMonth() + 1).padStart(2, "0");
    const d = String(day.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}

const DRAFT_SIZE_LEAGUE = 16; // Regular leagues 
const DRAFT_SIZE_CUP = 20;    // Cups / World Cup mode

function draftSizeForCompetitionType(type) {
  return String(type || "").toLowerCase() === "cup" ? DRAFT_SIZE_CUP : DRAFT_SIZE_LEAGUE;
}


export default function DraftWithPresence() {
  // Auth
  const [user, setUser] = useState(null);
  useEffect(() => onAuthStateChanged(auth, setUser), []);

  // Routing / room selection
  const [roomId, setRoomId] = useState(() => {
    const url = new URL(window.location.href);
    return url.searchParams.get("room") || "";
  });

  useEffect(() => {
    if (!user?.uid) return;

    const url = new URL(window.location.href);
    const roomFromUrl = url.searchParams.get("room");

    // If user came from an actual room link, use that.
    if (roomFromUrl) {
      setRoomId(roomFromUrl);
      return;
    }

    // Otherwise only load the saved room for THIS signed-in user.
    const savedRoom = getLastRoomId(user.uid);
    if (savedRoom) {
      setRoomId(savedRoom);
    }
  }, [user?.uid]);
  const [roomKeyInput, setRoomKeyInput] = useState("");

  // Live room state
  const [room, setRoom] = useState(null);
  const [members, setMembers] = useState([]);
  const [picks, setPicks] = useState([]);
  const [joining, setJoining] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [seedingPlayers, setSeedingPlayers] = useState(false);

  // Host scheduling
  const [startLocalISO, setStartLocalISO] = useState("");
  const [marketLocalISO, setMarketLocalISO] = useState("");

  // Player list UI
  const [posFilter, setPosFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [allPicksPos, setAllPicksPos] = useState("ALL");
  const [allPicksQuery, setAllPicksQuery] = useState("");
  const [memberLabelByUid, setMemberLabelByUid] = useState({});

  // User in room 
  const [joinAttempted, setJoinAttempted] = useState(false);

  const managerLabel = (uid, fallback = "Someone") => {
    const key = String(uid || "");
    return memberLabelByUid[key] || fallback;
  };

  const membersKey = useMemo(() => (members || []).join("|"), [members]);

  //Flags
  const competitionName = room?.competitionMeta?.name || "";
  const competitionSeason = room?.competition?.season || "";
  const competitionCountry = room?.competitionMeta?.country || "";

  const competitionLabel = [competitionSeason, competitionName]
    .filter(Boolean)
    .join(" ");

useEffect(() => {
  if (!roomId || !members?.length) {
    setMemberLabelByUid({});
    return;
  }

  const unsubs = [];
  const nameBy = {};
  const teamBy = {};

  const recompute = () => {
    const out = {};
    for (const uid of members) {
      const base = (nameBy[uid] || uid).trim();
      const team = (teamBy[uid] || "").trim();
      out[uid] = team ? `${base} — ${team}` : base;
    }
    setMemberLabelByUid(out);
  };

  for (const uid of members) {
    // chosen display name (your app) -> fallback to google name -> uid
    unsubs.push(
      onSnapshot(
        doc(db, "users", uid),
        (snap) => {
          const d = snap.exists() ? snap.data() : {};
          nameBy[uid] = (d.displayName || d.name || d.fullName || "").trim() || uid;
          recompute();
        },
        () => {}
      )
    );

    // optional: team name doc (since you already use team names elsewhere)
    unsubs.push(
      onSnapshot(
        doc(db, "rooms", roomId, "teamNames", uid),
        (snap) => {
          const d = snap.exists() ? snap.data() : {};
          teamBy[uid] = (d.teamName || "").trim();
          recompute();
        },
        () => {}
      )
    );
  }

  recompute();
  return () => unsubs.forEach((fn) => fn && fn());
}, [roomId, membersKey]);

  // Countdown + auto-pick
  const [timeLeft, setTimeLeft] = useState(TURN_SECONDS);
  const triedAutoRef = useRef(false);
  const [ clockNow, setClockNow] = useState(Date.now());

  //Live Listener
  const [poolPlayers, setPoolPlayers] = useState([]);

  useEffect(() => {
    if (!roomId) {
      setPoolPlayers([]);
      return;
    }
    const ref = collection(db, "rooms", roomId, "players");
    return onSnapshot(ref, (snap) => {
      setPoolPlayers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, [roomId]);


  //Clock tick
  useEffect(() => {
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Watch room doc (members live in the room doc's `members` array)
  useEffect(() => {
    if (roomId && user?.uid) setLastRoomId(roomId, user.uid);
  }, [roomId, user?.uid]);

  useEffect(() => {
    if (!roomId || !user?.uid) return;
    setLastRoomId(roomId, user.uid);
    setJoinAttempted(false);

    const unsubRoom = watchRoom(roomId, (data) => {
      setRoom(data);
      setMembers(
        Array.isArray(data?.members)
          ? data.members
              .map((m) => (typeof m === "string" ? m : m?.uid ?? m?.userId ?? m?.id))
              .filter(Boolean)
              .map(String)
          : []
      );
    });

    // Auto-join when signed-in & roomId present
    let didJoin = false;
    const tryJoin = async () => {
      if (didJoin || !roomId || !auth.currentUser) return;
      didJoin = true;
      setJoining(true);
      try {
        const profile = await getUserProfile(auth.currentUser.uid).catch(() => null);
        const displayName = profile?.displayName || auth.currentUser.displayName || auth.currentUser.email;
        await joinRoom(roomId, { displayName });
      } catch (e) {
        console.error("joinRoom failed:", e);
      } finally {
        setJoining(false);
        setJoinAttempted(true);
      }
    };
    const unAuth = watchAuth(() => tryJoin());
    tryJoin();

    // Picks stream
    const unsubPicks = onSnapshot(
      query(collection(db, "rooms", roomId, "picks"), orderBy("turn", "asc")),
      (snap) => setPicks(snap.docs.map((d) => d.data()))
    );

    return () => {
      unAuth && unAuth();
      unsubRoom && unsubRoom();
      unsubPicks && unsubPicks();
    };
  }, [roomId, user?.uid]);

  // If host kicks this user out, remove the room from their UI.
  useEffect(() => {
    if (!roomId || !user?.uid || !room || joining || !joinAttempted) return;

    const roomMembers = Array.isArray(room.members) ? room.members : [];
    const isStillMember = roomMembers.some((m) => {
      const uid = typeof m === "string" ? m : m?.uid ?? m?.userId ?? m?.id;
      return String(uid || "") === String(user.uid);
    });

    if (isStillMember) return;

    setRoomId("");
    setRoomKeyInput("");
    setRoom(null);
    setMembers([]);
    setPicks([]);

    localStorage.removeItem("lastRoomId");
    window.dispatchEvent(new Event("lastRoomIdChanged"));

    const url = new URL(window.location.href);
    if (url.searchParams.has("room")) {
      url.searchParams.delete("room");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }

    alert("You were removed from this room by the host.");
  }, [roomId, user?.uid, room, joining, joinAttempted]);

  // Create a room (host)
  async function createRoom() {
    if (!user) return alert("Sign in first");
    if (creatingRoom) return;

    setCreatingRoom(true);
    setSeedingPlayers(false);

    try {
      const key = randomKey();
      const ref = doc(db, "rooms", key);
      if ((await getDoc(ref)).exists()) return alert("Key collision, try again");

      const profile = await getUserProfile(user.uid).catch(() => null);
      const displayName = profile?.displayName || user.displayName || user.email || "Host";
      const initialMembers = [{ uid: user.uid, displayName }];

      await setDoc(ref, {
        code: key,
        name: "Friends Draft",
        hostUid: user.uid,
        members: initialMembers,
        turnIndex: 0,
                totalRounds: DRAFT_SIZE_LEAGUE, // <-- change draft size defaults above
        draftPlan: null,
        started: false,
        startAt: null,
        turnDeadlineAt: null,
        globalPipeline: buildClientGlobalPipeline(NEW_ROOM_GLOBAL_PIPELINE_MODE),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        
      });

      // Create the fast “mirrors” (these are quick)
      await setDoc(
        doc(db, "rooms", key, "members", user.uid),
        { uid: user.uid, displayName, joinedAt: serverTimestamp() },
        { merge: true }
      );

      await setDoc(
        doc(db, "users", user.uid, "rooms", key),
        {
          roomId: key,
          code: key,
          name: "Friends Draft",
          hostUid: user.uid,
          joinedAt: serverTimestamp(),
          lastSeenAt: serverTimestamp(),
        },
        { merge: true }
      );

      // CONNECT IMMEDIATELY (this makes UI feel instant)
      setRoomKeyInput(key);
      setRoomId(key);

      await updateDoc(doc(db, "rooms", key), {
      competition: null,
      competitionMeta: null,
      competitionLocked: false,
      status: "waiting_competition",
      playerCount: 0,
      updatedAt: serverTimestamp(),
    });

    logAnalyticsEvent("create_room", {
      room_id: key,
      source: "draft_page",
    });

    } catch (e) {
      console.error(e);
      alert("Failed to create room. Check console for details.");
    } finally {
      setCreatingRoom(false);
    }
  }

  // Join by code
  async function joinByCode() {
    if (!user) return alert("Sign in first");

    const key = roomKeyInput.trim().toUpperCase();
    if (!key) return alert("Enter a room key");

    try {
      const profile = await getUserProfile(user.uid).catch(() => null);
      const displayName =
        profile?.displayName ||
        user.displayName ||
        user.email ||
        "User";

      await joinRoom(key, { displayName });

      setRoomId(key);

      logAnalyticsEvent("join_room", {
        room_id: key,
        join_method: "code",
      });
    } catch (e) {
      alert(e?.message || "Could not join room.");
    }
  }

  //Host kick users
  async function handleKickMember(member) {
    if (!isHost || !roomId || room?.started) return;

    const targetUid = member?.uid;
    if (!targetUid) return;

    if (targetUid === room.hostUid) {
      return alert("You cannot kick the host.");
    }

    const name = displayNameOf(member, "this user");

    const ok = window.confirm(
      `Kick ${name} from this room?\n\nThey will be removed from the waiting room and will not be part of the draft.`
    );

    if (!ok) return;

    try {
      await kickMemberFromRoom(roomId, targetUid);
    } catch (e) {
      alert(e?.message || "Failed to kick user.");
    }
  }

  // Host: schedule start
  async function scheduleStart() {
    if (!user || !room) return;
    if (room.hostUid !== user.uid) return alert("Only host can schedule");
    if (!startLocalISO) return alert("Pick a date/time");
    const whenMillis = new Date(startLocalISO).getTime();
    await fnScheduleDraft({ roomId, startAtMs: whenMillis });
  }

  //Display Market Schedule 
  async function scheduleMarketOpen() {
    if (!user || !room) return;
    if (room.hostUid !== user.uid) return alert("Only host can schedule");
    if (!marketLocalISO) return alert("Pick a date/time");
    const whenMillis = new Date(marketLocalISO).getTime();
    await updateDoc(doc(db, "rooms", roomId), {
      marketOpenAt: whenMillis,
      updatedAt: serverTimestamp(),
    });
  }
  // Host: start now
  async function startNow() {
    if (!user || !room) return;
    if (room.hostUid !== user.uid) return alert("Only host can start");

    if (!poolReady) {
      return alert("Pick + lock a competition and load players before starting the draft.");
    }

    try {
      await callStartDraftNow({ roomId });
      logAnalyticsEvent("draft_started", {
        room_id: roomId,
        start_method: "manual",
      });
    } catch (e) {
      alert(e?.message || "Failed to start");
    }
  }

  // Flip to started when scheduled time arrives
  useEffect(() => {
    if (!room?.startAt || room.started || !roomId) return;
    const targetMillis =
      typeof room.startAt === "number"
        ? room.startAt
        : room.startAt?.toDate
        ? room.startAt.toDate().getTime()
        : null;
    if (!targetMillis) return;

    const tid = setInterval(async () => {
      if (Date.now() >= targetMillis) {
        clearInterval(tid);
        try { await callMaybeStartDraft({ roomId }); 

        if(room?.hostUid === user?.uid){
        logAnalyticsEvent("draft_started", {
          room_id: roomId,
          start_method: "scheduled",
        });}

      } catch {}
      }
    }, 1000);
    return () => clearInterval(tid);
  }, [room?.startAt, room?.started, roomId]);

  //Drafted players
  const draftedByPlayerId = useMemo(() => {
    const map = new Map();
    for (const p of picks || []) {
      // adapt if your pick object uses a different key than playerId
      map.set(String(p.playerId), {
        managerName: managerLabel(p.uid, p.displayName || "Someone"),
        turn: p.turn,
        round: p.round,
      });
    }
    return map;
  }, [picks]);

  const isPlayerDrafted = (playerId) => draftedByPlayerId.has(String(playerId));

  // Who is on the clock (snake)
  const currentPicker = useMemo(() => {
    if (!room) return null;
    const order = (Array.isArray(room.draftOrder) && room.draftOrder.length)
      ? room.draftOrder
      : (Array.isArray(room.members) ? room.members : []);
    const n = order.length;
    if (!n) return null;
    const ti = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
    const totalRounds = room.totalRounds ?? DRAFT_SIZE_LEAGUE;
    const maxPicks = totalRounds * n;
    if (ti >= maxPicks) return null;
    const roundIndex = Math.floor(ti / n);
    const withinRound = ti % n;
    const orderIndex = (roundIndex % 2 === 0) ? withinRound : (n - 1 - withinRound);
    return order[orderIndex] || null;
  }, [room]);

  //Next picker 
  const nextPicker = useMemo(() => {
    if (!room) return null;
    const order = (Array.isArray(room.draftOrder) && room.draftOrder.length)
      ? room.draftOrder
      : (Array.isArray(room.members) ? room.members : []);
    const n = order.length;
    if (!n) return null;

    const ti = Number.isFinite(room.turnIndex) ? room.turnIndex : 0;
    const totalRounds = room.totalRounds ?? DRAFT_SIZE_LEAGUE;
    const maxPicks = totalRounds * n;
    if (ti + 1 >= maxPicks) return null;

    const nextTi = ti + 1;
    const roundIndex = Math.floor(nextTi / n);
    const withinRound = nextTi % n;
    const orderIndex = (roundIndex % 2 === 0) ? withinRound : (n - 1 - withinRound);
    return order[orderIndex] || null;
  }, [room]);


  const currentRoundIdx = useMemo(() => {
    const n = room?.draftOrder?.length || room?.members?.length || 1;
    return Math.floor((room?.turnIndex ?? 0) / n);
  }, [room?.turnIndex, room?.members?.length, room?.draftOrder?.length]);

  const requiredSlot = null;

  const [posFilterState, searchState] = [posFilter, search]; // just to keep deps short
  const pickedIds = useMemo(() => new Set(picks.map(p => String(p.playerId))), [picks]);
  const loadingPlayers = !!roomId && poolPlayers.length === 0;

  // All Picks filtering + suggestions (player OR manager)
  const filteredPicks = useMemo(() => {
    const q = allPicksQuery.trim().toLowerCase();

    return (picks || []).filter((p) => {
      if (allPicksPos !== "ALL" && p.position !== allPicksPos) return false;
      if (!q) return true;

      const player = String(p.playerName || "").toLowerCase();
      const manager = String(managerLabel(p.uid, p.displayName || "")).toLowerCase();
      const team = String(p.teamName || "").toLowerCase();
      const country = String(p.nationality || "").toLowerCase();

      return player.includes(q) || manager.includes(q) || team.includes(q) || country.includes(q);
    });
  }, [picks, allPicksQuery, allPicksPos]);

  const allPicksSuggestions = useMemo(() => {
    const q = allPicksQuery.trim().toLowerCase();
    if (!q) return [];

    const set = new Set();

    for (const p of picks || []) {
      const player = String(p.playerName || "");
      const manager = String(managerLabel(p.uid, p.displayName || ""));

      if (player.toLowerCase().includes(q)) set.add(player);
      if (manager.toLowerCase().includes(q)) set.add(manager);
      if (set.size >= 10) break; // cap suggestions
    }

    return Array.from(set).slice(0, 10);
  }, [picks, allPicksQuery]);


  function normalizeDraftPos(pos) {
    const p = String(pos || "").toUpperCase();

    // API-Football often gives FWD/ST/CF etc — your draft only allows ATT/MID/DEF/GK
    if (["FWD", "FW", "ST", "CF"].includes(p)) return "ATT";

    if (["ATT"].includes(p)) return "ATT";
    if (["MID", "MF", "CM", "CDM", "CAM", "LM", "RM"].includes(p)) return "MID";
    if (["DEF", "DF", "CB", "LB", "RB", "LWB", "RWB"].includes(p)) return "DEF";
    if (["GK", "GKP"].includes(p)) return "GK";

    return p;
  }

  const myDraftPositionCounts = useMemo(() => {
    const counts = { GK: 0, DEF: 0, MID: 0, ATT: 0 };

    for (const p of picks || []) {
      if (String(p.uid || "") !== String(user?.uid || "")) continue;

      const pos = normalizeDraftPos(p.position);
      if (counts[pos] !== undefined) counts[pos] += 1;
    }

    return counts;
  }, [picks, user?.uid]);

  const myDraftedCount = useMemo(() => {
    return Object.values(myDraftPositionCounts).reduce((sum, n) => sum + Number(n || 0), 0);
  }, [myDraftPositionCounts]);

  // If you have poolPlayers from Firestore, use them; otherwise fall back to MOCK_PLAYERS
  const ALL_PLAYERS = (poolPlayers?.length ? poolPlayers : MOCK_PLAYERS).map((p) => ({
    ...p,
    id: String(p.id),
    name: p.fullName ?? p.name ?? "",
    position: normalizeDraftPos(p.position),
  }));

  const availablePlayers = useMemo(() => {
    const q = searchState.trim().toLowerCase();

      // show nothing until user types
      if (!q) return [];

      return ALL_PLAYERS
        .filter((p) => {
          if (posFilterState !== "ALL" && p.position !== posFilterState) return false;
          
          // Multi-field search
          const matchName = (p.name || "").toLowerCase().includes(q);
          const matchTeam = (p.teamName || "").toLowerCase().includes(q);
          const matchCountry = (p.nationality || "").toLowerCase().includes(q);

          if (!matchName && !matchTeam && !matchCountry) return false;
          return true;
        })
        // push drafted players to the bottom so undrafted show first
        .sort((a, b) => {
          const ad = pickedIds.has(a.id) ? 1 : 0;
          const bd = pickedIds.has(b.id) ? 1 : 0;
          return ad - bd; 
        })
        .slice(0, 50) 
        .map((p) => ({
          ...p,
          isDrafted: pickedIds.has(p.id),
        }));
  }, [ALL_PLAYERS, posFilterState, searchState, pickedIds]);


  const canPickNow = room?.started && currentPicker?.uid === user?.uid;

  const isDraftComplete = useMemo(() => {
    const n = room?.draftOrder?.length || room?.members?.length || 0;
    if (!n) return false;
    const totalRounds = room?.totalRounds ?? DRAFT_SIZE_LEAGUE;
    const ti = Number.isFinite(room?.turnIndex) ? room.turnIndex : 0;
    return ti >= totalRounds * n;
  }, [room]);

  async function pickPlayer(player) {
    if (!canPickNow) return alert(!room?.started ? "Draft not started" : "Not your turn");
    if (isDraftComplete) return alert("Draft is complete");
    try {
      await callMakePick({
        roomId,
        playerId: player.id,
        position: normalizeDraftPos(player.position),
        playerName: player.name,

        apiPlayerId: player.apiPlayerId ?? player.id,
        apiTeamId: player.apiTeamId ?? player.teamId,
        teamName: player.teamName ?? "",

        nationality: player.nationality ?? "",
      });
    } catch (e) {
      alert(e?.message || "Pick failed");
    }
  }

  // Countdown
  useEffect(() => {
    triedAutoRef.current = false;
    const deadlineMs = typeof room?.turnDeadlineAt === "number" ? room.turnDeadlineAt : null;
    const tick = () => {
      if (!deadlineMs) return setTimeLeft(TURN_SECONDS);
      setTimeLeft(Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [room?.turnDeadlineAt, room?.turnIndex]);

  const autoPickPool = useMemo(() => {
    return ALL_PLAYERS.filter((p) => !pickedIds.has(p.id));
  }, [ALL_PLAYERS, pickedIds]);

  // Host auto-pick when timer hits 0
  useEffect(() => {
    if (!room?.started || isDraftComplete) return;

    if (user?.uid !== room?.hostUid) return;

    const deadlineMs = typeof room?.turnDeadlineAt === "number" ? room.turnDeadlineAt : null;
    if (!deadlineMs) return;

    // prevent early fire if host clock is ahead
    if (Date.now() < deadlineMs) return;

    if (triedAutoRef.current) return;

    const candidates = autoPickPool.map((p) => ({
      id: p.id,
      name: p.name,
      position: normalizeDraftPos(p.position),
      apiPlayerId: p.apiPlayerId ?? p.id,
      apiTeamId: p.apiTeamId ?? p.teamId,
      teamName: p.teamName ?? "",
      nationality: p.nationality ?? "",
    }));

    if (!candidates.length) return;

    triedAutoRef.current = true;

    (async () => {
      try {
        await callAutoPick({ roomId, candidates });
      } catch (e) {
        if (String(e?.message || "").includes("Deadline not reached")) {
          triedAutoRef.current = false;
        }
        console.warn("Auto-pick failed:", e?.message || e);
      }
    })();
  }, [room?.started, room?.turnDeadlineAt, isDraftComplete, user?.uid, room?.hostUid, roomId, autoPickPool]);


  //User Picture 
  const memberUids = useMemo(() => {
    return (room?.members || []).map((m) => m.uid).filter(Boolean);
  }, [room?.members]);
  const profilesByUid = useUserProfiles(memberUids);

  function profileOf(uid) {
    return profilesByUid?.[uid] || {};
  }

  const currentName = displayNameOf(currentPicker, "—");
  const nextName = displayNameOf(nextPicker, "—");
  const currentPhoto = currentPicker ? profileOf(currentPicker.uid)?.photoURL : "";
  const nextPhoto = nextPicker ? profileOf(nextPicker.uid)?.photoURL : "";

  //Draft Name 
  const isHost = user?.uid && room?.hostUid === user.uid;
  const poolReady = room?.status === "ready_to_draft" && (poolPlayers?.length || 0) > 0;

  const [isEditingDraftName, setIsEditingDraftName] = useState(false);
  const [draftNameInput, setDraftNameInput] = useState("");

  // keep input synced when room updates
  useEffect(() => {
    setDraftNameInput(room?.name || "Friends Draft");
  }, [room?.name]);

  async function saveDraftName() {
    if (!isHost || !roomId) return;

    const clean = (draftNameInput || "").trim();
    if (clean.length < 2) return alert("Draft name must be at least 2 characters.");
    if (clean.length > 30) return alert("Draft name must be 30 characters or less.");

    await updateDoc(doc(db, "rooms", roomId), {
      name: clean,
      updatedAt: serverTimestamp(),
    });

    setIsEditingDraftName(false);
  }

  // ----- UI -----
  return (
    <div className="ff-page ff-page--dark draftPage">
      <div className="ff-container">
      {/* Create / Join */}
      <div className="ff-panel ff-panel--pad draftSection">
        <div className="text-lg font-semibold mb-2">Create / Join a Room</div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="flex items-center gap-2">
            <button
              onClick={createRoom}
              disabled={creatingRoom}
              className="ff-btn ff-btn--sm ff-btn--neon"
            >
              {creatingRoom ? "Creating Room..." : "Create Room (Host)"}
            </button>
            {seedingPlayers && (<div className="text-sm opacity-70">Fetching players…</div>)}
            {room?.code && <div className="text-sm">Room Key: <b>{room.code}</b></div>}
          </div>
          <div className="flex items-center gap-2">
            <input
              className="ff-input roomKeyInput"
              placeholder="Enter room key"
              value={roomKeyInput}
              onChange={(e) => setRoomKeyInput(e.target.value.toUpperCase())}
            />
            <button onClick={joinByCode} className="ff-btn ff-btn--sm ff-btn--neon">Join</button>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-sm opacity-70">
              {roomId ? <>Connected to <b>{roomId}</b></> : "Not connected"}
            </div>
          </div>
        </div>
      </div>

      {/* If no room selected */}
      {!room && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 text-center">
          <div className="text-lg font-semibold mb-2">Waiting to connect…</div>
          <p className="opacity-70">Create a room or enter a room key to continue.</p>
        </div>
      )}

      {/* Room UI */}
      {room && (
        <>
          {/* Waiting room */}
          {!room.started && (
             <div>
              {/* Soccer-themed waiting room header */}
              <div className="flex items-center gap-2 mb-4">
                <Medal className="text-green-500 w-6 h-6" />
                <h2 className="font-bold text-2xl text-white">Waiting Room</h2>
              </div>
              {seedingPlayers && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
                  <b>Fetching players…</b> You can stay in the room while the player pool loads.
                </div>
              )}
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Left: Room & Managers */}
              <Card className="bg-pitch text-line shadow-lg border border-goal min-h-[420px]">
                <CardHeader>
                  <CardTitle className="font-sporty text-2xl md:text-3xl">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span>🏟️</span>

                      {!isEditingDraftName ? (
                        <>
                          <span className="tracking-wide">{room?.name || "Friends Draft"}</span>

                          {isHost && (
                            <button
                              type="button"
                              className="rounded-md px-3 py-2 text-sm font-semibold tracking-widest bg-line/25 hover:bg-line/35 border border-line/60"
                              onClick={() => setIsEditingDraftName(true)}
                              title="Edit draft name"
                            >
                              Edit
                            </button>
                          )}
                        </>
                      ) : (
                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            value={draftNameInput}
                            onChange={(e) => setDraftNameInput(e.target.value)}
                            className="w-56 max-w-full rounded border border-line/60 bg-white px-2 py-1 text-lg  tracking-widest text-slate-900"
                            placeholder="Draft name"
                            autoFocus
                          />
                          <button
                            type="button"
                            className="rounded px-2 py-1 text-xs tracking-widest bg-goal text-ball hover:opacity-95"
                            onClick={saveDraftName}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="rounded px-2 py-1 text-xs tracking-widest bg-line/20 hover:bg-line/30"
                            onClick={() => {
                              setDraftNameInput(room?.name || "Friends Draft");
                              setIsEditingDraftName(false);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-base md:text-lg font-bold tracking-widest">Room Code:</span>
                      <span className="px-3 py-1 rounded-lg bg-pitchLight border border-line/60 text-base md:text-lg font-bold tracking-widest">
                        {room.code || roomId}
                      </span>
                    </div>
                  </CardTitle>
                  
                </CardHeader>
                <CardContent>
                  <h3 className="font-semibold mb-2">⚽ Managers in Room</h3>
                  <div className="space-y-2">
                    {(room.members || []).map((m) => (
                      <div
                        key={m.uid}
                        className="flex items-center justify-between rounded-lg border border-line/60 bg-pitchLight p-2"
                      >
                        <div className="flex items-center gap-3">
                          {(() => {
                            const p = profileOf(m.uid);
                            const name = displayNameOf(m);
                            return (
                              <Avatar className="h-10 w-10 border-2 border-line/60">
                                <AvatarImage src={p.photoURL || undefined} alt={name} />
                                <AvatarFallback className="bg-line text-pitch font-bold">
                                  {(name || "U").slice(0, 2).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                            );
                          })()}

                          <span className="font-medium">{displayNameOf(m)}</span>
                        </div>

                        <div className="flex items-center gap-2">
                          {m.uid === room.hostUid && (
                            <Badge className="bg-goal text-ball">Host</Badge>
                          )}

                          {isHost && !room.started && m.uid !== room.hostUid && (
                            <button
                              type="button"
                              onClick={() => handleKickMember(m)}
                              className="rounded-md border border-red-400/60 bg-red-500/15 px-2 py-1 text-xs font-semibold text-red-100 hover:bg-red-500/25"
                            >
                              Kick
                            </button>
                          )}
                        </div>
                      </div>
                    ))}

                    {(!room.members || room.members.length === 0) && (
                      <p className="text-sm opacity-80">No members yet.</p>
                    )}
                  </div>

                  <h3 className="font-semibold mt-4 mb-2">📋 Draft Order (Round 1)</h3>
                  <ol className="text-sm space-y-1 list-decimal list-inside">
                    {roundOrder(room.members || [], 0).map((m, idx) => (
                      <li key={m.uid} className="rounded border border-line/60 bg-pitch/70 px-2 py-1">
                        #{idx + 1} — {displayNameOf(m)}
                      </li>
                    ))}
                  </ol>
                  <p className="text-xs opacity-90 mt-2">
                    Order locks when the host starts.
                  </p>
                </CardContent>
              </Card>

              {/* Right: Draft Status / Host Controls */}
              <Card className="bg-pitch text-line shadow-lg border border-goal min-h-[420px]">
                <CardHeader>
                  <CardTitle className="font-sporty text-2xl">📊 Draft Status</CardTitle>
                </CardHeader>
                <CardContent>
                  {competitionLabel ? (
                    <div className="draftCompetitionMeta">
                      <span className="draftCompetitionHead">Competition:</span>
                      <span className="draftCompetitionLabel">
                        <FlagIcon
                          country={competitionCountry}
                          size={16}
                          title={competitionCountry}
                        />
                        <b>{competitionLabel}</b>
                      </span>
                    </div>
                  ) : null}

                  <div className="mt-6">
                  
                  <LeagueSelector
                    roomId={roomId}
                    room={room}
                    isHost={isHost}
                    poolCount={poolPlayers.length}
                    setSeedingPlayers={setSeedingPlayers}
                  />
                 
                  {!isHost && (
                    <div className="mt-4 text-center text-gray-500 text-sm">
                      Waiting for host to start...
                    </div>
                  )}
                </div>
                  <p className="text-sm mb-3">
                    {room.startAt ? "Scheduled" : "Not scheduled"} • Turn: {room.turnIndex ?? 0}
                  </p>
                  {/* Everyone sees scheduled draft start */}
                  {room.startAt ? (
                    <div className="text-sm mb-3">
                      🗓️ <b>Draft starts:</b> {formatWhen(room.startAt)}{" "}
                      <span className="opacity-80">
                        ({countdownStr(secondsUntil(room.startAt, clockNow))} remaining)
                      </span>
                    </div>
                  ) : (
                    <div className="text-sm mb-3 opacity-80">
                      🗓️ Draft start time not set yet.
                    </div>
                  )}

                  {user?.uid === room.hostUid ? (
                    <HostControls
                      startLocalISO={startLocalISO}
                      setStartLocalISO={setStartLocalISO}
                      scheduleStart={scheduleStart}
                      startNow={startNow}
                      seedingPlayers={seedingPlayers || room?.status === "seeding_players"}
                      canStart={poolReady}
                    />
                  ) : (
                    <p className="text-sm opacity-90">
                      Waiting for host to schedule or start…
                    </p>
                  )}
                  <p className="mt-4 text-xs opacity-90">
                    Draft plan: Pick any player.
                  </p>
                </CardContent>
              </Card>
            </div>
            </div>
          )}


          {/* Draft started */}
          {room.started && (
            <div className="grid gap-4 md:grid-cols-3">
              {/* Summary + countdown */}
              <div className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm">
                <div className="font-semibold">{room.name} — {room.code || roomId}</div>
                <div className="text-sm opacity-70">
                  Round: <b>{Math.floor((room.turnIndex ?? 0) / (room.members?.length || 1)) + 1}</b> / {room.totalRounds ?? DRAFT_SIZE_LEAGUE}
                </div>
                {competitionLabel ? (
                  <div className="draftCompetitionMeta">
                    <span className="draftCompetitionHead">Competition:</span>
                    <span className="draftCompetitionLabel">
                      <FlagIcon
                        country={competitionCountry}
                        size={16}
                        title={competitionCountry}
                      />
                      <b>{competitionLabel}</b>
                    </span>
                  </div>
                ) : null}

                <DraftFormationRules />
                <DraftPositionTracker
                  counts={myDraftPositionCounts}
                  total={myDraftedCount}
                />

                <div className="draftTurnBanner">
                  <div className="draftTurnMain">
                    <Avatar className="draftTurnAvatar">
                      <AvatarImage src={currentPhoto || undefined} alt={currentName} />
                      <AvatarFallback className="draftTurnFallback">
                        {(currentName || "U").slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>

                    <div>
                      <div className="draftTurnLabel">On the clock</div>
                      <div className="draftTurnName">{currentName}</div>
                    </div>
                  </div>

                  <div className="draftTurnNext">
                    <div className="draftTurnLabel">Next</div>
                    <div className="draftTurnNextRow">
                      <Avatar className="draftTurnAvatarSmall">
                        <AvatarImage src={nextPhoto || undefined} alt={nextName} />
                        <AvatarFallback className="draftTurnFallbackSmall">
                          {(nextName || "U").slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="draftTurnNextName">{nextName}</span>
                    </div>
                  </div>
                </div>
                {!isDraftComplete && (
                  <div className="mt-3">
                    <div className="text-sm font-semibold">Time left</div>
                    <div className={`text-2xl font-bold ${timeLeft <= 5 ? "text-red-600" : ""}`}>{timeLeft}s</div>
                    {user?.uid === room.hostUid && (
                      <div className="text-xs opacity-70 mt-1">Site will auto-pick if timer hits 0.</div>
                    )}
                  </div>
                )}
              </div>

              {/* Player Pool (only current picker sees it) */}
              {isDraftComplete ? (
                <div className="rounded-2xl border border-emerald-300 p-4 bg-emerald-50 shadow-sm md:col-span-1 grid place-items-center">
                  <div className="text-center">
                    <div className="font-semibold">Draft complete 🎉</div>
                    <div className="text-sm opacity-70">All rounds are finished.</div>
                  </div>
                </div>
              ) : currentPicker?.uid === user?.uid ? (
                <PlayerPool
                  availablePlayers={availablePlayers}
                  loadingPlayers={loadingPlayers}
                  posFilter={posFilter}
                  setPosFilter={setPosFilter}
                  search={search}
                  setSearch={setSearch}
                  onPick={pickPlayer}
                  requiredSlot={requiredSlot}
                />
              ) : (
                <div className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm md:col-span-1 grid place-items-center">
                  <div className="text-center">
                    <div className="font-semibold">Waiting for pick…</div>
                    <div className="text-sm opacity-70">
                      {displayNameOf(currentPicker, "Someone")} is on the clock.
                    </div>
                  </div>
                </div>
              )}

              {/* Draft Order + Picks */}
              <div className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm md:col-span-1">
                <div className="font-semibold mb-2">Draft Order (Frozen)</div>
                <ol className="text-sm space-y-1 list-decimal list-inside">
                  {(room.draftOrder || []).map((m, idx) => {
                    const isCurrent = currentPicker?.uid === m.uid;
                    return (
                      <li
                        key={m.uid}
                        className={`border rounded px-2 py-1 ${isCurrent ? "bg-yellow-50 border-yellow-300" : ""}`}
                        title={isCurrent ? "On the clock" : ""}
                      >
                        #{idx + 1} — {displayNameOf(m)} {isCurrent ? " • on the clock" : ""}
                      </li>
                    );
                  })}
                  {(!room.draftOrder || room.draftOrder.length === 0) && (
                    <div className="opacity-60">Order appears when the draft starts.</div>
                  )}
                </ol>

                <div className="mt-4">
                  <div className="font-semibold mb-1">
                    This Round Order (Round {Math.floor((room.turnIndex ?? 0) / (room.members?.length || 1)) + 1})
                  </div>
                  <ol className="text-sm space-y-1 list-decimal list-inside">
                    {roundOrder(room.draftOrder || room.members || [], Math.floor((room.turnIndex ?? 0) / (room.members?.length || 1)))
                      .map((m, idx) => {
                        const isCurrent = currentPicker?.uid === m.uid;
                        return (
                          <li key={m.uid} className={`border rounded px-2 py-1 ${isCurrent ? "bg-green-50 border-green-300" : ""}`}>
                            #{idx + 1} — {displayNameOf(m)} {isCurrent ? " • on the clock" : ""}
                          </li>
                        );
                      })}
                  </ol>
                </div>
                
                <div className="allPicksHeaderRow">
                  <div className="font-semibold">All Picks</div>

                  <div className="allPicksControls">
                    <select
                      className="allPicksSelect"
                      value={allPicksPos}
                      onChange={(e) => setAllPicksPos(e.target.value)}
                    >
                      <option value="ALL">All</option>
                      <option value="ATT">ATT</option>
                      <option value="MID">MID</option>
                      <option value="DEF">DEF</option>
                      <option value="GK">GK</option>
                    </select>

                    <input
                      className="allPicksSearch"
                      placeholder="Search player or manager…"
                      value={allPicksQuery}
                      onChange={(e) => setAllPicksQuery(e.target.value)}
                      
                    />

              
                  </div>
                </div>

                <ol className="text-sm space-y-1 max-h-[40vh] overflow-auto">
                  {filteredPicks.map((p) => {
                    const isMine = p.uid === user?.uid;
                    const mgr = managerLabel(p.uid, p.displayName || "Someone");

                    return (
                      <li
                        key={p.playerId}
                        className={`pickRow ${isMine ? "pickRowMine" : ""}`}
                      >
                        <span className="pickMain flex-wrap gap-1 items-center">
                          <span><b>#{p.turn}</b> — </span>
                          <span
                            className="pickManagerPill"
                            style={managerPillStyle(p.uid, isMine)}
                            title={isMine ? "Your pick" : mgr}
                          >
                            {mgr}
                          </span>
                          <span> picked <b>{p.playerName}</b> </span>
                          
                       
                          <span className="opacity-70 text-xs inline-flex items-center gap-1">
                            {p.position}
                            {p.teamName ? <span> • {p.teamName}</span> : null}
                            {p.nationality ? (
                              <>
                                <span> • </span>
                                <FlagIcon country={p.nationality} size={12} />
                                <span>{p.nationality}</span>
                              </>
                            ) : null}
                          </span>
                        </span>

                        <span className="opacity-70 whitespace-nowrap">Round {p.round}</span>
                      </li>
                    );
                  })}

                  {filteredPicks.length === 0 && (
                    <div className="opacity-60">
                      No picks match your search/filter.
                    </div>
                  )}
                </ol>

                
              </div>
            </div>         
          )}

          {roomId && isDraftComplete && (
            <div className="mt-6">
              <Marketplace
                roomId={roomId}
                user={user}
                isHost={user?.uid === room?.hostUid}
                players={poolPlayers}
              />
            </div>
          )}


        </>
      )}
      </div>
    </div>
  );
}

// ----- Subcomponents -----
function HostControls({ startLocalISO, setStartLocalISO, scheduleStart, startNow, seedingPlayers, canStart }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      <input
        type="datetime-local"
        className="ff-input draftScheduleInput"
        value={startLocalISO}
        onChange={(e) => setStartLocalISO(e.target.value)}
      />
      <button onClick={scheduleStart} disabled={seedingPlayers} className="ff-btn ff-btn--warn">
        {seedingPlayers ? "Fetching players..." : "Schedule"}
      </button>

      <button
        onClick={startNow}
        disabled={seedingPlayers || !canStart}
        className="ff-btn ff-btn--primary"
        title={!canStart ? "Load players first" : "Start draft"}
      >
        {seedingPlayers ? "Fetching players..." : "Start Draft Now"}
      </button>

      {!canStart ? (
        <div className="text-xs opacity-80">
          Select + lock a competition and load players first.
        </div>
      ) : null}
    </div>
  );
}


function PlayerPool({
  availablePlayers,
  loadingPlayers,         
  posFilter,
  setPosFilter,
  search,
  setSearch,
  onPick,
  requiredSlot,
}) {
  return (
    <div className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm md:col-span-1">
      <div className="font-semibold mb-2">Player Pool</div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          className="border px-3 py-2 rounded"
          value={posFilter}
          onChange={(e) => setPosFilter(e.target.value)}
        >
          <option value="ALL">All</option>
          <option value="ATT">ATT</option>
          <option value="MID">MID</option>
          <option value="DEF">DEF</option>
          <option value="GK">GK</option>
        </select>

        <input
          className="draftPlayerSearchInput flex-1 min-w-[200px]"
          placeholder="Search player, club, nation, or position…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <DraftFormationRules compact />

      <div className="grid gap-2">
        {loadingPlayers ? (
          <div className="opacity-70 p-2">Loading players from API…</div>
        ) : (
          <>
            {availablePlayers.map((pl) => {
              const drafted = !!pl.isDrafted; // <-- from your useMemo map()
              const blocked =
                requiredSlot && requiredSlot !== "SUB" && pl.position !== requiredSlot;

              const disabled = drafted || blocked;

              const title = drafted
                ? "Already drafted"
                : blocked
                ? `This round requires ${requiredSlot}`
                : "Pick";

              return (
                <div
                  key={pl.id}
                  className={`border rounded p-3 flex items-center justify-between ${
                    drafted ? "opacity-60" : ""
                  }`}
                >
                  <div>
                    <div className="font-semibold flex items-center gap-2">
                      <span>{pl.name}</span>

                      {/* ✅ Drafted badge */}
                      {drafted && <span className="draftedBadge">Drafted</span>}
                    </div>

                    <div className="text-xs opacity-70 flex items-center gap-1 mt-0.5 flex-wrap">
                      <span>{pl.position}</span>
                      {pl.teamName ? <span> • {pl.teamName}</span> : null}
                      {pl.nationality ? (
                        <span className="flex items-center gap-1">
                          <span> • </span>
                          <FlagIcon country={pl.nationality} size={12} />
                          <span>{pl.nationality}</span>
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="border px-3 py-1 rounded bg-black text-white disabled:opacity-50"
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return; // extra safety
                      onPick(pl);
                    }}
                    title={title}
                  >
                    {drafted ? "Taken" : "Pick"}
                  </button>
                </div>
              );
            })}

            {availablePlayers.length === 0 && (
              <div className="opacity-60">No players match your filters.</div>
            )}

          </>
        )}
      </div>
    </div>
  );
}

function LeagueSelector({ roomId, room, isHost, poolCount, setSeedingPlayers }) {
  const [queryText, setQueryText] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [season, setSeason] = useState(String(new Date().getFullYear()));
  const [searching, setSearching] = useState(false);
  const [locking, setLocking] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState("");

  const locked =
    !!room?.competitionLocked ||
    room?.status === "seeding_players" ||
    room?.status === "ready_to_draft" ||
    !!room?.started;

  // Show what's already locked in (for everyone)
  useEffect(() => {
    const c = room?.competition;
    const m = room?.competitionMeta;
    if (!c || !m) return;

    setSelected({
      leagueId: String(c.league),
      name: m.name,
      country: m.country,
      type: m.type,
      logo: m.logo,
    });
    setSeason(String(c.season || ""));
  }, [room?.competition?.league, room?.competition?.season, room?.competitionMeta?.name]);

  // Debounced API search
  useEffect(() => {
    if (!isHost || locked) return;

    const q = queryText.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }

    const t = setTimeout(async () => {
      setSearching(true);
      setError("");
      try {
        const fn = httpsCallable(functions, "searchLeagues");
        const res = await fn({ query: q });
        setResults(res.data?.results || []);
      } catch (e) {
        console.warn(e);
        setError("Search failed (did you deploy functions:searchLeagues?)");
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(t);
  }, [queryText, isHost, locked]);

  // countdown tick
  useEffect(() => {
    if (!locking) return;
    if (countdown <= 0) return;

    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [locking, countdown]);

  async function doLockAndSeed() {
    if (!isHost || locked) return;
    if (!selected?.leagueId) return;

    const leagueIdNum = Number(selected.leagueId);
    const seasonNum = Number(season);
    const timezone = "America/Los_Angeles";

    const totalRoundsForComp = draftSizeForCompetitionType(selected.type);
    try {
      setSeedingPlayers(true);
      setError("");

      // Mark as locked + seeding
      await updateDoc(doc(db, "rooms", roomId), {
        competition: { provider: "api-football", league: leagueIdNum, season: seasonNum, timezone },
        competitionMeta: {
          name: selected.name,
          country: selected.country,
          type: selected.type,
          logo: selected.logo,
        },
        competitionLocked: true,
        status: "seeding_players",
        totalRounds: totalRoundsForComp,
        playerCount: 0,
        updatedAt: serverTimestamp(),
      });

      // Seed players (league paging mode)
      const seedFn = httpsCallable(functions, "seedPlayersFromCompetition");
      const res = await seedFn({
        roomId,
        league: leagueIdNum,
        season: seasonNum,
        timezone,
        maxPages: 250, // adjust higher if you want a bigger pool
        maxPlayers: 1500,
      });
      alert(`Successfully loaded ${res.data?.written ?? 0} players.`);

      const written = res.data?.written ?? 0;

      await updateDoc(doc(db, "rooms", roomId), {
        competitionLocked: true,
        status: "ready_to_draft",
        playerCount: written,
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      console.error(e);
      const playersSnap = await getDocs(collection(db, "rooms", roomId, "players")).catch(() => null);
      const loadedCount = playersSnap?.size || 0;

      if (loadedCount > 0) {
        setError("Players loaded, but the backend returned a non-critical error. Room is ready to draft.");
        await updateDoc(doc(db, "rooms", roomId), {
          competitionLocked: true,
          status: "ready_to_draft",
          playerCount: loadedCount,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      } else {
        setError(e?.message || "Failed to seed players.");
        await updateDoc(doc(db, "rooms", roomId), {
          competitionLocked: false,
          status: "waiting_competition",
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
    } finally {
      setSeedingPlayers(false);
    }
  }

  function startLockCountdown() {
    if (!selected?.leagueId) return;
    setLocking(true);
    setCountdown(3);
    setError("");
  }

  // when countdown hits 0, lock/seed
  useEffect(() => {
    if (!locking) return;
    if (countdown > 0) return;

    setLocking(false);
    doLockAndSeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locking, countdown]);

  const statusLabel =
    room?.status === "seeding_players"
      ? "Loading players…"
      : room?.status === "ready_to_draft"
      ? "Ready to draft ✅"
      : "Waiting for competition";

  // Non-host view
  if (!isHost) {
    return (
      <div className="p-4 border border-gray-700 rounded bg-gray-900 mb-6">
        <div className="text-xs text-gray-400 mb-1">Competition</div>
        <div className="text-white font-bold">
          {selected ? `${selected.name} (${season})` : "Host has not selected yet."}
        </div>
        <div className="text-xs text-gray-400 mt-2">
          Status: <b>{statusLabel}</b> • Players loaded: <b>{poolCount}</b>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 border border-gray-700 rounded bg-gray-900 mb-6">
      <h3 className="font-bold text-white mb-2">Step 1: Choose Competition</h3>

      <div className="text-xs text-gray-400 mb-3">
        Search leagues/cups (ex: “World Cup”, “Champions League”, “Premier League”), then lock it in.
      </div>

      {locked ? (
        <>
          <div className="text-white font-bold">
            Locked: {selected ? `${selected.name} (${season})` : "—"}
          </div>
          <div className="text-xs text-gray-400 mt-2">
            Status: <b>{statusLabel}</b> • Players Loaded: <b>{poolCount}</b> • Player Count: <b>{room?.playerCount ?? 0}</b>
          </div>
        </>
      ) : (
        <>
          <input
            className="draftCompetitionSearchInput"
            placeholder="Search leagues/cups…"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            disabled={locking}
          />

          <div className="mt-2 flex gap-2 items-center">
            <input
              className="draftSeasonInput"
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              placeholder="Season"
              disabled={locking}
            />

            <button
              className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded text-sm font-bold disabled:opacity-50"
              onClick={startLockCountdown}
              disabled={!selected?.leagueId || locking}
            >
              Lock In
            </button>

            {locking ? (
              <button
                className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded text-sm font-bold"
                onClick={() => {
                  setLocking(false);
                  setCountdown(0);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>

          {locking ? (
            <div className="mt-2 text-sm text-amber-300 font-bold">
              Locking in: {countdown}…
            </div>
          ) : null}

          {searching ? <div className="mt-2 text-xs text-gray-400">Searching…</div> : null}
          {error ? <div className="mt-2 text-xs text-red-300">{error}</div> : null}

          {/* Results */}
          {results.length ? (
            <div className="mt-3 border border-gray-700 rounded overflow-hidden">
              {results.map((r) => (
                <button
                  key={r.leagueId}
                  className="w-full text-left px-3 py-2 text-sm text-white hover:bg-gray-800 flex justify-between"
                  onClick={() => {
                    setSelected(r);
                    setSeason(String(r.currentSeason || r.seasons?.[0] || season));
                    setResults([]);
                    setQueryText(`${r.name}`);
                  }}
                >
                  <span>
                    <b>{r.name}</b> <span className="text-gray-400">• {r.country} • {r.type}</span>
                  </span>
                  <span className="text-gray-400">{r.currentSeason || ""}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="mt-3 text-xs text-gray-400">
            Selected:{" "}
            <b className="text-white">
              {selected ? `${selected.name} (${season})` : "—"}
            </b>{" "}
            • Players loaded: <b className="text-white">{poolCount}</b>
          </div>
        </>
      )}
    </div>
  );
}
