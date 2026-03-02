// src/components/ui/FinalResultsCard/FinalResultsCard.jsx
import React from "react";
import "./FinalResultsCard.css";
import GlareHover from "./GlareHover";

export default function FinalResultsCard({ finalResults, renderUser }) {
  if (!finalResults) return null;

  const top3 = Array.isArray(finalResults.top3) ? finalResults.top3 : [];
  const first = top3[0] || null;
  const second = top3[1] || null;
  const third = top3[2] || null;

  // Changed from a Component <Spot> to a normal helper function renderSpot()
  const renderSpot = (place, row, variant) => {
    const isGold = variant === "gold";
    let innerContent;

    if (!row) {
      innerContent = (
        <>
          <div className="ffPodiumPlace">{place}</div>
          <div className="ffPodiumName">—</div>
          <div className="ffPodiumMeta">—</div>
        </>
      );
    } else {
      const uid = row.userId || row.uid || "";
      const name = row.name || uid || "Unknown";
      const wdl = `${Number(row.wins ?? 0)}/${Number(row.draws ?? 0)}/${Number(row.losses ?? 0)}`;
      const matchPts = Number(row.tablePoints ?? 0);
      const totalPts = Number(row.totalFantasyPoints ?? 0);

      innerContent = (
        <>
          <div className="ffPodiumPlace">{place}</div>
          <div className="ffPodiumName">
            {renderUser ? renderUser(uid, name) : <span>{name}</span>}
          </div>
          <div className="ffPodiumMeta">
            <span>W/D/L: <b>{wdl}</b></span>
            <span>Match: <b>{matchPts}</b></span>
            <span>Fantasy: <b>{totalPts}</b></span>
          </div>
        </>
      );
    }

    const spotClass = `ffPodiumSpot ${variant}`;

    if (isGold) {
      return (
        <GlareHover
          key={place}
          className={spotClass}
          width="100%"               
          height="100%"              
          background="transparent"   
          borderColor="transparent"  
          borderRadius="16px"        
          glareColor="#ffffff"
          glareOpacity={0.6}
          glareAngle={-30}
          glareSize={250}
          transitionDuration={1000}
          autoPlay={true}
          autoPlayInterval={3500}
        >
          {innerContent}
        </GlareHover>
      );
    }

    return <div key={place} className={spotClass}>{innerContent}</div>;
  };

  return (
    <div className="ffFinalCard">
      <div className="ffFinalTop">
        <div>
          <h3 className="ffFinalTitle">Season Complete</h3>
          <div className="ffFinalSub">Top 3</div>
        </div>
        <div className="ffFinalBadge">🏆</div>
      </div>

      <div className="ffPodium">
        {/* We now call it like a standard function so React doesn't destroy the timer */}
        {renderSpot("2nd", second, "silver")}
        {renderSpot("1st", first, "gold")}
        {renderSpot("3rd", third, "bronze")}
      </div>
    </div>
  );
}