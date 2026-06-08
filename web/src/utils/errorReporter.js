import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import { devWarn } from "./devLogger";

const DEFAULT_USER_MESSAGE =
  "Something went wrong. Please refresh and try again.";

const SAFE_BUSINESS_MESSAGES = [
  "Only host can start",
  "Draft has not started",
  "Draft not started",
  "Not your turn",
  "Player already picked",
  "Need at least 2 managers",
  "This draft has already started",
  "Trade must be 1-for-1 or 2-for-2",
  "Choose another manager",
  "You no longer own one of the offered players",
  "The selected manager no longer owns one of the requested players",
];

function normalizedErrorCode(error) {
  return String(error?.code || "")
    .toLowerCase()
    .replace(/^functions\//, "")
    .replace(/^firestore\//, "")
    .replace(/^auth\//, "");
}

function safeBusinessMessage(error) {
  const message = String(error?.message || "").trim();
  if (!message) return "";

  const match = SAFE_BUSINESS_MESSAGES.find((allowed) =>
    message.toLowerCase().includes(allowed.toLowerCase())
  );
  return match || "";
}

export function friendlyErrorMessage(error, fallback = DEFAULT_USER_MESSAGE) {
  const code = normalizedErrorCode(error);
  const message = String(error?.message || "").toLowerCase();
  const safeMessage = safeBusinessMessage(error);

  if (code === "unauthenticated" || code === "user-token-expired") {
    return "Please sign in and try again.";
  }
  if (code === "permission-denied") {
    return "You do not have permission to do that.";
  }
  if (
    code === "unavailable" ||
    code === "network-request-failed" ||
    message.includes("network") ||
    message.includes("offline")
  ) {
    return "Connection issue. Please refresh and try again.";
  }
  if (
    code === "already-exists" ||
    message.includes("player already picked") ||
    message.includes("player is no longer available")
  ) {
    return "That player is no longer available.";
  }
  if (safeMessage) return safeMessage;
  if (code === "failed-precondition") return fallback;

  return fallback;
}

export async function reportClientError({
  roomId = "",
  area = "",
  action = "",
  error,
  userMessage = DEFAULT_USER_MESSAGE,
  severity = "error",
  extra = {},
} = {}) {
  try {
    const fn = httpsCallable(functions, "reportClientErrorCallable");
    await fn({
      roomId,
      area,
      action,
      message: String(error?.message || error || ""),
      code: String(error?.code || ""),
      stack: String(error?.stack || ""),
      userMessage,
      severity,
      extra,
      url: typeof window !== "undefined" ? window.location.href : "",
      path: typeof window !== "undefined" ? window.location.pathname : "",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    });
  } catch (reportError) {
    devWarn("[errorReporter] failed to report client error", reportError);
  }
}
