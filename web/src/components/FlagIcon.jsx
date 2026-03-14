// src/components/FlagIcon.jsx
import { countryToFlagCode } from "../lib/flagCodes";

function getFlagSrc(code) {
  if (!code) return "";
  return `https://purecatamphetamine.github.io/country-flag-icons/3x2/${code}.svg`;
}

export default function FlagIcon({ country, size = 18, title }) {
  const code = countryToFlagCode(country);
  const src = getFlagSrc(code);

  if (!src) return null;

  return (
    <img
      src={src}
      alt={title || country || "flag"}
      title={title || country || ""}
      width={Math.round(size * 1.5)}
      height={size}
      loading="lazy"
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        objectFit: "cover",
        borderRadius: 2,
      }}
    />
  );
}