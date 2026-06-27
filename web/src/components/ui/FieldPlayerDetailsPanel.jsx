import FlagIcon from "../FlagIcon";

import "./FieldPlayerDetailsPanel.css";

function displayRowValue(row = {}) {
  if (row.formattedValue != null) return row.formattedValue;
  if (typeof row.value === "boolean") return row.value ? "Yes" : "No";
  return String(row.value ?? "");
}

export default function FieldPlayerDetailsPanel({
  player,
  isOpen = false,
  onClose,
  position = "MID",
  club = "Unknown club",
  country = "",
  isLive = false,
  totalPoints = 0,
  rawStatsRows = [],
  breakdownRows = [],
}) {
  if (!isOpen || !player) return null;

  const displayName = player?.name || player?.playerName || "Unknown player";
  const safePoints = Number.isFinite(Number(totalPoints))
    ? Number(totalPoints)
    : 0;

  return (
    <section className="fieldPlayerDetails" aria-label={`${displayName} details`}>
      <header className="fieldPlayerDetailsHeader">
        <div className="fieldPlayerDetailsIdentity">
          <div className="fieldPlayerDetailsBadges">
            <span className="fieldPlayerDetailsPosition">{position}</span>
            <span
              className={`fieldPlayerDetailsStatus ${
                isLive ? "fieldPlayerDetailsStatus--live" : ""
              }`}
            >
              {isLive ? "Live" : "Idle"}
            </span>
          </div>
          <h4 className="fieldPlayerDetailsName">{displayName}</h4>
          <div className="fieldPlayerDetailsMeta">
            <span>{club || "Unknown club"}</span>
            {country ? (
              <span className="fieldPlayerDetailsCountry">
                <FlagIcon country={country} size={14} title={country} />
                {country}
              </span>
            ) : null}
          </div>
        </div>

        <div className="fieldPlayerDetailsPoints">
          <span>Total fantasy points</span>
          <strong>{safePoints} PTS</strong>
        </div>

        <button
          type="button"
          className="fieldPlayerDetailsClose"
          onClick={onClose}
          aria-label={`Close ${displayName} details`}
        >
          X
        </button>
      </header>

      <div className="fieldPlayerDetailsGrid">
        <section className="fieldPlayerDetailsSection">
          <div className="fieldPlayerDetailsSectionTitle">
            <span>Raw Stats</span>
            {isLive ? <small>Live</small> : null}
          </div>
          <div className="fieldPlayerDetailsRows">
            {rawStatsRows.map((row) => (
              <div className="fieldPlayerDetailsRow" key={row.key}>
                <span>{row.label}</span>
                <strong>{displayRowValue(row)}</strong>
              </div>
            ))}
            {!rawStatsRows.length ? (
              <div className="fieldPlayerDetailsEmpty">
                No raw stats available yet.
              </div>
            ) : null}
          </div>
        </section>

        <section className="fieldPlayerDetailsSection">
          <div className="fieldPlayerDetailsSectionTitle">
            <span>Points Breakdown</span>
          </div>
          <div className="fieldPlayerDetailsRows">
            {breakdownRows.map((row) => (
              <div className="fieldPlayerDetailsRow" key={row.key}>
                <span>{row.label}</span>
                <strong
                  className={
                    Number(row.value) > 0
                      ? "fieldPlayerDetailsValue--positive"
                      : Number(row.value) < 0
                        ? "fieldPlayerDetailsValue--negative"
                        : ""
                  }
                >
                  {displayRowValue(row)}
                </strong>
              </div>
            ))}
            {!breakdownRows.length ? (
              <div className="fieldPlayerDetailsEmpty">
                No points breakdown available yet.
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <footer className="fieldPlayerDetailsTotal">
        <span>Total fantasy points</span>
        <strong>{safePoints} PTS</strong>
      </footer>
    </section>
  );
}
