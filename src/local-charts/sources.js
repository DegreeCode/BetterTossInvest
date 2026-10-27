function createTradeSources(trades, resolutions) {
  const { currentInstrumentCode, normalizeInstrumentCode, isFuturesInstrument } = resolutions;
  const { getBucket, addTick, notifyTick, hasBucket } = trades;
  const lastIndexSeedPrices = new Map();
  const indexSeedAttempts = new Map();
  let lastObservedPathname = location.pathname;
  let scanTimer = null;

  function parseDisplayedNumber(text) {
    if (typeof text !== "string") return null;
    const number = Number(text.replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(number) ? number : null;
  }

  function parseTableTime(text) {
    const match = String(text)
      .trim()
      .match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const now = new Date();
    const time = new Date(now);
    time.setHours(Number(match[1]), Number(match[2]), Number(match[3]), 0);
    if (time.getTime() > now.getTime() + 21_600_000) time.setDate(time.getDate() - 1);
    return time.getTime();
  }
  function parseIncomingTime(value) {
    if (typeof value === "string" && /^\d{1,2}:\d{2}:\d{2}$/.test(value.trim())) return parseTableTime(value);
    const time = new Date(value ?? "").getTime();
    return Number.isFinite(time) ? time : null;
  }
  function isRealtimeTradesTable(table) {
    let hasTradePrice = false;
    let hasTime = false;
    for (const cell of table.querySelectorAll("thead th")) {
      const text = cell.textContent?.replace(/\s+/g, " ").trim() ?? "";
      hasTradePrice ||= text.includes("체결가");
      hasTime ||= text === "시간" || text.endsWith(" 시간");
      if (hasTradePrice && hasTime) return true;
    }
    return false;
  }
  function seedIndexPrice(code) {
    const titleMatch = document.title.match(/^\s*([+-]?\d[\d,]*(?:\.\d+)?)/);
    const price = titleMatch ? parseDisplayedNumber(titleMatch[1]) : null;
    if (price == null || price <= 0 || lastIndexSeedPrices.get(code) === price) return;
    lastIndexSeedPrices.set(code, price);
    addTick(code, {
      time: Date.now(),
      volume: 0,
      cumulativeVolume: null,
      priceUsd: price,
      priceKrw: price,
      source: "loaded-index-summary",
    });
  }

  function addHistoricalTicks(code, ticks) {
    let added = false;
    for (const tick of ticks) added = addTick(code, tick, false) || added;
    if (!added) return;
    const latest = getBucket(code).ticks.at(-1);
    if (latest) notifyTick(code, latest);
  }

  function scanLoadedTrades() {
    scanTimer = null;
    const code = currentInstrumentCode();
    if (!code) return;
    // Index pages have no executions table. Seed one bar from the price that
    // Toss already rendered, then let the existing index WebSocket update it.
    // This reads the DOM/title only and issues no request.
    if (/^\/indices\//.test(location.pathname)) {
      seedIndexPrice(code);
      if (getBucket(code).ticks.length === 0) {
        const attempts = (indexSeedAttempts.get(code) ?? 0) + 1;
        indexSeedAttempts.set(code, attempts);
        if (attempts < 20) scheduleTradesScan(250);
      } else indexSeedAttempts.delete(code);
      return;
    }
    let table = null;
    for (const candidate of document.querySelectorAll("table"))
      if (isRealtimeTradesTable(candidate)) {
        table = candidate;
        break;
      }
    if (!table) return;
    const parsed = [];
    for (const row of table.querySelectorAll("tbody tr")) {
      const cells = row.cells;
      if (cells.length < 5) continue;
      const priceText = cells[0].textContent?.trim() ?? "";
      const price = parseDisplayedNumber(priceText);
      const volume = parseDisplayedNumber(cells[1].textContent ?? "");
      const cumulativeVolume = parseDisplayedNumber(cells[3].textContent ?? "");
      const time = parseTableTime(cells[4].textContent ?? "");
      if (null != price && null != volume && null != time)
        parsed.push({
          time,
          volume,
          cumulativeVolume,
          priceUsd: priceText.includes("$") ? price : null,
          priceKrw: priceText.includes("$") ? null : price,
          source: "loaded-trades-table",
          isTrade: true,
        });
    }
    // The table is newest-first. Reverse before the stable time sort so trades
    // sharing the same displayed second retain their chronological direction.
    parsed.reverse().sort((a, b) => a.time - b.time);
    addHistoricalTicks(code, parsed);
  }
  function scheduleTradesScan(delay = 30) {
    if (null == scanTimer) scanTimer = setTimeout(scanLoadedTrades, delay);
  }

  function observeWorkerMessage(data) {
    if (!data || "send" !== data.scope || "messageReceived" !== data.type) return;
    const destination = String(data.data?.destination ?? "");
    const body = data.data?.message?.body;
    if (typeof body !== "string") return;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return; }
    const destinationCode = normalizeInstrumentCode(destination.split("/").pop());
    const code = normalizeInstrumentCode(parsed?.code ?? parsed?.productCode ?? parsed?.stockCode ?? destinationCode);
    const currentCode = currentInstrumentCode();
    if (!code || (code !== currentCode && !hasBucket(code))) return;
    if (destinationCode && destinationCode.toUpperCase() !== code.toUpperCase()) return;
    const isIndicatorUpdate = /\/stock\/index\//.test(destination) || /^\/indices\//.test(location.pathname);
    const isFuturesUpdate = isFuturesInstrument(code) && /\/stock\/index\//.test(destination);
    const parsedTime = new Date(parsed?.dt ?? "").getTime();
    const time = Number.isFinite(parsedTime) ? parsedTime : isIndicatorUpdate && !isFuturesUpdate ? Date.now() : NaN;
    const close = finiteNumber(parsed?.close);
    const closeKrw = finiteNumber(parsed?.closeKrw);
    const volume = finiteNumber(parsed?.volume) ?? (isIndicatorUpdate ? 0 : null);
    if (!Number.isFinite(time) || volume == null || (close == null && closeKrw == null)) return;
    addTick(code, {
      time,
      volume,
      cumulativeVolume: finiteNumber(parsed?.cumulativeVolume),
      priceUsd: close,
      priceKrw: closeKrw,
      session: parsed?.session,
      source: "existing-websocket",
      isTrade: Number.isFinite(parsedTime) && (/\/trade\//.test(destination) || isFuturesUpdate),
    });
  }

  function ingestTickResponse(url, payload) {
    const match = String(url).match(/\/api\/v2\/stock-prices\/([^/?]+)\/ticks(?:\?|$)/);
    if (!match) return;
    const code = decodeURIComponent(match[1]);
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.body)
          ? payload.body
          : null;
    if (!rows) return;
    const ticks = rows
      .map((row) => ({
        time: parseIncomingTime(row?.dt ?? row?.time),
        volume: finiteNumber(row?.volume),
        cumulativeVolume: finiteNumber(row?.cumulativeVolume),
        priceUsd: finiteNumber(row?.close),
        priceKrw: finiteNumber(row?.closeKrw),
        session: row?.session,
        source: "existing-ticks-response",
        isTrade: true,
      }))
      .filter((tick) => null != tick.time && null != tick.volume);
    // Toss's ticks endpoint is newest-first.
    ticks.reverse().sort((a, b) => a.time - b.time);
    addHistoricalTicks(code, ticks);
  }

  function observeTickResponses() {
    if (typeof window.fetch !== "function" || window.fetch.__tossLocalSecondsTapped) return;
    const originalFetch = window.fetch;
    async function observedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url ?? response?.url ?? "");
        if (/\/api\/v2\/stock-prices\/[^/?]+\/ticks(?:\?|$)/.test(url))
          response
            .clone()
            .json()
            .then((payload) =>
              ingestTickResponse(url, payload),
            )
            .catch(() => {});
      } catch {
        // Observing the already-issued response must never affect Toss's request.
      }
      return response;
    }
    Object.setPrototypeOf(observedFetch, originalFetch);
    Object.defineProperty(observedFetch, "__tossLocalSecondsTapped", {
      value: true,
    });
    window.fetch = observedFetch;
  }

  function start() {
    runtime.workerHub.onMessage(observeWorkerMessage);
    observeTickResponses();
    onDocumentReady(() => {
      scheduleTradesScan();
      new MutationObserver(() => {
        if (lastObservedPathname !== location.pathname) {
          lastObservedPathname = location.pathname;
          scheduleTradesScan(120);
          return;
        }
        const code = currentInstrumentCode();
        if (/^\/(?:stocks|indices)\//.test(location.pathname) && code && getBucket(code).ticks.length === 0) scheduleTradesScan(250);
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  return { scanLoadedTrades, start };
}
