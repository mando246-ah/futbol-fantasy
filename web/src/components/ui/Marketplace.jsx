import React, { useEffect, useMemo, useState } from "react";
import "./Marketplace.css";
import { db } from "../../firebase";
import { orderBy, query} from "firebase/firestore";
import {
   marketSaveInterest
} from "../../firebase";
import {
  collection, getDocs, onSnapshot, doc
} from "firebase/firestore";
import { where } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import {app} from "../../firebase";
import FlagIcon from "../FlagIcon";

const functions = getFunctions(app, "us-west2");
const fnScheduleMarket = httpsCallable(functions, "scheduleMarket");
const fnResolveMarketNow = httpsCallable(functions, "resolveMarketNow");

function formatMs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatWhenMs(ms) {
  if (!ms) return "";
  return new Date(Number(ms)).toLocaleString([], {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function toMillis(value) {
  if (!value) return null;

  // Firestore Timestamp
  if (typeof value === "object" && typeof value.toMillis === "function") {
    return value.toMillis();
  }

  // Firestore-like { seconds, nanoseconds }
  if (typeof value === "object" && typeof value.seconds === "number") {
    return value.seconds * 1000;
  }

  // Number (could be seconds or ms)
  if (typeof value === "number") {
    // if it's too small to be ms, treat as seconds
    return value < 1e12 ? value * 1000 : value;
  }

  // String: ISO or numeric
  if (typeof value === "string") {
    // numeric string
    const asNum = Number(value);
    if (!Number.isNaN(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;

    // ISO datetime string
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function friendlyMarketReason(code) {
  switch (code) {
    case "SWAPOUT_STARTER_LIVE":
      return "Trade not processed because the player being dropped was LIVE when the market closed.";
    case "WANT_NOT_AVAILABLE":
      return "Not awarded — another manager had higher priority for this player (or the player is no longer available).";
    case "SWAPOUT_NOT_OWNED":
      return "Not awarded — the player being dropped is no longer on the roster.";
    case "MISSING_FIELDS":
      return "Not awarded — incomplete request.";
    case "SAME_PLAYER":
      return "Not awarded — you can’t trade a player for themselves.";
    case "WANT_NOT_IN_POOL":
      return "Not awarded — requested player was not found.";
    default:
      return "Not awarded.";
  }
}

function getPlayerName(p = {}) {
  return p.name || p.playerName || p.fullName || p.displayName || "Unknown";
}

function getPlayerTeam(p = {}) {
  return (
    p.teamName ||
    p.club ||
    p.clubName ||
    p.realTeamName ||
    p.team?.name ||
    ""
  );
}

function getPlayerNation(p = {}) {
  return (
    p.nationality ||
    p.country ||
    p.nation ||
    p.countryName ||
    ""
  );
}

function getPlayerSearchText(p = {}) {
  return [
    getPlayerName(p),
    p.position,
    getPlayerTeam(p),
    getPlayerNation(p),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function PlayerMetaLine({ player }) {
  const team = getPlayerTeam(player);
  const nation = getPlayerNation(player);
  const position = player?.position || "—";

  return (
    <div className="marketPlayerMeta">
      <span className="marketPlayerPos">{position} • </span>

      {team && (
        <span className="marketPlayerClub">
          {team} •
        </span>
      )}

      {nation && (
        <span className="marketPlayerNation">
          <FlagIcon country={nation} size={14} title={nation} />
          <span> {nation}</span>
        </span>
      )}
    </div>
  );
}
function useCountdown(targetMs, isActive) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isActive || !targetMs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive, targetMs]); 

  const remainingMs = useMemo(() => {
    if (!targetMs) return 0;
    return targetMs - now;
  }, [targetMs, now]);

  return { remainingMs, label: formatMs(remainingMs) };
}

const AcquireSearch = React.memo(function AcquireSearch({
  label,
  search,
  setSearch,
  state,
  setState,
  pool,          // full player pool (MOCK_PLAYERS / API later)
  pickedSet,     // Set of drafted playerIds
  disabled,
}) {
  const q = search.trim().toLowerCase();

  const results =
    q.length < 2
      ? []
      : (pool || [])
          .filter((p) => (p?.name || "").toLowerCase().includes(q))
          .slice(0, 20);

  const selected =
    state.wantId
      ? (pool || []).find((p) => String(p.id) === String(state.wantId))
      : null;

  return (
    <div className="w-full">
      <input
        className="marketInput"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search player to acquire (${label})…`}
        disabled={disabled}
      />

      {selected && (
        <div className="marketHint">
          Selected: <b>{selected.name}</b> ({selected.position})
          <button
            type="button"
            className="marketLinkBtn"
            onClick={() => {
              setState({ ...state, wantId: "" });
              setSearch("");
            }}
          >
            clear
          </button>
        </div>
      )}

      {!selected && results.length > 0 && (
        <div className="marketResults">
          {results.map((p) => {
            const taken = pickedSet?.has(String(p.id));
            return (
              <button
                type="button"
                key={p.id}
                className="marketResultItem"
                disabled={taken}
                onClick={() => {
                  setState({ ...state, wantId: p.id });
                  setSearch(p.name);
                }}
                title={taken ? "Already drafted" : disabled ? "Click Edit to change" : "Select"}
              >
                <div className="font-medium">
                  {p.name} {taken ? " (taken)" : ""}
                </div>
                <div className="text-xs opacity-70">{p.position}</div>
              </button>
            );
          })}
        </div>
      )}

      {q.length >= 2 && !selected && results.length === 0 && (
        <div className="text-xs opacity-60 mt-1">No matches.</div>
      )}
    </div>
  );
});


export default function Marketplace({ roomId, user, isHost, players= [] }) {
  const [market, setMarket] = useState(null);
  const [room, setRoom] = useState(null);
  const [undrafted, setUndrafted] = useState([]);
  const [myRoster, setMyRoster] = useState([]);
  const [choiceA, setChoiceA] = useState({ wantId: "", swapOutId: "" });
  const [choiceB, setChoiceB] = useState({ wantId: "", swapOutId: "" });
  const [dur, setDur] = useState({ days: 0, hours: 0, minutes: 10 });
  const [startISO, setStartISO] = useState("");
  const [searchA, setSearchA] = useState("");
  const [searchB, setSearchB] = useState("");
  const [pickedSet, setPickedSet] = useState(new Set());
  const [isEditing, setIsEditing] = useState(true); // default: editable
  const [saveStatus, setSaveStatus] = useState(""); 
  const [ marketResults, setMarketResults ] = useState([]);
  const [availableLimit, setAvailableLimit] = useState(30); // how many "Available Players" cards to show
  const [availableSearch, setAvailableSearch] = useState("");

  //Display Results After Market Closes
  useEffect(() => {
  if (!roomId) return;

  // If market has never resolved yet, don't show anything
  if (!market?.closesAt) {
    setMarketResults([]);
    return;
  }

  const closeMs = toMillis(market?.closesAt);
  if (!closeMs) {
    setMarketResults([]);
    return;
  }

  const fromMs = Number(closeMs || 0) - 5 * 60 * 1000;

  const qy = query(
    collection(db, "rooms", roomId, "marketResults"),
    where("resolvedAtMs", ">=", fromMs),
    orderBy("resolvedAtMs", "desc")
  );

  const unsub = onSnapshot(qy, (snap) => {
    setMarketResults(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });

  return () => unsub();
}, [roomId, market?.closesAt]);


  useEffect(() => {
    if (!roomId) return;

    const roomRef = doc(db, "rooms", roomId);
    const marketRef = doc(db, "rooms", roomId, "market", "current");

    const unsubRoom = onSnapshot(roomRef, (snap) => {
      setRoom(snap.exists() ? snap.data() : null);
    });

    const unsubMarket = onSnapshot(marketRef, (snap) => {
      setMarket(snap.exists() ? snap.data() : { status: "closed" });
    });

    return () => {
      unsubRoom();
      unsubMarket();
    };
  }, [roomId]);

  // Load undrafted & my roster
  useEffect(() => {
    async function load() {
      const picksSnap = await getDocs(collection(db, "rooms", roomId, "picks"));

      // who is already drafted
      const picked = new Set();
      picksSnap.forEach(d => picked.add(String(d.data().playerId)));
      setPickedSet(picked);

      // 1) Prefer passed-in players (MOCK_PLAYERS)
      let all = (players || []).map(p => ({
        ...p,
        id: String(p.id),
      }));

      // 2) Fallback: if none passed, load from Firestore players collection
      if (all.length === 0) {
        const playersSnap = await getDocs(collection(db, "rooms", roomId, "players"));
        all = playersSnap.docs.map(d => {
          const data = d.data();
          return { ...data, id: String(data.id ?? d.id) };
        });
      }

      setUndrafted(all.filter(p => !picked.has(String(p.id))));

      // my roster from picks
      const mine = [];
      picksSnap.forEach(d => {
        const p = d.data();
        if (p.uid === user?.uid) mine.push(p);
      });
      setMyRoster(mine);
    }

    if (roomId) load();
  }, [roomId, user?.uid, market?.status, players]);



  // Limit how many Available Players are rendered (less scrolling / faster)
  useEffect(() => {
    setAvailableLimit(30);
  }, [roomId, availableSearch]);

  const filteredUndrafted = useMemo(() => {
    const q = availableSearch.trim().toLowerCase();
    const list = undrafted || [];

    if (!q) return list;

    const terms = q.split(/\s+/).filter(Boolean);

    return list
      .filter((p) => {
        const haystack = getPlayerSearchText(p);
        return terms.every((term) => haystack.includes(term));
      })
      .sort((a, b) => {
        const aName = getPlayerName(a).toLowerCase();
        const bName = getPlayerName(b).toLowerCase();

        const aStarts = aName.startsWith(q) ? 0 : 1;
        const bStarts = bName.startsWith(q) ? 0 : 1;

        if (aStarts !== bStarts) return aStarts - bStarts;
        return aName.localeCompare(bName);
      });
  }, [undrafted, availableSearch]);

  const visibleUndrafted = useMemo(
    () => filteredUndrafted.slice(0, availableLimit),
    [filteredUndrafted, availableLimit]
  );

  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!roomId || !user?.uid) return;

    const nameFromPool = (id) =>
    (players || []).find(p => String(p.id) === String(id))?.name || "";

    const ref = doc(db, "rooms", roomId, "marketInterest", user.uid);
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const choices = Array.isArray(data?.choices) ? data.choices : [];

      const a = choices[0] || { wantId: "", swapOutId: "" };
      const b = choices[1] || { wantId: "", swapOutId: "" };

      setChoiceA({ wantId: a.wantId || "", swapOutId: a.swapOutId || "" });
      setChoiceB({ wantId: b.wantId || "", swapOutId: b.swapOutId || "" });

      // Optional: set search inputs to selected player names
      // (only if you kept searchA/searchB)
      setSearchA( nameFromPool(a.wantId) || "" );
      setSearchB( nameFromPool(b.wantId) || "" );
    });

    return () => unsub();
  }, [roomId, user?.uid]);

  //Market count down
  useEffect(() => {
    if (market?.status !== "open" || !market?.closesAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [market?.status, market?.closesAt]);

  const countdown = useMemo(() => {
    if (market?.status !== "open" || !market?.closesAt) return null;
    const closesAtMs = toMillis(market?.closesAt);
    const diff = (closesAtMs ?? 0) - now;
    if (diff <= 0) return "00:00";
    const mm = Math.floor(diff / 60000);
    const ss = Math.floor((diff % 60000) / 1000);
    return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }, [market?.status, market?.closesAt, now]);


  const durationMs = (Number(dur.days||0)*86400000) + (Number(dur.hours||0)*3600000) + (Number(dur.minutes||0)*60000);
  const scheduledAtMs = useMemo(() => toMillis(market?.scheduledAt), [market?.scheduledAt]);


  const scheduledOpenCountdown = useCountdown(
    scheduledAtMs,
    market?.status !== "open" && !!scheduledAtMs && scheduledAtMs > Date.now()
  );


  

function getSelectedPlayer(wantId) {
  if (!wantId) return null;

  return (
    (undrafted || []).find((p) => String(p.id) === String(wantId)) ||
    (players || []).find((p) => String(p.id) === String(wantId)) ||
    null
  );
}

function chooseTransferTarget(player) {
  if (!player?.id) return;

  const id = String(player.id);

  setSaveStatus("");

  if (!choiceA.wantId || String(choiceA.wantId) === id) {
    setChoiceA((prev) => ({ ...prev, wantId: id }));
    setSearchA(getPlayerName(player));
    return;
  }

  if (!choiceB.wantId || String(choiceB.wantId) === id) {
    setChoiceB((prev) => ({ ...prev, wantId: id }));
    setSearchB(getPlayerName(player));
    return;
  }

  // If both choices are full, replace Choice A.
  setChoiceA((prev) => ({ ...prev, wantId: id }));
  setSearchA(getPlayerName(player));
}

function clearChoice(label, state, setState) {
  setState({ ...state, wantId: "" });

  if (label === "Choice A") setSearchA("");
  if (label === "Choice B") setSearchB("");

  setSaveStatus("");
}

  async function onSaveInterest() {
    if (!market || market.status !== "open") return;

    try {
      setSaveStatus("saving");

      const choices = [];
      if (choiceA.wantId && choiceA.swapOutId) choices.push(choiceA);
      if (choiceB.wantId && choiceB.swapOutId) choices.push(choiceB);

      await marketSaveInterest({ roomId, choices });

      setSaveStatus("saved");
      setIsEditing(false); // lock inputs after save
    } catch (e) {
      console.error(e);
      setSaveStatus("error");
    }
  }


  async function onStartNow() {
    if (!durationMs) return alert("Please set a duration.");
    await marketOpenNow({ roomId, durationMs });
  }

     async function onSchedule() {
    if (!durationMs || !startISO) return alert("Start time + duration required.");

    const whenMillis = new Date(startISO).getTime();
    if (!Number.isFinite(whenMillis)) return alert("Invalid start time.");

    try {
      console.log("Scheduling market debug:", {
        startISO,
        whenMillis,
        whenLocal: new Date(whenMillis).toString(),
        durationMs,
      });
      const res = await fnScheduleMarket({
        roomId,
        scheduledAtMs: whenMillis,
        durationMs,
      });

      console.log("scheduleMarket ok:", res?.data ?? res);
    } catch (e) {
      console.error("scheduleMarket failed:", {
        code: e?.code,
        message: e?.message,
        details: e?.details,
        raw: e,
      });
      alert(`scheduleMarket failed: ${e?.message ?? e}`);
    }
  }

  async function onResolve() {
    try {
      const res = await fnResolveMarketNow({ roomId });
      const data = res?.data || {};

      console.log("resolveMarketNow()", data);
      alert(`Market resolved. Trades: ${data?.resolvedCount ?? 0}`);
    } catch (e) {
      console.error("resolveMarketNow failed:", e);
      alert(e?.message || "Failed to resolve market.");
    }
  }

  return (
    <div className="marketCard">
      <div className="marketHeader">
        <h2 className="text-xl font-bold">Transfer Market</h2>
        <div className="text-sm">
          {market?.status === "open" ? (
            <span className="marketBadge marketBadgeOpen">Open • {countdown ?? "—"}</span>
          ) : market?.status === "resolved" ? (
            <span className="marketBadge marketBadgeResolved">Resolved</span>
          ) :  market?.status === "resolving" ? (
            <span className="marketBadge marketBadgeScheduled">Resolving…</span>
          ) : market?.status === "scheduled" ? (
            <span className="marketBadge marketBadgeScheduled">
              Scheduled • {scheduledAtMs && scheduledAtMs > Date.now()
                ? scheduledOpenCountdown.label
                : "opening soon"}
            </span>
          ) : scheduledAtMs && scheduledAtMs > Date.now() ? (
            <span className="marketBadge marketBadgeScheduled">
              Scheduled • {scheduledOpenCountdown.label}
            </span>
          ) : (
            <span className="marketBadge marketBadgeClosed">Closed</span>
          )}
        </div>
      </div>

      {/* Host controls */}
      {isHost && (
        <div className="marketHostGrid">
          <div className="col-span-1">
            <label className="text-xs font-semibold block mb-1">Duration</label>
            <div className="marketDurationRow">
              <div className="marketDurationItem">
                <input
                  className="marketNum"
                  type="number"
                  min="0"
                  value={dur.days}
                  onChange={(e) => setDur({ ...dur, days: e.target.value })}
                />
                <span className="marketUnit">days</span>
              </div>

              <div className="marketDurationItem">
                <input
                  className="marketNum"
                  type="number"
                  min="0"
                  value={dur.hours}
                  onChange={(e) => setDur({ ...dur, hours: e.target.value })}
                />
                <span className="marketUnit">hrs</span>
              </div>

              <div className="marketDurationItem">
                <input
                  className="marketNum"
                  type="number"
                  min="0"
                  value={dur.minutes}
                  onChange={(e) => setDur({ ...dur, minutes: e.target.value })}
                />
                <span className="marketUnit">min</span>
              </div>
            </div>

          </div>
          <div className="col-span-1">
            <label className="text-xs font-semibold block mb-1">Schedule start</label>
            <input className="marketInput marketInputDate" type="datetime-local" value={startISO} onChange={e=>setStartISO(e.target.value)} />
          </div>
          <div className="marketHostActions">
            <button className="marketBtn marketBtnAmber" onClick={onSchedule}>Schedule</button>
            {/*<button className="marketBtn marketBtnGreen" onClick={onStartNow}>Open Now</button>
            {market?.status !== "resolved" ? (
              <button className="marketBtn marketBtnBlue" onClick={onResolve}>Resolve Now</button>
            ) : null} */}
          </div>
        </div>
      )}

      {/* Status note */}
      <div className="mt-4 text-sm opacity-70">
        {market?.status === "open"
          ? "Market is OPEN. Set up to two interests below."
          : market?.status === "scheduled"
          ? `Market is scheduled to open automatically at ${formatWhenMs(scheduledAtMs)}.`
          : scheduledAtMs && scheduledAtMs > Date.now()
          ? `Market is CLOSED (scheduled to open automatically at ${formatWhenMs(scheduledAtMs)}).`
          : "Market is CLOSED. You can still browse available players."}
      </div>

      {/* Available players */}
      {/* Transfer suggestions */}
      <div className="mt-4">
        <div className="marketSuggestionHeader">
          <div>
            <div className="font-semibold">Transfer Suggestions</div>
            <div className="marketSubText">
              Search by player, club, country, or position.
            </div>
          </div>

          {availableSearch && (
            <button
              type="button"
              className="marketBtn marketBtnOutline marketClearSearchBtn"
              onClick={() => setAvailableSearch("")}
            >
              Clear
            </button>
          )}
        </div>

        <input
          className="marketInput marketSearchInput"
          value={availableSearch}
          onChange={(e) => setAvailableSearch(e.target.value)}
          placeholder="Search available players, team, nation, or position..."
        />

        <div className="grid gap-2 md:grid-cols-3 marketAvailableList">
          {visibleUndrafted.map((p) => {
            const alreadyChoice =
              String(choiceA.wantId) === String(p.id) ||
              String(choiceB.wantId) === String(p.id);

            const canPick = market?.status === "open" && isEditing;

            return (
              <div key={p.id} className={`marketPlayerCard ${alreadyChoice ? "marketPlayerCardSelected" : ""}`}>
                <div className="marketPlayerCardTop">
                  <div className="marketPlayerInfo">
                    <div className="font-medium">{getPlayerName(p)}</div>
                    <PlayerMetaLine player={p} />
                  </div>

                  <button
                    type="button"
                    className="marketTransferMiniBtn"
                    disabled={!canPick}
                    onClick={() => chooseTransferTarget(p)}
                    title={
                      market?.status !== "open"
                        ? "Market must be open"
                        : !isEditing
                        ? "Click Edit choices first"
                        : "Add to your transfer choices"
                    }
                  >
                    {alreadyChoice ? "Selected" : "Transfer"}
                  </button>
                </div>
              </div>
            );
          })}

          {filteredUndrafted.length === 0 && (
            <div className="opacity-60 text-sm">
              No available players match your search.
            </div>
          )}
        </div>

        {filteredUndrafted.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <div className="text-xs opacity-60">
              Showing {Math.min(availableLimit, filteredUndrafted.length)} of {filteredUndrafted.length}
            </div>

            {filteredUndrafted.length > availableLimit && (
              <button
                type="button"
                className="marketBtn marketBtnOutline"
                onClick={() => setAvailableLimit((n) => n + 30)}
              >
                Show more
              </button>
            )}

            {availableLimit > 30 && (
              <button
                type="button"
                className="marketBtn marketBtnOutline"
                onClick={() => setAvailableLimit(30)}
              >
                Show less
              </button>
            )}
          </div>
        )}
      </div>

      {/* My interest (private to me) */}
      <div className="mt-6">
        <div className="font-semibold mb-2">Your Interest (private)</div>
        <div className="grid md:grid-cols-2 gap-3">
          {[{label:"Choice A", state: choiceA, set: setChoiceA},
            {label:"Choice B", state: choiceB, set: setChoiceB}].map(({label, state, set}) => (
            <div key={label} className="marketPanel">
              <div className="text-sm font-medium mb-2">{label}</div>
              <div className="marketChoiceRow">
                <div className="marketSelectedTarget">
                  {getSelectedPlayer(state.wantId) ? (
                    <>
                      <div className="marketSelectedInfo">
                        <div className="marketSelectedName">
                          {getPlayerName(getSelectedPlayer(state.wantId))}
                        </div>
                        <PlayerMetaLine player={getSelectedPlayer(state.wantId)} />
                      </div>

                      <button
                        type="button"
                        className="marketLinkBtn"
                        disabled={!isEditing}
                        onClick={() => clearChoice(label, state, set)}
                      >
                        clear
                      </button>
                    </>
                  ) : (
                    <div className="marketEmptyTarget">
                      Pick a player from the suggestions above.
                    </div>
                  )}
                </div>
                <span className="marketChoiceFor">for</span>
                <select disabled={!isEditing} className="marketSelect" value={state.swapOutId} onChange={e=>set({...state, swapOutId:e.target.value})}>
                  <option value="">— Select your player to release —</option>
                  {myRoster.map(p => <option key={p.playerId} value={p.playerId}>{p.playerName} ({p.position})</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>
        <div className="marketInterestActions">
          <button
            className="marketBtn marketBtnDark"
            onClick={onSaveInterest}
            disabled={!market || market.status !== "open" || !isEditing}
            type="button"
          >
            Save Interest
          </button>

          <button
            className="marketBtn marketBtnOutline"
            onClick={() => setIsEditing(true)}
            disabled={!market || market.status !== "open"}
            type="button"
          >
            Edit choices
          </button>
        </div>
        {market?.status !== "open" && <div className="text-xs opacity-60 mt-1">Interest can be saved only while market is open.</div>}
        <div className="mt-2 text-sm min-h-[20px]">
          {saveStatus === "saving" && (
            <span className="opacity-70">Saving your interest…</span>
          )}
          {saveStatus === "saved" && (
            <span className="marketTextSuccess">
              ✓ Interest saved. You can edit until the market closes.
            </span>
          )}
          {saveStatus === "error" && (
            <span className="marketTextError">
              Failed to save interest. Please try again.
            </span>
          )}
        </div>

          {market?.status === "resolved" && (
            <div className="marketResultsPanel">
              <div className="marketResultsTitle">Market Results</div>

              {marketResults.length === 0 ? (
                <div className="marketResultsEmpty">No market results recorded yet.</div>
              ) : (
                <div className="marketResultsList">
                  {marketResults.map((r) => {
                    const who = r.displayName || r.uid;
                    const wantName =
                      (players || []).find((p) => String(p.id) === String(r.wantId))?.name ||
                      (undrafted || []).find((p) => String(p.id) === String(r.wantId))?.name ||
                      r.wantId;

                    const swapOutName =
                      (players || []).find((p) => String(p.id) === String(r.swapOutId))?.name ||
                      (myRoster || []).find((p) => String(p.playerId) === String(r.swapOutId))?.playerName ||
                      r.swapOutId;

                    const ok = r.ok === true || r.result === "won";
                    const normalizedReleasedId = r.releasedId || r.swapOutId;
                    const normalizedGotId = r.gotId || r.wantId;
                    if (normalizedReleasedId && r.releasedId == null) r.releasedId = normalizedReleasedId;
                    if (normalizedGotId && r.gotId == null) r.gotId = normalizedGotId;
                    const fallbackReason =
                      r.reason
                        ? friendlyMarketReason(r.reason)
                        : r.result === "lost"
                        ? "Not awarded — higher priority lost or player not available."
                        : "Not awarded.";

                    return (
                      <div key={r.id} className="marketResultRow">
                        <div className="marketResultTop">
                          <div className="marketResultUser">{who}</div>
                          <span className={`marketResultTag ${ok ? "marketResultTagOk" : "marketResultTagFail"}`}>
                            {ok ? "Awarded" : "Not awarded"}
                          </span>
                        </div>

                        {ok ? (
                          <div className="marketResultSwap">
                            Dropped <b>{r.releasedName || r.releasedId}</b> → Added <b>{r.gotName || r.gotId}</b>
                          </div>
                        ) : (
                          <>
                            <div className="marketResultSwap">
                              Requested <b>{wantName || "—"}</b> for <b>{swapOutName || "—"}</b>
                            </div>
                            <div className="marketResultReason">{fallbackReason}</div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
      </div>

    </div>
  );
}
