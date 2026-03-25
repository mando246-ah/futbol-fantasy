// src/pages/TournamentPage/CupTournamentPage.jsx
import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { doc, onSnapshot, collection, query, orderBy } from "firebase/firestore";

import { useTournament } from "../../tournament/hooks/useTournament";
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

  if (!hasStats && !hasBD && !teamName && !opponentName) {
    return (
      <div className="tpStatsCard">
        <div className="tpStatsGrid">
          <div className="tpStatsCol">
            <span className="tpStatsHead">No stats yet</span>
            <div className="tpStatRow">
              <span>Waiting for next scored fixture</span>
              <span>—</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tpStatsCard">
      {(teamName || opponentName) && (
        <div className="tpCardHeader">
          <span className="tpCardTeam">{teamName || "Unknown Team"}</span>
          {opponentName && <span className="tpCardVs">vs {opponentName}</span>}
        </div>
      )}

      <div className="tpStatsGrid">
        {/* RAW STATS */}
        <div className="tpStatsCol">
          <span className="tpStatsHead">Raw Stats</span>
          {Object.entries(stats || {}).map(([k, v]) => {
            if (v === null || v === undefined) return null;
            if (v === false) return null;
            if (k === "minutes" && Number(v) === 0) return null;
            if (Number(v) === 0 && k !== "minutes") return null;
            return (
              <div key={k} className="tpStatRow">
                <span>{prettyStatLabel(k)}</span>
                <span>{String(v)}</span>
              </div>
            );
          })}
        </div>

        {/* POINTS */}
        <div className="tpStatsCol">
          <span className="tpStatsHead">Points</span>
          {Object.entries(breakdown || {}).map(([k, v]) => (
            <div key={k} className="tpStatRow">
              <span>{prettyStatLabel(k)}</span>
              <span className={Number(v) > 0 ? "tpPos" : "tpNeg"}>
                {Number(v) > 0 ? "+" : ""}
                {String(v)}
              </span>
            </div>
          ))}
          {Object.keys(breakdown || {}).length === 0 && (
            <div className="tpStatRow">
              <span>Base</span>
              <span>0</span>
            </div>
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

export default function CupTournamentPage() {
  const { roomId } = useParams();
  const { loading, error, data } = useTournament(roomId);
  const [myUid, setMyUid] = useState(auth.currentUser?.uid || null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Cup-specific State
  const [cupDoc, setCupDoc] = useState(null);
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
        const m = {};
        snap.forEach((d) => {
          const val = d.data();
          const pid = String(val.playerId || val.pid || val.apiPlayerId || "");
          if (pid) m[pid] = val;
        });
        setPicksMap(m);
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

  const competitionName = data?.room?.competitionMeta?.name || data?.room?.competition?.name || "";
  const competitionSeason = data?.room?.competition?.season || data?.room?.competitionMeta?.season || "";
  const competitionLabel = [competitionSeason, competitionName].filter(Boolean).join(" ");
  
    // Cup Data
    const statusRaw = cupDoc?.status || "IDLE";
    const status = String(statusRaw).toUpperCase();
    const statusLower = String(statusRaw).toLowerCase();

    const currentWindowLabel = cupDoc?.currentWindowLabel || "Waiting for next round";
    const isFinal = status === "FINAL" || cupDoc?.completed;

    // --- Live-style header timing (match TournamentPage feel) ---
    const lastUpdateMs = Number(cupDoc?.updatedAtMs || cupDoc?.lastPollAtMs || 0) || null;
    const ageSec = lastUpdateMs ? Math.max(0, Math.floor((nowMs - lastUpdateMs) / 1000)) : null;
    const nextUpdateInSec = lastUpdateMs ? Math.max(0, 60 - (ageSec % 60)) : null;
    const lastUpdateLabel = lastUpdateMs ? fmtDT(lastUpdateMs) : "—";

    // Status classification for styling
    const isLive = statusLower === "live";
    const isResolving = statusLower === "resolving";
    const statusClass = isLive ? "live" : isResolving ? "resolving" : "idle";
    const statusLabel = isLive ? "LIVE" : isResolving ? "RESOLVING" : "IDLE";

    const cupTotals = cupDoc?.cupTotalsByUid || {};
    const livePoints = cupDoc?.livePointsByUid || {}; // NEW
    const windowPoints = cupDoc?.windowPointsByUid || {};

    // Build Leaderboard (Base + Live)
    const leaderboard = users.map((u) => {
      const base = Number(cupTotals[u.userId] || 0);
      const live = Number(livePoints[u.userId] || 0);
      return {
        userId: u.userId,
        name: u.name || u.displayName,
        totalPoints: base + live,
      };
    }).sort((a, b) => b.totalPoints - a.totalPoints);

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
      ? historyRounds.find((r) => r.id === selectedHistoryId) || null
      : null;

  const selectedHistoryRows = Array.isArray(selectedHistory?.rows)
    ? selectedHistory.rows
    : [];

  const selectedHistoryLabel = selectedHistory?.label || "—";
  const selectedHistoryRange =
    selectedHistory?.startAtMs && selectedHistory?.endAtMs
      ? `${fmtDT(selectedHistory.startAtMs)} → ${fmtDT(selectedHistory.endAtMs)}`
      : "—";

  const activeBreakdownByUserId =
    selectedHistory?.breakdownByUserId ||
    cupDoc?.breakdownByUserId ||
    {};

  function getResolvedRoster(uid, type) {
    const lineup = lineups[uid] || {};
    const ids = getLineupIds(lineup, type);

    const cupUserBreakdown = activeBreakdownByUserId?.[uid] || {};
    const perPlayer = cupUserBreakdown?.perPlayer || {};

    return ids.map((pid) => {
      const pick = picksMap[pid] || {};
      const live = perPlayer[pid] || {};

      return {
        id: pid,
        name: live.name || pick.playerName || pick.name || "Unknown",
        position: live.position || pick.position || pick.pos || "MID",
        points: Number(live.points ?? pick.lastDelta ?? 0),
        counted: live.counted ?? (pick.lastCounted !== false),
        stats: live.stats || pick.lastStats || pick.stats || null,
        breakdown: live.breakdown || pick.lastBreakdown || pick.breakdown || null,
        teamName: live.teamName || pick.lastRealTeamName || pick.teamName || "",
        opponentName: live.opponentName || pick.lastOpponentName || pick.opponentName || "",
      };
    });
  }

  const myStarters = sortPlayersForDisplay(getResolvedRoster(myUid, 'starters'));
  const myBench = sortPlayersForDisplay(getResolvedRoster(myUid, 'bench'));
  const myRoundTotal = Number(activeBreakdownByUserId?.[myUid]?.total || 0);
  const myBenchTotal = Number(activeBreakdownByUserId?.[myUid]?.benchTotal || 0);
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

  const parsedWindow = parseCupWindowId(cupDoc?.currentWindowId);

  const nextLabel =
    cupDoc?.currentWindowLabel ||
    data?.room?.competitionState?.currentLabel ||
    data?.room?.["competitionState.currentLabel"] ||
    "—";

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
              <div className="tpRoomMeta">Room: <b>{roomId}</b></div>
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
                      return (
                        <li key={p.id} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                          <div className="tpRow" onClick={() => setExpandedPlayerId(isOpen ? null : p.id)}>
                            <div className="tpPlayerInfo"><span className="tpName">{p.name}</span></div>
                            <div className="tpMeta">
                              {normalizeDisplayPos(p.position)}
                              <span className={`tpLivePill ${statusClass}`}>{statusLabel}</span>
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
                          return (
                            <li key={p.id} className={`tpRowWrap ${isOpen ? "tpRowOpen" : ""}`}>
                              <div className="tpRow" onClick={() => setExpandedPlayerId(isOpen ? null : p.id)}>
                                <div className="tpPlayerInfo"><span className="tpName">{p.name}</span></div>
                                <div className="tpMeta">
                                  {normalizeDisplayPos(p.position)}
                                  <span className={`tpLivePill ${statusClass}`}>{statusLabel}</span>
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

                    const oppRoundTotal = Number(activeBreakdownByUserId?.[u.userId]?.total || 0);
                    const oppBenchTotal = Number(activeBreakdownByUserId?.[u.userId]?.benchTotal || 0);

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
                                    return (
                                      <li key={p.id} className={`tpRowWrap ${isPlayerOpen ? "tpRowOpen" : ""}`}>
                                        <div className="tpRow" onClick={() => setExpandedPlayerId(isPlayerOpen ? null : `opp-${p.id}`)}>
                                            <div className="tpPlayerInfo"><span className="tpName">{p.name}</span></div>
                                                <div className="tpMeta">
                                                    {normalizeDisplayPos(p.position)}
                                                    <span className={`tpLivePill ${statusClass}`}>{statusLabel}</span>
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
                                        return (
                                          <li key={p.id} className={`tpRowWrap ${isPlayerOpen ? "tpRowOpen" : ""}`}>
                                            <div className="tpRow" onClick={() => setExpandedPlayerId(isPlayerOpen ? null : `opp-${p.id}`)}>
                                              <div className="tpPlayerInfo"><span className="tpName">{p.name}</span></div>
                                            <div className="tpMeta">
                                                {normalizeDisplayPos(p.position)}
                                                <span className={`tpLivePill ${statusClass}`}>{statusLabel}</span>
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
                  disabled={historyRounds.length === 0}
                >
                  <option value="">
                    {historyRounds.length === 0 ? "No completed rounds yet" : "Select a previous round…"}
                  </option>

                  {historyRounds.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label || "Cup"}
                      {h.startAtMs && h.endAtMs ? ` — ${fmtDT(h.startAtMs)} → ${fmtDT(h.endAtMs)}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {selectedHistory == null ? (
              <p className="tpText">Pick a previous round to view final scores.</p>
            ) : (
              <>
                <p className="tpText tpHistoryMeta">
                  Window: <b>{selectedHistoryRange}</b>
                  {selectedHistoryLabel ? (
                    <>
                      {" "}• Round: <b>{selectedHistoryLabel}</b>
                    </>
                  ) : null}
                </p>

                {selectedHistoryRows.length > 0 ? (
                  <div className="tpHistoryTableWrap">
                    <table className="tpHistoryTable">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Manager</th>
                          <th>This Round</th>
                          <th>Total After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedHistoryRows.map((row) => (
                          <tr key={row.userId || row.uid}>
                            <td>{row.rank}</td>
                            <td>{row.name || "Unknown"}</td>
                            <td>{Number(row.roundPoints || 0)}</td>
                            <td>{Number(row.totalAfter || 0)}</td>
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