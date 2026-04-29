// src/pages/TournamentPage/CupTournamentPage.jsx
import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { doc, onSnapshot, collection, query, orderBy } from "firebase/firestore";

import { useTournament } from "../../tournament/hooks/useTournament";
import { scorePlayerFromCore, toCorePos } from "../../tournament/logic/scoringCoreClient";
import { auth, db } from "../../firebase";

import "./TournamentPage.css";
import { Avatar, AvatarImage, AvatarFallback } from "../../components/ui/avatar";
import FlagIcon from "../../components/FlagIcon";
import FinalResultsCard from "../../components/ui/FinalResultsCard";
import { getApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";

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

const STAT_LABELS = {
  // Core
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

// --- Helpers ---
function initials(s) {
  const t = String(s || "").trim();
  if (!t) return "U";
  const parts = t.split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase()).join("") || "U";
}

function fmtDT(v) {
  if (!v) return "—";
  const LOCALE = "en-US";
  const OPTS = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true };
  const ms = Number(v);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(LOCALE, OPTS);
}

const DISPLAY_POS_ORDER = { ATT: 0, MID: 1, DEF: 2, GK: 3 };

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
    const aRank = DISPLAY_POS_ORDER[normalizeDisplayPos(a.position)] ?? 99;
    const bRank = DISPLAY_POS_ORDER[normalizeDisplayPos(b.position)] ?? 99;
    if (aRank !== bRank) return aRank - bRank;
    return (a.name || "").localeCompare(b.name || "");
  });
}

function hasBreakdownMap(breakdown) {
  return !!(breakdown && Object.keys(breakdown).length > 0);
}

function sumDisplayedPoints(list = []) {
  return (list || []).reduce((sum, p) => sum + Number(p?.points || 0), 0);
}

function sortCupLeaderboardRows(rows = []) {
  return [...rows].sort((a, b) => {
    const aFantasy = Number(a.totalFantasyPoints ?? a.totalPoints ?? 0);
    const bFantasy = Number(b.totalFantasyPoints ?? b.totalPoints ?? 0);
    if (bFantasy !== aFantasy) return bFantasy - aFantasy;

    const aTable = Number(a.tablePoints ?? 0);
    const bTable = Number(b.tablePoints ?? 0);
    if (bTable !== aTable) return bTable - aTable;

    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function sumNumberMaps(base = {}, add = {}) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(add || {})) {
    const uid = String(key || "");
    if (!uid) continue;
    out[uid] = Number(out[uid] || 0) + Number(value || 0);
  }
  return out;
}

function buildFixtureTotalsByUid(fixtures = [], fixtureIds = null) {
  const out = {};
  const filterIds = fixtureIds
    ? new Set(Array.from(fixtureIds).map((id) => String(id)).filter(Boolean))
    : null;

  for (const fx of fixtures || []) {
    const fixtureId = String(fx?.fixtureId || fx?.id || "");
    if (filterIds && !filterIds.has(fixtureId)) continue;

    for (const [uid, pts] of Object.entries(fx?.pointsByUid || {})) {
      const key = String(uid || "");
      if (!key) continue;
      out[key] = Number(out[key] || 0) + Number(pts || 0);
    }
  }

  return out;
}

function sortCupHistoryRows(rows = []) {
  return [...rows]
    .sort((a, b) => {
      const aTotal = Number(a?.totalAfter || 0);
      const bTotal = Number(b?.totalAfter || 0);
      if (bTotal !== aTotal) return bTotal - aTotal;

      const aRound = Number(a?.roundPoints || 0);
      const bRound = Number(b?.roundPoints || 0);
      if (bRound !== aRound) return bRound - aRound;

      return String(a?.name || "").localeCompare(String(b?.name || ""));
    })
    .map((row, idx) => ({ ...row, rank: idx + 1 }));
}

function normalizeCupHistoryRounds(rounds = [], userById = {}) {
  const asc = [...(rounds || [])].sort(
    (a, b) =>
      Number(a?.closedAtMs || a?.endAtMs || a?.startAtMs || 0) -
      Number(b?.closedAtMs || b?.endAtMs || b?.startAtMs || 0)
  );

  const cumulativeByUid = {};
  const normalizedAsc = asc.map((round) => {
    const rowMap = new Map();
    for (const row of Array.isArray(round?.rows) ? round.rows : []) {
      const uid = String(row?.userId || row?.uid || "");
      if (!uid) continue;
      rowMap.set(uid, row);
    }

    const uids = new Set([
      ...Array.from(rowMap.keys()),
      ...Object.keys(round?.windowPointsByUid || {}).map(String),
      ...Object.keys(round?.cupTotalsAfterByUid || {}).map(String),
    ]);

    const rowsForRound = Array.from(uids).map((uid) => {
      const rawRow = rowMap.get(uid) || {};
      const roundPoints = Number(
        rawRow?.roundPoints ?? round?.windowPointsByUid?.[uid] ?? 0
      );

      cumulativeByUid[uid] = Number(cumulativeByUid[uid] || 0) + roundPoints;

      return {
        ...rawRow,
        userId: uid,
        uid,
        name:
          rawRow?.name ||
          userById?.[uid]?.name ||
          userById?.[uid]?.displayName ||
          "Unknown",
        roundPoints,
        totalAfter: cumulativeByUid[uid],
      };
    });

    return {
      ...round,
      cupTotalsAfterByUid: { ...cumulativeByUid },
      rows: sortCupHistoryRows(rowsForRound),
    };
  });

  return normalizedAsc.sort(
    (a, b) =>
      Number(b?.closedAtMs || b?.endAtMs || b?.startAtMs || 0) -
      Number(a?.closedAtMs || a?.endAtMs || a?.startAtMs || 0)
  );
}

function firstText(...values) {
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function getPlayerCountry(player = {}, entry = null) {
  return firstText(
    player?.country,
    player?.nationality,
    player?.playerCountry,
    player?.birthCountry,
    entry?.country,
    entry?.nationality,
    entry?.playerCountry
  );
}

function getPlayerClub(player = {}, entry = null) {
  return firstText(
    player?.clubName,
    player?.club,
    player?.teamName,
    player?.team?.name,
    entry?.clubName,
    entry?.club,
    entry?.realTeamName,
    entry?.teamName
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
          • {club ? (
            <span className="tpPlayerSubItem tpPlayerClub">{club}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function extractIds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => (typeof x === 'string' ? x : (x.id || x.playerId || x.pid))).filter(Boolean);
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

function PlayerStatsCard({ stats, breakdown, teamName, opponentName }) {
  const hasStats = stats && Object.keys(stats).length > 0;
  const hasBD = breakdown && Object.keys(breakdown).length > 0;
  
  // ✅ 1. Remove stats?.isLive so it shows permanently!
  const showMatchHeader = Boolean(teamName || opponentName);

  // ✅ 2. Look for the game score in the raw stats
  // (Adjust these names if your API uses 'homeScore' or 'goalsFor' instead)
  const tScore = stats?.teamScore ?? stats?.teamGoals ?? null;
  const oScore = stats?.opponentScore ?? stats?.opponentGoals ?? null;
  const hasScore = tScore !== null && oScore !== null;

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

  return (
    <div className="tpStatsCard">
      {showMatchHeader && (
        <div className="tpCardHeader">
          <div className="tpMatchHeaderTeam tpMatchHeaderTeamTop">
            <span className="tpMatchHeaderName">{teamName || "Unknown Team"}</span>
            {hasScore && <span className="tpMatchHeaderScore">{tScore}</span>}
          </div>

          {opponentName && (
            <>
              <div className="tpMatchHeaderDivider">
                {hasScore ? "FINAL SCORE" : "VS"}
              </div>

              <div className="tpMatchHeaderTeam">
                <span className="tpMatchHeaderName">{opponentName}</span>
                {hasScore && <span className="tpMatchHeaderScore">{oScore}</span>}
              </div>
            </>
          )}
        </div>
      )}

      <div className="tpStatsGrid">
        <div className="tpStatsCol">
          <span className="tpStatsHead">Raw Stats</span>
          {sortedRawKeys.map((k) => {
            const v = stats[k];
            if (v == null || v === false || v === 0 || v === "0") return null;
            
            // ✅ 4. Hide the score keys from the list below so they don't randomly show up twice!
            if (k === "isLive" || k === "teamId" || k === "fixtureId" || k === "teamScore" || k === "opponentScore" || k === "teamGoals" || k === "opponentGoals") return null;

            return (
              <div key={k} className="tpStatRow">
                <span>{prettyStatLabel(k)}</span>
                <span>{String(v)}</span>
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
                <span>{prettyStatLabel(k)}</span>
                <span className={v > 0 ? "tpPos" : "tpNeg"}>
                  {v > 0 ? "+" : ""}{v}
                </span>
              </div>
            );
          })}
          {validBreakdownKeys.length === 0 && (
            <div className="tpStatRow"><span>Base</span><span>0</span></div>
          )}
        </div>
      </div>
    </div>
  );
}

function parseCupWindowId(windowId) {
  const s = String(windowId || "");
  const colon = s.lastIndexOf(":");
  if (colon < 0) return null;

  const range = s.slice(colon + 1); // "min-max"
  const dash = range.indexOf("-");
  if (dash < 0) return null;

  const startAtMs = Number(range.slice(0, dash));
  const endAtMs = Number(range.slice(dash + 1));

  if (!Number.isFinite(startAtMs) || !Number.isFinite(endAtMs)) return null;
  return { startAtMs, endAtMs };
}

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

export default function CupTournamentPage() {
  const { roomId } = useParams();
  const { loading, error, data } = useTournament(roomId);
  const [myUid, setMyUid] = useState(auth.currentUser?.uid || null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  

  // Cup-specific State
  const [cupDoc, setCupDoc] = useState(null);
  const [cupFixtureDocs, setCupFixtureDocs] = useState([]);
  const [standingsDoc, setStandingsDoc] = useState(null);
  const [lineups, setLineups] = useState({});
  const [picksMap, setPicksMap] = useState({});
  const [finalResultsDoc, setFinalResultsDoc] = useState(null);
  //History 
  const [historyRounds, setHistoryRounds] = useState([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [devPreviewComplete, setDevPreviewComplete] = useState(false);
  
  // Accordion State
  const [expandedPlayerId, setExpandedPlayerId] = useState(null);
  const [expandedOtherUser, setExpandedOtherUser] = useState(null);
  const [showScoring, setShowScoring] = useState(false);
  const scoringRef = useRef(null);

  const [devBusy, setDevBusy] = useState(false);
  const [rosterByUid, setRosterByUid] = useState({});
  

  useEffect(() => {
    if (!roomId) return;

    return onSnapshot(
      doc(db, "rooms", roomId, "finalResults", "current"),
      (snap) => setFinalResultsDoc(snap.exists() ? snap.data() : null),
      () => setFinalResultsDoc(null)
    );
  }, [roomId]);

  useEffect(() => {
    if (!showScoring) return;

    const onDown = (e) => {
        if (!scoringRef.current) return;
        if (!scoringRef.current.contains(e.target)) setShowScoring(false);
    };

    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    }, [showScoring]);

  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => setMyUid(u?.uid || null));
    return unsub;
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Listen to Cup, Lineups, and Picks
  useEffect(() => {
    if (!roomId) return;

    const unsubCup = onSnapshot(
      doc(db, "rooms", roomId, "cup", "current"),
      (snap) => setCupDoc(snap.exists() ? snap.data() : null)
    );

    const unsubCupFixtures = onSnapshot(
      collection(db, "rooms", roomId, "cup", "current", "fixtures"),
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
        setCupFixtureDocs(rows);
      },
      () => setCupFixtureDocs([])
    );

    const unsubStandings = onSnapshot(
      doc(db, "rooms", roomId, "standings", "current"),
      (snap) => setStandingsDoc(snap.exists() ? snap.data() : null),
      () => setStandingsDoc(null)
    );

    const unsubLineups = onSnapshot(
      collection(db, "rooms", roomId, "lineups"),
      (snap) => {
        const m = {};
        snap.forEach((d) => (m[d.id] = d.data()));
        setLineups(m);
      }
    );

    const unsubPicks = onSnapshot(
      collection(db, "rooms", roomId, "picks"),
      (snap) => {
        const byPid = {};
        const byUid = {};

        snap.forEach((d) => {
          const val = d.data() || {};
          const pid = String(val.playerId || val.pid || val.apiPlayerId || "");
          if (!pid) return;

          // allow lookup by BOTH real player id and pick doc id
          byPid[pid] = {
            ...val,
            _resolvedPlayerId: pid,
            _pickDocId: d.id,
          };

          byPid[d.id] = {
            ...val,
            _resolvedPlayerId: pid,
            _pickDocId: d.id,
          };

          const ownerUid = inferOwnerUidFromPick(val);
          if (!ownerUid) return;

          if (!byUid[ownerUid]) byUid[ownerUid] = [];

          byUid[ownerUid].push({
            id: pid,
            name: val.playerName || val.name || "Unknown",
            position: val.position || val.pos || "MID",
            country:
              val.country ||
              val.nationality ||
              val.playerCountry ||
              "",
            clubName:
              val.clubName ||
              val.club ||
              val.teamName ||
              val.team?.name ||
              "",
            teamName:
              val.teamName ||
              val.clubName ||
              val.club ||
              val.team?.name ||
              "",
          });
        });

        setPicksMap(byPid);
        setRosterByUid(byUid);
      }
    );

    const historyQ = query(
      collection(db, "rooms", roomId, "cupHistory"),
      orderBy("closedAtMs", "desc")
    );

    const unsubHistory = onSnapshot(historyQ, (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setHistoryRounds(rows);

      setSelectedHistoryId((prev) => {
        if (prev && rows.some((r) => r.id === prev)) return prev;
        return "";
      });
    });

    return () => {
      unsubCup();
      unsubCupFixtures();
      unsubStandings();
      unsubLineups();
      unsubPicks();
      unsubHistory();
    };
  }, [roomId]);

  if (!roomId) return null;
  if (loading) {
    return (
      <div className="tpPage">
        <div className="tpCenter"><div className="loader"><div className="loader_cube loader_cube--color" /><div className="loader_cube loader_cube--glowing" /></div></div>
      </div>
    );
  }
  if (error) {
    return <div className="tpPage"><div className="tpWrap"><p className="tpText">Error: {String(error.message || error)}</p></div></div>;
  }

  const isHost = data?.room?.hostUid === myUid;
  const users = data?.users || [];
  const userById = Object.fromEntries(users.map((u) => [u.userId, u]));
  const displayHistoryRounds = normalizeCupHistoryRounds(historyRounds, userById);
  const latestCompletedHistoryTotalsByUid =
    displayHistoryRounds[0]?.cupTotalsAfterByUid || {};

  const competitionName = data?.room?.competitionMeta?.name || data?.room?.competition?.name || "";
  const competitionSeason = data?.room?.competition?.season || data?.room?.competitionMeta?.season || "";
  const competitionLabel = [competitionSeason, competitionName].filter(Boolean).join(" ");
  
    // Cup Data
    
    

    

    //Status 
    const statusRaw =
      cupDoc?.status ||
      data?.room?.competitionState?.weekStatus ||
      data?.room?.["competitionState.weekStatus"] ||
      "scheduled";

    const statusLower = String(statusRaw).toLowerCase();

    const isLive = statusLower === "live";
    const isResolving = statusLower === "resolving";
    const isScheduled = statusLower === "scheduled";
    const isError = statusLower === "error";

    const statusClass = isLive
      ? "live"
      : isResolving
      ? "resolving"
      : isScheduled
      ? "scheduled"
      : isError
      ? "error"
      : "idle";

    const statusLabel = isLive
      ? "LIVE"
      : isResolving
      ? "RESOLVING"
      : isScheduled
      ? "SCHEDULED"
      : isError
      ? "ERROR"
      : "IDLE";

    // --- Live-style header timing (match TournamentPage feel) ---
    const lastUpdateMs = Number(cupDoc?.updatedAtMs || 0) || null;
    const ageSec = lastUpdateMs ? Math.max(0, Math.floor((nowMs - lastUpdateMs) / 1000)) : null;
    const nextUpdateInSec = lastUpdateMs ? Math.max(0, 60 - (ageSec % 60)) : null;
    const lastUpdateLabel = lastUpdateMs ? fmtDT(lastUpdateMs) : "—";
    const status = String(statusRaw).toUpperCase();
    const currentWindowLabel = cupDoc?.currentWindowLabel || "Waiting for next round";
    const isFinal = status === "FINAL" || cupDoc?.completed;
    
    const livePoints = cupDoc?.livePointsByUid || {};
    const fixtureLedgerTotalsByUid = buildFixtureTotalsByUid(cupFixtureDocs);
    const creditedTotalsByUid =
      Object.keys(fixtureLedgerTotalsByUid).length > 0
        ? fixtureLedgerTotalsByUid
        : Object.keys(latestCompletedHistoryTotalsByUid).length > 0
        ? latestCompletedHistoryTotalsByUid
        : (cupDoc?.creditedTotalsByUid || cupDoc?.cupTotalsByUid || {});
    const projectedTotalsByUid = sumNumberMaps(creditedTotalsByUid, livePoints);
    const standingsIncludeLive =
      Boolean(standingsDoc?.includesLivePoints) ||
      Boolean(cupDoc?.projectedIncludesLivePoints);
    const standingsSourceIsCup =
      String(standingsDoc?.source || "").toLowerCase() === "cup";
    const shouldProjectLive =
      !isFinal &&
      !standingsIncludeLive &&
      Object.values(livePoints).some((v) => Number(v || 0) !== 0);
    const leaderboardByUid = {};
    const standingsRows = Array.isArray(standingsDoc?.standings) ? standingsDoc.standings : [];
    const standingsByUid = Object.fromEntries(
      standingsRows
        .map((row) => {
          const uid = String(row?.userId || row?.uid || "");
          return uid ? [uid, row] : null;
        })
        .filter(Boolean)
    );
    const leaderboardIds = new Set([
      ...users.map((u) => String(u.userId || "")).filter(Boolean),
      ...Object.keys(standingsByUid),
      ...Object.keys(creditedTotalsByUid || {}).map(String),
      ...Object.keys(projectedTotalsByUid || {}).map(String),
    ]);

    leaderboardIds.forEach((uid) => {
      const standingRow = standingsByUid[uid] || null;
      const hasCreditedTotal = Object.prototype.hasOwnProperty.call(
        creditedTotalsByUid || {},
        uid
      );
      const hasProjectedTotal = Object.prototype.hasOwnProperty.call(
        projectedTotalsByUid || {},
        uid
      );

      const fallbackCredited = standingsSourceIsCup
        ? Number(
            standingRow?.creditedFantasyPoints ??
              standingRow?.totalFantasyPoints ??
              0
          )
        : 0;
      const fallbackProjected = standingsSourceIsCup
        ? Number(
            standingRow?.projectedFantasyPoints ??
              standingRow?.totalFantasyPoints ??
              fallbackCredited
          )
        : fallbackCredited;

      const creditedTotal = hasCreditedTotal
        ? Number(creditedTotalsByUid?.[uid] || 0)
        : fallbackCredited;
      const projectedTotal = hasProjectedTotal
        ? Number(projectedTotalsByUid?.[uid] || 0)
        : fallbackProjected;
      const baseTotal = standingsIncludeLive ? projectedTotal : creditedTotal;

      leaderboardByUid[uid] = {
        userId: uid,
        uid,
        name:
          standingRow?.name ||
          userById?.[uid]?.name ||
          userById?.[uid]?.displayName ||
          "Unknown",
        tablePoints: baseTotal,
        totalFantasyPoints: baseTotal,
      };
    });

    const leaderboard = sortCupLeaderboardRows(
      Object.values(leaderboardByUid).map((row) => {
        const live = shouldProjectLive ? Number(livePoints[row.userId] || 0) : 0;
        const totalPoints = Number(row.totalFantasyPoints || 0) + live;
        return {
          ...row,
          tablePoints: totalPoints,
          totalFantasyPoints: totalPoints,
          totalPoints,
        };
      })
    );

  const fakePodiumData = {
    computedAtMs: Date.now(),
    top3: leaderboard.slice(0, 3).map((u, i) => ({
      userId: u.userId,
      uid: u.userId,
      name: u.name,
      rank: i + 1,
      wins: 0,
      draws: 0,
      losses: 0,
      tablePoints: u.totalPoints,
      totalFantasyPoints: u.totalPoints,
    })),
  };
  const showFinalPodium = devPreviewComplete || Boolean(finalResultsDoc) || isFinal;

  // Resolve Rosters Helper
  function firstNonEmptyArray(...candidates) {
    for (const arr of candidates) {
      if (Array.isArray(arr) && arr.length) return arr;
    }
    return [];
  }

  function getLineupIds(lineup, type) {
    if (!lineup) return [];

    const source =
      type === "starters"
        ? firstNonEmptyArray(
            lineup.starters,
            lineup.startingXI,
            lineup.starting11,
            lineup.starterIds,
            lineup.startingIds,
            lineup.lineup?.startingXI,
            lineup.lineup?.starting11,
            lineup.lineup?.starters
          )
        : firstNonEmptyArray(
            lineup.bench,
            lineup.subs,
            lineup.substitutes,
            lineup.benchIds,
            lineup.subIds,
            lineup.benchPlayers,
            lineup.benchPlayerIds,
            lineup.lineup?.bench,
            lineup.lineup?.subs,
            lineup.currentLineup?.bench,
            lineup.currentLineup?.subs
          );

    return extractIds(source);
  }

  const selectedHistory =
    selectedHistoryId
      ? displayHistoryRounds.find((r) => r.id === selectedHistoryId) || null
      : null;

  const selectedHistoryRows = Array.isArray(selectedHistory?.rows)
    ? selectedHistory.rows
    : [];

  const selectedHistoryLabel = selectedHistory?.label || "—";
  const selectedHistoryRange =
    selectedHistory?.startAtMs && selectedHistory?.endAtMs
      ? `${fmtDT(selectedHistory.startAtMs)} → ${fmtDT(selectedHistory.endAtMs)}`
      : "—";

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

  function mergeNumberMaps(a = {}, b = {}) {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[k] = Number(out[k] || 0) + n;
    }
    return out;
  }

  function mergePerPlayerEntry(prev = {}, next = {}) {
    return {
      id: next.id || prev.id || "",
      name: next.name || prev.name || "Unknown",
      position: next.position || prev.position || "MID",
      points: Number(prev.points || 0) + Number(next.points || 0),
      counted: next.counted ?? prev.counted ?? true,
      stats: mergeStatObjects(prev.stats || {}, next.stats || {}),
      breakdown: mergeNumberMaps(prev.breakdown || {}, next.breakdown || {}),
      teamName: next.teamName || prev.teamName || "",
      opponentName: next.opponentName || prev.opponentName || "",
      country: next.country || prev.country || "",
      clubName: next.clubName || prev.clubName || "",
    };
  }

  function mergeBreakdownMaps(base = {}, live = {}) {
    const out = { ...(base || {}) };

    for (const [uid, incoming] of Object.entries(live || {})) {
      const prev = out[uid] || { total: 0, benchTotal: 0, perPlayer: {} };

      const mergedPerPlayer = { ...(prev.perPlayer || {}) };
      for (const [pid, entry] of Object.entries(incoming?.perPlayer || {})) {
        mergedPerPlayer[pid] = mergePerPlayerEntry(mergedPerPlayer[pid], entry);
      }

      out[uid] = {
        total: Number(prev.total || 0) + Number(incoming?.total || 0),
        benchTotal: Number(prev.benchTotal || 0) + Number(incoming?.benchTotal || 0),
        perPlayer: mergedPerPlayer,
      };
    }

    return out;
  }

  function aggregateFixtureBreakdowns(fixtures = []) {
    let agg = {};
    for (const fx of fixtures || []) {
      agg = mergeBreakdownMaps(agg, fx?.breakdownByUserId || {});
    }
    return agg;
  }

  const parsedWindow = parseCupWindowId(cupDoc?.currentWindowId);

  const winStartMs =
    cupDoc?.currentWindowStartAtMs ??
    cupDoc?.startAtMs ??
    parsedWindow?.startAtMs ??
    null;

  const winEndMs =
    cupDoc?.currentWindowEndAtMs ??
    cupDoc?.endAtMs ??
    parsedWindow?.endAtMs ??
    null;

  const currentBreakdownByUserId = mergeBreakdownMaps(
    cupDoc?.breakdownByUserId || {},
    cupDoc?.liveBreakdownByUserId || {}
  );

  const latestHistory = displayHistoryRounds[0] || null;
  const autoHidePreviousRoundAtMs = Number(winStartMs || 0) ? Number(winStartMs) - (60 * 60 * 1000) : null;
  const shouldAutoShowLatestHistory =
    !selectedHistory &&
    !isFinal &&
    !isLive &&
    !isResolving &&
    !!latestHistory &&
    (autoHidePreviousRoundAtMs == null || nowMs < autoHidePreviousRoundAtMs);

  const activeHistory = selectedHistory || (shouldAutoShowLatestHistory ? latestHistory : null);
  const activeHistoryFixtureIds = new Set(
    Array.isArray(activeHistory?.fixtureIds)
      ? activeHistory.fixtureIds.map((id) => String(id)).filter(Boolean)
      : []
  );
  const activeFixtureDocs = activeHistory
    ? cupFixtureDocs.filter((fx) => {
        const fixtureId = String(fx?.fixtureId || fx?.id || "");
        if (activeHistoryFixtureIds.size > 0) return activeHistoryFixtureIds.has(fixtureId);
        if (activeHistory?.windowId && fx?.windowId) return String(fx.windowId) === String(activeHistory.windowId);
        return false;
      })
    : [];
  const currentWindowFixtureIds = new Set(
    Array.isArray(cupDoc?.currentWindowFixtureIds)
      ? cupDoc.currentWindowFixtureIds.map((id) => String(id)).filter(Boolean)
      : []
  );
  const currentWindowFixtureDocs = cupFixtureDocs.filter((fx) => {
    const fixtureId = String(fx?.fixtureId || fx?.id || "");
    return currentWindowFixtureIds.has(fixtureId);
  });
  const activeHistoryBreakdownByUserId =
    activeFixtureDocs.length > 0
      ? aggregateFixtureBreakdowns(activeFixtureDocs)
      : (activeHistory?.breakdownByUserId || {});
  const activeBreakdownByUserId = activeHistory ? activeHistoryBreakdownByUserId : currentBreakdownByUserId;
  const isAutoShowingLatestHistory = !selectedHistory && activeHistory === latestHistory && shouldAutoShowLatestHistory;
  const latestFixtureEntryByPlayerId = (() => {
    const out = {};
    const sourceFixtureDocs = activeHistory ? activeFixtureDocs : currentWindowFixtureDocs;
    const sorted = [...sourceFixtureDocs].sort(
      (a, b) => Number(b?.creditedAtMs || 0) - Number(a?.creditedAtMs || 0)
    );

    for (const fx of sorted) {
      for (const userBreakdown of Object.values(fx?.breakdownByUserId || {})) {
        for (const [pid, entry] of Object.entries(userBreakdown?.perPlayer || {})) {
          const key = String(pid || entry?.id || "");
          if (!key || out[key]) continue;
          out[key] = entry;
        }
      }
    }

    return out;
  })();

  function withDerivedScoring(player) {
    const stats = player?.stats && typeof player.stats === "object" ? player.stats : null;
    const breakdown = hasBreakdownMap(player?.breakdown) ? player.breakdown : null;
    const existingPoints = Number(player?.points ?? NaN);

    if (!stats) {
      return {
        ...player,
        points: Number.isFinite(existingPoints) ? existingPoints : 0,
        breakdown,
      };
    }

    const scored = scorePlayerFromCore(
      stats,
      toCorePos(player?.position || stats?.position || stats?.pos || stats?.role)
    );
    const derivedPoints = Number(scored?.points || 0);
    const derivedBreakdown = hasBreakdownMap(scored?.breakdown) ? scored.breakdown : null;
    const shouldKeepExistingPoints =
      breakdown &&
      Number.isFinite(existingPoints) &&
      (existingPoints !== 0 || derivedPoints === 0);

    return {
      ...player,
      position: player?.position || stats?.position || stats?.pos || stats?.role || "MID",
      points: shouldKeepExistingPoints ? existingPoints : derivedPoints,
      breakdown: breakdown || derivedBreakdown,
    };
  }

  function withDerivedLiveState(player, uid, pid) {
    const liveEntry = !activeHistory
      ? cupDoc?.liveBreakdownByUserId?.[uid]?.perPlayer?.[String(pid)]
      : null;
    const isPlayerLive = Boolean(player?.stats?.isLive) || Boolean(liveEntry);
    const nextStats = player?.stats
      ? { ...player.stats, isLive: isPlayerLive }
      : (isPlayerLive ? { isLive: true } : null);

    return {
      ...player,
      stats: nextStats,
    };
  }

  function buildHistoryRoster(uid, type) {
    if (!activeHistory) return null;

    const perPlayer = activeBreakdownByUserId?.[uid]?.perPlayer || {};

    const explicit =
      type === "starters"
        ? activeHistory?.startersByUserId?.[uid]
        : activeHistory?.benchByUserId?.[uid];

    if (Array.isArray(explicit) && explicit.length) {
      const normalized = explicit
        .map((p) => {
          const pid = String(p?.id || p?.playerId || p?.pid || "");
          const entry = perPlayer[pid] || null;
          return {
            id: pid,
            name: entry?.name || p?.name || p?.playerName || "Unknown",
            position: entry?.position || p?.position || p?.pos || "MID",
            points: Number(entry?.points || 0),
            counted: entry?.counted ?? (type === "starters"),
            stats: entry?.stats || null,
            breakdown: entry?.breakdown || null,
            teamName: entry?.teamName || p?.teamName || "",
            opponentName: entry?.opponentName || p?.opponentName || "",
            country: entry?.country || p?.country || p?.nationality || p?.playerCountry || "",
            clubName: entry?.clubName || p?.clubName || p?.club || p?.teamName || entry?.teamName || "",
          };
        })
        .filter((p) => p.id);

      if (normalized.length) {
        return normalized.map((player) =>
          withDerivedLiveState(withDerivedScoring(player), uid, player.id)
        );
      }
    }

    const derived = Object.values(perPlayer)
      .filter((entry) => Boolean(entry) && Boolean(entry.id))
      .filter((entry) => (type === "starters" ? entry.counted !== false : entry.counted === false))
      .map((entry) => ({
        id: String(entry.id),
        name: entry.name || "Unknown",
        position: entry.position || "MID",
        points: Number(entry.points || 0),
        counted: entry.counted !== false,
        stats: entry.stats || null,
        breakdown: entry.breakdown || null,
        teamName: entry.teamName || "",
        opponentName: entry.opponentName || "",
        country: entry.country || "",
        clubName: entry.clubName || entry.teamName || "",
      }));

    return derived.length
      ? derived.map((player) =>
          withDerivedLiveState(withDerivedScoring(player), uid, player.id)
        )
      : null;
  }


  function getResolvedRoster(uid, type) {
    const historyRoster = buildHistoryRoster(uid, type);
    if (historyRoster) return historyRoster;

    const lineup = lineups[uid] || {};
    let ids = getLineupIds(lineup, type);
      ids = ids
    .map((rawId) => {
      const row = picksMap[String(rawId)] || null;
      return String(row?._resolvedPlayerId || rawId);
    })
    .filter(Boolean);

    // prevent duplicates after remapping
    ids = Array.from(new Set(ids));

    const cupUserBreakdown = activeBreakdownByUserId?.[uid] || {};
    const perPlayer = cupUserBreakdown?.perPlayer || {};

    // Fallback: derive bench from roster picks if lineup doc doesn't store bench
    if (type === "bench" && (!ids || ids.length === 0)) {
      const starterIds = new Set(getLineupIds(lineup, "starters").map(String));
      const roster = rosterByUid[uid] || [];
      ids = roster
        .map((p) => String(p?.id || ""))
        .filter((pid) => pid && !starterIds.has(pid));
    }

    return ids.map((pid) => {
      const pick = picksMap[pid] || {};
      const rosterMeta =
        (rosterByUid[uid] || []).find((p) => String(p.id) === String(pid)) || {};

      const entry = perPlayer[pid] || null;
      const fixtureFallback = latestFixtureEntryByPlayerId[String(pid)] || null;

      const entryPoints = Number(entry?.points ?? NaN);
      const entryHasStats = !!(entry?.stats && Object.keys(entry.stats).length > 0);
      const entryHasBreakdown = !!(entry?.breakdown && Object.keys(entry.breakdown).length > 0);
      const entryHasContent =
        entryHasStats ||
        entryHasBreakdown ||
        (Number.isFinite(entryPoints) && entryPoints !== 0);

      return withDerivedLiveState(withDerivedScoring({
        id: pid,
        name:
          entry?.name ||
          fixtureFallback?.name ||
          pick.playerName ||
          pick.name ||
          rosterMeta.name ||
          "Unknown",
        position:
          entry?.position ||
          fixtureFallback?.position ||
          pick.position ||
          pick.pos ||
          rosterMeta.position ||
          "MID",
        points:
          entryHasContent
            ? entryPoints
            : Number(fixtureFallback?.points ?? pick.lastDelta ?? 0),
        counted: entry?.counted ?? fixtureFallback?.counted ?? (pick.lastCounted !== false),
        stats:
          entryHasStats
            ? entry.stats
            : (fixtureFallback?.stats || pick.lastStats || pick.stats || null),
        breakdown:
          entryHasBreakdown
            ? entry.breakdown
            : (fixtureFallback?.breakdown || pick.lastBreakdown || pick.breakdown || null),
        teamName:
          entry?.teamName ||
          fixtureFallback?.teamName ||
          pick.lastRealTeamName ||
          pick.teamName ||
          rosterMeta.teamName ||
          "",
        opponentName:
          entry?.opponentName ||
          fixtureFallback?.opponentName ||
          pick.lastOpponentName ||
          pick.opponentName ||
          "",
        country:
          fixtureFallback?.country ||
          pick.country ||
          pick.nationality ||
          pick.playerCountry ||
          rosterMeta.country ||
          "",
        clubName:
          fixtureFallback?.clubName ||
          pick.clubName ||
          pick.club ||
          pick.teamName ||
          pick.team?.name ||
          rosterMeta.clubName ||
          entry?.teamName ||
          "",
      }), uid, pid);
    });
  }

  const myStarters = sortPlayersForDisplay(getResolvedRoster(myUid, 'starters'));
  const myBench = sortPlayersForDisplay(getResolvedRoster(myUid, 'bench'));
  const myRoundTotal = sumDisplayedPoints(myStarters);
  const myBenchTotal = sumDisplayedPoints(myBench);
  const otherUsers = users.filter(u => u.userId !== myUid);

  async function copyRoomCode() {
    try {
      await navigator.clipboard.writeText(String(roomId));
      alert("Room code copied!");
    } catch (e) {
      alert("Could not copy.");
    }
  }

  async function forceRunCup() {
    try {
      setDevBusy(true);

      const functions = getFunctions(getApp(), "us-west2");
      const callForceRunCup = httpsCallable(functions, "debugForceRunCup");
      const res = await callForceRunCup({ roomId });

      console.log("debugForceRunCup:", res.data);
      alert(res.data?.message || "Cup sync complete.");
    } catch (e) {
      console.error("debugForceRunCup failed", e);
      alert(e?.message || "Cup sync failed.");
    } finally {
      setDevBusy(false);
    }
  }

    const roomNextLabel =
        data?.room?.competitionState?.currentLabel ||
        data?.room?.["competitionState.currentLabel"] ||
        null;

    const nextGameLabel = roomNextLabel || currentWindowLabel || "—";

  const nextLabel =
    cupDoc?.currentWindowLabel ||
    data?.room?.competitionState?.currentLabel ||
    data?.room?.["competitionState.currentLabel"] ||
    "—";

  const winText =
    winStartMs && winEndMs ? `${fmtDT(winStartMs)} → ${fmtDT(winEndMs)}` : "—";

  


  return (
    <div className="tpPage">
      <div className="tpWrap">
        {/* --- HEADER --- */}
        <div className="tpHeaderRow">
          <div className="tpHeaderLeft">
            <h2 className="tpTitle">Cup Tournament</h2>
            <div className="tpHeaderMetaBlock">
              {competitionLabel && (
                <div className="tpRoomMeta">
                  Competition: <b className="tpCompetitionLabel"><FlagIcon country={data?.room?.competitionMeta?.country} size={16} /> {competitionLabel}</b>
                </div>
              )}
                <div className="tpRoomMeta">
                    Next Games: <b>{winText}</b> • Round: <b style={{ color: "var(--color-primary)" }}>{nextLabel}</b>
                </div>
              <div className="tpRoomMeta">Room: <b>{data?.room?.name} - {roomId}</b></div>
              <div className="tpLiveHeaderLine">
                {isLive ? (
                    <span>
                    <b>Live Updating</b>
                    {nextUpdateInSec != null ? <> • Next update in: <b>{nextUpdateInSec}s</b></> : null}
                    <> • Last update at: <b>{lastUpdateLabel}</b></>
                    </span>
                ) : (
                    <span>
                    Status: <b className={`tpLivePill ${statusClass}`}>{statusLabel}</b>
                    <> • Last update at: <b>{lastUpdateLabel}</b></>
                    </span>
                )}
                </div>
            </div>
          </div>

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
                    <summary className="tpPointsBtn tpToolsBtn">
                    Tools <span className="tpCaret">▾</span>
                    </summary>
                    <div className="tpToolsMenu">
                    <button className="tpToolsItem" onClick={() => setDevPreviewComplete(!devPreviewComplete)}>
                        {devPreviewComplete ? "Hide Podium" : "DEV: Preview Final Podium"}
                    </button>

                    <button
                      type="button"
                      className="tpToolsItem"
                      onClick={forceRunCup}
                      disabled={devBusy}
                    >
                      {devBusy ? "Running Cup Sync..." : "DEV: Fix Cup Fixtures / Points"}
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

        {/* --- BODY --- */}
        <div className="tpGrid">
          {showFinalPodium && (
            <div className="tpCard tpFull">
              <FinalResultsCard
                finalResults={devPreviewComplete ? fakePodiumData : finalResultsDoc}
                title="Cup Complete"
                subtitle="Final Podium"
                badge="🏆"
                showWdl={false}
                matchLabel="Competition"
                fantasyLabel="Fantasy"
                renderUser={(uid, fallbackName) => (
                  <UserChip user={userById?.[uid] || { userId: uid, name: fallbackName }} />
                )}
              />
            </div>
          )}

          {/* LEADERBOARD */}
          <div className="tpCard tpFull">
            <h3 className="tpCardTitle">Global Leaderboard</h3>
            <div className="tpBoard">
              <div className="tpBoardHead">
                <span>#</span>
                <span>Manager</span>
                <span>Total Fantasy Pts</span>
              </div>
              {leaderboard.map((row, idx) => (
                <div key={row.userId} className="tpBoardRow" style={row.userId === myUid ? { backgroundColor: "rgba(255,255,255,0.05)" } : {}}>
                  <span style={{ fontWeight: "bold", color: idx === 0 ? "gold" : idx === 1 ? "silver" : idx === 2 ? "#cd7f32" : "inherit" }}>{idx + 1}</span>
                  <span><UserChip user={userById[row.userId] || { userId: row.userId, name: row.name }} /></span>
                  <span style={{ fontWeight: "bold" }}>{row.totalPoints}</span>
                </div>
              ))}
            </div>
          </div>

          {/* YOUR ROSTER */}
          {!showFinalPodium && (
            <div className="tpCard tpFull">
              <h3 className="tpCardTitle">Your Roster</h3>
              {isAutoShowingLatestHistory && (
                <p className="tpText" style={{ marginTop: -4, marginBottom: 14, opacity: 0.8 }}>
                  Showing the last completed Cup round until one hour before the next kickoff. The leaderboard above remains your cumulative Cup total.
                </p>
              )}
              <div className="tpLineups tpLineupsSingle">
                <div className="tpSide tpSideMe tpSideSolo">
                  <div className="tpLineupHead">
                    <span className="tpLineupName"><UserChip user={userById[myUid] || { userId: myUid, name: "You" }} /></span>
                    <span className="tpLineupTotal">{myRoundTotal} pts</span>
                  </div>
                  
                  <div className="tpSectionLabel">Starters</div>
                  <ul className="tpList">
                    {myStarters.map((p) => {
                      const isOpen = expandedPlayerId === p.id;
                      const isLiveNow = Boolean(p.stats?.isLive);
                      return (
                        <li key={p.id} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                          <div className="tpRow" onClick={() => setExpandedPlayerId(isOpen ? null : p.id)}>
                            <PlayerIdentity
                              name={p.name}
                              country={p.country}
                              club={p.clubName || p.teamName}
                            />

                            <div className="tpMeta">
                              {normalizeDisplayPos(p.position)}
                              <span className={`tpLivePill ${isLiveNow ? "live" : "idle"}`}>
                                {isLiveNow ? "LIVE" : "IDLE"}
                              </span>
                            </div>
                            <div className="tpPts">{p.points} pts</div>
                          </div>
                          {isOpen && (
                            <PlayerStatsCard
                                stats={p.stats}
                                breakdown={p.breakdown}
                                teamName={p.teamName}
                                opponentName={p.opponentName}
                            />
                            )}
                        </li>
                      );
                    })}
                  </ul>

                    <details className="tpBenchDetails">
                      <summary className="tpBenchSummary">
                        <div className="tpBenchLeft">
                          <span className="tpBenchTitle">Bench</span>
                          <span className="tpBenchNote">Not counted</span>
                        </div>
                        <div className="tpBenchRight">
                          <span className="tpLineupTotal">{myBenchTotal} pts</span>
                          <span className="tpBenchCaret">▾</span>
                        </div>
                      </summary>
                      <ul className="tpList tpBenchList">
                        {myBench.map((p) => {
                          const isOpen = expandedPlayerId === p.id;
                          const isLiveNow = Boolean(p.stats?.isLive);
                          return (
                            <li key={p.id} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                              <div className="tpRow" onClick={() => setExpandedPlayerId(isOpen ? null : p.id)}>
                                <PlayerIdentity
                                  name={p.name}
                                  country={p.country}
                                  club={p.clubName || p.teamName}
                                />

                                <div className="tpMeta">
                                  {normalizeDisplayPos(p.position)}
                                  <span className={`tpLivePill ${isLiveNow ? "live" : "idle"}`}>
                                    {isLiveNow ? "LIVE" : "IDLE"}
                                  </span>
                                </div>
                                <div className="tpPts">{p.points} pts</div>
                              </div>
                                {isOpen && (
                                    <PlayerStatsCard
                                        stats={p.stats}
                                        breakdown={p.breakdown}
                                        teamName={p.teamName}
                                        opponentName={p.opponentName}
                                    />
                                    )}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                
                </div>
              </div>
            </div>
          )}

          {/* OTHER MANAGERS */}
          {!showFinalPodium && (
            <div className="tpCard tpFull">
              <h3 className="tpCardTitle">Other Managers</h3>
              {!otherUsers.length ? (
                <p className="tpText">No other managers.</p>
              ) : (
                <div className="tpMatchup">
                  {otherUsers.map((u) => {
                    const isOpen = expandedOtherUser === u.userId;
                    const oppStarters = sortPlayersForDisplay(getResolvedRoster(u.userId, 'starters'));
                    const oppBench = sortPlayersForDisplay(getResolvedRoster(u.userId, 'bench'));

                    const oppRoundTotal = sumDisplayedPoints(oppStarters);
                    const oppBenchTotal = sumDisplayedPoints(oppBench);

                    return (
                      <div key={u.userId} className={`tpOtherMatchupItem ${isOpen ? "open" : ""}`}>
                        <button
                          type="button"
                          className="tpOtherMatchupTop"
                          onClick={() => setExpandedOtherUser(isOpen ? null : u.userId)}
                        >
                          <div className="tpMatchTeams"><UserChip user={u} /></div>
                          <div className="tpOtherScore">
                            <span className="tpPts">{oppRoundTotal} pts</span>
                            <span className={`tpCaret ${isOpen ? "open" : ""}`}>▾</span>
                          </div>
                        </button>

                        {isOpen && (
                          <div className="tpOtherMatchupBody">
                            <div className="tpLineups tpLineupsSingle" style={{ marginTop: 0 }}>
                              <div className="tpSide tpSideSolo">
                                <div className="tpSectionLabel">Starters</div>
                                <ul className="tpList">
                                  {oppStarters.map((p) => {
                                    const isPlayerOpen = expandedPlayerId === `opp-${p.id}`;
                                    const isLiveNow = Boolean(p.stats?.isLive);
                                    return (
                                      <li key={p.id} className={`tpRowWrap ${isPlayerOpen ? "tpRowOpen" : ""}`}>
                                        <div className="tpRow" onClick={() => setExpandedPlayerId(isPlayerOpen ? null : `opp-${p.id}`)}>
                                            <PlayerIdentity
                                              name={p.name}
                                              country={p.country}
                                              club={p.clubName || p.teamName}
                                            />

                                            <div className="tpMeta">
                                              {normalizeDisplayPos(p.position)}
                                              <span className={`tpLivePill ${isLiveNow ? "live" : "idle"}`}>
                                                {isLiveNow ? "LIVE" : "IDLE"}
                                              </span>
                                            </div>
                                            <div className="tpPts">{p.points} pts</div>
                                        </div>
                                        {isPlayerOpen && <PlayerStatsCard
                                             stats={p.stats}
                                            breakdown={p.breakdown}
                                            teamName={p.teamName}
                                            opponentName={p.opponentName}
                                        />}
                                      </li>
                                    );
                                  })}
                                </ul>

                                
                                  <details className="tpBenchDetails">
                                    <summary className="tpBenchSummary">
                                      <div className="tpBenchLeft">
                                        <span className="tpBenchTitle">Bench</span>
                                        <span className="tpBenchNote">Not counted</span>
                                      </div>
                                      <div className="tpBenchRight">
                                        <span className="tpLineupTotal">{oppBenchTotal} pts</span>
                                        <span className="tpBenchCaret">▾</span>
                                      </div>
                                    </summary>
                                    <ul className="tpList tpBenchList">
                                      {oppBench.map((p) => {
                                        const isPlayerOpen = expandedPlayerId === `opp-${p.id}`;
                                        const isLiveNow = Boolean(p.stats?.isLive);
                                        return (
                                          <li key={p.id} className={`tpRowWrap ${isPlayerOpen ? "tpRowOpen" : ""}`}>
                                            <div className="tpRow" onClick={() => setExpandedPlayerId(isPlayerOpen ? null : `opp-${p.id}`)}>
                                              <PlayerIdentity
                                                name={p.name}
                                                country={p.country}
                                                club={p.clubName || p.teamName}
                                              />

                                              <div className="tpMeta">
                                                {normalizeDisplayPos(p.position)}
                                                <span className={`tpLivePill ${isLiveNow ? "live" : "idle"}`}>
                                                  {isLiveNow ? "LIVE" : "IDLE"}
                                                </span>
                                              </div>
                                              <div className="tpPts">{p.points} pts</div>
                                            </div>
                                            {isPlayerOpen && (
                                              <PlayerStatsCard
                                                stats={p.stats}
                                                breakdown={p.breakdown}
                                                teamName={p.teamName}
                                                opponentName={p.opponentName}
                                              />
                                            )}
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </details>
                                
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          
          {/* ROUND HISTORY */}
          <div className="tpCard tpFull">
            <div className="tpHistoryHeader">
              <h3 className="tpCardTitle tpHistoryTitle">Round History</h3>

              <div className="tpHistoryControls">
                <select
                  className="tpHistorySelect"
                  value={selectedHistoryId}
                  onChange={(e) => setSelectedHistoryId(e.target.value)}
                  disabled={displayHistoryRounds.length === 0}
                >
                  <option value="">
                    {displayHistoryRounds.length === 0 ? "No completed rounds yet" : "Select a previous round…"}
                  </option>

                  {displayHistoryRounds.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label || "Cup"}
                      {h.startAtMs ? ` • ${fmtDT(h.startAtMs)}` : ""}
                    </option>
                  ))}
                </select>
                
                {/* ✅ ADDED: The Clear Button */}
                {selectedHistoryId && selectedHistoryId !== "" && (
                  <button 
                    type="button" 
                    className="tpMiniBtn" 
                    onClick={() => setSelectedHistoryId("")}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {selectedHistory == null ? (
              <p className="tpText">Pick a previous round to view final scores.</p>
            ) : (
              <>
                <div className="tpHistoryMetaGrid">
                  <div className="tpHistoryMetaCard">
                    <span className="tpHistoryMetaLabel">Window</span>
                    <span className="tpHistoryMetaValue">{selectedHistoryRange}</span>
                  </div>

                  <div className="tpHistoryMetaCard">
                    <span className="tpHistoryMetaLabel">Round</span>
                    <span className="tpHistoryMetaValue">{selectedHistoryLabel}</span>
                  </div>

                  <div className="tpHistoryMetaCard">
                    <span className="tpHistoryMetaLabel">Winner</span>
                    <span className="tpHistoryMetaValue">
                      {selectedHistoryRows[0]?.name || "—"}
                    </span>
                  </div>
                </div>

                {selectedHistoryRows.length > 0 ? (
                  <div className="tpHistoryTableWrap">
                    <table className="tpHistoryTable">
                      <thead>
                        <tr>
                          <th>Rank</th>
                          <th>Manager</th>
                          <th>Round Pts</th>
                          <th>Cup Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedHistoryRows.map((row) => (
                          <tr key={row.userId || row.uid}>
                            <td>
                              <span className="tpHistoryRankBadge">#{row.rank}</span>
                            </td>
                            <td>
                              <div className="tpHistoryManagerCell">
                                <span className="tpHistoryManagerName">{row.name || "Unknown"}</span>
                              </div>
                            </td>
                            <td>
                              <span className="tpHistoryPointsPill">
                                {Number(row.roundPoints || 0)} pts
                              </span>
                            </td>
                            <td>
                              <span className="tpHistoryTotalValue">
                                {Number(row.totalAfter || 0)} pts
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="tpText">No scores saved for this round yet.</p>
                )}
              </>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
