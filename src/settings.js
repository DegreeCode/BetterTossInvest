const SETTINGS_KEY = "better-toss-invest-settings-v1-release";
if (window.__TOSS_INTEGRATED__) {
  console.warn("[Toss Integrated] 다른 통합판이 이미 실행 중이라 현재 스크립트를 중단합니다.");
  return;
}
const DEFAULTS = {
  modules: {
    bidAsk: true,
    midQuote: true,
    hollowCandles: true,
    indexChartUnlock: true,
    enableSec: false,
    enableTick: false,
    noWait: true,
  },
  bidAsk: {
    maxCachedSymbols: 1_000,
  },
  midQuote: {
    insertIntoOrderBook: false,
    alwaysShow: false,
    compactRows: false,
    showVolume: true,
    hideSideInfo: false,
  },
  enableSec: {
    presets: [1, 3, 5, 10, 15, 30, 60],
    maxTicksPerSymbol: 50_000,
    maxSymbolBuckets: 6,
  },
  enableTick: {
    presets: [10, 30, 100, 300, 1_000],
  },
  noWait: {
    intervalMs: 16,
  },
};
const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);
function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}
function mergeKnownSettings(target, source) {
  if (!isPlainObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) continue;
    if (isPlainObject(target[key])) {
      mergeKnownSettings(target[key], value);
    } else if (typeof target[key] !== "boolean" || typeof value === "boolean") {
      target[key] = value;
    }
  }
}

function normalizeSettings(value) {
  const settings = structuredClone(DEFAULTS);
  mergeKnownSettings(settings, value);
  for (const key of Object.keys(settings.modules)) settings.modules[key] = !!settings.modules[key];
  for (const key of Object.keys(DEFAULTS.midQuote)) settings.midQuote[key] = !!settings.midQuote[key];
  settings.bidAsk.maxCachedSymbols = clampNumber(settings.bidAsk.maxCachedSymbols, 1_000, 10, 10_000);
  settings.enableSec.maxTicksPerSymbol = clampNumber(settings.enableSec.maxTicksPerSymbol, 50_000, 1_000, 200_000);
  settings.enableSec.maxSymbolBuckets = clampNumber(settings.enableSec.maxSymbolBuckets, 6, 1, 30);
  const presets = Array.isArray(settings.enableSec.presets) ? settings.enableSec.presets : [];
  settings.enableSec.presets = [
    ...new Set(presets.map((item) => clampNumber(item, 0, 1, 60)).filter((item) => item >= 1 && item <= 60)),
  ].sort((a, b) => a - b);
  if (0 === settings.enableSec.presets.length) settings.enableSec.presets = [...DEFAULTS.enableSec.presets];
  const tickPresets = Array.isArray(settings.enableTick.presets) ? settings.enableTick.presets : [];
  settings.enableTick.presets = [...new Set(tickPresets.map(Number).filter((item) =>
    Number.isInteger(item) && item >= 1 && item <= Math.min(10_000, settings.enableSec.maxTicksPerSymbol),
  ))].sort((a, b) => a - b);
  if (settings.enableTick.presets.length === 0) settings.enableTick.presets = [...DEFAULTS.enableTick.presets];
  settings.noWait.intervalMs = clampNumber(settings.noWait.intervalMs, 16, 8, 1_000);
  return settings;
}
function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null"));
  } catch {
    return normalizeSettings(null);
  }
}
const settings = loadSettings();
