// src/lib/flagCodes.js
export const COUNTRY_TO_FLAG_CODE = {
  Germany: "DE",
  Spain: "ES",
  Italy: "IT",
  France: "FR",
  Portugal: "PT",
  Netherlands: "NL",
  Belgium: "BE",
  Brazil: "BR",
  Argentina: "AR",
  Mexico: "MX",
  USA: "US",
  "United States": "US",
  Japan: "JP",
  Morocco: "MA",
  Croatia: "HR",
  Serbia: "RS",
  Poland: "PL",
  Denmark: "DK",
  Sweden: "SE",
  Norway: "NO",
  Switzerland: "CH",
  Austria: "AT",
  Turkey: "TR",
  Türkiye: "TR",
  Ukraine: "UA",
  Colombia: "CO",
  Uruguay: "UY",

  // football-specific
  England: "GB-ENG",
  Scotland: "GB-SCT",
  Wales: "GB-WLS",
  "Northern Ireland": "GB-NIR",
  Kosovo: "XK",
};

export function countryToFlagCode(country) {
  const clean = String(country || "").trim();
  return COUNTRY_TO_FLAG_CODE[clean] || "";
}