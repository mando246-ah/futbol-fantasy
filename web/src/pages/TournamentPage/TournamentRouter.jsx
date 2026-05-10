// src/pages/TournamentPage/TournamentRouter.jsx
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { doc, onSnapshot } from "firebase/firestore";

import { db } from "../../firebase";
import { useTournament } from "../../tournament/hooks/useTournament";
import TournamentPage from "./TournamentPage";
import CupTournamentPage from "./CupTournamentPage";
import "./TournamentPage.css";

function detectPhaseFromRoundLabelClient(roundLabel) {
  const s = String(roundLabel || "").toLowerCase().trim();
  if (!s) return "RegularSeason";

  if (
    s.includes("regular season") ||
    s.includes("matchday") ||
    s.includes("group stage") ||
    s.includes("league stage") ||
    s.includes("clausura") ||
    s.includes("apertura")
  ) {
    return "RegularSeason";
  }

  if (
    /\bround of\b/.test(s) ||
    /\bquarter\b/.test(s) ||
    /\bsemi\b/.test(s) ||
    /\bfinals?\b/.test(s) ||
    /\bplay[- ]?offs?\b/.test(s) ||
    /\bknockouts?\b/.test(s) ||
    /\b1\/8\b/.test(s) ||
    /\b1\/4\b/.test(s) ||
    /\b1\/2\b/.test(s)
  ) {
    return "Cup";
  }

  return "RegularSeason";
}

function getClientCompetitionState(room = {}) {
  return room?.competitionState && typeof room.competitionState === "object"
    ? room.competitionState
    : {};
}

export default function TournamentRouter() {
  const { roomId } = useParams();
  const { loading, error, data } = useTournament(roomId);
  const [cupDoc, setCupDoc] = useState(null);
  const [weekDoc, setWeekDoc] = useState(null);

  useEffect(() => {
    const currentWeekIndex = Number(data?.room?.currentWeekIndex);

    if (!roomId || !Number.isFinite(currentWeekIndex) || currentWeekIndex <= 0) {
      setWeekDoc(null);
      return;
    }

    const unsub = onSnapshot(
      doc(db, "rooms", roomId, "weeks", String(currentWeekIndex)),
      (snap) => setWeekDoc(snap.exists() ? snap.data() : null),
      () => setWeekDoc(null)
    );

    return unsub;
  }, [roomId, data?.room?.currentWeekIndex]);


  useEffect(() => {
    if (!roomId) {
      setCupDoc(null);
      return;
    }

    const unsub = onSnapshot(
      doc(db, "rooms", roomId, "cup", "current"),
      (snap) => setCupDoc(snap.exists() ? snap.data() : null),
      () => setCupDoc(null)
    );

    return unsub;
  }, [roomId]);

  // 1. Handle Missing Room
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

  // 2. Handle Loading
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

  // 3. Handle Error
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

  // 4. Robust Cup vs RegularSeason routing
  const room = data?.room || {};
  const state = getClientCompetitionState(room);

  const storedPhase =
    state.phaseLabel ||
    room?.["competitionState.phaseLabel"] ||
    room?.competitionState?.phaseLable ||
    room?.["competitionState.phaseLable"] ||
    "";

  const roundLabel =
    state.currentLabel ||
    cupDoc?.currentWindowLabel ||
    weekDoc?.roundLabel ||
    data?.week?.roundLabel ||
    data?.currentWeek?.roundLabel ||
    data?.activeWeek?.roundLabel ||
    data?.weekDoc?.roundLabel ||
    room?.roundLabel ||
    room?.competitionMeta?.roundLabel ||
    room?.competitionMeta?.currentLabel ||
    "";

  const detectedPhase = detectPhaseFromRoundLabelClient(roundLabel);

  const hasCupDoc =
    !!cupDoc &&
    (
      Array.isArray(cupDoc.currentWindowFixtureIds) ||
      cupDoc.currentWindowLabel ||
      cupDoc.currentWindowId ||
      cupDoc.cupTotalsByUid ||
      cupDoc.livePointsByUid ||
      cupDoc.projectedTotalsByUid
    );

  const isCup =
    String(storedPhase).toLowerCase() === "cup" ||
    detectedPhase === "Cup" ||
    hasCupDoc;

  

  return isCup ? <CupTournamentPage /> : <TournamentPage />;
}