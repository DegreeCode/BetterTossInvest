function createLocalResolutions() {
  const secondsEnabled = settings.modules.enableSec;
  const ticksEnabled = settings.modules.enableTick;
  const SECOND_PRESETS = settings.enableSec.presets;
  const MAX_TICKS_PER_SYMBOL = settings.enableSec.maxTicksPerSymbol;
  const TICK_RESOLUTIONS = settings.enableTick.presets.map((count) => `${count}T`);
  const SECOND_MULTIPLIERS = Array.from({ length: 60 }, (_, index) => String(index + 1));
  const SECOND_RESOLUTIONS = SECOND_MULTIPLIERS.map((value) => `${value}S`);

  let cachedInstrumentPathname = null;
  let cachedInstrumentCode = null;
  function normalizeInstrumentCode(value) {
    let code = String(value ?? "")
      .trim()
      .split(/[?#]/)[0];
    try {
      code = decodeURIComponent(code);
    } catch {
      // Keep the original code when a third-party symbol is not URI-encoded.
    }
    code = code.replace(/^INDEX:/i, "");
    // TradingView uppercases chart.symbol(), including the futures c1 suffix.
    const future = code.match(/^RFU\.(NQ|ES|RTY)C1$/i);
    if (future) return `RFU.${future[1].toUpperCase()}c1`;
    return /^exchange-rate$/i.test(code) ? "EXCHANGE_RATE" : code;
  }
  function currentInstrumentCode() {
    if (cachedInstrumentPathname === location.pathname) return cachedInstrumentCode;
    cachedInstrumentPathname = location.pathname;
    const stockMatch = location.pathname.match(/\/stocks\/([^/]+)/);
    const indexMatch = location.pathname.match(/\/indices\/([^/?#]+)/);
    const match = stockMatch ?? indexMatch;
    cachedInstrumentCode = match ? normalizeInstrumentCode(match[1]) : null;
    return cachedInstrumentCode;
  }

  function isSecondsResolution(resolution) {
    const match = String(resolution).match(/^(\d+)S$/);
    if (!match) return null;
    const seconds = Number(match[1]);
    return Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : null;
  }
  function isTickResolution(resolution) {
    const match = String(resolution).match(/^(\d+)T$/);
    const count = match ? Number(match[1]) : NaN;
    return Number.isInteger(count) && count >= 1 && count <= Math.min(10_000, MAX_TICKS_PER_SYMBOL) ? count : null;
  }

  function isFuturesInstrument(code) {
    // Toss exposes these futures through /indices and resolves their type as
    // "index", but their socket messages carry volume and cumulativeVolume.
    return /^RFU\.(?:NQ|ES|RTY)c1$/i.test(normalizeInstrumentCode(code));
  }
  function supportsTickBars(symbolInfo) {
    return ticksEnabled && (isFuturesInstrument(symbolCode(symbolInfo)) ||
      (!/^\/indices\//.test(location.pathname) && symbolInfo?.type !== "index"));
  }
  function symbolCode(symbolInfo) {
    return normalizeInstrumentCode(symbolInfo?.ticker ?? symbolInfo?.name ?? currentInstrumentCode() ?? "");
  }

  function patchResolutionList(list, symbolInfo) {
    return Array.from(new Set([
      ...(Array.isArray(list) ? list.map(String) : []),
      ...(secondsEnabled ? SECOND_RESOLUTIONS : []),
      ...(supportsTickBars(symbolInfo) ? TICK_RESOLUTIONS : []),
    ]));
  }

  return {
    secondsEnabled, ticksEnabled, SECOND_PRESETS, SECOND_RESOLUTIONS, SECOND_MULTIPLIERS,
    TICK_RESOLUTIONS, MAX_TICKS_PER_SYMBOL,
    normalizeInstrumentCode, currentInstrumentCode, symbolCode, isFuturesInstrument,
    isSecondsResolution, isTickResolution, supportsTickBars, patchResolutionList,
  };
}
