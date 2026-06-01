import React, { useEffect, useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import "./SuperAdminFix246.css";

function formatWhen(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "Not set";
  return new Date(n).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatCountMap(map = {}) {
  return Object.entries(map || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .map(([key, value]) => `${key || "unknown"}: ${value}`)
    .join(" / ");
}

function pillClass(pill, base = "ownerPill") {
  const key = String(pill?.className || pill?.key || pill || "unknown").toLowerCase().replace(/\s+/g, "-");
  return `${base} ${base}--${key}`;
}

function getDisplayStatus(room) {
  if (room?.displayStatus) return room.displayStatus;

  const weekStatus = String(room?.weekStatus || "").toLowerCase();
  if (room?.isDone || weekStatus === "complete" || weekStatus === "final") {
    return { key: "complete", label: "COMPLETE", className: "complete" };
  }
  if (weekStatus === "live") return { key: "live", label: "LIVE UPDATING", className: "live" };
  if (weekStatus === "resolving") return { key: "resolving", label: "RESOLVING", className: "resolving" };
  if (weekStatus === "scheduled" || weekStatus === "idle") {
    return { key: "idle", label: "IDLE", className: "idle" };
  }
  if (room?.actionableMissingQueue) return { key: "missing", label: "MISSING POLL", className: "problem" };
  if (room?.isIgnoredRoom) return { key: "ignored", label: "IGNORED", className: "ignored" };
  return { key: "unknown", label: "UNKNOWN", className: "idle" };
}

function getCurrentWeekIndex(room = {}) {
  const value = room.currentWeekIndex ?? room.weekIndex ?? room.currentWeek ?? null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getRoomTypeFlags(room = {}) {
  const worldCupPhase = String(room.worldCupPhase || "").trim();
  const isWorldCupGroupRoom =
    room.engineType === "worldCupDaily" ||
    room.phaseLabel === "WorldCupGroup" ||
    worldCupPhase === "group" ||
    worldCupPhase === "WorldCupGroup";

  const isCupRoom = room.phaseLabel === "Cup" && !isWorldCupGroupRoom;
  const isRegularRoom = !isCupRoom && !isWorldCupGroupRoom;

  return { isWorldCupGroupRoom, isCupRoom, isRegularRoom };
}

function getOwnerActionSections(room = {}) {
  const currentWeekIndex = getCurrentWeekIndex(room);
  const missingWeek = !currentWeekIndex;
  const { isWorldCupGroupRoom, isCupRoom, isRegularRoom } = getRoomTypeFlags(room);

  if (isWorldCupGroupRoom) {
    return [
      {
        title: "Quick Fixes",
        actions: [
          {
            key: "worldCupGroupEngineNow",
            label: "Run WC Group Engine Now",
            callableName: "ownerRunWorldCupGroupEngineNow",
            payloadBuilder: (r) => ({ roomId: r.roomId }),
            confirm: true,
            confirmMessage: "This writes World Cup day results, standings, and room state. Continue?",
            description:
              "Runs the group-stage engine once. Writes day results/standings/state if the current day is ready. Does not rebuild missing daily windows.",
            className: "danger",
          },
        ],
      },
    ];
  }

  if (isCupRoom) {
    return [
      {
        title: "Quick Fixes",
        actions: [
          {
            key: "cupEngineNow",
            label: "Force Cup Engine Now",
            callableName: "ownerRunCupEngineNow",
            payloadBuilder: (r) => ({ roomId: r.roomId }),
            confirm: true,
            confirmMessage:
              "DANGER: This can rewrite Cup current state/results for this room. Use only if a Cup room is stuck. Continue?",
            className: "danger",
          },
        ],
      },
      {
        title: "Shadow / Global",
        actions: [
          {
            key: "cupShadowTest",
            label: "Run Cup Shadow Test",
            callableName: "ownerRunCupShadowTest",
            payloadBuilder: (r) => ({ roomId: r.roomId }),
            className: "shadow",
          },
          {
            key: "cupGlobalWriteRehearsal",
            label: "Rehearse Cup Global Write",
            callableName: "ownerRehearseCupGlobalWriteFromHistory",
            payloadBuilder: (r) => ({ roomId: r.roomId }),
            description:
              "Builds the Cup global write payload from the clean shadow result, but only saves it to globalShadowResults. Does not change real room scores.",
            confirm: true,
            confirmMessage:
              "This only writes a Cup global rehearsal payload under globalShadowResults. It will not change real scores. Continue?",
            className: "shadow",
          },
          {
            key: "prepareCupGlobalReplay",
            label: "Prepare Cup Replay From History",
            callableName: "ownerPrepareCupGlobalReplayFromHistory",
            payloadBuilder: (r) => ({ roomId: r.roomId, confirm: "PREPARE_CUP_REPLAY" }),
            description:
              "Temporarily loads the latest completed Cup history fixture IDs into cup/current so Apply Cup Global Current Window can be tested before a live knockout match. Creates a backup first.",
            confirm: true,
            confirmMessage:
              "This prepares a Cup replay test by modifying cup/current and saving a backup. Use only on test rooms. Continue?",
            className: "apply",
          },
          {
            key: "enableGlobalPipeline",
            label: "Enable Global Pipeline",
            callableName: "ownerEnableRoomGlobalPipeline",
            payloadBuilder: (r) => ({ roomId: r.roomId, confirm: "ENABLE_GLOBAL_PIPELINE" }),
            description:
              "Enables globalPipeline.mode='global' and roomAggregator=true for this room. Useful for old test rooms before running global apply tools.",
            confirm: true,
            confirmMessage:
              "This backs up the current globalPipeline and enables global mode for this room. Continue?",
            className: "apply",
          },
          {
            key: "refreshCupGlobalFixtureCache",
            label: "Refresh Cup Global Fixture Cache",
            callableName: "ownerRefreshCupGlobalFixtureCache",
            payloadBuilder: (r) => ({ roomId: r.roomId }),
            description:
              "Refreshes global fixture status/stats for the current Cup window from API-Football. Use before Apply Cup Global Current Window if status looks stale.",
            confirm: true,
            confirmMessage:
              "This refreshes global fixture cache docs for the current Cup window from API-Football. Continue?",
            className: "shadow",
          },
          {
            key: "enableCupGlobalAutoApply",
            label: "Enable Cup Global Auto Apply",
            callableName: "ownerSetCupGlobalAutoApply",
            payloadBuilder: (r) => ({
              roomId: r.roomId,
              enabled: true,
              confirm: "CUP_GLOBAL_AUTO_ON",
            }),
            description:
              "Turns on automatic Cup current-window global projection writes for this room. Does not enable finalization yet.",
            confirm: true,
            confirmMessage:
              "This enables automatic Cup current-window global projection writes for this room. Continue?",
            className: "apply",
          },
          {
            key: "disableCupGlobalAutoApply",
            label: "Disable Cup Global Auto Apply",
            callableName: "ownerSetCupGlobalAutoApply",
            payloadBuilder: (r) => ({
              roomId: r.roomId,
              enabled: false,
              confirm: "CUP_GLOBAL_AUTO_OFF",
            }),
            description:
              "Turns off automatic Cup current-window global projection writes for this room.",
            confirm: true,
            confirmMessage:
              "This disables automatic Cup global projection writes for this room. Continue?",
            className: "shadow",
          },
          {
            key: "runCupGlobalAutoOnce",
            label: "Run Cup Global Auto Once",
            callableName: "ownerRunCupGlobalAutoOnce",
            payloadBuilder: (r) => ({ roomId: r.roomId }),
            description:
              "Runs the same Cup global auto path once. Requires Cup Global Auto Apply to be enabled.",
            confirm: true,
            confirmMessage:
              "This runs the Cup global auto projection path once for this room. Continue?",
            className: "apply",
          },
          {
            key: "enableCupGlobalFinalize",
            label: "Enable Cup Global Finalize",
            callableName: "ownerSetCupGlobalFinalize",
            payloadBuilder: (r) => ({
              roomId: r.roomId,
              enabled: true,
              confirm: "CUP_GLOBAL_FINALIZE_ON",
            }),
            description:
              "Allows global Cup rooms to finalize completed current windows into cupHistory and standings. Requires Cup Global Auto Apply.",
            confirm: true,
            confirmMessage:
              "This enables Cup global finalization for this room. Continue?",
            className: "apply",
          },
          {
            key: "disableCupGlobalFinalize",
            label: "Disable Cup Global Finalize",
            callableName: "ownerSetCupGlobalFinalize",
            payloadBuilder: (r) => ({
              roomId: r.roomId,
              enabled: false,
              confirm: "CUP_GLOBAL_FINALIZE_OFF",
            }),
            description:
              "Turns off Cup global finalization for this room.",
            confirm: true,
            confirmMessage:
              "This disables Cup global finalization for this room. Continue?",
            className: "shadow",
          },
          {
            key: "rehearseCupGlobalFinalize",
            label: "Rehearse Cup Global Finalize",
            callableName: "ownerRehearseCupGlobalFinalizeCurrentWindow",
            payloadBuilder: (r) => ({ roomId: r.roomId }),
            description:
              "Builds the finalization payload and saves it only to globalShadowResults. Safe for replay testing.",
            confirm: true,
            confirmMessage:
              "This writes only a Cup global finalization rehearsal payload. Continue?",
            className: "shadow",
          },
          {
            key: "finalizeCupGlobalCurrentWindow",
            label: "Finalize Cup Global Current Window",
            callableName: "ownerFinalizeCupGlobalCurrentWindowOnce",
            payloadBuilder: (r) => ({
              roomId: r.roomId,
              confirm: "FINALIZE_CUP_GLOBAL_WINDOW",
            }),
            description:
              "Writes cupHistory and final Cup standings from global cache. Blocked in replay mode. Requires finalization enabled.",
            confirm: true,
            confirmMessage:
              "This writes Cup global finalization data to cupHistory and standings. Continue?",
            className: "danger",
          },
          {
            key: "applyCupGlobalCurrentWindow",
            label: "Apply Cup Global Current Window",
            callableName: "ownerApplyCupGlobalCurrentWindowOnce",
            payloadBuilder: (r) => ({ roomId: r.roomId }),
            description:
              "Writes current Cup window projected scores from global cache. Only works when cup/current has active fixture IDs. Does not write cupHistory or finalResults.",
            confirm: true,
            confirmMessage:
              "This writes projection-only Cup current-window scores from global cache. It does not write cupHistory or finalResults. Continue?",
            className: "apply",
          },
          {
            key: "restoreCupReplayBackup",
            label: "Restore Cup Replay Backup",
            callableName: "ownerRestoreCupCurrentFromReplayBackup",
            payloadBuilder: (r) => ({ roomId: r.roomId, confirm: "RESTORE_CUP_REPLAY" }),
            description:
              "Restores cup/current from the backup created before replay testing.",
            confirm: true,
            confirmMessage:
              "This restores cup/current from the replay backup. Continue?",
            className: "shadow",
          },
        ],
      },
    ];
  }

  if (!isRegularRoom) return [];

  return [
    {
      title: "Quick Fixes",
      actions: [
        {
          key: "forceRegularWeekUpdate",
          label: "Force Week Update Now",
          callableName: "ownerForceRegularWeekUpdate",
          payloadBuilder: (r) => ({ roomId: r.roomId, weekIndex: getCurrentWeekIndex(r) }),
          confirm: true,
          confirmMessage:
            "This will force recompute/write the current regular-season week for this room. Continue?",
          disabled: missingWeek,
          disabledReason: "Missing currentWeekIndex",
        },
      ],
    },
    {
      title: "Fixtures",
      actions: [
        {
          key: "repairRegularWeekFixtures",
          label: "Repair Current Week Fixtures",
          callableName: "ownerRepairRegularWeekFixtures",
          payloadBuilder: (r) => ({ roomId: r.roomId, weekIndex: getCurrentWeekIndex(r) }),
          confirm: true,
          confirmMessage:
            "This will rebuild this room's current week fixture list and repair the poll queue. Continue?",
          disabled: missingWeek,
          disabledReason: "Missing currentWeekIndex",
        },
      ],
    },
    {
      title: "Points",
      actions: [
        {
          key: "rebuildRegularStandings",
          label: "Rebuild Regular Standings",
          callableName: "ownerRebuildRegularStandings",
          payloadBuilder: (r) => ({ roomId: r.roomId }),
          confirm: true,
          confirmMessage:
            "This will rebuild standings/current from saved final week results. Continue?",
        },
      ],
    },
    {
      title: "Shadow / Global",
      actions: [
        {
          key: "regularShadowTest",
          label: "Run Regular Shadow Test",
          callableName: "ownerRunRegularShadowTest",
          payloadBuilder: (r) => ({ roomId: r.roomId, weekIndex: getCurrentWeekIndex(r) }),
          className: "shadow",
          disabled: missingWeek,
          disabledReason: "Missing currentWeekIndex",
        },
        {
          key: "applyRegularGlobalAggregator",
          label: "Apply Regular Global Aggregator Once",
          callableName: "ownerApplyRegularGlobalAggregatorOnce",
          payloadBuilder: (r) => ({ roomId: r.roomId, weekIndex: getCurrentWeekIndex(r) }),
          confirm: true,
          confirmMessage:
            "This writes real week results from the global aggregator. Only use this for global-mode rooms. Continue?",
          className: "danger",
          disabled: missingWeek,
          disabledReason: "Missing currentWeekIndex",
        },
      ],
    },
  ];
}

function formatResultValue(key, value) {
  if (key === "nextPollAtMs" || key === "nextKickoffMs") {
    return `${value} (${formatWhen(value)})`;
  }
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function renderActionResult(resultWrapper) {
  if (!resultWrapper) return null;

  const result = resultWrapper.data || {};
  const fields = [
    "ok",
    "roomId",
    "mode",
    "message",
    "seasonKey",
    "enabled",
    "finalizeEnabled",
    "weekIndex",
    "status",
    "weekStatus",
    "statusValue",
    "pipelineMode",
    "windowKey",
    "historyDocId",
    "fixtureCount",
    "refreshedCount",
    "missingFixtureCount",
    "missingCount",
    "maxAbsDiff",
    "userCount",
    "standingsCount",
    "queueRepaired",
    "nextPollAtMs",
    "nextKickoffMs",
    "realWriteApplied",
    "projectionOnly",
    "allFinished",
    "anyInPlay",
    "finalizedUserCount",
    "wroteFinalResults",
    "source",
    "compareScope",
    "shadowSource",
    "replaySource",
    "statusByFixtureId",
    "historyLabel",
    "historyFixtureCount",
    "noFixtureIdsReason",
    "fixtureIds",
    "missingFixtureIds",
    "writtenSummaryCount",
    "writtenLiveFixtureCount",
    "playerMismatchCount",
    "statMismatchCount",
    "projectedUserCount",
    "backupPath",
    "writtenPath",
    "historyPath",
    "cupCurrentPath",
    "standingsPath",
    "finalResultsPath",
    "restoredPath",
    "replayTestMode",
    "replayHistoryLabel",
    "auditPath",
  ];

  return (
    <div className="ownerActionResult">
      <div className="ownerActionResultHeader">
        <strong>{resultWrapper.label || "Latest action"}</strong>
        <button
          type="button"
          className="ownerActionLogBtn"
          onClick={() => console.log("[SuperAdminFix246 stored owner action result]", resultWrapper)}
        >
          Log full result again
        </button>
      </div>
      <div className="ownerActionResultGrid">
        {fields.map((key) => {
          const value = result?.[key];
          if (value === undefined || value === null || value === "") return null;
          return (
            <span key={key}>
              <b>{key}:</b> {formatResultValue(key, value)}
            </span>
          );
        })}
        {Array.isArray(result?.fixtureCoverage) && (
          <span>
            <b>fixtureCoverage:</b> {result.fixtureCoverage.length} rows, logged to console
          </span>
        )}
        {Array.isArray(result?.playerMismatches) && (
          <span>
            <b>playerMismatches:</b> {result.playerMismatches.length}
          </span>
        )}
        {Array.isArray(result?.statMismatches) && (
          <span>
            <b>statMismatches:</b> {result.statMismatches.length}
          </span>
        )}
      </div>
      {result?.noFixtureIdsReason ? (
        <div className="ownerActionWarning">
          {result.noFixtureIdsReason}
        </div>
      ) : null}
    </div>
  );
}

export default function SuperAdminFix246() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openRoomId, setOpenRoomId] = useState(null);
  const [actionBusyKey, setActionBusyKey] = useState("");
  const [actionResultByRoomId, setActionResultByRoomId] = useState({});
  const [actionErrorByRoomId, setActionErrorByRoomId] = useState({});

  async function loadStatus() {
    setLoading(true);
    setError("");

    try {
      const fn = httpsCallable(functions, "getOwnerSiteStatus");
      const res = await fn({});
      setStatus(res?.data || null);
    } catch (err) {
      console.error("getOwnerSiteStatus failed", err);
      setError(err?.message || "Could not load owner status.");
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  const groups = useMemo(() => status?.groups || [], [status]);

  async function runOwnerRoomAction(room, actionKey, label, callableName, payloadBuilder, options = {}) {
    if (!room?.roomId) return;

    const defaultMessage = `Run "${label}" for ${room.name || room.roomId}?`;
    if (options.confirm && !window.confirm(options.confirmMessage || defaultMessage)) {
      return;
    }

    const busyKey = `${room.roomId}:${actionKey}`;
    setActionBusyKey(busyKey);
    setActionErrorByRoomId((prev) => ({ ...prev, [room.roomId]: "" }));

    try {
      const payload = payloadBuilder(room);
      const fn = httpsCallable(functions, callableName);
      const res = await fn(payload);

      console.log("[SuperAdminFix246 owner action result]", actionKey, res.data);

      setActionResultByRoomId((prev) => ({
        ...prev,
        [room.roomId]: {
          actionKey,
          label,
          callableName,
          payload,
          data: res?.data || {},
        },
      }));

      await loadStatus();
    } catch (err) {
      console.error("[SuperAdminFix246 owner action failed]", actionKey, err);
      setActionErrorByRoomId((prev) => ({
        ...prev,
        [room.roomId]: err?.message || String(err),
      }));
    } finally {
      setActionBusyKey("");
    }
  }

  function renderRoomActionsDrawer(room) {
    const sections = getOwnerActionSections(room);
    const roomBusy = actionBusyKey.startsWith(`${room.roomId}:`);
    const latestResult = actionResultByRoomId[room.roomId] || null;
    const latestError = actionErrorByRoomId[room.roomId] || "";

    return (
      <div className="ownerRoomActions">
        <div className="ownerActionWarning">
          Owner emergency actions can write room data. Use them when a room is stuck and prefer shadow tests before real writes.
        </div>

        {!sections.length && (
          <div className="ownerActionMuted">No owner actions are available for this room type yet.</div>
        )}

        {sections.map((section) => (
          <section className="ownerActionSection" key={section.title}>
            <h3 className="ownerActionSectionTitle">{section.title}</h3>
            <div className="ownerActionGrid">
              {section.actions.map((action) => {
                const busyKey = `${room.roomId}:${action.key}`;
                const isBusy = actionBusyKey === busyKey;
                const disabled = roomBusy || Boolean(action.disabled);
                const className = [
                  "ownerActionBtn",
                  action.className ? `ownerActionBtn--${action.className}` : "",
                ].filter(Boolean).join(" ");

                return (
                  <button
                    type="button"
                    className={className}
                    key={action.key}
                    disabled={disabled}
                    title={action.disabledReason || action.label}
                    onClick={() =>
                      runOwnerRoomAction(
                        room,
                        action.key,
                        action.label,
                        action.callableName,
                        action.payloadBuilder,
                        {
                          confirm: Boolean(action.confirm),
                          confirmMessage: action.confirmMessage,
                        }
                      )
                    }
                  >
                    {isBusy ? "Running..." : action.label}
                    {action.disabledReason ? (
                      <span className="ownerActionMuted">{action.disabledReason}</span>
                    ) : null}
                    {action.description ? (
                      <span className="ownerActionMuted">{action.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        {latestError && <div className="ownerActionError">Action failed: {latestError}</div>}
        {renderActionResult(latestResult)}
      </div>
    );
  }

  return (
    <main className="ownerStatusPage">
      <section className="ownerHero">
        <div>
          <p className="ownerEyebrow"></p>
          <h1>Owner-only control center</h1>
          <p className="ownerIntro">
             
          </p>
        </div>
        <button className="ownerRefreshBtn" type="button" onClick={loadStatus} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh status"}
        </button>
      </section>

      {error && (
        <div className="ownerError" role="alert">
          {error}
        </div>
      )}

      {loading && !status && <div className="ownerLoading">Loading owner status...</div>}

      {status && (
        <>
          <section className="ownerSummaryGrid" aria-label="Owner status summary">
            <div className="ownerSummaryCard">
              <span>Rooms scanned</span>
              <strong>{status.scannedRoomCount ?? 0}</strong>
            </div>
            <div className="ownerSummaryCard">
              <span>Competition groups</span>
              <strong>{status.competitionGroupCount ?? groups.length}</strong>
            </div>
            <div className="ownerSummaryCard">
              <span>Total users</span>
              <strong>{status?.authUserCount ?? "—"}</strong>
            </div>
            <div className="ownerSummaryCard">
              <span>Live users</span>
              <strong>{status?.liveUserCount ?? "—"}</strong>
              <small>Last 3 min</small>
            </div>
            <div className="ownerSummaryCard">
              <span>Due now</span>
              <strong>{status.totals?.dueNowCount ?? 0}</strong>
            </div>
            <div className="ownerSummaryCard">
              <span>Missing queue</span>
              <strong>{status.totals?.actionableMissingQueueCount ?? status.totals?.missingQueueCount ?? 0}</strong>
            </div>
            <div className="ownerSummaryCard">
              <span>Ignored missing queue</span>
              <strong>{status.totals?.ignoredMissingQueueCount ?? 0}</strong>
            </div>
            <div className="ownerSummaryCard">
              <span>Last read</span>
              <strong>{formatWhen(status.nowMs)}</strong>
            </div>
          </section>

          <section className="ownerGroups" aria-label="Competition status groups">
            {groups.map((group) => {
              const groupDisplayStatus = group.groupDisplayStatus || group.groupStatusPill || {
                key: "unknown",
                label: "UNKNOWN",
                className: "idle",
              };

              return (
              <article className="ownerGroupCard" key={group.groupKey}>
                <header className="ownerGroupHeader">
                  <div className="ownerGroupTitleRow">
                    {group.logo ? <img src={group.logo} alt="" className="ownerGroupLogo" /> : null}
                    <div>
                      <h2>{group.label}</h2>
                      <p>
                        League {group.league || "unknown"} / Season {group.season || "unknown"}
                        {group.country ? ` / ${group.country}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="ownerGroupBadges">
                    <div className="ownerStatusLine">
                      <span>Status:</span>
                      <span className={pillClass(groupDisplayStatus)}>
                        {groupDisplayStatus.label || "UNKNOWN"}
                      </span>
                    </div>
                    <div className="ownerStatusLine">
                      <span className={pillClass(group.groupHealth, "ownerHealth")}>
                        Health: {group.groupHealth?.label || "OK"}
                      </span>
                    </div>
                    <span className="ownerLastUpdate">Last update at: {formatWhen(group.latestUpdatedAtMs)}</span>
                    <span className="ownerGroupRoomCount">{group.roomCount} rooms</span>
                  </div>
                </header>

                <div className="ownerGroupMetrics">
                  <span>Scheduled: <b>{group.scheduledCount}</b></span>
                  <span>Live: <b>{group.liveCount}</b></span>
                  <span>Resolving: <b>{group.resolvingCount}</b></span>
                  <span>Complete: <b>{group.completeCount}</b></span>
                  <span>Done: <b>{group.doneCount}</b></span>
                  <span>Due now: <b>{group.dueNowCount}</b></span>
                  <span>Future queue: <b>{group.futureQueueCount}</b></span>
                  <span>Missing queue: <b>{group.actionableMissingQueueCount ?? group.missingQueueCount}</b></span>
                  <span>Ignored missing: <b>{group.ignoredMissingQueueCount ?? 0}</b></span>
                </div>

                <div className="ownerGroupMeta">
                  <span>Phase: {formatCountMap(group.countsByPhaseLabel) || "none"}</span>
                  <span>Status: {formatCountMap(group.countsByWeekStatus) || "none"}</span>
                  <span>Engine: {formatCountMap(group.countsByEngineType) || "none"}</span>
                  <span>Pipeline: {formatCountMap(group.countsByPipelineMode) || "none"}</span>
                  <span>Next poll: {formatWhen(group.soonestNextPollAtMs)}</span>
                  <span>Next kickoff: {formatWhen(group.soonestNextKickoffMs)}</span>
                </div>

                <div className="ownerRoomList">
                  {(group.rooms || []).map((room) => {
                    const displayStatus = getDisplayStatus(room);
                    const isOpen = openRoomId === room.roomId;

                    return (
                    <div
                      className={`ownerRoomRow ${room.isIgnoredRoom ? "ownerRoomRow--ignored" : ""}`}
                      key={room.roomId}
                    >
                      <div className="ownerRoomMain">
                        <strong>{room.name}</strong>
                        <span>{room.code || room.roomId}</span>
                        <button
                          type="button"
                          className="ownerRoomManageBtn"
                          onClick={() => setOpenRoomId((prev) => (prev === room.roomId ? null : room.roomId))}
                          aria-expanded={isOpen}
                        >
                          {isOpen ? "Close" : "Manage"}
                        </button>
                      </div>
                      <div className="ownerRoomDetails">
                        <span className={pillClass(displayStatus)}>
                          {displayStatus.label}
                        </span>
                        <span className="ownerLastUpdate">
                          Last update: {formatWhen(room.lastUpdateAtMs || room.updatedAtMs)}
                        </span>
                        {room.roomHealth && (
                          <span className={pillClass(room.roomHealth, "ownerHealth")}>
                            {room.roomHealth.label}
                          </span>
                        )}
                        <span>{room.phaseLabel || "No phase"}</span>
                        <span>{room.engineType || "No engine"}</span>
                        <span>{room.pipelineMode || "No pipeline"}</span>
                        {room.draftStatusLabel && (
                          <span className={`ownerPill ownerPill--${room.draftStatusTone || "muted"}`}>
                            {room.draftStatusLabel}
                          </span>
                        )}
                        {room.progressLabel && (
                          <span className={`ownerPill ownerPill--${room.progressTone || "muted"}`}>
                            {room.progressLabel}
                          </span>
                        )}
                        {room.progressDetail && (
                          <span className="ownerPill ownerPill--muted">
                            {room.progressDetail}
                          </span>
                        )}
                        <span>Managers: {room.managerCountLabel || `${room.managerCount ?? 0}/${room.managerLimit ?? 10}`}</span>
                        <span>Players: {room.playerCount || 0}</span>
                        <span>From: {room.playersFrom || "unknown"}</span>
                        <span>Queue: {room.queueState || (room.queue?.dueNow ? "due" : room.queue?.nextPollAtMs ? "future" : room.queueMissing ? "missing" : "none")}</span>
                        <span>Next poll: {formatWhen(room.queue?.nextPollAtMs || room.nextPollAtMs)}</span>
                        <span>Next kickoff: {formatWhen(room.nextKickoffMs)}</span>
                      </div>
                      {room.managerCountWarning ? (
                        <div className="ownerRoomWarning">
                          Managers warning: {room.managerCountWarning}
                        </div>
                      ) : null}
                      {isOpen && renderRoomActionsDrawer(room)}
                    </div>
                    );
                  })}
                </div>
              </article>
              );
            })}
          </section>
        </>
      )}
    </main>
  );
}
