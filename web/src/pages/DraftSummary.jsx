// web/src/pages/DraftSummary.jsx
import { useEffect, useMemo, useState, useRef } from "react";
import { auth, db, functions, watchRoom, getLastRoomId } from "../firebase";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { setLastRoomId } from "../firebase";
import TradePanel from "../components/ui/TradePanel";
import useUserProfiles from "../lib/useUserProfiles";
import { Avatar, AvatarImage, AvatarFallback } from "../components/ui/avatar";
import useTeamNames from "../lib/useTeamNames";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import "./DraftSummary.css";
import FlagIcon from "@/components/FlagIcon";


const DEFAULT_DRAFT_PLAN = ["ATT", "ATT", "MID", "MID", "DEF", "DEF", "GK", "SUB", "SUB"];
const STARTING_CAP = 11;
const STARTER_RULES = {
  GK:  { min: 1, max: 1 },
  DEF: { min: 3, max: 5 },
  MID: { min: 3, max: 5 },
  ATT: { min: 1, max: 3 },
};


function displayNameOf(m) {
  return m?.displayName || m?.uid || "User";
}


//Subs locked
function useSubsLock(roomId, enabled) {
  const [locked, setLocked] = useState(false);
  const [livePlayers, setLivePlayers] = useState([]);

  useEffect(() => {
    if (!enabled || !roomId) {
      setLocked(false);
      setLivePlayers([]);
      return;
    }

    let cancelled = false;
    const fn = httpsCallable(functions, "getUserLockStatus");

    async function run() {
      try {
        const res = await fn({ roomId });
        if (cancelled) return;
        setLocked(!!res.data.locked);
        setLivePlayers(res.data.livePlayers || []);
      } catch (e) {
        // If the function errors, fail open (don’t lock)
        if (!cancelled) {
          setLocked(false);
          setLivePlayers([]);
        }
      }
    }

    run();
    const id = setInterval(run, 30000); // poll every 30s
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [roomId, enabled]);

  return { locked, livePlayers };
}


export default function DraftSummary() {
  // pick up room from URL or last saved
  const [urlRoomId] = useState(() => {
    const url = new URL(window.location.href);
    return url.searchParams.get("room") || getLastRoomId() || "";
  });

  // We'll allow the UI to switch rooms via prompt as well
  const [roomId, setRoomId] = useState(urlRoomId);

  //Use team name
  const teamNamesByUid = useTeamNames(roomId);
  const myUid = auth.currentUser?.uid;
 //Trade: user to user
  const [room, setRoom] = useState(null);
  const [picks, setPicks] = useState([]);
  const tradeRoomPath = room?.code && room.code !== roomId ? room.code : roomId;
  const [sortMode, setSortMode] = useState("order"); // 'order' | 'alpha'

  useEffect(() => {
    if (!tradeRoomPath) return;

    const q = query(
      collection(db, "rooms", tradeRoomPath, "picks"),
      orderBy("turn")
    );

    return onSnapshot(q, (snap) => {
      setPicks(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [tradeRoomPath]);
 
  // Persist last used room id for convenience
  useEffect(() => {
    if (roomId) localStorage.setItem("lastRoomId", roomId);
    if(roomId) setLastRoomId(roomId);
  }, [roomId]);

  // Live room doc (by current roomId)
  useEffect(() => {
    if (!roomId) return;
    const unsub = watchRoom(roomId, (data) => setRoom(data || null));
    return () => unsub && unsub();
  }, [roomId]);

  /**
   * Picks stream
   * Some projects created rooms with a doc ID different from the visible room "code".
   * This listener will:
   *   1) Start listening at rooms/{roomId}/picks
   *   2) If the loaded room contains a different .code, it will rewire to rooms/{room.code}/picks
   */
  useEffect(() => {
    let unsub = null;

    function attach() {
      if (!tradeRoomPath) return;
      const picksRef = collection(db, "rooms", tradeRoomPath, "picks");
      const q = query(picksRef, orderBy("turn", "asc"));
      unsub = onSnapshot(q, (snap) => {
        setPicks(snap.docs.map((d) => ({id: d.id, ...d.data()}))); // expects {playerId, playerName, position, uid, displayName, turn, round}
      });
    }

    // 1) start with roomId immediately
    attach(roomId);

    return () => {
      if (unsub) unsub();
    };
  }, [roomId]);

  // If the loaded room has a different .code than roomId, prefer that path for picks
  useEffect(() => {
    if (!room?.code || room?.code === roomId) return;

    // Swap listener to the room.code path
    const picksRef = collection(db, "rooms", tradeRoomPath, "picks");
    const q = query(picksRef, orderBy("turn", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      setPicks(snap.docs.map((d) => ({id: d.id, ...d.data()})));
    });
    return () => unsub();
  }, [room?.code, roomId]);

  const members = useMemo(() => (Array.isArray(room?.members) ? room.members : []), [room?.members]);
  const draftOrder = useMemo(
    () => (Array.isArray(room?.draftOrder) && room.draftOrder.length ? room.draftOrder : members),
    [room?.draftOrder, members]
  );

  // Profiles (photoURL + displayName) for members
  const memberUids = useMemo(() => members.map((m) => m.uid).filter(Boolean), [members]);
  const profilesByUid = useUserProfiles(memberUids);
  const profileOf = (uid) => profilesByUid?.[uid] || {};


  // Group picks by manager uid
  const byManager = useMemo(() => {
    const map = new Map();
    for (const m of members) {
      map.set(m.uid, { manager: m, picks: [] });
    }
    for (const p of picks) {
      const uid = p.uid || "unknown";
      if (!map.has(uid)) {
        map.set(uid, { manager: { uid, displayName: p.displayName || uid }, picks: [] });
      }
      map.get(uid).picks.push(p);
    }
    return map;
  }, [members, picks]);

  // Ordering of manager cards (you first, then by draft order or A–Z)
  const currentUid = auth.currentUser?.uid || null;
  const managerRows = useMemo(() => {
    const rows = Array.from(byManager.values());

    rows.sort((a, b) => {
      const aYou = a.manager.uid === currentUid;
      const bYou = b.manager.uid === currentUid;
      if (aYou && !bYou) return -1;
      if (bYou && !aYou) return 1;

      if (sortMode === "alpha") {
        const an = (a.manager.displayName || "").toLowerCase();
        const bn = (b.manager.displayName || "").toLowerCase();
        return an.localeCompare(bn);
      }

      // sort by draft order
      const aIdx = draftOrder.findIndex((m) => m.uid === a.manager.uid);
      const bIdx = draftOrder.findIndex((m) => m.uid === b.manager.uid);
      if (aIdx === -1 && bIdx === -1) return 0;
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });

    return rows;
  }, [byManager, draftOrder, currentUid, sortMode]);

  // Header computed values
  const totalRounds = room?.totalRounds ?? 9;
  const perRoundPlan =
    Array.isArray(room?.draftPlan) && room.draftPlan.length === totalRounds
      ? room.draftPlan
      : DEFAULT_DRAFT_PLAN;

  const n = draftOrder.length || 1;
  const turnIndex = Number.isFinite(room?.turnIndex) ? room.turnIndex : 0;
  const roundNumber = Math.floor(turnIndex / n) + 1;
  const requiredSlot = perRoundPlan[roundNumber - 1] || null;
  const competitionName =
    room?.competitionMeta?.name ||
    room?.competition?.name ||
    "";

  const competitionSeason =
    room?.competition?.season ||
    room?.competitionMeta?.season ||
    "";

  const competitionCountry = room?.competitionMeta?.country || "";

  const competitionLabel = [competitionSeason, competitionName]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="vrPage min-h-screen w-full p-4 md:p-6">
      {/* Header */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">
              {room?.name || "Draft Room"}{" "}
              {room?.code ? `— ${room.code}` : roomId ? `— ${roomId}` : ""}
            </div>
            <div className="text-sm text-gray-600">
              Host: <b>{displayNameOf(members.find((m) => m.uid === room?.hostUid))}</b> ·{" "}
              Status: {room?.started ? <b>Live</b> : <b>Waiting</b>} ·{" "}
              Round: <b>{Math.max(1, Math.min(roundNumber, totalRounds))}</b> / {totalRounds} ·{" "}
              Required: <b>{requiredSlot || "-"}</b>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/*<button
            type="button"
              className="px-3 py-2 rounded border"
              onClick={() => {
                const id = prompt("Enter room key to switch");
                if (id) setRoomId(id.toUpperCase());
              }}
            >
              Switch Room
            </button>
            <button
            type="button"
              className="px-3 py-2 rounded border"
              onClick={() => {
                if (!roomId) return;
                navigator.clipboard.writeText(`${window.location.origin}/room?room=${room?.code || roomId}`);
                alert("Link copied");
              }}
              disabled={!roomId}
            >
              Copy Link
            </button> */}
            <select
              className="px-2 py-2 rounded border"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value)}
              title="Sort teams"
            >
              <option value="order">Order</option>
              <option value="alpha">A–Z</option>
            </select>
          </div>
        </div>

        {competitionLabel ? (
          <div className="mt-3">
            <div className="text-sm text-gray-600 mb-1">Competition</div>
            <div className="flex items-center gap-2 text-sm">
              <FlagIcon
                country={competitionCountry}
                size={16}
                title={competitionCountry}
              />
              <span className="font-medium">{competitionLabel}</span>
            </div>
          </div>
        ) : null}

        {/* Members */}
        <div className="mt-3">
          <div className="text-sm text-gray-600 mb-1">Members</div>
          <div className="flex flex-wrap gap-2">
              {(members || []).map((m) => {
                const p = profileOf(m.uid);
                const name = displayNameOf(m);

                return (
                  <div
                    key={m.uid}
                    className="flex items-center gap-2 px-2 py-1 rounded bg-gray-100 text-sm"
                  >
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={p.photoURL || ""} alt={name} />
                      <AvatarFallback className="text-[10px] font-bold">
                        {(name || "U").slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span>{name}</span>
                  </div>
                );
              })}
            {(!members || members.length === 0) && (
              <div className="text-sm text-gray-500">No members yet.</div>
            )}
          </div>
        </div>
      </div>

      {/* Rules / Info panel */}
      <div className="dsInfoPanel">
        <div className="dsInfoTop">
          <div>
            <div className="dsInfoTitle">Rules</div>
            <div className="dsInfoSub">
              
            </div>
          </div>

          {/* optional placeholder: later you can add a button/menu here */}
          <div className="dsInfoRightHint"></div>
        </div>

        <div className="dsInfoGrid">
          <div className="dsInfoBlock">
            <div className="dsInfoBlockTitle">Starting XI formation</div>
            <div className="dsRulePills">
              <span className="dsRulePill">GK: 1</span>
              <span className="dsRulePill">DEF: 3–5</span>
              <span className="dsRulePill">MID: 3–5</span>
              <span className="dsRulePill">ATT: 1–3</span>
            </div>
            <div className="dsInfoNote">
              Total starters must be 11. Bench does not score.
            </div>
          </div>

          <div className="dsInfoBlock">
            <div className="dsInfoBlockTitle">Substitution lock</div>
            <div className="dsInfoNote">
              Subs are disabled if the player you’re subbing <b>IN</b> is <b>LIVE</b>, or the starter
              you’re subbing <b>OUT</b> is <b>LIVE</b>.
            </div>
            <div className="dsInfoNote">
              
            </div>
          </div>
        </div>

        {/* Reserved space for future widgets */}
        <div className="dsInfoFooter">
          <span className="dsInfoFooterHint"></span>
        </div>
      </div>

      {/* Rosters */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {managerRows.map(({ manager, picks }) => (
          <ManagerRosterCard
            key={manager.uid}
            manager={manager}
            picks={picks}
            totalRounds={totalRounds}
            photoURL={profileOf(manager.uid).photoURL || ""}
            teamName={teamNamesByUid[manager.uid] || ""}
            roomId={roomId}
            room={room}
            roomPath={tradeRoomPath}
            myUid={myUid}
            
          />
        ))}
      </div>

      {/* Empty state */}
      {(!picks || picks.length === 0) && (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="font-semibold mb-1">No picks found yet</div>
          <div className="text-sm opacity-70">
            Make sure you opened the summary for the correct room and that drafting has started.
          </div>
        </div>
      )}

      <TradePanel
        roomId={roomId}
        tradeRoomPath={tradeRoomPath}
        room={room}
        picks={picks}
      />
    </div>
  );
}

function ManagerRosterCard({ manager, picks, totalRounds, photoURL, teamName, roomId, myUid, room, roomPath }) {
  const name = displayNameOf(manager);
  const showTeamName = teamName?.trim();
  const title = showTeamName ? `${name} — ${showTeamName}` : name;
  const lineupRoomId = roomId;

  const isMe = myUid && manager.uid === myUid;

  // Ensure the "members mirror" doc exists so Firestore rules (isRoomMember) passes.
  useEffect(() => {
    if (!isMe || !myUid || !lineupRoomId) return;

    setDoc(
      doc(db, "rooms", lineupRoomId, "members", myUid),
      {
        uid: myUid,
        displayName: displayNameOf(manager),
        lastSeenAt: serverTimestamp(),
      },
      { merge: true }
    );
  }, [isMe, myUid, roomPath, manager]);



  // Lock editing when games are live (UI-only for now)
  const lineupLocked =
    room?.gamesLive === true ||          
    !!room?.lineupsLocked ||             
    (room?.lineupLockAt && Date.now() >= Number(room.lineupLockAt));

  const { locked: liveLocked, livePlayers } = useSubsLock(lineupRoomId, isMe);
  const lockedNow = lineupLocked || liveLocked;
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(teamName || "");

  useEffect(() => setInput(teamName || ""), [teamName]);

  async function saveTeamName() {
    const clean = (input || "").trim();
    if (clean.length < 2) return alert("Team name must be at least 2 characters.");
    if (clean.length > 30) return alert("Team name must be 30 characters or less.");

    await setDoc(
      doc(db, "rooms", roomId, "teamNames", myUid),
      { teamName: clean, updatedAt: serverTimestamp() },
      { merge: true }
    );

    setEditing(false);
  }

  // ---------- LINEUP LOGIC (only for me) ----------
  const keyOf = (p) => p.playerId || p.id || p.playerName;

  const orderedPicks = useMemo(
    () => [...(picks || [])].sort((a, b) => (a.turn || 0) - (b.turn || 0)),
    [picks]
  );

  const allKeys = useMemo(() => orderedPicks.map(keyOf), [orderedPicks]);
  const pickByKey = useMemo(() => {
    const m = new Map();
    for (const p of orderedPicks) m.set(keyOf(p), p);
    return m;
  }, [orderedPicks]);


  const [lineupDoc, setLineupDoc] = useState(undefined);
  const [pendingIn, setPendingIn] = useState(null); // bench player picked to sub in
  const didInitLineup = useRef(false);
  const didRepairLineup = useRef(false);

  useEffect(() => {
    if (!lineupRoomId || !manager?.uid) return;
    const ref = doc(db, "rooms", lineupRoomId, "lineups", manager.uid);
    return onSnapshot(ref, (snap) => setLineupDoc(snap.exists() ? snap.data() : null));
  }, [lineupRoomId, manager?.uid]);

  //Helpers for starters useMemo
  // --- Starter formation rules (GK 1, DEF 3–5, MID 3–5, ATT 1–3) ---
  const posOfKey = (k) => {
    const p = pickByKey.get(k);
    const raw = (p?.position || "MID").toUpperCase();
    return STARTER_RULES[raw] ? raw : "MID";
  };

  const countByPos = (keys) => {
    const counts = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
    for (const k of keys || []) {
      const pos = posOfKey(k);
      counts[pos] = (counts[pos] || 0) + 1;
    }
    return counts;
  };

  const validateStarters = (keys) => {
    const cleanKeys = (keys || []).slice(0, STARTING_CAP);
    const counts = countByPos(cleanKeys);

    // Allow partial XI while drafting (only enforce when XI is full)
    if (cleanKeys.length < STARTING_CAP) return { ok: true, counts, errors: [] };

    const errors = [];
    for (const [pos, rule] of Object.entries(STARTER_RULES)) {
      const n = counts[pos] || 0;
      if (rule.min != null && n < rule.min) errors.push(`${pos}: need at least ${rule.min}`);
      if (rule.max != null && n > rule.max) errors.push(`${pos}: max ${rule.max}`);
    }
    return { ok: errors.length === 0, counts, errors };
  };

  const buildDefaultXI = (keys) => {
    const byPos = { GK: [], DEF: [], MID: [], ATT: [] };
    for (const k of keys || []) {
      const pos = posOfKey(k);
      if (byPos[pos]) byPos[pos].push(k);
    }

    const out = [];
    const take = (pos, n) => {
      const arr = byPos[pos] || [];
      for (const k of arr) {
        if (out.length >= STARTING_CAP) break;
        if (out.includes(k)) continue;
        out.push(k);
        if (out.filter((x) => posOfKey(x) === pos).length >= n) break;
      }
    };

    // meet mins first
    take("GK",  STARTER_RULES.GK.min);
    take("DEF", STARTER_RULES.DEF.min);
    take("MID", STARTER_RULES.MID.min);
    take("ATT", STARTER_RULES.ATT.min);

    // fill remaining, respecting max
    const counts = countByPos(out);
    for (const k of keys || []) {
      if (out.length >= STARTING_CAP) break;
      if (out.includes(k)) continue;
      const pos = posOfKey(k);
      const max = STARTER_RULES[pos]?.max ?? Infinity;
      if ((counts[pos] || 0) >= max) continue;
      out.push(k);
      counts[pos] = (counts[pos] || 0) + 1;
    }

    return out.slice(0, STARTING_CAP);
  };

  const sameKeyOrder = (a = [], b = []) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

  const starters = useMemo(() => {
    const saved = Array.isArray(lineupDoc?.starters) ? lineupDoc.starters : null;
    const base = saved && saved.length ? saved : buildDefaultXI(allKeys);

    const set = new Set(allKeys);
    return base.filter((k) => set.has(k)).slice(0, STARTING_CAP);
  }, [lineupDoc, allKeys, pickByKey]);


  const benchKeys = useMemo(() => {
    const s = new Set(starters);
    return allKeys.filter((k) => !s.has(k));
  }, [allKeys, starters]);

  // Build a quick lookup of LIVE players returned by getUserLockStatus
  const liveLookup = useMemo(() => {
    const s = new Set();
    (livePlayers || []).forEach((lp) => {
      if (!lp) return;

      // try multiple possible shapes coming back from the function
      if (lp.apiPlayerId != null) s.add(`api:${String(lp.apiPlayerId)}`);
      if (lp.playerId != null) s.add(`pid:${String(lp.playerId)}`);
      if (lp.id != null) s.add(`pid:${String(lp.id)}`);
      if (lp.name) s.add(`name:${String(lp.name).toLowerCase()}`);
    });
    return s;
  }, [livePlayers]);

  const isPickLive = (p) => {
    if (!p) return false;

    const api = p.apiPlayerId ?? p.api_player_id ?? p.apiPlayerID;
    if (api != null && liveLookup.has(`api:${String(api)}`)) return true;

    const pid = p.playerId ?? p.id;
    if (pid != null && liveLookup.has(`pid:${String(pid)}`)) return true;

    const nm = (p.playerName || p.name || "").toLowerCase();
    if (nm && liveLookup.has(`name:${nm}`)) return true;

    return false;
  };

  // If you selected a bench player already, track whether THEY are live
  const pendingPick = pendingIn ? pickByKey.get(pendingIn) : null;
  const pendingIsLive = pendingPick ? isPickLive(pendingPick) : false;

  async function saveStarters(next) {
    if (!isMe || lockedNow) return;

    const clean = (next || []).slice(0, STARTING_CAP);

    const v = validateStarters(clean);
    if (!v.ok) {
      alert(
        `Invalid starting XI (Rules: GK 1, DEF 3–5, MID 3–5, ATT 1–3)\n\n${v.errors.join("\n")}`
      );
      return;
    }
    
    // 1) Build detailed objects for starters
    const startingXI = clean.map((k) => {
      const p = pickByKey.get(k);
      const rawPos = (p?.position || "MID").toUpperCase();
      const normPos = rawPos === "ATT" ? "FWD" : rawPos;

      return {
        id: k,
        name: p?.playerName || "",
        position: normPos,
        teamId: p?.teamId ?? p?.apiTeamId ?? null,
        apiPlayerId: p?.apiPlayerId ?? null,
      };
    });

    // 2) Build explicit bench lists for BOTH regular season and cup engines
    const sSet = new Set(clean);
    const benchKeys = allKeys.filter(k => !sSet.has(k));
    
    const benchXI = benchKeys.map((k) => {
      const p = pickByKey.get(k);
      const rawPos = (p?.position || "MID").toUpperCase();
      const normPos = rawPos === "ATT" ? "FWD" : rawPos;

      return {
        id: k,
        name: p?.playerName || "",
        position: normPos,
        teamId: p?.teamId ?? p?.apiTeamId ?? null,
        apiPlayerId: p?.apiPlayerId ?? null,
      };
    });

    try {
      // 3) Keep the member mirror update (Crucial for both engines to see you)
      await setDoc(
        doc(db, "rooms", lineupRoomId, "members", myUid),
        { uid: myUid, lastSeenAt: serverTimestamp() },
        { merge: true }
      );

      // 4) Write lineup with FULL explicit data for both Matchday & Cup
      await setDoc(
        doc(db, "rooms", lineupRoomId, "lineups", myUid),
        {
          uid: myUid,
          starters: clean,       // String IDs
          startingXI,            // Objects
          bench: benchKeys,      // String IDs for Bench (Cup/Regular)
          benchXI,               // Objects for Bench
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      console.error("Failed to save substitution:", error);
      alert("Substitution failed. Check console for details.");
    }
  }


  useEffect(() => {
    if (!isMe || lockedNow) return;
    
    // CRITICAL FIX: Only auto-initialize if we have explicitly confirmed the DB doc is completely empty (null).
    // If it is undefined, it means Firebase is still loading, so we must wait!
    if (lineupDoc !== null) return; 
    
    if (didInitLineup.current) return;     // prevent double-write
    if (!allKeys.length) return;

    didInitLineup.current = true;
    saveStarters(buildDefaultXI(allKeys));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMe, lockedNow, lineupDoc, allKeys]);

  useEffect(() => {
    if (!isMe || lockedNow) return;
    if (!lineupDoc) return;
    if (didRepairLineup.current) return;

    // only auto-repair once roster is complete
    if ((picks?.length || 0) < totalRounds) return;
    if (allKeys.length < STARTING_CAP) return;

    const rosterSet = new Set(allKeys);

    // current saved starters, but only keep players still on this roster
    const saved = Array.isArray(lineupDoc?.starters)
      ? lineupDoc.starters.filter((k) => rosterSet.has(k)).slice(0, STARTING_CAP)
      : [];

    const savedIsValid =
      saved.length === STARTING_CAP && validateStarters(saved).ok;

    if (savedIsValid) return;

    const repaired = buildDefaultXI(allKeys);

    // safety check: only save if the repaired XI is truly valid
    if (repaired.length !== STARTING_CAP) return;
    if (!validateStarters(repaired).ok) return;

    // avoid pointless rewrite
    if (sameKeyOrder(saved, repaired)) return;

    didRepairLineup.current = true;
    saveStarters(repaired);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMe, lockedNow, lineupDoc, picks, totalRounds, allKeys]);

  function onSubInClick(benchKey) {
    if (!isMe || lockedNow) return;

    const benchPick = pickByKey.get(benchKey);
    if (isPickLive(benchPick)) {
      alert("You can’t SUB IN a player that is LIVE.");
      return;
    }

    // tap again to cancel
    if (pendingIn === benchKey) {
      setPendingIn(null);  
      return;
    }

    // if there is still space, add immediately
    if (starters.length < STARTING_CAP) {
      saveStarters([...starters, benchKey]);
      setPendingIn(null);
      return;
    }

    // otherwise wait for user to pick who to replace
    setPendingIn(benchKey);
  }

  function onStarterClick(starterKey) {
    if (!isMe || lockedNow) return;
    if (!pendingIn) return;

    const starterPick = pickByKey.get(starterKey);
    const benchPick = pickByKey.get(pendingIn);

  
    if (isPickLive(benchPick)) {
      alert("You can’t SUB IN a bench player that is LIVE.");
      return;
    }

    const next = starters.map((k) => (k === starterKey ? pendingIn : k));
    saveStarters(next);
    setPendingIn(null);
  }

  const replaceableStarters = useMemo(() => {
    if (!pendingIn) return null;
    const allowed = new Set();
    for (const starterKey of starters) {
      const next = starters.map((k) => (k === starterKey ? pendingIn : k));
      if (validateStarters(next).ok) allowed.add(starterKey);
    }
    return allowed;
  }, [pendingIn, starters, pickByKey]);


  // Starters grouped into the same ATT/MID/DEF/GK layout
  const startersByPos = useMemo(() => {
    const map = { ATT: [], MID: [], DEF: [], GK: [] };

    for (const k of starters) {
      const p = pickByKey.get(k);
      const pos = p?.position;
      if (pos && map[pos]) map[pos].push(p);
    }
    return map;
  }, [starters, pickByKey]);

  // For other managers, keep your original grouping by position
  const byPosOther = useMemo(() => {
    const map = { ATT: [], MID: [], DEF: [], GK: [], SUB: [] };
    if (isMe) return map;
    for (const p of picks) {
      const key = p.position && ["ATT", "MID", "DEF", "GK"].includes(p.position) ? p.position : "SUB";
      map[key].push(p);
    }
    return map;
  }, [picks, isMe]);

  const benchPicks = useMemo(() => {
    return benchKeys.map((k) => pickByKey.get(k)).filter(Boolean);
  }, [benchKeys, pickByKey]);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
      <div className="flex items-center gap-3 mb-1">
        <Avatar className="h-10 w-10 border">
          <AvatarImage src={photoURL || ""} alt={displayNameOf(manager)} />
          <AvatarFallback className="font-bold">
            {(name || "U").slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="flex items-start justify-between gap-2 w-full">
          <div className="font-semibold text-xl leading-tight">{title}</div>

          {isMe && !editing && (
            <button
              type="button"
              className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
              onClick={() => setEditing(true)}
              title="Edit team name"
              aria-label="Edit team name"
            >
              ✏️
            </button>
          )}
        </div>

        {isMe && editing && (
          <div className="mt-2 w-full">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="w-full border rounded px-2 py-1 text-sm"
              placeholder="Your team name"
            />

            <div className="mt-2 flex gap-2">
              <button type="button" className="border rounded px-3 py-1 text-sm" onClick={saveTeamName}>
                Save
              </button>
              <button
                type="button"
                className="border rounded px-3 py-1 text-sm"
                onClick={() => {
                  setInput(teamName || "");
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="text-xs text-gray-500 mb-3">
        Picks: {picks.length} / {totalRounds}

        {isMe && (
          <>
            <span className="ml-2">
              • Starters {starters.length}/{STARTING_CAP}
              {lockedNow ? " (Locked)" : pendingIn ? " — pick a starter to replace" : ""}
            </span>

            {liveLocked && (
              <div className="mt-2 text-xs text-red-600">
                Subs locked (live match): {livePlayers.map((p) => p.name).join(", ")}
              </div>
            )}
          </>
        )}
      </div>

      {/* Same layout (ATT/MID/DEF/GK) */}
      <div className="grid grid-cols-2 gap-2 text-sm">
        {isMe ? (
          <>
            <StarterBlock title="ATT" list={startersByPos.ATT} pendingIn={!!pendingIn} locked={lockedNow} onPick={onStarterClick} keyOf={keyOf} isLivePick={isPickLive} pendingInPickLive={pendingIsLive} replaceable={replaceableStarters}/>
            <StarterBlock title="MID" list={startersByPos.MID} pendingIn={!!pendingIn} locked={lockedNow} onPick={onStarterClick} keyOf={keyOf} isLivePick={isPickLive} pendingInPickLive={pendingIsLive} replaceable={replaceableStarters}/>
            <StarterBlock title="DEF" list={startersByPos.DEF} pendingIn={!!pendingIn} locked={lockedNow} onPick={onStarterClick} keyOf={keyOf} isLivePick={isPickLive} pendingInPickLive={pendingIsLive} replaceable={replaceableStarters}/>
            <StarterBlock title="GK"  list={startersByPos.GK}  pendingIn={!!pendingIn} locked={lockedNow} onPick={onStarterClick} keyOf={keyOf} isLivePick={isPickLive} pendingInPickLive={pendingIsLive} replaceable={replaceableStarters}/>

            {/* SUB section becomes Bench */}
            <div className="col-span-2">
              <BenchBlock
                title="SUB"
                list={benchPicks}
                pendingKey={pendingIn}
                locked={lockedNow}
                onSubIn={onSubInClick}
                keyOf={keyOf}
                isLivePick={isPickLive}
              />
            </div>
          </>
        ) : (
          <>
            <PosBlock title="ATT" list={startersByPos.ATT} />
            <PosBlock title="MID" list={startersByPos.MID} />
            <PosBlock title="DEF" list={startersByPos.DEF} />
            <PosBlock title="GK"  list={startersByPos.GK} />
            <div className="col-span-2">
              <BenchReadOnlyBlock title="SUB" list={benchPicks} />
            </div>
          </>
        )}
      </div>

      {/* Flat list ordered by turn (unchanged) */}
      <div className="mt-3">
        <div className="text-xs text-gray-500 mb-1">All Picks (by draft order)</div>
        <ol className="space-y-1 max-h-48 overflow-auto">
          {orderedPicks.map((p) => (
            <li key={p.id || `${p.uid}-${p.turn}`} className="border rounded px-2 py-1 flex items-center justify-between">
              <span>
                <b>#{p.turn}</b> — {p.playerName} <span className="opacity-70">({p.position || "SUB"})</span>
              </span>
              <span className="opacity-60 text-xs">R{p.round}</span>
            </li>
          ))}
          {picks.length === 0 && <div className="opacity-60 text-sm">No picks yet.</div>}
        </ol>
      </div>
    </div>
  );
}

function StarterBlock({ title, list, pendingIn, locked, onPick, keyOf, isLivePick, pendingInPickLive, replaceable }) {
  return (
    <div className="border rounded p-2">
      <div className="text-xs font-semibold mb-1">{title}</div>
      <ul className="space-y-1">
        {list.map((p) => {
          const k = keyOf(p);

          const illegalByFormation = !!pendingIn && !!replaceable && !replaceable.has(k);

          const disabled =
            locked ||
            !pendingIn ||
            pendingInPickLive ||
            illegalByFormation;

          return (
            <li
              key={p.id || `${p.uid}-${p.turn}`}
              className={`border rounded px-2 py-1 flex items-center justify-between
                ${locked ? "opacity-60" : ""}
                ${
                  pendingIn
                    ? disabled
                      ? "opacity-50 cursor-not-allowed"
                      : "cursor-pointer hover:bg-slate-50"
                    : ""
                }`}
              title={
                locked
                  ? "Lineups locked"
                  : pendingInPickLive
                  ? "Selected bench player is LIVE (can’t sub in)"
                  : isLivePick?.(p)
                  ? "This starter is LIVE (can’t sub out)"
                  : illegalByFormation
                  ? "Can’t sub out (formation rules)"
                  : pendingIn
                  ? "Tap to sub out"
                  : undefined
              }
              onClick={() => {
                if (disabled) return;
                onPick(k);
              }}
            >
              <span>{p.playerName}</span>
            </li>
          );
        })}
        {list.length === 0 && <li className="text-xs text-gray-400">—</li>}
      </ul>
    </div>
  );
}

function BenchBlock({ title, list, pendingKey, locked, onSubIn, keyOf, isLivePick }) {
  return (
    <div className="border rounded p-2">
      <div className="text-xs font-semibold mb-1">{title} <span className="opacity-60">(Bench)</span></div>
      <ul className="space-y-1">
        {list.map((p) => {
          const k = keyOf(p);
          const selected = pendingKey === k;
          const live = !!isLivePick?.(p);
          return (
            <li
              key={p.id || `${p.uid}-${p.turn}`}
              className={`border rounded px-2 py-1 flex items-center justify-between ${
                selected ? "bg-amber-50 border-amber-200" : ""
              } ${locked ? "opacity-60" : ""}`}
            >
              <span>
                {p.playerName} <span className="opacity-60 text-xs">({p.position})</span>
                {live && (
                  <span className="ml-2 text-[10px] font-bold px-2 py-[2px] rounded-full border border-red-400/40 bg-red-500/10 text-red-600">
                    LIVE
                  </span>
                )}
              </span>

              <button
                type="button"
                className={`border rounded px-2 py-1 text-xs ${locked ? "opacity-50 cursor-not-allowed" : ""}`}
                disabled={locked || live}
                title={
                  locked
                    ? "Lineups locked while games are live"
                    : live
                    ? "This player is LIVE (can’t sub in)"
                    : "Move to starting lineup"
                }
                onClick={() => onSubIn(k)}
              >
                SUB IN
              </button>
            </li>
          );
        })}
        {list.length === 0 && <li className="text-xs text-gray-400">—</li>}
      </ul>
    </div>
  );
}

function PosBlock({ title, list }) {
  return (
    <div className="border rounded p-2">
      <div className="text-xs font-semibold mb-1">{title}</div>
      <ul className="space-y-1">
        {list.map((p) => (
          <li key={p.id || `${p.uid}-${p.turn}`} className="border rounded px-2 py-1">
            {p.playerName}
          </li>
        ))}
        {list.length === 0 && <li className="text-xs text-gray-400">—</li>}
      </ul>
    </div>
  );
}

function BenchReadOnlyBlock({ title, list }) {
  return (
    <div className="border rounded p-2">
      <div className="text-xs font-semibold mb-1">
        {title} <span className="opacity-60">(Bench)</span>
      </div>
      <ul className="space-y-1">
        {list.map((p) => (
          <li key={p.id || `${p.uid}-${p.turn}`} className="border rounded px-2 py-1 flex justify-between">
            <span>{p.playerName}</span>
            <span className="opacity-60 text-xs">({p.position})</span>
          </li>
        ))}
        {list.length === 0 && <li className="text-xs text-gray-400">—</li>}
      </ul>
    </div>
  );
}

