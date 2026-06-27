import { useCallback, useEffect, useRef, useState } from "react";

import { APP_VERSION } from "../config/appVersion";
import "./AppUpdateBanner.css";

const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const DISMISSED_VERSION_KEY = "appUpdateDismissedVersion";

function cleanVersion(value) {
  return String(value || "").trim();
}

function getDismissedVersion() {
  try {
    return cleanVersion(window.sessionStorage.getItem(DISMISSED_VERSION_KEY));
  } catch {
    return "";
  }
}

export default function AppUpdateBanner() {
  const [updateInfo, setUpdateInfo] = useState(null);
  const requestRef = useRef(null);

  const checkVersion = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    try {
      const baseUrl = String(import.meta.env.BASE_URL || "/");
      const versionUrl = `${baseUrl}version.json?ts=${Date.now()}`;
      const response = await fetch(versionUrl, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) return;

      const data = await response.json();
      const remoteVersion = cleanVersion(data?.version);
      if (!remoteVersion || remoteVersion === APP_VERSION) {
        setUpdateInfo(null);
        return;
      }

      const required = data?.required === true;
      if (!required && getDismissedVersion() === remoteVersion) return;

      setUpdateInfo({
        version: remoteVersion,
        required,
        message: cleanVersion(data?.message),
      });
    } catch (error) {
      if (error?.name !== "AbortError") {
        // Version checks should never interrupt normal app use.
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    checkVersion();
    const intervalId = window.setInterval(checkVersion, CHECK_INTERVAL_MS);

    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") checkVersion();
    };

    document.addEventListener("visibilitychange", checkWhenVisible);

    return () => {
      requestRef.current?.abort();
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [checkVersion]);

  if (!updateInfo) return null;

  const dismiss = () => {
    try {
      window.sessionStorage.setItem(
        DISMISSED_VERSION_KEY,
        updateInfo.version
      );
    } catch {
      // Dismissal still works for this render if storage is unavailable.
    }
    setUpdateInfo(null);
  };

  return (
    <aside
      className={`appUpdateBanner ${
        updateInfo.required ? "appUpdateBanner--required" : ""
      }`}
      role="status"
      aria-live="polite"
      aria-label="Application update available"
    >
      <div className="appUpdateBannerCopy">
        <strong>
          {updateInfo.required
            ? "Important update required."
            : "New update available."}
        </strong>
        <span>
          {updateInfo.message ||
            "Refresh when you are ready to use the latest version."}
        </span>
      </div>

      <div className="appUpdateBannerActions">
        {!updateInfo.required ? (
          <button
            type="button"
            className="appUpdateBannerLater"
            onClick={dismiss}
          >
            Later
          </button>
        ) : null}
        <button
          type="button"
          className="appUpdateBannerRefresh"
          onClick={() => window.location.reload()}
        >
          {updateInfo.required ? "Refresh now" : "Refresh"}
        </button>
      </div>
    </aside>
  );
}
