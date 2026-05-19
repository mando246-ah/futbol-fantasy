// src/pages/TournamentPage/TournamentPage.jsx
import { useEffect, useState, useRef} from "react";
import { useParams, Link } from "react-router-dom";
import { doc, onSnapshot, collection, query, orderBy, limit } from "firebase/firestore";

import { useLineupsForUsers, useTournament } from "../../tournament/hooks/useTournament";
import { app, auth, db } from "../../firebase";

import "./TournamentPage.css";
import { Avatar, AvatarImage, AvatarFallback } from "../../components/ui/avatar";
import { httpsCallable } from "firebase/functions"; 
import { functions } from "../../firebase";
import FinalResultsCard from "../../components/ui/FinalResultsCard";
import FlagIcon from "../../components/FlagIcon";

//Labels for stats
const STAT_LABELS = {
  // Core
  base: "Appearance",
  appearance: "Appearance",
  sixtyPlus: "Played 60+ mins",
  goals: "Goals",
  assists: "Assists",
  cleanSheet: "Clean sheet (60+ mins)",
  saves: "Saves",
  goalsConceded: "Goals conceded",
  yellow: "Yellow card",
  red: "Red card",
  ownGoals: "Own goal",

  // Penalties
  pensSaved: "Penalty saved",
  pensMissed: "Penalty missed",
  pensCommitted: "Penalty committed",

  // Passing
  passesCompleted: "Passes completed",

  // Advanced
  tackles: "Tackles",
  duelsWon: "Duels won",
  dribblesSuccess: "Dribbles (successful)",
  foulsCommitted: "Fouls committed",
  offsides: "Offsides",
  shotsOnTarget: "Shots on target",
  rating: "Rating",
  rating85: "Rating 8.5+",

  minutes: "Minutes played",
  pensScored: "Penalty scored",
  dribbles: "Dribbles",
  duels: "Duels",
  shotsOn: "Shots on target",
  kickoffMs: "Kickoff",
  kickoffAtMs: "Kickoff",
};

function prettyStatLabel(key) {
  if (!key) return "";
  if (STAT_LABELS[key]) return STAT_LABELS[key];

  // fallback: camelCase / snake_case -> Title Case
  const s = String(key)
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();

  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getUserBreakdown(resultsDoc, uid) {
  const bd = resultsDoc?.breakdownByUserId?.[uid] || null;
  if (!bd) return { starters: [], bench: [], partsByPlayerId: {} };

  const starters = bd.starters || bd.startingXI || bd.starting || bd.xi || [];
  const bench = bd.bench || bd.subs || bd.substitutes || [];
  const partsByPlayerId =
    bd.partsByPlayerId || bd.playerBreakdown || bd.breakdownByPlayerId || {};

  return { starters, bench, partsByPlayerId };
}

function playerIdOf(p) {
  return String(p?.playerId ?? p?.id ?? p?.pid ?? "");
}
function playerNameOf(p) {
  return p?.name ?? p?.playerName ?? p?.fullName ?? "Player";
}
function playerPosOf(p) {
  return p?.pos ?? p?.position ?? "";
}
function playerPtsOf(p) {
  return Number(p?.pts ?? p?.points ?? p?.total ?? 0);
}

function mainPointsClass(points) {
  const n = Number(points);
  if (Number.isFinite(n) && n > 0) return "tpPtsPositive";
  if (Number.isFinite(n) && n < 0) return "tpPtsNegative";
  return "tpPtsZero";
}

function fmtDT(v) {
  if (!v) return "—";

  const LOCALE = "en-US";
  const OPTS = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true };

  // Firestore Timestamp support
  if (typeof v === "object") {
    if (typeof v.toMillis === "function") return new Date(v.toMillis()).toLocaleString(LOCALE, OPTS);
    if (typeof v.seconds === "number") return new Date(v.seconds * 1000).toLocaleString(LOCALE, OPTS);
  }

  // Milliseconds support
  const ms = Number(v);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(LOCALE, OPTS);
}

function initials(s) {
  const t = String(s || "").trim();
  if (!t) return "U";
  const parts = t.split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase()).join("") || "U";
}

function getBenchList(activeResults, uid, userObj) {
  const key = uid == null ? null : String(uid);

  const fromResults = key ? activeResults?.benchByUserId?.[key] : null;

  // ✅ only trust backend if it actually has players
  if (Array.isArray(fromResults) && fromResults.length > 0) return fromResults;

  // Fallbacks (hook-loaded lineup bench)
  if (Array.isArray(userObj?.bench) && userObj.bench.length > 0) return userObj.bench;
  if (Array.isArray(userObj?.subs) && userObj.subs.length > 0) return userObj.subs;
  if (Array.isArray(userObj?.benchPlayers) && userObj.benchPlayers.length > 0) return userObj.benchPlayers;

  // If backend explicitly provided [] and we have no fallback, return []
  if (Array.isArray(fromResults)) return fromResults;

  return [];
}

function getStartersList(activeResults, uid, userObj) {
  const key = uid == null ? null : String(uid);
  const fromResults = key ? activeResults?.startersByUserId?.[key] : null;

  // trust backend if it has players
  if (Array.isArray(fromResults) && fromResults.length > 0) return fromResults;

  // fallback to hook-loaded lineup
  if (Array.isArray(userObj?.starters) && userObj.starters.length > 0) return userObj.starters;

  // if backend explicitly provided [] and no fallback, return []
  if (Array.isArray(fromResults)) return fromResults;

  return [];
}

const DISPLAY_POS_ORDER = {
  ATT: 0,
  MID: 1,
  DEF: 2,
  GK: 3,
};

function normalizeDisplayPos(pos) {
  const p = String(pos || "").toUpperCase().trim();

  if (["ATT", "ATK", "FWD", "FW", "ST", "CF", "LW", "RW"].includes(p)) return "ATT";
  if (["MID", "CM", "CDM", "CAM", "LM", "RM"].includes(p)) return "MID";
  if (["DEF", "CB", "LB", "RB", "LWB", "RWB"].includes(p)) return "DEF";
  if (["GK", "G"].includes(p)) return "GK";

  return p;
}

function sortPlayersForDisplay(list = []) {
  return [...list].sort((a, b) => {
    const aRank = DISPLAY_POS_ORDER[normalizeDisplayPos(playerPosOf(a))] ?? 99;
    const bRank = DISPLAY_POS_ORDER[normalizeDisplayPos(playerPosOf(b))] ?? 99;

    if (aRank !== bRank) return aRank - bRank;

    return playerNameOf(a).localeCompare(playerNameOf(b));
  });
}

function firstText(...values) {
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

const LIVE_STATUS_CODES = new Set(["1H", "HT", "2H", "ET", "BT", "P"]);
const FINAL_STATUS_CODES = new Set(["FT", "AET", "PEN"]);

function isLiveStatusCode(value) {
  return LIVE_STATUS_CODES.has(String(value || "").trim().toUpperCase());
}

function isFinalStatusCode(value) {
  return FINAL_STATUS_CODES.has(String(value || "").trim().toUpperCase());
}

function isPlayerLiveFromStats(stats = {}) {
  const status =
    stats?.statusShort ||
    stats?.fixtureStatus ||
    stats?.matchStatus ||
    "";

  if (isFinalStatusCode(status)) return false;

  return Boolean(stats?.isLive) || isLiveStatusCode(status);
}

function statsFromEntry(entry = {}) {
  return entry?.stats || entry?.rawStats || {};
}

function getPlayerCountry(player = {}, entry = null, pick = null) {
  return firstText(
    player?.country,
    player?.nationality,
    player?.playerCountry,
    player?.birthCountry,

    pick?.country,
    pick?.nationality,
    pick?.playerCountry,
    pick?.birthCountry,

    entry?.country,
    entry?.nationality,
    entry?.playerCountry
  );
}

function getPlayerClub(player = {}, entry = null, pick = null) {
  const stats = statsFromEntry(entry || {});
  return firstText(
    stats?.teamName,
    stats?.realTeamName,
    stats?.clubName,

    entry?.teamName,
    entry?.realTeamName,
    entry?.clubName,
    entry?.club,

    player?.clubName,
    player?.club,
    player?.teamName,
    player?.realTeamName,
    player?.team?.name,

    pick?.clubName,
    pick?.club,
    pick?.teamName,
    pick?.realTeamName,
    pick?.team?.name,
    pick?.lastRealTeamName,

    "Unknown Team"
  );
}

function getDisplayTeamName(player = {}, entry = null, pick = null, stats = null) {
  const liveStats = stats || statsFromEntry(entry || {});
  return firstText(
    liveStats?.teamName,
    liveStats?.realTeamName,
    liveStats?.clubName,
    entry?.teamName,
    entry?.realTeamName,
    entry?.clubName,
    player?.teamName,
    player?.clubName,
    player?.club,
    pick?.teamName,
    pick?.clubName,
    pick?.club,
    "Unknown Team"
  );
}

function getDisplayOpponentName(player = {}, entry = null, stats = null) {
  const liveStats = stats || statsFromEntry(entry || {});
  return firstText(
    liveStats?.opponentName,
    liveStats?.opponentTeamName,
    entry?.opponentName,
    player?.opponentName,
    "Opponent"
  );
}

function PlayerIdentity({ name, country, club }) {
  return (
    <div className="tpPlayerInfo">
      <span className="tpName">{name}</span>

      {(country || club) && (
        <div className="tpPlayerSubline">
          {country ? (
            <span className="tpPlayerSubItem">
              <FlagIcon country={country} size={14} title={country} />
              <span>{country}</span>
            </span>
          ) : null}
          •
          {club ? (
            <span className="tpPlayerSubItem tpPlayerClub">{club}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function pointsFromEntry(entry) {
  if (typeof entry === "number") return entry;
  if (entry && typeof entry === "object") return Number(entry.points ?? 0) || 0;
  return 0;
}

function sumPointsForList(breakdown, list) {
  const perPlayer = breakdown?.perPlayer || {};
  return (list || []).reduce((acc, p) => {
    const entry = perPlayer[String(p?.id)];
    return acc + pointsFromEntry(entry);
  }, 0);
}

function UserChip({ user }) {
  const displayName = user?.displayName || user?.name || user?.userId || "Unknown";
  const teamName = user?.teamName || "";
  const photoURL = user?.photoURL || "";

  return (
    <div className="tpUserChip">
      <Avatar className="tpAvatar">
        <AvatarImage src={photoURL || undefined} alt={displayName} />
        <AvatarFallback>{initials(displayName)}</AvatarFallback>
      </Avatar>

      <div className="tpUserText">
        <div className="tpUserName">{displayName}</div>
        {teamName ? <div className="tpUserTeam">{teamName}</div> : null}
      </div>
    </div>
  );
}

const SCORING_DISPLAY = [
  { label: "Appearance", detail: "+1 (any minutes)" },
  { label: "Played 60+ mins", detail: "+1 (60+ minutes)" },

  { label: "Goals", detail: "FWD: +4 • MID: +5 • DEF/GK: +6" },
  { label: "Assists", detail: "+3" },

  { label: "Clean Sheet (60+ mins)", detail: "DEF/GK: +4 • MID: +1 • FWD: +0" },
  { label: "Saves (GK)", detail: "+1 per 2 saves" },
  { label: "Goals Conceded", detail: "-1 per 2 conceded (DEF/GK)" },

  { label: "Yellow Card", detail: "-1" },
  { label: "Red Card", detail: "-3" },

  { label: "Rating 8.5+", detail: "+3" },

  { label: "Penalties Saved (GK)", detail: "+5" },
  { label: "Penalties Missed", detail: "-2" },
  { label: "Penalties Committed", detail: "-1" },

  { label: "Passing Total", detail: "GK: 30 • DEF/MID: 25 • FWD: 20 = +1" },

  { label: "Tackles", detail: "+1 per 2" },
  { label: "Duels Won", detail: "+1 per 4" },
  { label: "Dribbles Success", detail: "+1 per 2" },

  { label: "Fouls Committed", detail: "-1 per 2" },
  { label: "Offsides", detail: "-1 per 3" },

  { label: "Shots on Target", detail: "+1 each" },
];

export default function TournamentPage() {
  const { roomId } = useParams();
  const { loading, error, data } = useTournament(roomId, { loadScope: "core", enableLocalFallback: false });
  const [myUid, setMyUid] = useState(auth.currentUser?.uid || null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  
  //const myUid = auth.currentUser?.uid;
  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => setMyUid(u?.uid || null));
    return unsub;
  }, [])

  
  // UI-only clock (used for the "Live updating" countdown)
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const isHost = data?.room?.hostUid === myUid;

  // Firestore live docs for the new "Weeks" system
  const [currentWeekIndex, setCurrentWeekIndex] = useState(null);
  const [weekDoc, setWeekDoc] = useState(null);
  const [weekResults, setWeekResults] = useState(null);
  const [stableWeekResults, setStableWeekResults] = useState(null);
  const [standingsDoc, setStandingsDoc] = useState(null);
  const [bootingWeek, setBootingWeek] = useState(false);
  const [bootWeekErr, setBootWeekErr] = useState(null);
  const [bootAttempted, setBootAttempted] = useState(false);
  const [expandedPlayerId, setExpandedPlayerId] = useState(null);
  const [showScoring, setShowScoring] = useState(false);
  const [forcingUpdate, setForcingUpdate] = useState(false);
  const [creatingNextWeek, setCreatingNextWeek] = useState(false);
  const [shadowTestBusy, setShadowTestBusy] = useState(false);
  const [globalApplyBusy, setGlobalApplyBusy] = useState(false);
  // Week history (previous weeks dropdown)
  const [historyEnabled, setHistoryEnabled] = useState(false);
  const [weekHistory, setWeekHistory] = useState([]);
  const [historyWeekIndex, setHistoryWeekIndex] = useState(null);
  const [historyWeekDoc, setHistoryWeekDoc] = useState(null);
  const [historyWeekResults, setHistoryWeekResults] = useState(null);
  const [openBreakdownKey, setOpenBreakdownKey] = useState(null);
  //Ending Draft
  const [finalResultsDoc, setFinalResultsDoc] = useState(null);
  const [syncingRounds, setSyncingRounds] = useState(false);
  const [forcingFinalize, setForcingFinalize] = useState(false);
  const [clearingFinalize, setClearingFinalize] = useState(false);
  const [totalRounds, setTotalRounds] = useState(null);

  //Test
  
  // 1. Add the fake toggle and mock podium data
  const [devPreviewComplete, setDevPreviewComplete] = useState(false);

  const fakePodiumData = {
    computedAtMs: Date.now(),
    top3: [
      // Use myUid instead of me! The UI will automatically grab your real name/avatar.
      { userId: myUid || "1", name: "You (Champion)", wins: 15, tablePoints: 45, totalFantasyPoints: 1200 },
      { userId: "2", name: "Silver Manager", wins: 12, tablePoints: 36, totalFantasyPoints: 1050 },
      { userId: "3", name: "Bronze Manager", wins: 10, tablePoints: 30, totalFantasyPoints: 980 }
    ]
  };

  // 2. Update this line so it listens to the toggle OR the database
  const showFinalPodium = devPreviewComplete || Boolean(finalResultsDoc);

  // Other Matchups expand/collapse (separate from main matchup player expand)
  const [expandedOtherMatchupKey, setExpandedOtherMatchupKey] = useState(null);
  const [expandedOtherPlayer, setExpandedOtherPlayer] = useState({ matchupKey: null, playerId: null });

  const toggleOtherMatchup = (matchupKey) => {
    setExpandedOtherMatchupKey((prev) => (prev === matchupKey ? null : matchupKey));
    // close any open player card inside other matchups when switching
    setExpandedOtherPlayer({ matchupKey: null, playerId: null });
  };

  const toggleOtherPlayer = (matchupKey, pid) => {
    setExpandedOtherPlayer((prev) => {
      const same = prev.matchupKey === matchupKey && prev.playerId === pid;
      return same ? { matchupKey: null, playerId: null } : { matchupKey, playerId: pid };
    });
  };


  const togglePlayer = (pid) => {
    setExpandedPlayerId(expandedPlayerId === pid ? null : pid);
  };

  const createNextWeekFn = httpsCallable(functions, "createNextWeek");
  const syncTotalRoundsFn = httpsCallable(functions, "debugSyncTotalRounds");
  const forceFinalizeSeasonFn = httpsCallable(functions, "debugForceFinalizeSeason");
  const clearFinalResultsFn = httpsCallable(functions, "debugClearFinalResults");
  const scoringRef = useRef(null);

  const recomputeStandingsFn = httpsCallable(
    functions,
    "debugRecomputeRegularSeasonStandings"
  );

  const totalRoundsDisplay =
    totalRounds ??
    (() => {
      // Check both the nested path and the literal string key path
      const trNested = data?.room?.competitionMeta?.totalRounds;
      const trLiteral = data?.room?.["competitionMeta.totalRounds"];
      const trComp = data?.room?.competition?.totalRounds;
      
      const val = Number(trNested || trLiteral || trComp || 0);
      return val > 0 ? val : null;
    })();

  const competitionName =
    data?.room?.competitionMeta?.name ||
    data?.room?.competition?.name ||
    "";

  const competitionSeason =
    data?.room?.competition?.season ||
    data?.room?.competitionMeta?.season ||
    "";

  const competitionLabel = [competitionSeason, competitionName]
    .filter(Boolean)
    .join(" ");

  

  //Add previous weeeks 
  const [repairing, setRepairing] = useState(false);
  const [recomputingStandings, setRecomputingStandings] = useState(false);

    async function repairThisWeek() {
      if (!isHost) return;
      if (currentWeekIndex == null) return alert("No current weekIndex yet.");

      try {
        setRepairing(true);
        const fn = httpsCallable(functions, "repairWeekFixtures");

        // Use the current week shown on the page:
        await fn({ roomId, weekIndex: currentWeekIndex });

        alert("Week fixtures repaired. Give it ~1 minute then refresh.");
      } catch (e) {
        console.error(e);
        alert(e?.message || "Repair failed.");
      } finally {
        setRepairing(false);
      }
    }

  async function debugRunGlobalShadowRegularTest() {
    if (!isHost) return;
    if (!roomId) return;
    if (currentWeekIndex == null) return alert("No current weekIndex yet.");

    try {
      setShadowTestBusy(true);

      const fn = httpsCallable(functions, "debugComputeGlobalShadowRegularRoom");
      const res = await fn({ roomId, weekIndex: currentWeekIndex });

      console.log("====================================");
      console.log("GLOBAL SHADOW REGULAR TEST RESULT");
      console.log("Room:", roomId);
      console.log("Week:", currentWeekIndex);
      console.log("Season:", res.data?.seasonKey);
      console.log("Summary:", res.data);
      console.table(res.data?.fixtureCoverage || []);
      console.table(
        Object.entries(res.data?.diffsByUid || {}).map(([uid, diff]) => ({
          uid,
          diff,
        }))
      );
      console.table(res.data?.playerMismatches || []);
      console.log("Max Abs Diff:", res.data?.maxAbsDiff);
      console.log("Missing Fixtures:", res.data?.missingFixtureCount);
      console.log("====================================");

      alert(
        `Shadow test complete: maxAbsDiff=${res.data?.maxAbsDiff ?? 0}, missingFixtures=${res.data?.missingFixtureCount ?? 0}`
      );
    } catch (e) {
      console.error("GLOBAL SHADOW REGULAR TEST FAILED", e);
      alert(e?.message || "Global regular shadow test failed. Check console.");
    } finally {
      setShadowTestBusy(false);
    }
  }

  async function debugApplyRegularGlobalAggregatorOnce() {
    if (!isHost) return;
    if (!roomId) return;
    if (currentWeekIndex == null) return alert("No current weekIndex yet.");

    try {
      setGlobalApplyBusy(true);

      const fn = httpsCallable(functions, "debugApplyRegularGlobalAggregatorOnce");
      const res = await fn({ roomId, weekIndex: currentWeekIndex });

      console.log("====================================");
      console.log("GLOBAL REGULAR AGGREGATOR APPLY RESULT");
      console.log("Summary:", res.data);
      console.table(
        Object.entries(res.data?.diffsByUid || {}).map(([uid, diff]) => ({
          uid,
          diff,
        }))
      );
      console.table(res.data?.matchups || []);
      console.table(res.data?.weekLeaderboard || []);
      console.log("====================================");

      alert(
        `Global aggregator applied: maxAbsDiff=${res.data?.maxAbsDiff ?? 0}, missingFixtures=${res.data?.missingFixtureCount ?? 0}`
      );
    } catch (e) {
      console.error("GLOBAL REGULAR AGGREGATOR APPLY FAILED", e);
      alert(e?.message || "Global regular aggregator apply failed. Check console.");
    } finally {
      setGlobalApplyBusy(false);
    }
  }

  async function forceUpdateThisWeek() {
    if (!isHost) return;
    if (currentWeekIndex == null) return alert("No current weekIndex yet.");

    try {
      setForcingUpdate(true);
      const fn = httpsCallable(functions, "debugForceUpdateWeek");
      const res = await fn({ roomId, weekIndex: currentWeekIndex });        //does current week buttom one for specific weeks
      //const res = await fn({ roomId, weekIndex: 1});
      console.log("debugForceUpdateWeek:", res?.data);
      alert("Success! Stats updated and saved.");
    } catch (e) {
      console.error(e);
      alert("Error: " + (e?.message || "Unknown error"));
    } finally {
      setForcingUpdate(false);
    }
  }

  async function recomputeRegularStandingsNow() {
    if (!isHost) return;

    try {
      setRecomputingStandings(true);

      const res = await recomputeStandingsFn({ roomId });

      console.log("debugRecomputeRegularSeasonStandings:", res?.data);

      const count = res?.data?.standingsCount ?? 0;
      const finalWeekCount = res?.data?.standingsDoc?.finalWeekCount ?? "?";

      alert(
        `Leaderboard rebuilt. Rows: ${count}. Final weeks counted: ${finalWeekCount}.`
      );
    } catch (e) {
      console.error("debugRecomputeRegularSeasonStandings failed", e);
      alert("Error: " + (e?.message || "Unknown error"));
    } finally {
      setRecomputingStandings(false);
    }
  }

  async function syncTotalRounds() {
    if (!isHost) return;
    try {
      setSyncingRounds(true);
      const res = await syncTotalRoundsFn({ roomId });
      const total = res?.data?.totalRounds;
      setTotalRounds(Number(total) > 0 ? Number(total) : null);
      alert(`Saved total rounds: ${total ?? "OK"}`);
    } catch (e) {
      console.error(e);
      alert("Error: " + (e?.message || "Unknown error"));
    } finally {
      setSyncingRounds(false);
    }
  }

 function forceFinalizeSeason() {
    // Just toggle the UI, don't touch the database!
    setDevPreviewComplete(true);
  }

  function clearFinalResults() {
    // Revert the UI back to normal
    setDevPreviewComplete(false);
  }

  async function createNextWeekNow() {
    if (!isHost) return;
    try {
      setCreatingNextWeek(true);
      const res = await createNextWeekFn({ roomId });
      console.log("createNextWeek:", res?.data);
      alert("Next week created (or already exists).");
    } catch (e) {
      console.error(e);
      alert("Error: " + (e?.message || "Unknown error"));
    } finally {
      setCreatingNextWeek(false);
    }
  }

  async function copyRoomCode() {
    try {
      await navigator.clipboard.writeText(String(roomId));
      alert("Room code copied!");
    } catch (e) {
      console.error(e);
      alert("Could not copy. Room code: " + String(roomId));
    }
  }

  //FInal results
  useEffect(() => {
    if (!roomId) return;
    return onSnapshot(
      doc(db, "rooms", roomId, "finalResults", "current"),
      (snap) => setFinalResultsDoc(snap.exists() ? snap.data() : null),
      () => setFinalResultsDoc(null)
    );
  }, [roomId]);

  //History Matches
  useEffect(() => {
    if (!roomId || !historyEnabled) {
      setWeekHistory([]);
      setHistoryWeekIndex(null);
      return;
    }

    const qy = query(
      collection(db, "rooms", roomId, "weeks"),
      orderBy("index", "desc"),
      limit(20)
    );

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const items = snap.docs
          .map((d) => {
            const data = d.data() || {};
            const idx = Number(data.index ?? d.id);
            return { id: d.id, ...data, index: idx };
          })
          .filter((w) => Number.isFinite(Number(w.index)))
          .sort((a, b) => Number(b.index) - Number(a.index));
        setWeekHistory(items);
      },
      () => setWeekHistory([])
    );

    return () => unsub();
  }, [roomId, historyEnabled]);

  useEffect(() => {
    if (!roomId || !historyEnabled || historyWeekIndex == null) {
      setHistoryWeekDoc(null);
      setHistoryWeekResults(null);
      return;
    }

    const u1 = onSnapshot(
      doc(db, "rooms", roomId, "weeks", String(historyWeekIndex)),
      (s) => setHistoryWeekDoc(s.exists() ? s.data() : null),
      () => setHistoryWeekDoc(null)
    );

    const u2 = onSnapshot(
      doc(db, "rooms", roomId, "weekResults", String(historyWeekIndex)),
      (s) => setHistoryWeekResults(s.exists() ? s.data() : null),
      () => setHistoryWeekResults(null)
    );

    return () => {
      u1();
      u2();
    };
  }, [roomId, historyEnabled, historyWeekIndex]);




  useEffect(() => {
    if (!showScoring) return;

    const onMouseDown = (e) => {
      if (scoringRef.current && !scoringRef.current.contains(e.target)) {
        setShowScoring(false);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") setShowScoring(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showScoring]);

  useEffect(() => {
    if (!roomId) {
      setFinalResultsDoc(null);
      return;
    }
    const unsub = onSnapshot(
      doc(db, "rooms", roomId, "finalResults", "current"),
      (snap) => setFinalResultsDoc(snap.exists() ? snap.data() : null),
      () => setFinalResultsDoc(null)
    );
    return unsub;
  }, [roomId]);

  // Always run hooks (no conditional hooks)
  useEffect(() => {
    if (!roomId) {
      setCurrentWeekIndex(null);
      setTotalRounds(null);
      return;
    }

    const unsub = onSnapshot(
      doc(db, "rooms", roomId),
      (snap) => {
        const r = snap.exists() ? snap.data() : null;

        const idx = Number(r?.currentWeekIndex);
        setCurrentWeekIndex(Number.isFinite(idx) ? idx : null);

        // Target league rounds ONLY, ignoring the draft's root totalRounds
        const savedTotal = r?.competitionMeta?.totalRounds 
                        || r?.["competitionMeta.totalRounds"]
                        || r?.competition?.totalRounds;

        const tr = Number(savedTotal || 0);
        setTotalRounds(Number.isFinite(tr) && tr > 0 ? tr : null);
      },
      (err) => {
        console.error("rooms/{roomId} onSnapshot error:", err);
      }
    );

    return unsub;
  }, [roomId]);

  useEffect(() => {
    const savedTotal = data?.room?.competitionMeta?.totalRounds 
                    || data?.room?.["competitionMeta.totalRounds"]
                    || data?.room?.competition?.totalRounds;

    const tr = Number(savedTotal || 0);
    if (Number.isFinite(tr) && tr > 0) setTotalRounds(tr);
  }, [data?.room]); // Keeping dependency broad to catch all nested/literal changes

  useEffect(() => {
      if (!roomId || currentWeekIndex == null) {
        setWeekDoc(null);
        setWeekResults(null);
        setStandingsDoc(null);
        return;
      }


      const u1 = onSnapshot(
        doc(db, "rooms", roomId, "weeks", String(currentWeekIndex)),
        (s) => setWeekDoc(s.exists() ? s.data() : null),
        () => setWeekDoc(null)
      );

      const u2 = onSnapshot(
        doc(db, "rooms", roomId, "weekResults", String(currentWeekIndex)),
        (s) => setWeekResults(s.exists() ? s.data() : null),
        () => setWeekResults(null)
      );

      const u3 = onSnapshot(
        doc(db, "rooms", roomId, "standings", "current"),
        (s) => setStandingsDoc(s.exists() ? s.data() : null),
        () => setStandingsDoc(null)
      );

      return () => {
        u1();
        u2();
        u3();
      };
    }, [roomId, currentWeekIndex]);

  // Keep UI totals stable if Firestore briefly returns an empty/zero snapshot
  useEffect(() => {
    if (!weekResults) return;

    setStableWeekResults((prev) => {
      const next = weekResults;

      // Reset cache on week change
      if (!prev || Number(prev.weekIndex) !== Number(next.weekIndex)) return next;

      const prevTotals = prev.teamScoresByUserId || {};
      const nextTotals = next.teamScoresByUserId || {};
      const prevHasPoints = Object.values(prevTotals).some((v) => Number(v) > 0);
      const nextHasPoints = Object.values(nextTotals).some((v) => Number(v) > 0);

      // If we had points and the next snapshot looks like a temporary reset, keep the previous totals/breakdown.
      // (Helps prevent the "points -> 0 -> back" flicker.)
      if (prevHasPoints && !nextHasPoints && String(next.status || "").toLowerCase() !== "scheduled") {
        return {
          ...next,
          teamScoresByUserId: prevTotals,
          breakdownByUserId: prev.breakdownByUserId || next.breakdownByUserId,
          matchups: (Array.isArray(next.matchups) && next.matchups.length) ? next.matchups : (prev.matchups || next.matchups),
          weekLeaderboard: (Array.isArray(next.weekLeaderboard) && next.weekLeaderboard.length) ? next.weekLeaderboard : (prev.weekLeaderboard || next.weekLeaderboard),
        };
      }

      return next;
    });
  }, [weekResults]);

    useEffect(() => {
    if (!roomId) return;
    if (loading) return;
    if (!isHost) return;
    if (!data?.room?.competitionLocked || !data?.room?.competition?.league) return;
    // already have a week → nothing to do
    if (currentWeekIndex) return;

    // prevent retry loop
    if (bootAttempted) return;

    setBootAttempted(true);
    setBootingWeek(true);
    setBootWeekErr(null);

    createNextWeekFn({ roomId })
      .catch((e) => {
        setBootWeekErr(e);
      })
      .finally(() => setBootingWeek(false));
  }, [roomId, loading, isHost, currentWeekIndex, bootAttempted]);


  const coreUsers = data?.users || [];
  const preActiveResults = stableWeekResults || weekResults || null;
  const preMeUid = myUid || coreUsers[0]?.userId || null;
  const preMatchupsAllRaw =
    preActiveResults?.matchups?.length ? preActiveResults.matchups : weekDoc?.matchups || [];
  const preMyMatchup =
    (preMatchupsAllRaw || []).find(
      (m) => m.homeUserId === preMeUid || m.awayUserId === preMeUid
    ) || null;
  const preOpponentUid = preMyMatchup
    ? preMyMatchup.homeUserId === preMeUid
      ? preMyMatchup.awayUserId
      : preMyMatchup.homeUserId
    : null;
  const preExpandedOtherMatchup =
    expandedOtherMatchupKey
      ? (preMatchupsAllRaw || []).find(
          (m) => `${m.homeUserId}-${m.awayUserId}` === expandedOtherMatchupKey
        ) || null
      : null;
  const stagedLineupUserIds = Array.from(
    new Set([
      preMeUid,
      preOpponentUid,
      preExpandedOtherMatchup?.homeUserId,
      preExpandedOtherMatchup?.awayUserId,
    ].filter(Boolean).map(String))
  );
  const stagedLineups = useLineupsForUsers(roomId, stagedLineupUserIds, {
    enabled: Boolean(roomId && !loading),
  });

  // ---------- UI guards (after hooks) ----------
  if (!roomId) {
    return (
      <div className="tpPage">
      <div className="tpWrap">
        <h2 className="tpTitle">Tournament</h2>
        <p className="tpText">Join or create a room to get started.</p>
        <div className="tpLinks">
          <Link to="/draft">Create / Join Room</Link>
          <Link to="/">Go Home</Link>
        </div>
      </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="tpPage">
        <div className="tpCenter">
        <div className="tpWrap tpCenter">
          <div className="loader" aria-label="Loading tournament">
            <div className="loader_cube loader_cube--color" />
            <div className="loader_cube loader_cube--glowing" />
          </div>
        </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="tpPage">
        <div className="tpWrap">
          <h2 className="tpTitle">Tournament</h2>
          <p className="tpText">Something went wrong: {String(error.message || error)}</p>
        </div>
      </div>
    );
  }

  const stagedUsersById = stagedLineups.usersById || {};
  const users = [
    ...(data?.users || []).map((u) => ({
      ...u,
      ...(stagedUsersById[String(u.userId)] || {}),
    })),
    ...Object.values(stagedUsersById).filter(
      (u) => !(data?.users || []).some((base) => String(base.userId) === String(u.userId))
    ),
  ];
  const picksMap = stagedLineups.picksMap || {};
  const userById = Object.fromEntries(users.map((u) => [u.userId, u]));

  // Prefer week results if present; fallback to old results (Option A)
  const activeResults = stableWeekResults || weekResults || null;

  // --- Live Updating display (header) ---
  const resultsStatusRaw = activeResults?.status ?? "";
  const resultsStatus = String(resultsStatusRaw).toLowerCase();

  let lastUpdateMs = null;
  if (activeResults?.updatedAtMs) lastUpdateMs = Number(activeResults.updatedAtMs);
  else if (activeResults?.computedAt?.toMillis) lastUpdateMs = activeResults.computedAt.toMillis();
  else if (activeResults?.computedAt?.seconds) lastUpdateMs = activeResults.computedAt.seconds * 1000;

  const ageSec = lastUpdateMs ? Math.max(0, Math.floor((nowMs - lastUpdateMs) / 1000)) : null;
  const nextUpdateInSec = lastUpdateMs ? Math.max(0, 60 - (ageSec % 60)) : null;
  const lastUpdateLabel = lastUpdateMs ? fmtDT(lastUpdateMs) : "—";

  // Add this variable right above the if statement
  // Update to listen to devPreviewComplete
  const isSeasonComplete = devPreviewComplete || Boolean(finalResultsDoc) || data?.room?.seasonPhase === "COMPLETE";

  // Update the if statement to ONLY catch brand new drafts, not finished ones
  if (!isSeasonComplete && !activeResults) {
    const baseRows = (data?.users || []).map((u) => ({
      userId: u.userId,
      name: u.name || u.displayName || u.userId,
      wins: 0, draws: 0, losses: 0, tablePoints: 0, totalFantasyPoints: 0
    }));

    return (
      <div className="tpPage">
        <div className="tpWrap">
          <div className="tpHeaderRow">
            <div className="tpHeaderLeft">
              <h2 className="tpTitle">Tournament</h2>
              {competitionLabel ? (
                <div className="tpRoomMeta">
                  Competition: <b>{competitionLabel}</b>
                </div>
              ) : null}
              <p className="tpText">
                Room: <b>{roomId}</b>
                {currentWeekIndex != null ? (
                  <>
                    {" "}
                    • Week: <b>{currentWeekIndex}</b>
                  </>
                ) : null}
              </p>

              {weekDoc && (
                <p className="tpText">
                  Window: <b>{fmtDT(weekDoc.startAtMs)}</b> → <b>{fmtDT(weekDoc.endAtMs)}</b>
                  {weekDoc.roundLabel ? (
                    <>
                      {" "}
                      • Round: <b>{weekDoc.roundLabel}</b>
                      {totalRoundsDisplay ? <> / <b>{totalRoundsDisplay}</b></> : null}
                    </>
                  ) : null}
                </p>
              )}
            </div>

            {/* TOP RIGHT */}
            <div className="tpHeaderRight" ref={scoringRef}>
              <button
                type="button"
                className="tpScoringBtn"
                onClick={() => setShowScoring((v) => !v)}
                aria-expanded={showScoring}
                aria-haspopup="dialog"
              >
                Scoring <span className={`tpCaret ${showScoring ? "open" : ""}`}>▾</span>
              </button>

              {showScoring && (
                <div className="tpScoringPopover" role="dialog" aria-label="Scoring rules">
                  <div className="tpScoringTitle">Scoring</div>
                  <ul className="tpScoringList">
                    {SCORING_DISPLAY.map((r) => (
                      <li key={r.label} className="tpScoringItem">
                        <span className="tpScoringLabel">{r.label}</span>
                        <span className="tpScoringDetail">{r.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          <div className="tpGrid">
            {showFinalPodium && (
              <div className="tpCard tpFull">
                <FinalResultsCard
                  finalResults={devPreviewComplete ? fakePodiumData : finalResultsDoc}
                  title="Season Complete"
                  subtitle="Top 3"
                  badge="🏆"
                  showWdl={true}
                  matchLabel="Match"
                  fantasyLabel="Fantasy"
                  renderUser={(uid, fallbackName) => (
                    <UserChip user={userById?.[uid] || { userId: uid, name: fallbackName }} />
                  )}
                />
              </div>
            )}
             <div className="tpCard tpFull">
              <h3 className="tpCardTitle">Leaderboard</h3>

              <div className="tpBoard">
                <div className="tpBoardHead">
                  <span>#</span>
                  <span>Name</span>
                  <span>W/D/L</span>
                  <span>Match Pts</span>
                  <span>Total Fantasy</span>
                </div>

                {baseRows.map((row, idx) => (
                  <div key={row.userId || idx} className="tpBoardRow">
                    <span>{idx + 1}</span>
                    <span>
                      <UserChip user={userById[row.userId] || { userId: row.userId, name: row.name }} />
                    </span>
                    <span>0/0/0</span>
                    <span>0</span>
                    <span>0</span>
                  </div>
                ))}
              </div>

              <p className="tpText" style={{ marginTop: 10, opacity: 0.75 }}>
                Week results not available yet. Once the backend writes weekResults, points will appear.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }


  const me = users.find((u) => u.userId === myUid) || users[0];
  const myTotal = activeResults?.teamScoresByUserId?.[myUid] ?? 0;

  // No useMemo (avoids hook-order problems)
  const nameById = Object.fromEntries(users.map((u) => [u.userId, u.name]));

  // Matchups source:
  // - Prefer matchups written into weekResults (when available)
  // - Fallback to the week doc's matchups so "Your Matchup" shows immediately after Next Week
  const matchupsAllRaw =
    activeResults?.matchups?.length ? activeResults.matchups : weekDoc?.matchups || [];

  // Normalize matchup objects so UI always has totals/results even if week doc only has userIds
  const matchupsAll = matchupsAllRaw.map((m) => {
    const homeTotal = m.homeTotal ?? (activeResults?.teamScoresByUserId?.[m.homeUserId] ?? 0);
    const awayTotal = m.awayTotal ?? (activeResults?.teamScoresByUserId?.[m.awayUserId] ?? 0);

    const homeResult =
      m.homeResult ?? (homeTotal > awayTotal ? "W" : homeTotal < awayTotal ? "L" : "D");
    const awayResult =
      m.awayResult ?? (awayTotal > homeTotal ? "W" : awayTotal < homeTotal ? "L" : "D");

    return { ...m, homeTotal, awayTotal, homeResult, awayResult };
  });


  const myMatchup =
    matchupsAll.find(
      (m) => m.homeUserId === me?.userId || m.awayUserId === me?.userId
    ) || null;

  const myBreakdown = activeResults?.breakdownByUserId?.[me?.userId] || null;
  const myBench = getBenchList(activeResults, me?.userId, me);
  const myStarters = sortPlayersForDisplay(getStartersList(activeResults, me?.userId, me));


  const opponentUid = myMatchup
    ? myMatchup.homeUserId === me?.userId
      ? myMatchup.awayUserId
      : myMatchup.homeUserId
    : null;

  const opponent = opponentUid ? users.find((u) => u.userId === opponentUid) : null;
  const oppTotal = opponentUid ? (activeResults?.teamScoresByUserId?.[opponentUid] ?? 0) : 0;
  const oppBreakdown = opponentUid ? (activeResults?.breakdownByUserId?.[opponentUid] || null) : null;

  const oppBench = getBenchList(activeResults, opponentUid, opponent);
  const oppStarters = sortPlayersForDisplay(getStartersList(activeResults, opponentUid, opponent));
  const isLineupLoading = (uid) => Boolean(stagedLineups.loadingByUid?.[String(uid || "")]);

  const myBenchTotal = sumPointsForList(myBreakdown, myBench);
  const oppBenchTotal = sumPointsForList(oppBreakdown, oppBench);

  const otherMatchups = matchupsAll.filter(
      (m) => m.homeUserId !== me?.userId && m.awayUserId !== me?.userId
    ) || [];

  const boardRows = activeResults?.weekLeaderboard || activeResults?.leaderboard || [];

  // --- NEW LIVE STANDINGS LOGIC ---
  const baseStandings = standingsDoc?.standings || [];
  let liveStandings = [...baseStandings];

  // If there is an active week that is NOT final yet, project the live points onto the base standings
  const activeStatus = String(activeResults?.status || "").toLowerCase();
  const shouldProjectActiveWeek = activeResults && ["live", "resolving"].includes(activeStatus);

  if (shouldProjectActiveWeek) {
    const map = {};
    
    // 1. Copy the base standings into a map
    baseStandings.forEach(row => {
      map[row.userId] = { ...row };
    });

    // 2. Ensure every user in the room has a row
    (users || []).forEach(u => {
      if (!map[u.userId]) {
        map[u.userId] = { userId: u.userId, name: u.name, played: 0, wins: 0, draws: 0, losses: 0, tablePoints: 0, totalFantasyPoints: 0 };
      }
    });

    // 3. Add live fantasy points
    const liveScores = activeResults.teamScoresByUserId || {};
    Object.entries(liveScores).forEach(([uid, score]) => {
      if (map[uid]) map[uid].totalFantasyPoints += Number(score || 0);
    });

    // 4. Add projected live match points
    const liveMatchups = activeResults.matchups || [];
    liveMatchups.forEach(m => {
      if (!map[m.homeUserId] || !map[m.awayUserId]) return;
      
      if (m.homeResult === "W") {
        map[m.homeUserId].wins += 1; map[m.homeUserId].tablePoints += 3;
        map[m.awayUserId].losses += 1;
      } else if (m.homeResult === "D") {
        map[m.homeUserId].draws += 1; map[m.homeUserId].tablePoints += 1;
        map[m.awayUserId].draws += 1; map[m.awayUserId].tablePoints += 1;
      } else if (m.homeResult === "L") {
        map[m.homeUserId].losses += 1;
        map[m.awayUserId].wins += 1; map[m.awayUserId].tablePoints += 3;
      }
    });

    // Convert back to array
    liveStandings = Object.values(map);
  }

  // Sort the final table
  liveStandings.sort((a, b) => (b.tablePoints - a.tablePoints) || (b.totalFantasyPoints - a.totalFantasyPoints));
  
  const standingsRows = liveStandings;
  // --- END LIVE STANDINGS LOGIC ---

  const wrStatus = String(weekResults?.status || "").toUpperCase();
  const historyOptions = (weekHistory || [])
    .map((w) => ({
      index: Number(w.index ?? w.id),
      roundLabel: w.roundLabel || null,
      status: w.status || null,
    }))
    .filter((w) => Number.isFinite(w.index))
    .filter((w) => currentWeekIndex == null || w.index !== Number(currentWeekIndex))
    .sort((a, b) => b.index - a.index);

  const histResults = historyWeekResults || null;
  const histWeek = historyWeekDoc || null;

  const histMatchupsRaw =
    histResults?.matchups?.length ? histResults.matchups : histWeek?.matchups || [];

  const histMatchups = (histMatchupsRaw || []).map((m) => {
    const homeTotal = m.homeTotal ?? (histResults?.teamScoresByUserId?.[m.homeUserId] ?? 0);
    const awayTotal = m.awayTotal ?? (histResults?.teamScoresByUserId?.[m.awayUserId] ?? 0);

    const homeResult =
      m.homeResult ?? (homeTotal > awayTotal ? "W" : homeTotal < awayTotal ? "L" : "D");
    const awayResult =
      m.awayResult ?? (awayTotal > homeTotal ? "W" : awayTotal < homeTotal ? "L" : "D");

    return { ...m, homeTotal, awayTotal, homeResult, awayResult };
  });

  //Status label with color 
  const statusRaw = activeResults?.status || "idle";
  const statusLowerRaw = String(statusRaw).toLowerCase();

  // Keep the UI consistent: scheduled/sleeping should look like IDLE.
  const statusLower = statusLowerRaw === "scheduled" ? "idle" : statusLowerRaw;

  const isLive = statusLower === "live";
  const isResolving = statusLower === "resolving";

  const statusClass = isLive ? "live" : isResolving ? "resolving" : "idle";
  const statusLabel = isLive ? "LIVE" : isResolving ? "RESOLVING" : "IDLE";

  return (
    <div className="tpPage">
    <div className="tpWrap">
      <div className="tpHeaderRow">
        <div className="tpHeaderLeft">
          <h2 className="tpTitle">Tournament</h2>
          <div className="tpHeaderMetaBlock">
            {competitionLabel ? (
              <div className="tpRoomMeta">
                Competition:{" "}
                <b className="tpCompetitionLabel">
                  <FlagIcon
                    country={data?.room?.competitionMeta?.country}
                    size={16}
                    title={data?.room?.competitionMeta?.country}
                  />{" "}
                  {competitionLabel}
                </b>
              </div>
            ) : null}

            {weekDoc && (
              <div className="tpRoomMeta">
                Window: <b>{fmtDT(weekDoc.startAtMs)}</b> → <b>{fmtDT(weekDoc.endAtMs)}</b>
                {weekDoc.roundLabel ? (
                  <>
                    {" "}
                    • Round: <b>{weekDoc.roundLabel}</b>
                    {totalRoundsDisplay ? <> / <b>{totalRoundsDisplay}</b></> : null}
                  </>
                ) : null}
              </div>
            )}

            <div className="tpRoomMeta">
              Room: <b>{data?.room?.name} - {roomId}</b>
              {currentWeekIndex != null ? (
                <>
                  {" "}
                  • Week: <b>{currentWeekIndex}</b>
                </>
              ) : null}{" "}
            </div>

            <div className="tpLiveHeaderLine">
              {resultsStatus === "live" ? (
                <span>
                  <b className="tpLivePill live">Live Updating</b>
                  {nextUpdateInSec != null ? <> • Next update in: <b>{nextUpdateInSec}s</b></> : null}
                  <> • Last update at: <b>{lastUpdateLabel}</b></>
                </span>
              ) : (
                <span>
                  Status:  <b className={`tpLivePill ${statusClass}`}>{statusLabel}</b>
                  <> • Last update at: <b>{lastUpdateLabel}</b></>
                </span>
              )}
            </div>
          </div>
          
        </div>

        {/* ✅ RIGHT SIDE = ONLY BUTTONS */}
        <div className="tpHeaderRight" ref={scoringRef}>
          <div className="tpHeaderButtons">
            <button
              type="button"
              className="tpScoringBtn"
              onClick={() => setShowScoring((v) => !v)}
              aria-expanded={showScoring}
              aria-haspopup="dialog"
            >
              Scoring <span className={`tpCaret ${showScoring ? "open" : ""}`}>▾</span>
            </button>

            {isHost && (
              <details className="tpTools">
                <summary className="tpPointsBtn tpToolsBtn" aria-label="Host tools">
                  Tools <span className="tpCaret">▾</span>
                </summary>
                <div className="tpToolsMenu">
                  <button
                    type="button"
                    className="tpToolsItem"
                    onClick={debugRunGlobalShadowRegularTest}
                    disabled={
                      shadowTestBusy ||
                      globalApplyBusy ||
                      forcingUpdate ||
                      creatingNextWeek ||
                      repairing ||
                      recomputingStandings
                    }
                  >
                    {shadowTestBusy ? "Running Shadow Test..." : "DEV: Test Global Shadow"}
                  </button>

                  <button
                    type="button"
                    className="tpToolsItem"
                    onClick={debugApplyRegularGlobalAggregatorOnce}
                    disabled={
                      globalApplyBusy ||
                      shadowTestBusy ||
                      forcingUpdate ||
                      creatingNextWeek ||
                      repairing ||
                      recomputingStandings
                    }
                  >
                    {globalApplyBusy ? "Applying Global..." : "DEV: Apply Global Aggregator Once"}
                  </button>

                  <button
                    type="button"
                    className="tpToolsItem"
                    onClick={forceUpdateThisWeek}
                    disabled={forcingUpdate || creatingNextWeek || repairing}
                  >
                    {forcingUpdate ? "Updating..." : "Refresh Stats"}
                  </button>

                  <button
                    type="button"
                    className="tpToolsItem"
                    onClick={syncTotalRounds}
                    disabled={syncingRounds || forcingUpdate || creatingNextWeek || repairing}
                  >
                    {syncingRounds ? "Syncing..." : "Sync Total Rounds"}
                  </button>

                  <button
                    type="button"
                    className="tpToolsItem"
                    onClick={recomputeRegularStandingsNow}
                    disabled={recomputingStandings || forcingUpdate || creatingNextWeek || repairing}
                  >
                    {recomputingStandings ? "Rebuilding..." : "DEV: Rebuild Leaderboard"}
                  </button>

                  <button className="tpToolsItem" onClick={forceFinalizeSeason} disabled={forcingFinalize}>
                    {forcingFinalize ? "Finalizing..." : "DEV: Force Final Podium"}
                  </button>

                  <button className="tpToolsItem" onClick={clearFinalResults} disabled={clearingFinalize}>
                    {clearingFinalize ? "Clearing..." : "DEV: Clear Final Podium"}
                  </button>

                  <button
                    type="button"
                    className="tpToolsItem"
                    onClick={createNextWeekNow}
                    disabled={creatingNextWeek || forcingUpdate || repairing}
                  >
                    {creatingNextWeek ? "Creating..." : "Next Week"}
                  </button>


                  <button
                    type="button"
                    className="tpToolsItem"
                    onClick={repairThisWeek}
                    disabled={repairing || forcingUpdate || creatingNextWeek}
                  >
                    {repairing ? "Repairing..." : "Repair Fixtures"}
                  </button>


                  <button type="button" className="tpToolsItem" onClick={copyRoomCode}>
                    Copy Room Code
                  </button>
                </div>
              </details>
            )}
          </div>

          {showScoring && (
            <div className="tpScoringPopover" role="dialog" aria-label="Scoring rules">
              <div className="tpScoringTitle">Scoring</div>
              <ul className="tpScoringList">
                {SCORING_DISPLAY.map((r) => (
                  <li key={r.label} className="tpScoringItem">
                    <span className="tpScoringLabel">{r.label}</span>
                    <span className="tpScoringDetail">{r.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

    </div>

<div className="tpGrid">
   {showFinalPodium && (
      <div className="tpCard tpFull">
        <FinalResultsCard
          finalResults={devPreviewComplete ? fakePodiumData : finalResultsDoc}
          title="Season Complete"
          subtitle="Top 3"
          badge="🏆"
          showWdl={true}
          matchLabel="Match"
          fantasyLabel="Fantasy"
          renderUser={(uid, fallbackName) => (
            <UserChip user={userById?.[uid] || { userId: uid, name: fallbackName }} />
          )}
        />
      </div>
    )}
<div className="tpCard tpFull">
  <h3 className="tpCardTitle">Leaderboard</h3>
  <div className="tpBoard">
    <div className="tpBoardHead">
      <span>#</span>
      <span>Name</span>
      <span>W/D/L</span>
      <span>Match Pts</span>
      <span>Total Fantasy</span>
    </div>

    {(standingsRows.length ? standingsRows : boardRows).map((row, idx) => {
      const isStand = !!row?.tablePoints || row?.wins !== undefined;
      const name = row.name || nameById[row.userId] || row.userId;
      const wdl = isStand ? `${row.wins ?? 0}/${row.draws ?? 0}/${row.losses ?? 0}` : (row.result || "—");
      const matchPts = isStand ? (row.tablePoints ?? 0) : (row.matchPoints ?? 0);
      const totalFantasy = isStand ? (row.totalFantasyPoints ?? 0) : (row.fantasyPoints ?? 0);

      return (
        <div key={row.userId || idx} className="tpBoardRow">
          <span>{idx + 1}</span>
          <span><UserChip user={userById[row.userId] || { userId: row.userId, name }} /></span>
          <span>{wdl}</span>
          <span>{matchPts}</span>
          <span>{totalFantasy}</span>
        </div>
      );
    })}
  </div>
 
</div>

{!showFinalPodium && (
<div className="tpCard tpFull">
  <h3 className="tpCardTitle">Your Matchup</h3>
  {!myMatchup ? (
    <p className="tpText">No matchup yet.</p>
  ) : (
    <>
      <div className="tpMatchup">
        <div className="tpMatchRow">
          <span>
            <UserChip user={userById[myMatchup.homeUserId] || { userId: myMatchup.homeUserId, name: myMatchup.homeUserId }} />
          </span>
          <span>{myMatchup.homeTotal}</span>
        </div>
        <div className="tpMatchRow">
          <span>
            <UserChip user={userById[myMatchup.awayUserId] || { userId: myMatchup.awayUserId, name: myMatchup.awayUserId }} />
          </span>
          <span>{myMatchup.awayTotal}</span>
        </div>
        <div className="tpMatchFooter">
          Result:{" "}
          <b>{myMatchup.homeUserId === me?.userId ? myMatchup.homeResult : myMatchup.awayResult}</b>
        </div>
      </div>

      <div className="tpLineups">
        <div className="tpSide tpSideMe">
          <div className="tpLineupHead">
            <span className="tpLineupName">
              <UserChip user={userById[me?.userId] || { userId: me?.userId, name: me?.userId }} />
            </span>
            <span className="tpLineupTotal">{myTotal} pts</span>
          </div>
          <div className="tpSectionLabel">Starters</div>
          <ul className="tpList">
            {myStarters.map((p) => {
              const pid = playerIdOf(p);
              const entry = myBreakdown?.perPlayer?.[pid];
              const entryObj = typeof entry === "object" ? entry : null;
              const pickObj = picksMap[pid] || null;

              const pts = typeof entry === "number" ? entry : entry?.points ?? 0;
              const breakdown = entryObj?.breakdown || {};
              const stats = entryObj?.stats || {};
              const realTeamName = getDisplayTeamName(p, entryObj, pickObj, stats);
              const opponentName = getDisplayOpponentName(p, entryObj, stats);
              const country = getPlayerCountry(p, entryObj, pickObj);
              const club = realTeamName || getPlayerClub(p, entryObj, pickObj);
              const isPlayerLive = isPlayerLiveFromStats(stats);

              const isOpen = expandedPlayerId === pid;

              return (
                <li key={pid} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                  <div className="tpRow" onClick={() => togglePlayer(pid)}>
                    <PlayerIdentity
                      name={playerNameOf(p)}
                      country={country}
                      club={club}
                    />

                    <div className="tpMeta">
                      {normalizeDisplayPos(playerPosOf(p))}
                      <span className={`tpLivePill ${isPlayerLive ? "live" : "idle"}`}>
                        {isPlayerLive ? "LIVE" : "IDLE"}
                      </span>
                    </div>

                    <div className={`tpPts ${mainPointsClass(pts)}`}>{pts} pts</div>
                  </div>

                  {isOpen && (
                    <PlayerStatsCard
                      stats={stats}
                      breakdown={breakdown}
                      teamName={realTeamName}
                      opponentName={opponentName}
                    />
                  )}
                </li>
              );
            })}
            {!myStarters.length && isLineupLoading(me?.userId) && (
              <li className="tpLineupLoading">Loading your lineup...</li>
            )}
          </ul>
          {(myBench?.length || 0) > 0 && (
            <details className="tpBenchDetails">
              <summary className="tpBenchSummary">
                <div className="tpBenchLeft">
                  <span className="tpBenchTitle">Bench</span>
                  <span className="tpBenchHint">Not counted</span>
                </div>
                <div className="tpBenchRight">
                  <span className="tpBenchTotal">{myBenchTotal} pts</span>
                  <span className="tpBenchCaret">▾</span>
                </div>
              </summary>

              <ul className="tpList tpBenchList">
                {myBench.map((p) => {
                  const pid = playerIdOf(p);
                  const entry = myBreakdown?.perPlayer?.[pid];
                  const entryObj = typeof entry === "object" ? entry : null;
                  const pickObj = picksMap[pid] || null;

                  const pts = pointsFromEntry(entry);
                  const breakdown = entryObj?.breakdown || {};
                  const stats = entryObj?.stats || {};
                  const realTeamName = getDisplayTeamName(p, entryObj, pickObj, stats);
                  const opponentName = getDisplayOpponentName(p, entryObj, stats);
                  const country = getPlayerCountry(p, entryObj, pickObj);
                  const club = realTeamName || getPlayerClub(p, entryObj, pickObj);
                  const isPlayerLive = isPlayerLiveFromStats(stats);

                  const isOpen = expandedPlayerId === pid;

                  return (
                    <li key={pid} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                      <div className="tpRow" onClick={() => togglePlayer(pid)}>
                        <PlayerIdentity
                          name={playerNameOf(p)}
                          country={country}
                          club={club}
                        />

                        <div className="tpMeta">
                          {normalizeDisplayPos(playerPosOf(p))}
                          <span className={`tpLivePill ${isPlayerLive ? "live" : "idle"}`}>
                            {isPlayerLive ? "LIVE" : "IDLE"}
                          </span>
                        </div>

                        <div className={`tpPts ${mainPointsClass(pts)}`}>{pts} pts</div>
                      </div>

                      {isOpen && (
                        <PlayerStatsCard
                          stats={stats}
                          breakdown={breakdown}
                          teamName={realTeamName}
                          opponentName={opponentName}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </div>

        <div className="tpSide">
          <div className="tpLineupHead">
            <span className="tpLineupName">
              <UserChip user={userById[opponentUid] || { userId: opponentUid, name: opponentUid }} />
            </span>
            <span className="tpLineupTotal">{oppTotal} pts</span>
          </div>
          <div className="tpSectionLabel">Starters</div>
          <ul className="tpList">
            {oppStarters.map((p) => {
              const pid = playerIdOf(p);
              const entry = oppBreakdown?.perPlayer?.[pid];
              const entryObj = typeof entry === "object" ? entry : null;
              const pickObj = picksMap[pid] || null;

              const pts = typeof entry === "number" ? entry : entry?.points ?? 0;
              const breakdown = entryObj?.breakdown || {};
              const stats = entryObj?.stats || {};
              const realTeamName = getDisplayTeamName(p, entryObj, pickObj, stats);
              const opponentName = getDisplayOpponentName(p, entryObj, stats);
              const country = getPlayerCountry(p, entryObj, pickObj);
              const club = realTeamName || getPlayerClub(p, entryObj, pickObj);
              const isPlayerLive = isPlayerLiveFromStats(stats);

              const isOpen = expandedPlayerId === pid;

              return (
                <li key={pid} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                  <div className="tpRow" onClick={() => togglePlayer(pid)}>
                    <PlayerIdentity
                      name={playerNameOf(p)}
                      country={country}
                      club={club}
                    />

                    <div className="tpMeta">
                      {normalizeDisplayPos(playerPosOf(p))}
                      <span className={`tpLivePill ${isPlayerLive ? "live" : "idle"}`}>
                        {isPlayerLive ? "LIVE" : "IDLE"}
                      </span>
                    </div>

                    <div className={`tpPts ${mainPointsClass(pts)}`}>{pts} pts</div>
                  </div>

                  {isOpen && (
                    <PlayerStatsCard
                      stats={stats}
                      breakdown={breakdown}
                      teamName={realTeamName}
                      opponentName={opponentName}
                    />
                  )}
                </li>
              );
            })}
            {!oppStarters.length && isLineupLoading(opponentUid) && (
              <li className="tpLineupLoading">Loading opponent lineup...</li>
            )}
          </ul>
          {(oppBench?.length || 0) > 0 && (
            <details className="tpBenchDetails">
              <summary className="tpBenchSummary">
                <div className="tpBenchLeft">
                  <span className="tpBenchTitle">Bench</span>
                  <span className="tpBenchHint">Not counted</span>
                </div>
                <div className="tpBenchRight">
                  <span className="tpBenchTotal">{oppBenchTotal} pts</span>
                  <span className="tpBenchCaret">▾</span>
                </div>
              </summary>

              <ul className="tpList tpBenchList">
                {oppBench.map((p) => {
                  const pid = playerIdOf(p);
                  const entry = oppBreakdown?.perPlayer?.[pid];
                  const entryObj = typeof entry === "object" ? entry : null;
                  const pickObj = picksMap[pid] || null;

                  const pts = pointsFromEntry(entry);
                  const breakdown = entryObj?.breakdown || {};
                  const stats = entryObj?.stats || {};
                  const realTeamName = getDisplayTeamName(p, entryObj, pickObj, stats);
                  const opponentName = getDisplayOpponentName(p, entryObj, stats);
                  const country = getPlayerCountry(p, entryObj, pickObj);
                  const club = realTeamName || getPlayerClub(p, entryObj, pickObj);
                  const isPlayerLive = isPlayerLiveFromStats(stats);

                  const isOpen = expandedPlayerId === pid;

                  return (
                    <li key={pid} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                      <div className="tpRow" onClick={() => togglePlayer(pid)}>
                        <PlayerIdentity
                          name={playerNameOf(p)}
                          country={country}
                          club={club}
                        />

                        <div className="tpMeta">
                          {normalizeDisplayPos(playerPosOf(p))}
                          <span className={`tpLivePill ${isPlayerLive ? "live" : "idle"}`}>
                            {isPlayerLive ? "LIVE" : "IDLE"}
                          </span>
                        </div>

                        <div className={`tpPts ${mainPointsClass(pts)}`}>{pts} pts</div>
                      </div>

                      {isOpen && (
                        <PlayerStatsCard
                          stats={stats}
                          breakdown={breakdown}
                          teamName={realTeamName}
                          opponentName={opponentName}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </div>
      </div>
    </>
  )}
</div> 
)}

{!showFinalPodium && (
  <div className="tpCard tpFull">
  <h3 className="tpCardTitle">Other Matchups</h3>

  {!otherMatchups.length ? (
    <p className="tpText">No other matchups.</p>
  ) : (
    <div className="tpMatchup">
      {otherMatchups.map((m) => {
        const matchupKey = `${m.homeUserId}-${m.awayUserId}`;
        const isOpen = expandedOtherMatchupKey === matchupKey;

        // full user objects (these include starters)
        const homeUid = m.homeUserId;
        const awayUid = m.awayUserId;
        const homeTotal = Number(activeResults?.teamScoresByUserId?.[homeUid] ?? 0);
        const awayTotal = Number(activeResults?.teamScoresByUserId?.[awayUid] ?? 0);

        const homeBreakdown = activeResults?.breakdownByUserId?.[homeUid] || null;
        const awayBreakdown = activeResults?.breakdownByUserId?.[awayUid] || null;

        const homeUserFull = users.find((u) => u.userId === homeUid) || null;
        const awayUserFull = users.find((u) => u.userId === awayUid) || null;

        const homeBench = getBenchList(activeResults, homeUid, homeUserFull);
        const awayBench = getBenchList(activeResults, awayUid, awayUserFull);

        const homeStarters = getStartersList(activeResults, homeUid, homeUserFull);
        const awayStarters = getStartersList(activeResults, awayUid, awayUserFull);

        const homeBenchTotal = homeBreakdown?.benchTotal ?? sumPointsForList(homeBreakdown, homeBench);
        const awayBenchTotal = awayBreakdown?.benchTotal ?? sumPointsForList(awayBreakdown, awayBench);


        // chip fallback
        const homeUser = userById[m.homeUserId] || {
          userId: m.homeUserId,
          displayName: nameById[m.homeUserId] || m.homeUserId,
          teamName: "",
          photoURL: "",
        };

        const awayUser = userById[m.awayUserId] || {
          userId: m.awayUserId,
          displayName: nameById[m.awayUserId] || m.awayUserId,
          teamName: "",
          photoURL: "",
        };

        
        return (
          <div key={matchupKey} className={`tpOtherMatchupItem ${isOpen ? "open" : ""}`}>
            {/* clickable header row */}
            <button
              type="button"
              className="tpOtherMatchupTop"
              onClick={() => toggleOtherMatchup(matchupKey)}
              aria-expanded={isOpen}
            >
              <div className="tpMatchTeams">
                <UserChip user={homeUser} />
                <span className="tpVs">vs</span>
                <UserChip user={awayUser} />
              </div>

              <div className="tpOtherScore">
                <span className="tpMatchScore">
                  {homeTotal} — {awayTotal}
                </span>
                <span className={`tpCaret ${isOpen ? "open" : ""}`}>▾</span>
              </div>
            </button>

            {/* dropdown body */}
            {isOpen && (
              <div className="tpOtherMatchupBody">
                <div className="tpLineups" style={{ marginTop: 0 }}>
                  {/* HOME SIDE */}
                  <div className="tpSide">
                    <div className="tpLineupHead" style={{ marginTop: 0 }}>
                      <span className="tpLineupName">
                        <UserChip user={homeUser} />
                      </span>
                      <span className="tpLineupTotal">{homeTotal} pts</span>
                    </div>
                    <div className="tpSectionLabel">Starters</div>
                    <ul className="tpList">
                      {sortPlayersForDisplay(homeStarters).map((p) => {
                        const pid = playerIdOf(p);
                        const entry = homeBreakdown?.perPlayer?.[pid];
                        const pts = typeof entry === "number" ? entry : entry?.points ?? 0;
                        const breakdown = typeof entry === "object" ? entry?.breakdown : {};
                        const stats = typeof entry === "object" ? entry?.stats : {};
                        const entryObj = typeof entry === "object" ? entry : null;
                        const realTeamName = getDisplayTeamName(p, entryObj, null, stats);
                        const opponentName = getDisplayOpponentName(p, entryObj, stats);
                        const isPlayerLive = isPlayerLiveFromStats(stats);

                        const isPlayerOpen =
                          expandedOtherPlayer.matchupKey === matchupKey &&
                          expandedOtherPlayer.playerId === pid;

                        return (
                          <li key={pid} className={`tpRowWrap ${isPlayerOpen ? "tpRowOpen" : ""}`}>
                            <div className="tpRow" onClick={() => toggleOtherPlayer(matchupKey, pid)}>
                              <div className="tpPlayerInfo">
                                <span className="tpName">{playerNameOf(p)}</span>
                              </div>

                              <div className="tpMeta">
                                {normalizeDisplayPos(playerPosOf(p))}
                                <span className={`tpLivePill ${isPlayerLive ? "live" : "idle"}`}>
                                  {isPlayerLive ? "LIVE" : "IDLE"}
                                </span>
                              </div>

                              <div className={`tpPts ${mainPointsClass(pts)}`}>{pts} pts</div>
                            </div>

                            {isPlayerOpen && (
                              <PlayerStatsCard
                                stats={stats}
                                breakdown={breakdown}
                                teamName={realTeamName}
                                opponentName={opponentName}
                              />
                            )}
                          </li>
                        );
                      })}
                      {!homeStarters.length && isLineupLoading(homeUid) && (
                        <li className="tpLineupLoading">Loading lineups...</li>
                      )}
                    </ul>
                    {(homeBench?.length || 0) > 0 && (
                      <details className="tpBenchDetails">
                        <summary className="tpBenchSummary">
                          <div className="tpBenchLeft">
                            <span className="tpBenchTitle">Bench</span>
                            <span className="tpBenchHint">Not counted</span>
                          </div>
                          <div className="tpBenchRight">
                            <span className="tpBenchTotal">{homeBenchTotal} pts</span>
                            <span className="tpBenchCaret">▾</span>
                          </div>
                        </summary>

                        <ul className="tpList tpBenchList">
                          {homeBench.map((p) => {
                            const pid = playerIdOf(p);
                            const entry = homeBreakdown?.perPlayer?.[pid];
                            const pts = pointsFromEntry(entry);
                            const breakdown = typeof entry === "object" ? entry?.breakdown : {};
                            const stats = typeof entry === "object" ? entry?.stats : {};
                            const entryObj = typeof entry === "object" ? entry : null;
                            const realTeamName = getDisplayTeamName(p, entryObj, null, stats);
                            const opponentName = getDisplayOpponentName(p, entryObj, stats);
                            const isPlayerLive = isPlayerLiveFromStats(stats);

                            const isOpen =
                              expandedOtherPlayer.matchupKey === matchupKey &&
                              expandedOtherPlayer.playerId === pid;

                            return (
                              <li key={pid} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                                <div className="tpRow" onClick={() => toggleOtherPlayer(matchupKey, pid)}>
                                  <div className="tpPlayerInfo">
                                    <span className="tpName">{playerNameOf(p)}</span>
                                  </div>

                                  <div className="tpMeta">
                                    {normalizeDisplayPos(playerPosOf(p))}
                                    <span className={`tpLivePill ${isPlayerLive ? "live" : "idle"}`}>
                                      {isPlayerLive ? "LIVE" : "IDLE"}
                                    </span>
                                  </div>

                                  <div className={`tpPts ${mainPointsClass(pts)}`}>{pts} pts</div>
                                </div>

                                {isOpen && (
                                  <PlayerStatsCard
                                    stats={stats}
                                    breakdown={breakdown}
                                    teamName={realTeamName}
                                    opponentName={opponentName}
                                  />
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    )}
                  </div>

                  {/* AWAY SIDE */}
                  <div className="tpSide">
                    <div className="tpLineupHead" style={{ marginTop: 0 }}>
                      <span className="tpLineupName">
                        <UserChip user={awayUser} />
                      </span>
                      <span className="tpLineupTotal">{awayTotal} pts</span>
                    </div>
                    <div className="tpSectionLabel">Starters</div>
                    <ul className="tpList">
                      {sortPlayersForDisplay(awayStarters).map((p) => {
                        const pid = playerIdOf(p);
                        const entry = awayBreakdown?.perPlayer?.[pid];
                        const pts = typeof entry === "number" ? entry : entry?.points ?? 0;
                        const breakdown = typeof entry === "object" ? entry?.breakdown : {};
                        const stats = typeof entry === "object" ? entry?.stats : {};
                        const entryObj = typeof entry === "object" ? entry : null;
                        const realTeamName = getDisplayTeamName(p, entryObj, null, stats);
                        const opponentName = getDisplayOpponentName(p, entryObj, stats);
                        const isPlayerLive = isPlayerLiveFromStats(stats);

                        const isPlayerOpen =
                          expandedOtherPlayer.matchupKey === matchupKey &&
                          expandedOtherPlayer.playerId === pid;

                        return (
                          <li key={pid} className={`tpRowWrap ${isPlayerOpen ? "tpRowOpen" : ""}`}>
                            <div className="tpRow" onClick={() => toggleOtherPlayer(matchupKey, pid)}>
                              <div className="tpPlayerInfo">
                                <span className="tpName">{playerNameOf(p)}</span>
                              </div>

                              <div className="tpMeta">
                                {normalizeDisplayPos(playerPosOf(p))}
                                <span className={`tpLivePill ${isPlayerLive ? "live" : "idle"}`}>
                                  {isPlayerLive ? "LIVE" : "IDLE"}
                                </span>
                              </div>

                              <div className={`tpPts ${mainPointsClass(pts)}`}>{pts} pts</div>
                            </div>

                            {isPlayerOpen && (
                              <PlayerStatsCard
                                stats={stats}
                                breakdown={breakdown}
                                teamName={realTeamName}
                                opponentName={opponentName}
                              />
                            )}
                          </li>
                        );
                      })}
                      {!awayStarters.length && isLineupLoading(awayUid) && (
                        <li className="tpLineupLoading">Loading lineups...</li>
                      )}
                    </ul>
                    {(awayBench?.length || 0) > 0 && (
                      <details className="tpBenchDetails">
                        <summary className="tpBenchSummary">
                          <div className="tpBenchLeft">
                            <span className="tpBenchTitle">Bench</span>
                            <span className="tpBenchHint">Not counted</span>
                          </div>
                          <div className="tpBenchRight">
                            <span className="tpBenchTotal">{awayBenchTotal} pts</span>
                            <span className="tpBenchCaret">▾</span>
                          </div>
                        </summary>

                        <ul className="tpList tpBenchList">
                          {awayBench.map((p) => {
                            const pid = playerIdOf(p);
                            const entry = awayBreakdown?.perPlayer?.[pid];
                            const pts = pointsFromEntry(entry);
                            const breakdown = typeof entry === "object" ? entry?.breakdown : {};
                            const stats = typeof entry === "object" ? entry?.stats : {};
                            const entryObj = typeof entry === "object" ? entry : null;
                            const realTeamName = getDisplayTeamName(p, entryObj, null, stats);
                            const opponentName = getDisplayOpponentName(p, entryObj, stats);
                            const isPlayerLive = isPlayerLiveFromStats(stats);

                            const isOpen =
                              expandedOtherPlayer.matchupKey === matchupKey &&
                              expandedOtherPlayer.playerId === pid;

                            return (
                              <li key={pid} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                                <div className="tpRow" onClick={() => toggleOtherPlayer(matchupKey, pid)}>
                                  <div className="tpPlayerInfo">
                                    <span className="tpName">{playerNameOf(p)}</span>
                                  </div>

                                  <div className="tpMeta">
                                    {normalizeDisplayPos(playerPosOf(p))}
                                    <span className={`tpLivePill ${isPlayerLive ? "live" : "idle"}`}>
                                      {isPlayerLive ? "LIVE" : "IDLE"}
                                    </span>
                                  </div>

                                  <div className={`tpPts ${mainPointsClass(pts)}`}>{pts} pts</div>
                                </div>

                                {isOpen && (
                                  <PlayerStatsCard
                                    stats={stats}
                                    breakdown={breakdown}
                                    teamName={realTeamName}
                                    opponentName={opponentName}
                                  />
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  )}

  </div> )}
  {/*Week History*/}
  <div className="tpCard tpFull">
    {!historyEnabled ? (
      <div className="tpHistoryLoadCard">
        <div>
          <h3 className="tpHistoryLoadTitle">Week History</h3>
          <p className="tpHistoryLoadText">
          
          </p>
        </div>
        <button type="button" className="tpPointsBtn" onClick={() => setHistoryEnabled(true)}>
          Load Week History
        </button>
      </div>
    ) : (
      <>
    <div className="tpHistoryHeader">
      <h3 className="tpCardTitle tpHistoryTitle">Week History</h3>

      <div className="tpHistoryControls">
        <select
          className="tpHistorySelect"
          value={historyWeekIndex == null ? "" : String(historyWeekIndex)}
          onChange={(e) => {
            const v = e.target.value;
            setHistoryWeekIndex(v ? Number(v) : null);
          }}
        >
          <option value="">Select a previous week…</option>
          {historyOptions.map((w) => (
            <option key={w.index} value={String(w.index)}>
              Week {w.index}
              {w.roundLabel ? ` — ${w.roundLabel}` : ""}
              {w.status ? ` (${String(w.status).toUpperCase()})` : ""}
            </option>
          ))}
        </select>

        {historyWeekIndex != null && (
          <button type="button" className="tpMiniBtn" onClick={() => setHistoryWeekIndex(null)}>
            Clear
          </button>
        )}
      </div>
    </div>

    {historyWeekIndex == null ? (
      <p className="tpText">Pick a previous week to view final scores.</p>
    ) : !histWeek ? (
      <p className="tpText">Loading week…</p>
    ) : (
      <>
        <div className="tpHistoryMetaGrid">
          {/* Window Card */}
          <div className="tpHistoryMetaCard">
            <span className="tpHistoryMetaLabel">Window</span>
            <span className="tpHistoryMetaValue">
              {histWeek?.startAtMs ? fmtDT(histWeek.startAtMs) : "—"} → {histWeek?.endAtMs ? fmtDT(histWeek.endAtMs) : "—"}
            </span>
          </div>

          {/* Round Card */}
          <div className="tpHistoryMetaCard">
            <span className="tpHistoryMetaLabel">Round</span>
            <span className="tpHistoryMetaValue">
              {histWeek?.roundLabel || "—"}
              {totalRoundsDisplay ? ` / ${totalRoundsDisplay}` : ""}
            </span>
          </div>

          {/* Status (or Winner) Card */}
          <div className="tpHistoryMetaCard">
            <span className="tpHistoryMetaLabel">Status</span>
            <span className="tpHistoryMetaValue">
              {histResults?.status ? String(histResults.status).toUpperCase() : "—"}
            </span>
          </div>
        </div>

        {!histMatchups.length ? (
          <p className="tpText">No matchups found for this week.</p>
        ) : (
          <div className="tpHistoryList">
            {histMatchups.map((m) => {
              const matchupKey = `hist-${historyWeekIndex}-${m.homeUserId}-${m.awayUserId}`;
              const bdKey = `histbd-${historyWeekIndex}-${m.homeUserId}-${m.awayUserId}`;
              const isOpen = openBreakdownKey === bdKey;

              const homeUid = String(m.homeUserId);
              const awayUid = String(m.awayUserId);

              const homeUser = userById[m.homeUserId] || {
                userId: m.homeUserId,
                displayName: nameById[m.homeUserId] || m.homeUserId,
                teamName: "",
                photoURL: "",
              };

              const awayUser = userById[m.awayUserId] || {
                userId: m.awayUserId,
                displayName: nameById[m.awayUserId] || m.awayUserId,
                teamName: "",
                photoURL: "",
              };

              // ---- Breakdown helpers (local to this matchup) ----
              // NOTE:
              // - per-player breakdown is in breakdownByUserId[uid].perPlayer
              // - bench list is in benchByUserId[uid]
              // - starters list will only be in startersByUserId[uid] if you add it in functions;
              //   otherwise we fallback to current lineup in userById[uid].starters
              const getBD = (uid) => {
                const u = userById?.[uid] || null;

                const starters =
                  histResults?.startersByUserId?.[uid] || u?.starters || [];

                const bench =
                  histResults?.benchByUserId?.[uid] || u?.bench || [];

                const perPlayer =
                  histResults?.breakdownByUserId?.[uid]?.perPlayer || {};

                return { starters, bench, perPlayer };
              };

              const pidOf = (p) => String(p?.id ?? p?.playerId ?? p?.pid ?? "");
              const nameOf = (p) => p?.name ?? p?.playerName ?? p?.fullName ?? "Player";
              const posOf = (p) => p?.position ?? p?.pos ?? "";

              const normalizeParts = (entry) => {
                if (!entry || typeof entry !== "object") return null;
                // most common: entry.breakdown (what your backend stores)
                if (entry.breakdown && typeof entry.breakdown === "object") return entry.breakdown;
                // sometimes: entry.parts
                if (entry.parts && typeof entry.parts === "object") return entry.parts;
                // sometimes: entry.stats (still useful)
                if (entry.stats && typeof entry.stats === "object") return entry.stats;
                return null;
              };

              const pointsToneClass = (points) => {
                const n = Number(points);
                if (Number.isFinite(n) && n > 0) return "tpBreakdownPointsPillPositive";
                if (Number.isFinite(n) && n < 0) return "tpBreakdownPointsPillNegative";
                return "tpBreakdownPointsPillNeutral";
              };

              const valueToneClass = (value) => {
                const n = typeof value === "number" ? value : Number(value);
                if (Number.isFinite(n) && n > 0) return "tpBreakdownValuePositive";
                if (Number.isFinite(n) && n < 0) return "tpBreakdownValueNegative";
                return "tpBreakdownValueNeutral";
              };

              const renderSide = (title, bd) => (
                <div className="tpBreakdownCol">
                  <div className="tpBreakdownColTitle">{title}</div>

                  <div className="tpBreakdownSectionTitle">Starters</div>
                  {(bd.starters || []).length ? (
                    (bd.starters || []).map((p) => {
                      const pid = pidOf(p);
                      const entry = bd.perPlayer?.[pid] || bd.perPlayer?.[String(pid)] || null;
                      const totalPts = Number(entry?.points ?? p?.pts ?? p?.points ?? p?.total ?? 0);
                      const parts = normalizeParts(entry);

                      return (
                        <details key={`s-${title}-${pid}`} className="tpBreakdownPlayer">
                          <summary className="tpBreakdownSummary">
                            <span className="tpBreakdownName">{nameOf(p)}</span>
                            <span className="tpBreakdownMeta">
                              <span className="tpBreakdownPosBadge">{posOf(p) || "—"}</span>
                              <span className={`tpBreakdownPointsPill ${pointsToneClass(totalPts)}`}>
                                {totalPts} pts
                              </span>
                            </span>
                          </summary>

                          {parts ? (
                            <div className="tpBreakdownParts">
                              {Object.entries(parts)
                                .filter(([, v]) => v != null && Number(v) !== 0)
                                .map(([k, v]) => (
                                  <div key={k} className="tpBreakdownPartRow">
                                    <span className="tpBreakdownPartKey">{prettyStatLabel(k)}</span>
                                    <span className={`tpBreakdownPartVal ${valueToneClass(v)}`}>{String(v)}</span>
                                  </div>
                                ))}
                            </div>
                          ) : (
                            <div className="tpBreakdownParts tpMuted">No stat breakdown saved</div>
                          )}
                        </details>
                      );
                    })
                  ) : (
                    <div className="tpMuted">No starters saved for this week</div>
                  )}

                  <div className="tpBreakdownSectionTitle tpBreakdownBenchSection">Bench (not counted)</div>
                  {(bd.bench || []).length ? (
                    (bd.bench || []).map((p) => {
                      const pid = pidOf(p);
                      const entry = bd.perPlayer?.[pid] || bd.perPlayer?.[String(pid)] || null;
                      const totalPts = Number(entry?.points ?? p?.pts ?? p?.points ?? p?.total ?? 0);

                      return (
                        <details key={`b-${title}-${pid}`} className="tpBreakdownPlayer">
                          <summary className="tpBreakdownSummary">
                            <span className="tpBreakdownName">{nameOf(p)}</span>
                            <span className="tpBreakdownMeta">
                              <span className="tpBreakdownPosBadge">{posOf(p) || "—"}</span>
                              <span className={`tpBreakdownPointsPill ${pointsToneClass(totalPts)}`}>
                                {totalPts} pts
                              </span>
                            </span>
                          </summary>

                          {normalizeParts(entry) ? (
                            <div className="tpBreakdownParts">
                              {Object.entries(normalizeParts(entry))
                                .filter(([, v]) => v != null && Number(v) !== 0)
                                .map(([k, v]) => (
                                  <div key={k} className="tpBreakdownPartRow">
                                    <span className="tpBreakdownPartKey">{prettyStatLabel(k)}</span>
                                    <span className={`tpBreakdownPartVal ${valueToneClass(v)}`}>{String(v)}</span>
                                  </div>
                                ))}
                            </div>
                          ) : (
                            <div className="tpBreakdownParts tpMuted">No stat breakdown saved</div>
                          )}
                        </details>
                      );
                    })
                  ) : (
                    <div className="tpMuted">No bench saved for this week</div>
                  )}
                </div>
              );

              const homeBD = getBD(homeUid);
              const awayBD = getBD(awayUid);

              return (
                <div key={matchupKey} className="tpHistoryRowWrap">
                  <div className="tpHistoryRow">
                    <div className="tpHistoryTeams">
                      <UserChip user={homeUser} />
                      <span className="tpVs">vs</span>
                      <UserChip user={awayUser} />
                    </div>

                    <div className="tpHistoryScore">
                      <span className="tpMatchScore">
                        {Number(m.homeTotal ?? 0)} — {Number(m.awayTotal ?? 0)}
                      </span>
                      <span className="tpHistoryResult">
                        {m.homeResult}/{m.awayResult}
                      </span>

                      <button
                        type="button"
                        className="tpMiniBtn"
                        onClick={() => setOpenBreakdownKey(isOpen ? null : bdKey)}
                        style={{ marginLeft: 10 }}
                      >
                        {isOpen ? "Hide" : "Breakdown"}
                      </button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="tpBreakdownWrap">
                      <div className="tpBreakdownCols">
                        {renderSide("Home", homeBD)}
                        {renderSide("Away", awayBD)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </>
    )}
      </>
    )}
  </div>

  </div>
    </div>
  );
}

const LIVE_TIMER_STATUSES = new Set(["1H", "2H", "ET"]);
const HOLD_TIMER_STATUSES = new Set(["HT", "BT", "P"]);
const FINISHED_TIMER_STATUSES = new Set(["FT", "AET", "PEN"]);
const MAX_DISPLAY_EXTRA_MINUTES = 30;

function timerStatusOf(stats = {}) {
  return String(
    stats?.statusShort ||
    stats?.fixtureStatus ||
    stats?.matchStatus ||
    ""
  ).toUpperCase();
}

function formatClockSeconds(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getLiveTimerDisplay(stats, nowMs) {
  const status = timerStatusOf(stats);

  if (!status || status === "NS" || status === "TBD") return null;

  if (FINISHED_TIMER_STATUSES.has(status)) {
    return { main: "FINAL SCORE", extra: "", kind: "final" };
  }

  if (status === "HT") {
    return { main: "HT 45:00", extra: "", kind: "hold" };
  }

  if (status === "BT") {
    return { main: "ET 90:00", extra: "", kind: "hold" };
  }

  if (status === "P") {
    return { main: "PENS", extra: "", kind: "hold" };
  }

  const apiElapsed = Number(
    stats?.elapsed ??
    stats?.timerElapsed ??
    stats?.matchElapsed
  );
  const apiExtra = Number(stats?.extra ?? stats?.stoppageTime ?? 0);
  const updatedAtMs = Number(
    stats?.statusUpdatedAtMs ??
    stats?.timerUpdatedAtMs ??
    stats?.updatedAtMs
  );

  if (!Number.isFinite(apiElapsed) || apiElapsed <= 0) return null;

  let seconds = Math.floor(apiElapsed * 60);

  if (
    LIVE_TIMER_STATUSES.has(status) &&
    Number.isFinite(updatedAtMs) &&
    updatedAtMs > 0 &&
    nowMs > updatedAtMs
  ) {
    seconds += Math.floor((nowMs - updatedAtMs) / 1000);
  }

  let capSeconds = null;
  if (status === "1H") capSeconds = 45 * 60;
  if (status === "2H") capSeconds = 90 * 60;
  if (status === "ET") capSeconds = 120 * 60;

  let extra = "";

  if (capSeconds && seconds > capSeconds) {
    const computedExtra = Math.min(
      MAX_DISPLAY_EXTRA_MINUTES,
      Math.ceil((seconds - capSeconds) / 60)
    );
    const safeApiExtra =
      Number.isFinite(apiExtra) && apiExtra > 0 && apiExtra <= MAX_DISPLAY_EXTRA_MINUTES
        ? Math.floor(apiExtra)
        : 0;

    extra = `+${Math.max(computedExtra, safeApiExtra)}`;
    seconds = capSeconds;
  } else if (Number.isFinite(apiExtra) && apiExtra > 0 && apiExtra <= MAX_DISPLAY_EXTRA_MINUTES) {
    extra = `+${Math.floor(apiExtra)}`;
  }

  return {
    main: formatClockSeconds(seconds),
    extra,
    kind: "live",
  };
}

function PlayerStatsCard({ stats, breakdown, teamName, opponentName, labels }) {
  const hasStats = stats && Object.keys(stats).length > 0;
  const hasBD = breakdown && Object.keys(breakdown).length > 0;

  const [timerNowMs, setTimerNowMs] = useState(Date.now());
  const timerStatus = timerStatusOf(stats);

  useEffect(() => {
    if (!LIVE_TIMER_STATUSES.has(timerStatus)) return;

    setTimerNowMs(Date.now());

    const id = window.setInterval(() => {
      setTimerNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(id);
  }, [
    timerStatus,
    stats?.elapsed,
    stats?.extra,
    stats?.statusUpdatedAtMs,
    stats?.timerUpdatedAtMs,
    stats?.updatedAtMs,
  ]);
  
  const homeTeamName = firstText(stats?.homeTeamName, stats?.homeName);
  const awayTeamName = firstText(stats?.awayTeamName, stats?.awayName);
  const showHomeAwayHeader = Boolean(homeTeamName && awayTeamName);
  const headerTeamName = showHomeAwayHeader
    ? homeTeamName
    : firstText(stats?.teamName, stats?.realTeamName, stats?.clubName, teamName, "Unknown Team");
  const headerOpponentName = showHomeAwayHeader
    ? awayTeamName
    : firstText(stats?.opponentName, stats?.opponentTeamName, opponentName, "Opponent");
  const showMatchHeader = Boolean(headerTeamName || headerOpponentName);

  // Look for the game score in the raw stats
  const tScore = showHomeAwayHeader
    ? (stats?.goalsHome ?? stats?.homeGoals ?? stats?.homeScore ?? null)
    : (stats?.teamScore ?? stats?.teamGoals ?? null);
  const oScore = showHomeAwayHeader
    ? (stats?.goalsAway ?? stats?.awayGoals ?? stats?.awayScore ?? null)
    : (stats?.opponentScore ?? stats?.opponentGoals ?? null);
  const hasScore = tScore !== null && oScore !== null;
  const timerDisplay = getLiveTimerDisplay(stats, timerNowMs);
  const isLiveStatus =
    Boolean(stats?.isLive) ||
    LIVE_TIMER_STATUSES.has(timerStatus) ||
    HOLD_TIMER_STATUSES.has(timerStatus);
  const minutes = Number(stats?.minutes ?? stats?.minutesPlayed ?? 0);
  const showLiveNoAppearanceNote = isLiveStatus && minutes === 0;

  const dividerLabel =
    timerDisplay?.main ||
    (isLiveStatus ? "LIVE" : hasScore ? "FINAL SCORE" : "VS");

  if (!hasStats && !hasBD) {
    return (
      <div className="tpStatsCard">
        <div className="tpStatsGrid">
          <div className="tpStatsCol" style={{ gridColumn: "1 / -1" }}>
            <span className="tpStatsHead" style={{ textTransform: "uppercase" }}>No stats yet</span>
            <div className="tpStatRow">
              <span>Waiting for next games</span>
              <span>—</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // The Master Order for sorting
  const STAT_ORDER = [
    "position",
    "rating",
    "minutes",
    "goals",
    "assists",
    "shotsOnTarget",
    "passesCompleted",
    "tackles",
    "duelsWon",
    "dribblesSuccess",
    "saves",
    "goalsConceded",
    "cleanSheet",
    "yellow",
    "red",
    "foulsCommitted",
    "offsides",
    "sixtyPlus",
    "appearance"
  ];

  const sortedRawKeys = Object.keys(stats || {}).sort((a, b) => {
    const indexA = STAT_ORDER.indexOf(a);
    const indexB = STAT_ORDER.indexOf(b);
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return a.localeCompare(b);
  });
  const displayRawKeys = showLiveNoAppearanceNote && !sortedRawKeys.includes("minutes")
    ? ["minutes", ...sortedRawKeys]
    : sortedRawKeys;

  const sortedBreakdownKeys = Object.keys(breakdown || {}).sort((a, b) => {
    const indexA = STAT_ORDER.indexOf(a);
    const indexB = STAT_ORDER.indexOf(b);
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return a.localeCompare(b);
  });

  const validBreakdownKeys = sortedBreakdownKeys.filter((k) => {
    const v = breakdown[k];
    return v != null && v !== 0 && v !== "0";
  });

  // Helper to fallback to pretty text if STAT_LABELS is missing a key
  const prettyLabel = (k) => {
    if (labels && labels[k]) return labels[k];
    if (STAT_LABELS[k]) return STAT_LABELS[k];

    return k
      .replace(/_/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/^./, str => str.toUpperCase());
  };

  function formatStatValue(key, value) {
    if (key === "kickoffMs" || key === "kickoffAtMs") {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) return "—";

      return new Date(ms).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    }

    return String(value);
  }

  return (
    <div className="tpStatsCard">
      {showMatchHeader && (
      <div className="tpCardHeader">
        <div className="tpMatchHeaderTeam tpMatchHeaderTeamTop">
          <span className="tpMatchHeaderName">{headerTeamName}</span>
          {hasScore && <span className="tpMatchHeaderScore">{tScore}</span>}
        </div>

        {headerOpponentName && (
          <>
            <div className={`tpMatchHeaderDivider ${timerDisplay?.kind ? `tpMatchHeaderDivider-${timerDisplay.kind}` : ""}`}>
              <span>{dividerLabel}</span>
              {timerDisplay?.extra ? (
                <span className="tpMatchTimerExtra">{timerDisplay.extra}</span>
              ) : null}
            </div>

            <div className="tpMatchHeaderTeam">
              <span className="tpMatchHeaderName">{headerOpponentName}</span>
              {hasScore && <span className="tpMatchHeaderScore">{oScore}</span>}
            </div>
          </>
        )}
      </div>
    )}

      {showLiveNoAppearanceNote && (
        <div className="tpStatsNote">
          Team is live, but this player has not appeared yet.
        </div>
      )}

      <div className="tpStatsGrid">
        <div className="tpStatsCol">
          <span className="tpStatsHead">Raw Stats</span>
          {displayRawKeys.map((k) => {
            const v = k === "minutes" ? minutes : stats[k];
            
            // Hide the stat completely if the value is 0, false, null, or an internal API flag
            if (k !== "minutes" && (v == null || v === false || v === 0 || v === "0")) return null;
            if (k === "minutes" && !showLiveNoAppearanceNote && (v == null || v === false || v === 0 || v === "0")) return null;
            if (
              k === "isLive" ||
              k === "teamId" ||
              k === "fixtureId" ||
              k === "fixtureIds" ||
              k === "fixtureStatus" ||
              k === "matchStatus" ||
              k === "statusShort" ||
              k === "statusLong" ||
              k === "statusUpdatedAtMs" ||
              k === "elapsed" ||
              k === "extra" ||
              k === "teamScore" ||
              k === "opponentScore" ||
              k === "teamGoals" ||
              k === "opponentGoals" ||
              k === "goalsHome" ||
              k === "goalsAway" ||
              k === "homeTeamId" ||
              k === "awayTeamId" ||
              k === "homeTeamName" ||
              k === "awayTeamName" ||
              k === "homeTeamLogo" ||
              k === "awayTeamLogo"
            ) return null;

            return (
              <div key={k} className="tpStatRow">
                <span>{prettyLabel(k)}</span>
                <span>{formatStatValue(k, v)}</span>
              </div>
            );
          })}
        </div>

        <div className="tpStatsCol">
          <span className="tpStatsHead">Points</span>
          {validBreakdownKeys.map((k) => {
            const v = breakdown[k];
            return (
              <div key={k} className="tpStatRow">
                <span>{prettyLabel(k)}</span>
                <span className={v > 0 ? "tpPos" : "tpNeg"}>
                  {v > 0 ? "+" : ""}{v}
                </span>
              </div>
            );
          })}
          {validBreakdownKeys.length === 0 && (
            <div className="tpStatRow"><span>Appearance</span><span>0</span></div>
          )}
        </div>
      </div>
    </div>
  );
}
