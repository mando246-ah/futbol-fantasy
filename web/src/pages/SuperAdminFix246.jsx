import React, { useEffect, useMemo, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { auth, db, functions } from "../firebase";
import "./SuperAdminFix246.css";

const OWNER_UIDS = new Set(["WspA06q2KlQr7KUq2PP58FMyIJk2"]);

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

function formatDurationMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "0m";

  const totalMinutes = Math.ceil(n / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
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
  const normalizedWorldCupPhase = worldCupPhase.toLowerCase();
  const competitionKey = String(room.competitionKey || "").trim().toLowerCase();
  const competitionType = String(room.competitionType || "").trim().toLowerCase();
  const seasonKey = String(room.seasonKey || "").trim().toLowerCase();
  const pipelineMode = String(room.pipelineMode || "").trim().toLowerCase();
  const isWorldCupGroupRoom =
    room.engineType === "worldCupDaily" ||
    room.phaseLabel === "WorldCupGroup" ||
    normalizedWorldCupPhase === "group" ||
    worldCupPhase === "WorldCupGroup";
  const isWorldCupKnockoutRoom =
    normalizedWorldCupPhase === "knockout" ||
    (room.engineType === "cupEngine" && competitionKey === "worldcup") ||
    (room.engineType === "cupEngine" && seasonKey.startsWith("worldcup-"));

  const isWorldCupRoom =
    isWorldCupGroupRoom ||
    isWorldCupKnockoutRoom ||
    competitionKey === "worldcup" ||
    competitionType === "worldcup" ||
    seasonKey.startsWith("worldcup-");
  const isCupRoom = room.phaseLabel === "Cup" && !isWorldCupGroupRoom;
  const isGlobalCupRoom =
    isCupRoom && (pipelineMode === "global" || isWorldCupKnockoutRoom);
  const isRegularRoom = !isCupRoom && !isWorldCupGroupRoom;

  return {
    isWorldCupGroupRoom,
    isWorldCupKnockoutRoom,
    isWorldCupRoom,
    isCupRoom,
    isGlobalCupRoom,
    isRegularRoom,
  };
}

function groupLooksWorldCupGroup(group = {}) {
  if (group.countsByEngineType?.worldCupDaily) return true;
  if (group.countsByPhaseLabel?.WorldCupGroup) return true;
  if (group.countsByWorldCupPhase?.group || group.countsByWorldCupPhase?.WorldCupGroup) {
    return true;
  }

  return (group.rooms || []).some((room) => getRoomTypeFlags(room).isWorldCupGroupRoom);
}

function groupActionKey(group = {}) {
  return String(
    group.groupKey ||
      group.seasonKey ||
      `${group.competitionKey || "competition"}:${group.league || "league"}:${group.season || "season"}`
  );
}

function buildWorldCupGroupRepairPayload(group = {}, dryRun = true) {
  const visibleRoomIds = (group.rooms || [])
    .map((room) => room.roomId)
    .filter(Boolean);
  const includeRoomIds =
    visibleRoomIds.length > 0 &&
    Number(visibleRoomIds.length) === Number(group.roomCount || visibleRoomIds.length);

  const payload = {
    competitionKey: group.competitionKey || "",
    competitionType: group.competitionType || "",
    league: group.league || "",
    season: group.season || "",
    seasonKey: group.seasonKey || "",
    ...(includeRoomIds ? { roomIds: visibleRoomIds } : {}),
    dryRun,
    forceRefresh: !dryRun,
  };

  console.log("[SuperAdminFix246 World Cup group repair payload]", {
    groupKey: group.groupKey || "",
    groupRoomCount: group.roomCount || 0,
    visibleRoomIdCount: visibleRoomIds.length,
    includeRoomIds,
    payload,
  });

  return payload;
}

function getWorldCupPlayerRepairActions() {
  return [
    {
      key: "dryRunMissingWorldCupPlayers",
      label: "Dry Run Missing World Cup Players",
      callableName: "repairWorldCupRoomMissingPlayers",
      payloadBuilder: (r) => ({
        roomId: r.roomId,
        forceApiRefresh: true,
        dryRun: true,
      }),
      description:
        "Compares the latest World Cup player pool with this room and previews missing players. Makes no writes.",
      className: "shadow",
    },
    {
      key: "addMissingWorldCupPlayers",
      label: "Add Missing World Cup Players",
      callableName: "repairWorldCupRoomMissingPlayers",
      payloadBuilder: (r) => ({
        roomId: r.roomId,
        forceApiRefresh: true,
        dryRun: false,
      }),
      confirm: true,
      confirmMessage:
        "This adds only missing World Cup player documents. It does not change picks, drafted ownership, or existing players. Continue?",
      description:
        "Adds only players missing from rooms/{roomId}/players so they can appear as undrafted Transfer Market players.",
      className: "apply",
    },
  ];
}

function getWorldCupGlobalPlayerPoolSection() {
  const payloadForRoom = (room, dryRun) => ({
    seasonKey: room.seasonKey || `worldcup-${room.season || ""}`,
    league: room.league ?? room.competition?.league,
    season: room.season ?? room.competition?.season,
    timezone:
      room.timezone ||
      room.competition?.timezone ||
      "America/Los_Angeles",
    worldCupPhase: room.worldCupPhase || "group",
    forceRefresh: true,
    dryRun,
  });

  return {
    title: "Global World Cup Player Pool",
    actions: [
      {
        key: "dryRunRefreshWorldCupGlobalPlayerPool",
        label: "Dry Run Refresh World Cup Global Player Pool",
        callableName: "refreshWorldCupGlobalPlayerPool",
        payloadBuilder: (room) => payloadForRoom(room, true),
        description:
          "Checks the latest API player pool against globalData for future rooms. Makes no writes and does not modify this room or any drafted picks.",
        className: "shadow",
      },
      {
        key: "refreshWorldCupGlobalPlayerPool",
        label: "Refresh World Cup Global Player Pool",
        callableName: "refreshWorldCupGlobalPlayerPool",
        payloadBuilder: (room) => payloadForRoom(room, false),
        confirm: true,
        confirmMessage:
          "This merges the latest World Cup players into the global pool used by future rooms. It does not modify existing rooms or drafted picks. Continue?",
        description:
          "Refreshes and merges globalData only, preventing future World Cup rooms from using a stale pool. Existing rooms remain unchanged.",
        className: "apply",
      },
    ],
  };
}

function getOwnerActionSections(room = {}) {
  const currentWeekIndex = getCurrentWeekIndex(room);
  const missingWeek = !currentWeekIndex;
  const {
    isWorldCupGroupRoom,
    isWorldCupRoom,
    isCupRoom,
    isGlobalCupRoom,
    isRegularRoom,
  } =
    getRoomTypeFlags(room);

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
          ...getWorldCupPlayerRepairActions(),
        ],
      },
      getWorldCupGlobalPlayerPoolSection(),
    ];
  }

  if (isCupRoom) {
    return [
      {
        title: "Quick Fixes",
        actions: [
          ...(isGlobalCupRoom
            ? [
                {
                  key: "cupGlobalEngineNow",
                  label: "Force Global Cup Engine Now",
                  callableName: "ownerRunCupGlobalEngineNow",
                  payloadBuilder: (r) => ({ roomId: r.roomId }),
                  confirm: true,
                  confirmMessage:
                    "This refreshes only active/due Cup fixtures through the shared global cache and writes cup/current projections. Continue?",
                  description:
                    "Default for World Cup Knockout/global Cup rooms. Does not call legacy runCupEngine.",
                  className: "apply",
                },
                {
                  key: "repairCupGlobalDuplicateWindow",
                  label: "Repair Duplicate Global Cup Window",
                  callableName: "ownerRepairCupGlobalDuplicateCurrentWindow",
                  payloadBuilder: (r) => ({
                    roomId: r.roomId,
                    confirm: "REPAIR_CUP_GLOBAL_DUPLICATE_WINDOW",
                  }),
                  confirm: true,
                  confirmMessage:
                    "This backs up cup/current, then repairs duplicate current-window global projection/display fields. It does not call API-Football. Continue?",
                  description:
                    "Use only if a global Cup window appears double-counted after legacy/global overlap.",
                  className: "danger",
                },
              ]
            : [
                {
                  key: "cupEngineNow",
                  label: "Force Legacy Cup Engine Now",
                  callableName: "ownerRunCupEngineNow",
                  payloadBuilder: (r) => ({ roomId: r.roomId }),
                  confirm: true,
                  confirmMessage:
                    "DANGER: This runs the legacy Cup engine and can rewrite Cup current state/results. Do not use for global or World Cup Knockout rooms. Continue?",
                  description:
                    "Legacy Cup rooms only. Global Cup rooms should use Force Global Cup Engine Now.",
                  className: "danger",
                },
              ]),
          ...(isWorldCupRoom ? getWorldCupPlayerRepairActions() : []),
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
      ...(isWorldCupRoom ? [getWorldCupGlobalPlayerPoolSection()] : []),
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
  if (
    key === "nextPollAtMs" ||
    key === "nextKickoffMs" ||
    key === "lastApiRefreshAtMs"
  ) {
    return `${value} (${formatWhen(value)})`;
  }
  if (key === "sampleMissingPlayers" && Array.isArray(value)) {
    return value
      .map((player) => player?.name || player?.id || "Unknown")
      .join(", ");
  }
  if (key === "teamFetchSummary" && Array.isArray(value)) {
    return `${value.length} team rows (full details logged to console)`;
  }
  if (Array.isArray(value)) {
    return value.some((item) => item && typeof item === "object")
      ? JSON.stringify(value)
      : value.join(", ");
  }
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
    "targetUid",
    "mode",
    "message",
    "error",
    "competitionKey",
    "competitionType",
    "league",
    "season",
    "seasonKey",
    "dryRun",
    "forceRefresh",
    "forceApiRefresh",
    "refreshed",
    "wasStale",
    "refreshReason",
    "refreshSkipped",
    "refreshSkippedReason",
    "lastApiRefreshAtMs",
    "staleMs",
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
    "fullWindowFixtureCount",
    "refreshFixtureCount",
    "refreshedFixtureCount",
    "refreshedStatusCount",
    "refreshedStatsCount",
    "refreshedCount",
    "checkedRoomCount",
    "eligibleRoomCount",
    "repairedRoomCount",
    "changedRoomCount",
    "changedDayCount",
    "daysFound",
    "daysEligible",
    "daysSkippedNoPriorResult",
    "changedUserCount",
    "totalPointDelta",
    "totalAbsPointDelta",
    "latestFetchedCount",
    "beforeCount",
    "afterCount",
    "existingRoomPlayerCount",
    "repairedRoomPlayerCount",
    "missingFixtureCount",
    "missingCount",
    "addedCount",
    "skippedExistingCount",
    "teamCount",
    "apiPlayerCount",
    "globalPlayerCount",
    "maxAbsDiff",
    "userCount",
    "standingsCount",
    "queueRepaired",
    "queueUpdated",
    "queueDeleted",
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
    "duplicateDetected",
    "affectedUids",
    "beforeTotalsByUid",
    "afterTotalsByUid",
    "baseTotalsByUid",
    "currentGlobalPointsByUid",
    "removedLegacyWindowPointsByUid",
    "creditedCurrentWindowFixtureIds",
    "shadowSource",
    "replaySource",
    "statusByFixtureId",
    "historyLabel",
    "historyFixtureCount",
    "noFixtureIdsReason",
    "skippedReason",
    "skippedDayIndexes",
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
    "repairRoomMatchDebug",
    "currentStarters",
    "currentBench",
    "ownedPlayerIds",
    "invalidCurrentIds",
    "removedInvalidPlayerIds",
    "addedNewPlayerIdsToBench",
    "nextStarters",
    "nextBench",
    "starterCount",
    "benchCount",
    "sampleMissingPlayers",
    "teamFetchSummary",
    "warnings",
    "errors",
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
        {Array.isArray(result?.roomSummaries) && (
          <span>
            <b>roomSummaries:</b> {result.roomSummaries.length} rooms, logged to console
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

function OwnerErrorCenter() {
  const [errors, setErrors] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [loadingErrors, setLoadingErrors] = useState(false);
  const [liveWatchOn, setLiveWatchOn] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [statusFilter, setStatusFilter] = useState("new");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");
  const [roomSearch, setRoomSearch] = useState("");
  const liveUnsubscribeRef = useRef(null);

  useEffect(() => {
    return () => {
      liveUnsubscribeRef.current?.();
      liveUnsubscribeRef.current = null;
    };
  }, []);

  function buildErrorsQuery() {
    return query(
      collection(db, "adminErrors"),
      orderBy("createdAtMs", "desc"),
      limit(50)
    );
  }

  function rowsFromSnapshot(snap) {
    return snap.docs.map((errorDoc) => ({
      id: errorDoc.id,
      ...(errorDoc.data() || {}),
    }));
  }

  async function loadErrors() {
    setLoadingErrors(true);
    setLoadError("");
    try {
      const snap = await getDocs(buildErrorsQuery());
      setErrors(rowsFromSnapshot(snap));
    } catch (error) {
      setLoadError(error?.message || "Could not load Admin Error Center.");
    } finally {
      setLoadingErrors(false);
    }
  }

  function stopLiveWatch() {
    liveUnsubscribeRef.current?.();
    liveUnsubscribeRef.current = null;
    setLiveWatchOn(false);
  }

  function startLiveWatch() {
    if (liveUnsubscribeRef.current) return;

    setLoadError("");
    setLiveWatchOn(true);
    liveUnsubscribeRef.current = onSnapshot(
      buildErrorsQuery(),
      (snap) => {
        setLoadError("");
        setErrors(rowsFromSnapshot(snap));
      },
      (error) => {
        liveUnsubscribeRef.current = null;
        setLiveWatchOn(false);
        setLoadError(error?.message || "Could not watch Admin Error Center.");
      }
    );
  }

  const areas = useMemo(
    () =>
      Array.from(
        new Set(errors.map((item) => String(item.area || "").trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b)),
    [errors]
  );

  const visibleErrors = useMemo(() => {
    const search = roomSearch.trim().toLowerCase();
    return errors
      .filter((item) => statusFilter === "all" || item.status === statusFilter)
      .filter((item) => sourceFilter === "all" || item.source === sourceFilter)
      .filter(
        (item) =>
          severityFilter === "all" || item.severity === severityFilter
      )
      .filter((item) => areaFilter === "all" || item.area === areaFilter)
      .filter(
        (item) =>
          !search || String(item.roomId || "").toLowerCase().includes(search)
      )
      .sort((a, b) => {
        const aNew = a.status === "new" ? 1 : 0;
        const bNew = b.status === "new" ? 1 : 0;
        return bNew - aNew || Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0);
      });
  }, [
    areaFilter,
    errors,
    roomSearch,
    severityFilter,
    sourceFilter,
    statusFilter,
  ]);

  async function markError(errorId, status) {
    const uid = auth.currentUser?.uid;
    if (!uid || !errorId) return;

    const nowMs = Date.now();
    const statusFields =
      status === "resolved"
        ? {
            resolvedAt: serverTimestamp(),
            resolvedAtMs: nowMs,
            resolvedByUid: uid,
          }
        : {
            ignoredAt: serverTimestamp(),
            ignoredAtMs: nowMs,
            ignoredByUid: uid,
          };
    const localStatusFields =
      status === "resolved"
        ? {
            resolvedAtMs: nowMs,
            resolvedByUid: uid,
          }
        : {
            ignoredAtMs: nowMs,
            ignoredByUid: uid,
          };

    setBusyId(errorId);
    setLoadError("");
    try {
      await updateDoc(doc(db, "adminErrors", errorId), {
        status,
        ...statusFields,
      });
      setErrors((current) =>
        current.map((item) =>
          item.id === errorId
            ? { ...item, status, ...localStatusFields }
            : item
        )
      );
    } catch (error) {
      setLoadError(error?.message || `Could not mark error ${status}.`);
    } finally {
      setBusyId("");
    }
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(String(value || ""));
    } catch (error) {
      setLoadError(error?.message || "Could not copy error details.");
    }
  }

  function errorDetails(item) {
    return JSON.stringify(
      {
        id: item.id,
        severity: item.severity,
        source: item.source,
        area: item.area,
        action: item.action,
        roomId: item.roomId,
        uid: item.uid,
        email: item.email,
        displayName: item.displayName,
        message: item.message,
        code: item.code,
        stack: item.stack,
        userMessage: item.userMessage,
        url: item.url,
        path: item.path,
        userAgent: item.userAgent,
        extra: item.extra,
        status: item.status,
        createdAtMs: item.createdAtMs,
      },
      null,
      2
    );
  }

  return (
    <section className="ownerErrorCenter" aria-labelledby="ownerErrorCenterTitle">
      <header className="ownerErrorCenterHeader">
        <div>
          <p className="ownerErrorCenterEyebrow">Production diagnostics</p>
          <h2 id="ownerErrorCenterTitle">Error Center</h2>
          <p>Latest 50 sanitized client reports. New errors are shown first.</p>
        </div>
        <div className="ownerErrorCenterControls">
          <span
            className={`ownerErrorMode ${
              liveWatchOn ? "ownerErrorMode--live" : ""
            }`}
          >
            {liveWatchOn ? "Live watch on" : "Manual mode"}
          </span>
          <span className="ownerErrorCenterCount">{visibleErrors.length} shown</span>
          <button
            type="button"
            className="ownerErrorControlBtn"
            disabled={loadingErrors}
            onClick={loadErrors}
          >
            {loadingErrors ? "Refreshing..." : "Refresh Errors"}
          </button>
          {liveWatchOn ? (
            <button
              type="button"
              className="ownerErrorControlBtn ownerErrorControlBtn--stop"
              onClick={stopLiveWatch}
            >
              Stop Live Watch
            </button>
          ) : (
            <button
              type="button"
              className="ownerErrorControlBtn"
              onClick={startLiveWatch}
            >
              Start Live Watch
            </button>
          )}
        </div>
      </header>

      <div className="ownerErrorFilters">
        <label>
          Status
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="new">New</option>
            <option value="resolved">Resolved</option>
            <option value="ignored">Ignored</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Source
          <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
            <option value="all">All</option>
            <option value="client">Client</option>
            <option value="server">Server</option>
          </select>
        </label>
        <label>
          Severity
          <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}>
            <option value="all">All</option>
            <option value="critical">Critical</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label>
          Area
          <select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}>
            <option value="all">All</option>
            {areas.map((area) => (
              <option value={area} key={area}>{area}</option>
            ))}
          </select>
        </label>
        <label>
          Room ID
          <input
            value={roomSearch}
            onChange={(event) => setRoomSearch(event.target.value)}
            placeholder="Search room"
          />
        </label>
      </div>

      {loadError ? <div className="ownerError">{loadError}</div> : null}

      <div className="ownerErrorList">
        {visibleErrors.map((item) => (
          <article className="ownerErrorCard" key={item.id}>
            <div className="ownerErrorCardTop">
              <div className="ownerErrorPills">
                <span className={`ownerErrorPill ownerErrorPill--${item.severity || "error"}`}>
                  {item.severity || "error"}
                </span>
                <span className="ownerErrorPill">{item.source || "client"}</span>
                <span className={`ownerErrorPill ownerErrorPill--status-${item.status || "new"}`}>
                  {item.status || "new"}
                </span>
              </div>
              <time>{formatWhen(item.createdAtMs)}</time>
            </div>

            <div className="ownerErrorCardGrid">
              <span><b>Area:</b> {item.area || "Unknown"}</span>
              <span><b>Action:</b> {item.action || "Unknown"}</span>
              <span><b>Room:</b> {item.roomId || "Not set"}</span>
              <span><b>User:</b> {item.displayName || item.email || item.uid || "Unknown"}</span>
            </div>

            <p className="ownerErrorTechnical">{item.message || "No technical message provided."}</p>
            {item.userMessage ? (
              <p className="ownerErrorUserMessage">
                <b>User saw:</b> {item.userMessage}
              </p>
            ) : null}

            <details className="ownerErrorDetails">
              <summary>Technical details</summary>
              <div className="ownerErrorDetailsGrid">
                <span><b>Code:</b> {item.code || "Not set"}</span>
                <span><b>UID:</b> {item.uid || "Not set"}</span>
                <span><b>Email:</b> {item.email || "Not set"}</span>
                <span><b>URL:</b> {item.url || item.path || "Not set"}</span>
              </div>
              {item.stack ? <pre>{item.stack}</pre> : null}
              {item.extra && Object.keys(item.extra).length ? (
                <pre>{JSON.stringify(item.extra, null, 2)}</pre>
              ) : null}
              {item.userAgent ? <p className="ownerErrorAgent">{item.userAgent}</p> : null}
            </details>

            <div className="ownerErrorActions">
              <button
                type="button"
                disabled={busyId === item.id || item.status === "resolved"}
                onClick={() => markError(item.id, "resolved")}
              >
                Mark Resolved
              </button>
              <button
                type="button"
                disabled={busyId === item.id || item.status === "ignored"}
                onClick={() => markError(item.id, "ignored")}
              >
                Mark Ignored
              </button>
              <button
                type="button"
                disabled={!item.roomId}
                onClick={() => copyText(item.roomId)}
              >
                Copy Room ID
              </button>
              <button type="button" onClick={() => copyText(errorDetails(item))}>
                Copy Error Details
              </button>
            </div>
          </article>
        ))}

        {!visibleErrors.length && !loadError ? (
          <div className="ownerErrorEmpty">No errors match these filters.</div>
        ) : null}
      </div>
    </section>
  );
}

export default function SuperAdminFix246() {
  const isOwner = Boolean(
    auth.currentUser?.uid && OWNER_UIDS.has(auth.currentUser.uid)
  );
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openRoomId, setOpenRoomId] = useState(null);
  const [actionBusyKey, setActionBusyKey] = useState("");
  const [actionResultByRoomId, setActionResultByRoomId] = useState({});
  const [actionErrorByRoomId, setActionErrorByRoomId] = useState({});
  const [groupActionBusyKey, setGroupActionBusyKey] = useState("");
  const [groupActionResultByKey, setGroupActionResultByKey] = useState({});
  const [groupActionErrorByKey, setGroupActionErrorByKey] = useState({});
  const [lineupRepairInputByRoomId, setLineupRepairInputByRoomId] = useState({});
  const [apiRuntimeBusy, setApiRuntimeBusy] = useState(false);

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
    if (isOwner) {
      loadStatus();
    } else {
      setLoading(false);
      setError("Owner only.");
    }
  }, [isOwner]);

  const groups = useMemo(() => status?.groups || [], [status]);

  async function runApiFootballSafeModeAction(enabled, options = {}) {
    const defaultReason = enabled
      ? "Emergency quota protection"
      : "Owner disabled API safe mode";
    const reason = window.prompt(
      enabled
        ? "Reason for enabling API-Football Safe Mode:"
        : "Reason for disabling API-Football Safe Mode:",
      defaultReason
    );

    if (reason === null) return;

    const clearCooldown = Boolean(options.clearCooldown);
    if (
      clearCooldown &&
      !window.confirm("Also clear the current API-Football cooldown?")
    ) {
      return;
    }

    setApiRuntimeBusy(true);
    setError("");

    try {
      const fn = httpsCallable(functions, "ownerSetApiFootballSafeMode");
      const payload = {
        enabled,
        reason: String(reason || defaultReason).trim(),
        ...(enabled ? { cooldownMinutes: 60 } : {}),
        ...(clearCooldown ? { clearCooldown: true } : {}),
      };
      const res = await fn(payload);
      const runtime = res?.data?.runtime || null;

      setStatus((prev) =>
        prev && runtime
          ? { ...prev, apiFootballRuntime: runtime }
          : prev
      );

      await loadStatus();
    } catch (err) {
      console.error("[SuperAdminFix246 API runtime action failed]", err);
      setError(err?.message || "Could not update API-Football Safe Mode.");
    } finally {
      setApiRuntimeBusy(false);
    }
  }

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

  async function runOwnerGroupRepairAction(group, dryRun) {
    const key = groupActionKey(group);
    const actionKey = dryRun ? "dryRunRepairPoints" : "applyRepairPoints";
    const label = dryRun ? "Dry Run Repair Points" : "Apply Repair Points";

    if (!dryRun) {
      const confirmed = window.confirm(
        "This will recalculate and overwrite results for this competition group using only each room's saved fixture IDs. Continue?"
      );
      if (!confirmed) return;
    }

    const busyKey = `${key}:${actionKey}`;
    setGroupActionBusyKey(busyKey);
    setGroupActionErrorByKey((prev) => ({ ...prev, [key]: "" }));
    let payload = null;

    try {
      payload = buildWorldCupGroupRepairPayload(group, dryRun);
      const fn = httpsCallable(functions, "ownerRepairCompetitionWorldCupGroupPoints");
      const res = await fn(payload);

      console.log("[SuperAdminFix246 group repair result]", actionKey, res.data);

      setGroupActionResultByKey((prev) => ({
        ...prev,
        [key]: {
          actionKey,
          label,
          callableName: "ownerRepairCompetitionWorldCupGroupPoints",
          payload,
          data: res?.data || {},
        },
      }));

      await loadStatus();
    } catch (err) {
      const details = err?.details || err?.customData?.details || null;
      console.error("[SuperAdminFix246 group repair failed]", actionKey, {
        error: err,
        details,
        payload,
      });
      setGroupActionErrorByKey((prev) => ({
        ...prev,
        [key]: err?.message || String(err),
      }));
      if (details) {
        setGroupActionResultByKey((prev) => ({
          ...prev,
          [key]: {
            actionKey,
            label,
            callableName: "ownerRepairCompetitionWorldCupGroupPoints",
            payload,
            data: {
              ok: false,
              error: err?.message || String(err),
              ...details,
            },
          },
        }));
      }
    } finally {
      setGroupActionBusyKey("");
    }
  }

  function updateLineupRepairInput(roomId, field, value) {
    setLineupRepairInputByRoomId((prev) => ({
      ...prev,
      [roomId]: {
        roomId: prev[roomId]?.roomId || roomId,
        targetUid: prev[roomId]?.targetUid || "",
        [field]: value,
      },
    }));
  }

  function renderRoomActionsDrawer(room) {
    const sections = getOwnerActionSections(room);
    const roomBusy = actionBusyKey.startsWith(`${room.roomId}:`);
    const latestResult = actionResultByRoomId[room.roomId] || null;
    const latestError = actionErrorByRoomId[room.roomId] || "";
    const lineupRepairInput = lineupRepairInputByRoomId[room.roomId] || {
      roomId: room.roomId,
      targetUid: "",
    };
    const lineupRepairDisabled =
      roomBusy ||
      !String(lineupRepairInput.roomId || "").trim() ||
      !String(lineupRepairInput.targetUid || "").trim();

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

        <section className="ownerActionSection">
          <h3 className="ownerActionSectionTitle">Repair User Lineup From Picks</h3>
          <div className="ownerLineupRepairFields">
            <label>
              <span>Room ID</span>
              <input
                type="text"
                value={lineupRepairInput.roomId}
                onChange={(event) =>
                  updateLineupRepairInput(
                    room.roomId,
                    "roomId",
                    event.target.value
                  )
                }
                placeholder="Room ID"
              />
            </label>
            <label>
              <span>Target UID</span>
              <input
                type="text"
                value={lineupRepairInput.targetUid}
                onChange={(event) =>
                  updateLineupRepairInput(
                    room.roomId,
                    "targetUid",
                    event.target.value
                  )
                }
                placeholder="Firebase Auth UID"
              />
            </label>
          </div>
          <div className="ownerActionGrid">
            <button
              type="button"
              className="ownerActionBtn ownerActionBtn--shadow"
              disabled={lineupRepairDisabled}
              onClick={() =>
                runOwnerRoomAction(
                  room,
                  "dryRunLineupRepair",
                  "Dry Run Lineup Repair",
                  "repairUserLineupFromPicks",
                  () => ({
                    roomId: String(lineupRepairInput.roomId || "").trim(),
                    targetUid: String(lineupRepairInput.targetUid || "").trim(),
                    dryRun: true,
                  })
                )
              }
            >
              {actionBusyKey === `${room.roomId}:dryRunLineupRepair`
                ? "Running..."
                : "Dry Run Lineup Repair"}
            </button>
            <button
              type="button"
              className="ownerActionBtn ownerActionBtn--danger"
              disabled={lineupRepairDisabled}
              onClick={() =>
                runOwnerRoomAction(
                  room,
                  "applyLineupRepair",
                  "Apply Lineup Repair",
                  "repairUserLineupFromPicks",
                  () => ({
                    roomId: String(lineupRepairInput.roomId || "").trim(),
                    targetUid: String(lineupRepairInput.targetUid || "").trim(),
                    dryRun: false,
                  }),
                  {
                    confirm: true,
                    confirmMessage:
                      "This will rewrite the target user's lineup from their current picks. Continue?",
                  }
                )
              }
            >
              {actionBusyKey === `${room.roomId}:applyLineupRepair`
                ? "Running..."
                : "Apply Lineup Repair"}
            </button>
          </div>
          <div className="ownerActionMuted">
            Dry run first. The repair never changes picks or player ownership.
          </div>
        </section>

        {latestError && <div className="ownerActionError">Action failed: {latestError}</div>}
        {renderActionResult(latestResult)}
      </div>
    );
  }

  if (!isOwner) {
    return (
      <main className="ownerStatusPage">
        <div className="ownerError" role="alert">Owner only.</div>
      </main>
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

      <OwnerErrorCenter />

      {status && (
        <>
          {(() => {
            const apiRuntime = status?.apiFootballRuntime || {};
            const apiBlocked = Boolean(apiRuntime.blocked);
            const cooldownActive = Boolean(apiRuntime.cooldownActive);
            const safeModeActive = Boolean(apiRuntime.safeMode);
            const cooldownUntilMs = Number(apiRuntime.cooldownUntilMs || 0);

            return (
              <section
                className={`ownerApiRuntime ${
                  apiBlocked ? "ownerApiRuntime--blocked" : ""
                }`}
                aria-label="API-Football runtime controls"
              >
                <div>
                  <p className="ownerEyebrow">Emergency API guard</p>
                  <h2>API-Football Safe Mode</h2>
                  <p>
                    Safe Mode freezes API-Football updates but protects quota.
                    Normal cached room data, lineups, drafts, and standings still load.
                  </p>
                  <div className="ownerApiRuntimeMeta">
                    <span>
                      Status: <b>{apiBlocked ? "Guard active" : "Normal"}</b>
                    </span>
                    <span>
                      Safe mode: <b>{safeModeActive ? "On" : "Off"}</b>
                    </span>
                    <span>
                      Cooldown:{" "}
                      <b>
                        {cooldownActive
                          ? `${formatDurationMs(apiRuntime.cooldownRemainingMs)} remaining`
                          : "Inactive"}
                      </b>
                    </span>
                    {cooldownUntilMs > 0 ? (
                      <span>Cooldown until: <b>{formatWhen(cooldownUntilMs)}</b></span>
                    ) : null}
                  </div>
                  {apiRuntime.safeModeReason ? (
                    <small>Reason: {apiRuntime.safeModeReason}</small>
                  ) : null}
                  {apiRuntime.cooldownReason ? (
                    <small>Cooldown reason: {apiRuntime.cooldownReason}</small>
                  ) : null}
                </div>

                <div className="ownerApiRuntimeActions">
                  <button
                    type="button"
                    className="ownerActionBtn ownerActionBtn--danger"
                    disabled={apiRuntimeBusy}
                    onClick={() => runApiFootballSafeModeAction(true)}
                  >
                    {apiRuntimeBusy ? "Updating..." : "Enable API Safe Mode"}
                  </button>
                  <button
                    type="button"
                    className="ownerActionBtn ownerActionBtn--shadow"
                    disabled={apiRuntimeBusy || !safeModeActive}
                    onClick={() => runApiFootballSafeModeAction(false)}
                  >
                    Disable Safe Mode
                  </button>
                  <button
                    type="button"
                    className="ownerActionBtn"
                    disabled={apiRuntimeBusy || (!safeModeActive && !cooldownActive)}
                    onClick={() =>
                      runApiFootballSafeModeAction(false, { clearCooldown: true })
                    }
                  >
                    Disable & Clear Cooldown
                  </button>
                </div>
              </section>
            );
          })()}

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
              const repairableWorldCupGroup = groupLooksWorldCupGroup(group);
              const currentGroupActionKey = groupActionKey(group);
              const groupBusy = groupActionBusyKey.startsWith(`${currentGroupActionKey}:`);
              const dryRunBusy =
                groupActionBusyKey === `${currentGroupActionKey}:dryRunRepairPoints`;
              const applyBusy =
                groupActionBusyKey === `${currentGroupActionKey}:applyRepairPoints`;
              const latestGroupResult =
                groupActionResultByKey[currentGroupActionKey] || null;
              const latestGroupError =
                groupActionErrorByKey[currentGroupActionKey] || "";

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

                {repairableWorldCupGroup ? (
                  <div className="ownerGroupActions">
                    <div className="ownerGroupActionCopy">
                      <strong>World Cup Group points repair</strong>
                      <span>
                        Recalculates this competition group using only each room's saved day fixture IDs.
                      </span>
                    </div>
                    <div className="ownerActionGrid">
                      <button
                        type="button"
                        className="ownerActionBtn ownerActionBtn--shadow"
                        disabled={groupBusy}
                        onClick={() => runOwnerGroupRepairAction(group, true)}
                      >
                        {dryRunBusy ? "Running..." : "Dry Run Repair Points"}
                        <span className="ownerActionMuted">
                          Preview score diffs and refresh shared cache.
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ownerActionBtn ownerActionBtn--apply"
                        disabled={groupBusy}
                        onClick={() => runOwnerGroupRepairAction(group, false)}
                      >
                        {applyBusy ? "Running..." : "Apply Repair Points"}
                        <span className="ownerActionMuted">
                          Overwrite day results, standings, and completed final results.
                        </span>
                      </button>
                    </div>
                    {latestGroupError ? (
                      <div className="ownerActionError">
                        Group repair failed: {latestGroupError}
                      </div>
                    ) : null}
                    {renderActionResult(latestGroupResult)}
                  </div>
                ) : null}

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
                    const roomFlags = getRoomTypeFlags(room);
                    const shouldRecommendGlobalCupAction =
                      roomFlags.isGlobalCupRoom &&
                      ["stale", "problem", "due"].includes(
                        String(displayStatus?.key || "").toLowerCase()
                      );

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
                      {shouldRecommendGlobalCupAction ? (
                        <div className="ownerRoomWarning">
                          Recommended action: use Force Global Cup Engine Now.
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
