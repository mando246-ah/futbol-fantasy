// src/pages/TournamentPage/TournamentRouter.jsx
import { useEffect, useState } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import { doc, onSnapshot } from "firebase/firestore";

import { db } from "../../firebase";
import TournamentPage from "./TournamentPage";
import CupTournamentPage from "./CupTournamentPage";
import WorldCupTournamentPage from "./WorldCupTournamentPage";
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
  const location = useLocation();
  const [room, setRoom] = useState(null);
  const [loading, setLoading] = useState(Boolean(roomId));
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!roomId) {
      setRoom(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    const unsub = onSnapshot(
      doc(db, "rooms", roomId),
      (snap) => {
        if (!snap.exists()) {
          setRoom(null);
          setError(new Error(`Room ${roomId} not found`));
        } else {
          setRoom({ id: snap.id, ...(snap.data() || {}) });
          setError(null);
        }
        setLoading(false);
      },
      (snapshotError) => {
        setRoom(null);
        setError(snapshotError);
        setLoading(false);
      }
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
  const state = getClientCompetitionState(room || {});
  const engineType = String(room?.engineType || room?.worldCup?.engineType || "").trim();
  const worldCupPhase = String(room?.worldCupPhase || room?.worldCup?.phase || "").trim();
  const competitionKey = String(room?.competitionKey || "").toLowerCase();
  const competitionMetaType = String(room?.competitionMeta?.type || "").toLowerCase();
  const competitionMetaName = String(room?.competitionMeta?.name || room?.competition?.name || "").toLowerCase();
  const viewOverride = new URLSearchParams(location.search).get("view");

  if (viewOverride === "worldcup") {
    return <WorldCupTournamentPage />;
  }

  if (viewOverride === "cup") {
    return <CupTournamentPage />;
  }

  const isWorldCupRoom = Boolean(
    room?.worldCup ||
    room?.worldCupPhase ||
    competitionMetaType.includes("world cup") ||
    competitionMetaName.includes("world cup") ||
    competitionKey.includes("worldcup") ||
    competitionKey.includes("world-cup")
  );

  const isWorldCupGroupRoom =
    engineType === "worldCupDaily" ||
    room?.worldCup?.engineType === "worldCupDaily" ||
    worldCupPhase.toLowerCase() === "group" ||
    state?.phaseLabel === "WorldCupGroup";

  const isWorldCupKnockoutRoom =
    isWorldCupRoom &&
    (
      worldCupPhase.toLowerCase() === "knockout" ||
      String(room?.worldCup?.phase || "").toLowerCase() === "knockout" ||
      engineType === "cupEngine" ||
      state?.phaseLabel === "Cup"
    );

  if (isWorldCupGroupRoom || isWorldCupKnockoutRoom) {
    return <WorldCupTournamentPage />;
  }

  const storedPhase =
    state.phaseLabel ||
    room?.["competitionState.phaseLabel"] ||
    room?.competitionState?.phaseLable ||
    room?.["competitionState.phaseLable"] ||
    "";

  const roundLabel =
    state.currentLabel ||
    room?.roundLabel ||
    room?.competitionMeta?.roundLabel ||
    room?.competitionMeta?.currentLabel ||
    "";

  const detectedPhase = detectPhaseFromRoundLabelClient(roundLabel);

  const isCup =
    worldCupPhase.toLowerCase() === "knockout" ||
    engineType === "cupEngine" ||
    String(storedPhase).toLowerCase() === "cup" ||
    detectedPhase === "Cup";

  

  return isCup ? <CupTournamentPage /> : <TournamentPage />;
}
