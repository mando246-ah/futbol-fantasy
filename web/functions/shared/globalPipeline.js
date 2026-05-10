"use strict";

const GLOBAL_PIPELINE_VERSION = 1;
const VALID_GLOBAL_PIPELINE_MODES = ["legacy", "shadow", "global"];

function normalizeGlobalPipelineMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  return VALID_GLOBAL_PIPELINE_MODES.includes(normalized) ? normalized : "legacy";
}

function buildDefaultGlobalPipeline(mode = "legacy") {
  const normalizedMode = normalizeGlobalPipelineMode(mode);

  const pipeline = {
    playerPool: false,
    liveFixtureCache: false,
    roomAggregator: false,
    mode: normalizedMode,
    version: GLOBAL_PIPELINE_VERSION,
  };

  if (normalizedMode === "shadow") {
    pipeline.playerPool = true;
    pipeline.liveFixtureCache = true;
  } else if (normalizedMode === "global") {
    pipeline.playerPool = true;
    pipeline.liveFixtureCache = true;
    pipeline.roomAggregator = true;
  }

  return pipeline;
}

function getNormalizedGlobalPipeline(room = {}) {
  const raw = room?.globalPipeline && typeof room.globalPipeline === "object"
    ? room.globalPipeline
    : {};

  const defaults = buildDefaultGlobalPipeline(raw.mode);
  const version = Number(raw.version);

  return {
    ...defaults,
    playerPool: typeof raw.playerPool === "boolean" ? raw.playerPool : defaults.playerPool,
    liveFixtureCache:
      typeof raw.liveFixtureCache === "boolean"
        ? raw.liveFixtureCache
        : defaults.liveFixtureCache,
    roomAggregator:
      typeof raw.roomAggregator === "boolean"
        ? raw.roomAggregator
        : defaults.roomAggregator,
    mode: defaults.mode,
    version:
      Number.isFinite(version) && version > 0
        ? version
        : GLOBAL_PIPELINE_VERSION,
  };
}

function getGlobalPipelineMode(room = {}) {
  return getNormalizedGlobalPipeline(room).mode;
}

function isGlobalPlayerPoolEnabled(room = {}) {
  return getNormalizedGlobalPipeline(room).playerPool;
}

function isGlobalLiveFixtureCacheEnabled(room = {}) {
  return getNormalizedGlobalPipeline(room).liveFixtureCache;
}

function isGlobalRoomAggregatorEnabled(room = {}) {
  return getNormalizedGlobalPipeline(room).roomAggregator;
}

module.exports = {
  GLOBAL_PIPELINE_VERSION,
  VALID_GLOBAL_PIPELINE_MODES,
  buildDefaultGlobalPipeline,
  getGlobalPipelineMode,
  getNormalizedGlobalPipeline,
  isGlobalLiveFixtureCacheEnabled,
  isGlobalPlayerPoolEnabled,
  isGlobalRoomAggregatorEnabled,
  normalizeGlobalPipelineMode,
};
