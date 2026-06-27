import FlagIcon from "../FlagIcon";
import playerCardBg from "../../assets/Card.png";

import "./FieldPlayerCard.css";

function getCardDisplayName(player, fallbackName) {
  const fullName = String(fallbackName || player?.name || "").trim();
  if (!fullName) return "Unknown";

  const firstName =
    player?.firstName ||
    player?.firstname ||
    player?.first_name ||
    "";

  const lastName =
    player?.lastName ||
    player?.lastname ||
    player?.last_name ||
    "";

  if (firstName && lastName) {
    return `${String(firstName).trim().charAt(0).toUpperCase()}. ${String(lastName).trim()}`;
  }

  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return fullName;

  const firstInitial = parts[0].charAt(0).toUpperCase();

  const surnameParticles = new Set([
    "de",
    "da",
    "del",
    "della",
    "di",
    "dos",
    "das",
    "van",
    "von",
    "der",
    "den",
    "la",
    "le",
    "du",
  ]);

  const suffixes = new Set(["jr", "jr.", "junior", "sr", "sr.", "ii", "iii", "iv"]);

  let surnameStart = parts.length - 1;

  // Keep suffix names together, example:
  // Vinicius Jose Paixao de Oliveira Junior -> V. Oliveira Junior
  if (parts.length > 2 && suffixes.has(parts[parts.length - 1].toLowerCase())) {
    surnameStart = parts.length - 2;
  }

  // Keep surname particles together, example:
  // Kevin De Bruyne -> K. De Bruyne
  while (
    surnameStart > 1 &&
    surnameParticles.has(parts[surnameStart - 1].toLowerCase())
  ) {
    surnameStart -= 1;
  }

  const surname = parts.slice(surnameStart).join(" ");
  return `${firstInitial}. ${surname}`;
}

export default function FieldPlayerCard({
  player,
  position = "MID",
  statusLabel = "Idle",
  isLive = false,
  isSelected = false,
  onClick,
  points = 0,
  name,
  club,
  country,
}) {
  const displayName = name || player?.name || "Unknown player";
  const cardDisplayName = getCardDisplayName(player, displayName);
  const displayClub = club || player?.clubName || player?.teamName || "Unknown club";
  const displayCountry = country || player?.country || player?.nationality || "";
  const displayPoints = Number.isFinite(Number(points)) ? Number(points) : 0;
  const isInteractive = typeof onClick === "function";

  const handleKeyDown = (event) => {
    if (!isInteractive || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onClick();
  };

  return (
    <article
      className={[
        "fieldPlayerCard",
        isLive ? "fieldPlayerCard--live" : "",
        isSelected ? "fieldPlayerCard--selected" : "",
        isInteractive ? "fieldPlayerCard--interactive" : "",
      ].filter(Boolean).join(" ")}
      title={`${displayName} - ${displayClub} - ${displayPoints} points`}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-pressed={isInteractive ? isSelected : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <img
        className="fieldPlayerCardFrame"
        src={playerCardBg}
        alt=""
        aria-hidden="true"
      />
      <span className="fieldPlayerCardPosition">{position}</span>
      <span className="fieldPlayerCardStatus">
        {statusLabel || (isLive ? "Live" : "Idle")}
      </span>

      <strong className="fieldPlayerCardName" title={displayName}>
        {cardDisplayName}
      </strong>
      {/* <span className="fieldPlayerCardClub">{displayClub}</span>    change this when World Cup is over*/}
      <span
        className="fieldPlayerCardCountry"
        title={displayCountry || "Country unavailable"}
      >
        {displayCountry ? (
          <FlagIcon country={displayCountry} size={12} title={displayCountry} />
        ) : null}
        <span>{displayCountry || "Country unavailable"}</span>
      </span>

      <span className="fieldPlayerCardPoints">
        <strong>{displayPoints}</strong> PTS
      </span>
    </article>
  );
}
