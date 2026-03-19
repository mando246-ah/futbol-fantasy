// src/pages/TournamentPage/TournamentRouter.jsx
import { useParams, Link } from "react-router-dom";
import { useTournament } from "../../tournament/hooks/useTournament";
import TournamentPage from "./TournamentPage";
import CupTournamentPage from "./CupTournamentPage";
import "./TournamentPage.css";

export default function TournamentRouter() {
  const { roomId } = useParams();
  const { loading, error, data } = useTournament(roomId);

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

  // 4. THE ROUTER LOGIC
  // Catch both the proper nested map and the literal string key
  const phaseLabel =
    data?.room?.competitionState?.phaseLabel ??
    data?.room?.["competitionState.phaseLabel"] ??
    "RegularSeason";

  if (phaseLabel === "Cup") {
    return <CupTournamentPage />;
  }

  // Default to the original Matchday UI
  return <TournamentPage />;
}