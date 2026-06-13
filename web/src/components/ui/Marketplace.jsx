import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./Marketplace.css";
import { db } from "../../firebase";
import {
   marketSaveInterest
} from "../../firebase";
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import {app} from "../../firebase";
import FlagIcon from "../FlagIcon";
import {
  friendlyErrorMessage,
  reportClientError,
} from "../../utils/errorReporter";
import { devError, devLog } from "../../utils/devLogger";
import {
  matchesPlayerSearch,
  normalizeSearchText,
} from "../../utils/playerSearch";

const functions = getFunctions(app, "us-west2");
const fnScheduleMarket = httpsCallable(functions, "scheduleMarket");

function pickOwnerUid(p = {}) {
  return String(
    p.uid ||
    p.ownerUid ||
    p.userId ||
    p.managerUid ||
    p.pickedByUid ||
    p.pickedBy ||
    p.owner?.uid ||
    p.owner?.id ||
    ""
  ).trim();
}

function pickPlayerId(p = {}, fallback = "") {
  return String(
    p.playerId ||
    p.pid ||
    p.apiPlayerId ||
    p.player?.id ||
    p.id ||
    fallback ||
    ""
  ).trim();
}

function pickDisplayName(p = {}) {
  return (
    p.name ||
    p.playerName ||
    p.fullName ||
    p.displayName ||
    p.player?.name ||
    "Unknown"
  );
}

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
    case "TIE_RANDOM_LOST":
      return "Not awarded — you had the same priority as the winner, but lost the random tiebreaker.";
    default:
      return "Not awarded.";
  }
}

function getPlayerName(p = {}) {
  return pickDisplayName(p);
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
  const q = normalizeSearchText(search);

  const results =
    q.length < 2
      ? []
      : (pool || [])
          .filter((p) => matchesPlayerSearch(p, search))
          .slice(0, 20);

  const selected =
    state.wantId
      ? (pool || []).find((p) => String(p.id) === String(state.wantId))
      : null;

  return (
    <div className="w-full max-w-full min-w-0 overflow-x-hidden box-border">
      <input
        className="marketInput w-full max-w-full min-w-0 box-border"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search players"
        aria-label={`Search player to acquire (${label})`}
        disabled={disabled}
      />

      {selected && (
        <div className="marketHint">
          Selected: <b>{pickDisplayName(selected)}</b> ({selected.position})
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
        <div className="marketResults w-full max-w-full overflow-y-auto overflow-x-hidden box-border">
          {results.map((p) => {
            const taken = pickedSet?.has(String(p.id));
            return (
              <button
                type="button"
                key={p.id}
                className="marketResultItem w-full max-w-full min-w-0 box-border"
                disabled={taken}
                onClick={() => {
                  setState({ ...state, wantId: p.id });
                  setSearch(pickDisplayName(p));
                }}
                title={taken ? "Already drafted" : disabled ? "Click Edit to change" : "Select"}
              >
                <div className="font-medium min-w-0 break-words">
                  {pickDisplayName(p)} {taken ? " (taken)" : ""}
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


export default function Marketplace({
  roomId,
  user,
  isHost,
  players,
  picks,
  playersLoaded = false,
}) {
  const [market, setMarket] = useState(null);
  const [fallbackPlayers, setFallbackPlayers] = useState([]);
  const [fallbackPicks, setFallbackPicks] = useState([]);
  const [choiceA, setChoiceA] = useState({ wantId: "", swapOutId: "" });
  const [choiceB, setChoiceB] = useState({ wantId: "", swapOutId: "" });
  const [dur, setDur] = useState({ days: 0, hours: 0, minutes: 10 });
  const [startISO, setStartISO] = useState("");
  const [isEditing, setIsEditing] = useState(true); // default: editable
  const [saveStatus, setSaveStatus] = useState(""); 
  const [marketError, setMarketError] = useState("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [marketHistory, setMarketHistory] = useState([]);
  const [historyError, setHistoryError] = useState("");
  const [availableLimit, setAvailableLimit] = useState(30); // how many "Available Players" cards to show
  const [availableSearch, setAvailableSearch] = useState("");
  const hasParentPlayers = Array.isArray(players);
  const hasParentPicks = Array.isArray(picks);

  const parentPlayers = useMemo(
    () =>
      (Array.isArray(players) ? players : [])
        .map((player) => {
          const id = pickPlayerId(player);
          return id ? { ...player, id } : null;
        })
        .filter(Boolean),
    [players]
  );

  const allPlayers =
    hasParentPlayers && parentPlayers.length > 0
      ? parentPlayers
      : fallbackPlayers;

  const ownershipPicks = hasParentPicks ? picks : fallbackPicks;

  const { pickedSet, myRoster } = useMemo(() => {
    const picked = new Set();
    const mine = [];

    for (const rawPick of Array.isArray(ownershipPicks) ? ownershipPicks : []) {
      const data = rawPick || {};
      const pickDocId = String(data.pickDocId || data.docId || data.id || "");
      const playerId = pickPlayerId(data, pickDocId);
      if (playerId) picked.add(playerId);

      if (pickOwnerUid(data) === String(user?.uid || "")) {
        mine.push({
          ...data,
          id: pickDocId || playerId,
          pickDocId: pickDocId || playerId,
          playerId,
          playerName: pickDisplayName(data),
        });
      }
    }

    return { pickedSet: picked, myRoster: mine };
  }, [ownershipPicks, user?.uid]);

  const loadMarketHistory = useCallback(async () => {
    if (!roomId) {
      setMarketHistory([]);
      setHistoryLoaded(false);
      return;
    }

    setHistoryLoading(true);
    setHistoryError("");
    try {
      const resultsRef = collection(db, "rooms", roomId, "marketResults");
      let snap = await getDocs(
        query(resultsRef, orderBy("resolvedAtMs", "desc"), limit(50))
      );

      // Older result docs may only have resolvedAt.
      if (snap.empty) {
        snap = await getDocs(
          query(resultsRef, orderBy("resolvedAt", "desc"), limit(50))
        );
      }

      const rows = snap.docs
        .map((resultDoc) => ({ id: resultDoc.id, ...(resultDoc.data() || {}) }))
        .sort((a, b) => {
          const aMs = toMillis(a.resolvedAtMs ?? a.resolvedAt) || 0;
          const bMs = toMillis(b.resolvedAtMs ?? b.resolvedAt) || 0;
          return bMs - aMs;
        })
        .slice(0, 50);
      setMarketHistory(rows);
      setHistoryLoaded(true);
      devLog("[Marketplace] market history read", {
        roomId,
        resultDocsRead: snap.size,
      });
    } catch (error) {
      devError("[Marketplace] market history read failed", error);
      setHistoryError("Could not load market history.");
    } finally {
      setHistoryLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    setMarketHistory([]);
    setHistoryError("");
    setHistoryLoaded(false);
    setHistoryLoading(false);
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;

    const marketRef = doc(db, "rooms", roomId, "market", "current");

    const unsubMarket = onSnapshot(marketRef, (snap) => {
      setMarket(snap.exists() ? snap.data() : { status: "closed" });
    });

    return () => unsubMarket();
  }, [roomId]);

  // Draft normally provides the full player pool. Only use Firestore as a fallback.
  useEffect(() => {
    let cancelled = false;

    if (!roomId) {
      setFallbackPlayers([]);
      return () => {
        cancelled = true;
      };
    }

    if (hasParentPlayers && (!playersLoaded || parentPlayers.length > 0)) {
      setFallbackPlayers([]);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const snap = await getDocs(collection(db, "rooms", roomId, "players"));
        if (cancelled) return;

        const roomPlayerRows = snap.docs
          .map((playerDoc) => {
            const data = playerDoc.data() || {};
            const id = pickPlayerId(data, playerDoc.id);
            return id ? { ...data, id } : null;
          })
          .filter(Boolean);

        setFallbackPlayers(roomPlayerRows);
        devLog("[Marketplace] fallback room players read once", {
          roomId,
          playerDocsRead: snap.size,
        });
      } catch (error) {
        devError("[Marketplace] room players read failed", error);
        if (!cancelled) setFallbackPlayers([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    hasParentPlayers,
    parentPlayers.length,
    playersLoaded,
    roomId,
  ]);

  // Draft normally provides live picks. Only open a picks listener as a fallback.
  useEffect(() => {
    if (!roomId) {
      setFallbackPicks([]);
      return;
    }

    if (hasParentPicks) {
      setFallbackPicks([]);
      return;
    }

    const picksRef = collection(db, "rooms", roomId, "picks");
    return onSnapshot(picksRef, (snap) => {
      setFallbackPicks(
        snap.docs.map((pickDoc) => ({
          id: pickDoc.id,
          pickDocId: pickDoc.id,
          ...(pickDoc.data() || {}),
        }))
      );
      devLog("[Marketplace] fallback picks snapshot", {
        roomId,
        pickDocsRead: snap.size,
      });
    });
  }, [hasParentPicks, roomId]);

  const undrafted = useMemo(
    () =>
      allPlayers.filter(
        (player) => !pickedSet.has(String(pickPlayerId(player)))
      ),
    [allPlayers, pickedSet]
  );


  // Limit how many Available Players are rendered (less scrolling / faster)
  useEffect(() => {
    setAvailableLimit(30);
  }, [roomId, availableSearch]);

  const filteredUndrafted = useMemo(() => {
    const q = normalizeSearchText(availableSearch);
    const list = undrafted || [];

    if (!q) return list;

    return list
      .filter((p) => matchesPlayerSearch(p, availableSearch))
      .sort((a, b) => {
        const aName = normalizeSearchText(getPlayerName(a));
        const bName = normalizeSearchText(getPlayerName(b));

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

    const ref = doc(db, "rooms", roomId, "marketInterest", user.uid);
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const choices = Array.isArray(data?.choices) ? data.choices : [];

      const a = choices[0] || { wantId: "", swapOutId: "" };
      const b = choices[1] || { wantId: "", swapOutId: "" };

      setChoiceA({ wantId: a.wantId || "", swapOutId: a.swapOutId || "" });
      setChoiceB({ wantId: b.wantId || "", swapOutId: b.swapOutId || "" });
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
    allPlayers.find((p) => String(p.id) === String(wantId)) ||
    null
  );
}

function chooseTransferTarget(player) {
  if (!player?.id) return;

  const id = String(player.id);

  setSaveStatus("");

  if (!choiceA.wantId || String(choiceA.wantId) === id) {
    setChoiceA((prev) => ({ ...prev, wantId: id }));
    return;
  }

  if (!choiceB.wantId || String(choiceB.wantId) === id) {
    setChoiceB((prev) => ({ ...prev, wantId: id }));
    return;
  }

  // If both choices are full, replace Choice A.
  setChoiceA((prev) => ({ ...prev, wantId: id }));
}

function clearChoice(label, state, setState) {
  setState({ ...state, wantId: "" });

  setSaveStatus("");
}

  async function onSaveInterest() {
    if (!market || market.status !== "open") return;

    try {
      setSaveStatus("saving");
      setMarketError("");

      const choices = [];
      if (choiceA.wantId && choiceA.swapOutId) choices.push(choiceA);
      if (choiceB.wantId && choiceB.swapOutId) choices.push(choiceB);

      await marketSaveInterest({ roomId, choices });

      setSaveStatus("saved");
      setIsEditing(false); // lock inputs after save
    } catch (e) {
      const userMessage = friendlyErrorMessage(
        e,
        "Could not save your transfer interest. Please try again."
      );
      await reportClientError({
        roomId,
        area: "Marketplace",
        action: "marketSaveInterest",
        error: e,
        userMessage,
        extra: {
          marketStatus: market?.status || "",
          choiceCount: [choiceA, choiceB].filter(
            (choice) => choice.wantId && choice.swapOutId
          ).length,
        },
      });
      devError("[Marketplace] marketSaveInterest failed", e);
      setMarketError(userMessage);
      setSaveStatus("error");
    }
  }


     async function onSchedule() {
    if (!durationMs || !startISO) return alert("Start time + duration required.");

    const whenMillis = new Date(startISO).getTime();
    if (!Number.isFinite(whenMillis)) return alert("Invalid start time.");

    try {
      setMarketError("");
      devLog("Scheduling market debug:", {
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

      devLog("scheduleMarket ok:", res?.data ?? res);
    } catch (e) {
      const userMessage = friendlyErrorMessage(
        e,
        "Could not schedule the market. Please refresh and try again."
      );
      await reportClientError({
        roomId,
        area: "Marketplace",
        action: "scheduleMarket",
        error: e,
        userMessage,
        extra: {
          scheduledAtMs: whenMillis,
          durationMs,
        },
      });
      devError("[Marketplace] scheduleMarket failed", e);
      setMarketError(userMessage);
      alert(userMessage);
    }
  }

  return (
    <div className="marketCard w-full max-w-full overflow-hidden box-border">
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
      <div className="mt-4 w-full max-w-full min-w-0 overflow-x-hidden box-border">
        <div className="marketSuggestionHeader">
          <div className="min-w-0 max-w-full">
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
          className="marketInput marketSearchInput w-full max-w-full min-w-0 box-border"
          value={availableSearch}
          onChange={(e) => setAvailableSearch(e.target.value)}
          placeholder="Search players"
        />

        <div className="w-full max-w-full min-w-0 overflow-x-hidden box-border">
          <div className="grid gap-2 md:grid-cols-3 marketAvailableList w-full max-w-full min-w-0 overflow-y-auto overflow-x-hidden box-border">
            {visibleUndrafted.map((p) => {
              const alreadyChoice =
                String(choiceA.wantId) === String(p.id) ||
                String(choiceB.wantId) === String(p.id);

              const canPick = market?.status === "open" && isEditing;

              return (
                <div
                  key={p.id}
                  className={`marketPlayerCard w-full max-w-full min-w-0 box-border ${
                    alreadyChoice ? "marketPlayerCardSelected" : ""
                  }`}
                >
                  <div className="marketPlayerCardTop w-full max-w-full min-w-0">
                    <div className="marketPlayerInfo min-w-0 max-w-full">
                      <div className="font-medium min-w-0 break-words">
                        {getPlayerName(p)}
                      </div>
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
              <div className="opacity-60 text-sm min-w-0 break-words">
                No available players match your search.
              </div>
            )}
          </div>
        </div>

        {filteredUndrafted.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 min-w-0 max-w-full">
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
      <div className="mt-6 w-full max-w-full min-w-0 overflow-x-hidden box-border">
        <div className="font-semibold mb-2">Your Interest (private)</div>
        <div className="grid md:grid-cols-2 gap-3 w-full max-w-full min-w-0">
          {[{label:"Choice A", state: choiceA, set: setChoiceA},
            {label:"Choice B", state: choiceB, set: setChoiceB}].map(({label, state, set}) => (
            <div key={label} className="marketPanel w-full max-w-full min-w-0 box-border">
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
                  {myRoster.map((p) => {
                    const playerId = pickPlayerId(p);
                    return (
                      <option key={p.id || playerId} value={playerId}>
                        {pickDisplayName(p)} ({p.position || p.pos || "SUB"})
                      </option>
                    );
                  })}
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
              {marketError || "Failed to save interest. Please try again."}
            </span>
          )}
        </div>

          <div className="marketResultsPanel">
            <div className="marketResultsHeader">
              <div className="marketResultsTitle">Market History</div>
              <button
                type="button"
                className="marketBtn marketBtnOutline"
                disabled={historyLoading}
                onClick={loadMarketHistory}
              >
                {historyLoading
                  ? "Loading History..."
                  : historyLoaded
                    ? "Refresh History"
                    : "Load Market History"}
              </button>
            </div>

            <div className="marketHistoryHelp">
              History is loaded only when requested to save reads.
            </div>

            {historyError ? (
              <div className="marketTextError">{historyError}</div>
            ) : !historyLoaded ? null : marketHistory.length === 0 ? (
              <div className="marketResultsEmpty">No market history yet.</div>
            ) : (
              <div className="marketResultsList">
                {marketHistory.map((r) => {
                  const who =
                    r.managerName ||
                    r.winnerName ||
                    r.displayName ||
                    r.uid ||
                    "Manager";
                  const wantedPlayer = allPlayers.find(
                    (p) => String(p.id) === String(r.wantId)
                  );
                  const wantName =
                    r.wantName ||
                    r.gotName ||
                    (wantedPlayer ? pickDisplayName(wantedPlayer) : "") ||
                    r.wantId;
                  const swapOutName =
                    r.swapOutName ||
                    r.releasedName ||
                    r.swapOutId;

                  const ok = r.ok === true || r.result === "won";
                  const releasedId = r.releasedId || r.swapOutId;
                  const gotId = r.gotId || r.wantId;
                  const fallbackReason =
                    r.reasonMessage ||
                    (r.tieBrokenRandomly
                      ? "Not awarded — you had the same priority as the winner, but lost the random tiebreaker."
                      : r.reason
                        ? friendlyMarketReason(r.reason)
                        : r.result === "lost"
                          ? "Not awarded — higher priority lost or player not available."
                          : "Not awarded.");

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
                          Dropped <b>{r.releasedName || r.swapOutName || releasedId}</b> → Added <b>{r.gotName || r.wantName || gotId}</b>
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
      </div>

    </div>
  );
}
