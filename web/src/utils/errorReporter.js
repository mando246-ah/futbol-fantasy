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

const EXPECTED_CLIENT_ERROR_MESSAGES = [
  "Not your turn",
  "Player already picked",
  "That player is no longer available",
  "Draft not started",
  "Draft has not started",
  "Draft is complete",
  "Draft complete",
  "All rounds completed",
  "Room not found",
  "Sign in required",
  "Not signed in",
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

function sanitizeErrorDetailValue(value, depth = 0) {
  if (depth > 3) return "[TRUNCATED]";
  if (value == null || typeof value === "boolean") return value ?? null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    return value
      .replace(
        /(password|access[_-]?token|id[_-]?token|api[_-]?key|secret|authorization)(\s*[:=]\s*)([^\s,;}"']+)/gi,
        "$1$2[REDACTED]"
      )
      .slice(0, 2000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => sanitizeErrorDetailValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const clean = {};
    for (const [rawKey, rawValue] of Object.entries(value).slice(0, 50)) {
      const key = String(rawKey || "").slice(0, 120);
      clean[key] = /password|token|apikey|secret|authorization/i.test(key)
        ? "[REDACTED]"
        : sanitizeErrorDetailValue(rawValue, depth + 1);
    }
    return clean;
  }
  return String(value).slice(0, 500);
}

export function shouldReportClientError(error, context = {}) {
  const code = normalizedErrorCode(error);
  const message = String(error?.message || error || "").toLowerCase();
  const userMessage = String(context?.userMessage || "").toLowerCase();
  const action = String(context?.action || "").toLowerCase();
  const area = String(context?.area || "").toLowerCase();
  const combined = `${message} ${userMessage}`;

  if (code === "unauthenticated" || combined.includes("sign in required") || combined.includes("not signed in")) {
    return false;
  }

  const isDraftAction = area === "draft" || action === "makepick" || action === "autopick";
  if (isDraftAction) {
    return !EXPECTED_CLIENT_ERROR_MESSAGES.some((expected) =>
      combined.includes(expected.toLowerCase())
    );
  }

  return true;
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
  if (!shouldReportClientError(error, { area, action, userMessage })) {
    return { ok: true, skipped: true };
  }

  const errorDetails = {
    code: String(error?.code || ""),
    message: String(error?.message || error || ""),
    ...(error?.details !== undefined
      ? { details: sanitizeErrorDetailValue(error.details) }
      : {}),
    ...(error?.customData !== undefined
      ? { customData: sanitizeErrorDetailValue(error.customData) }
      : {}),
  };

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
      extra: {
        ...(extra && typeof extra === "object" ? extra : {}),
        errorDetails,
      },
      url: typeof window !== "undefined" ? window.location.href : "",
      path: typeof window !== "undefined" ? window.location.pathname : "",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    });
  } catch (reportError) {
    devWarn("[errorReporter] failed to report client error", reportError);
  }
}
