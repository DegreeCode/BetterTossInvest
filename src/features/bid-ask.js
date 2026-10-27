function installBidAsk(moduleState) {
  if (window.top !== window.self) return;
  if (window.__tossNativeBidAsk?.installed) return;
  const MAX_CACHED_SYMBOLS = settings.bidAsk.maxCachedSymbols;
  const bookByCode = new Map();
  const transportRecords = new Map();
  const nativeRealtimeSubscriptions = new Set();
  const tradingViewRequireByWindow = new WeakMap();
  const bidAskClassByWindow = new WeakMap();
  const state = Object.assign(moduleState, { nativeSourcesInstalled: 0 });
  const BID_ASK_OVERRIDES = Object.freeze({
    "mainSeriesProperties.bidAsk.visible": true,
    "scalesProperties.showBidAskLabels": true,
  });
  function warn(...args) {
    console.warn("[Toss Native Bid/Ask]", ...args);
  }
  function asFiniteNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && "" !== value.trim()) {
      const parsed = Number(value.replaceAll(",", ""));
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  function firstDefined(object, keys) {
    for (const key of keys) if (null != object?.[key]) return object[key];
  }
  function toArray(value) {
    return Array.isArray(value) ? value : null == value ? [] : [value];
  }
  function parseExtendedSymbol(symbol) {
    const value = String(symbol ?? "").trim();
    if (!value.startsWith("=")) return null;
    try {
      const parsed = JSON.parse(value.slice(1));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function normalizeCode(symbol) {
    const value = String(symbol ?? "").trim();
    if (!value) return "";
    // Charting Library는 통화가 붙은 심볼을 ={"currency-id":"KRW","symbol":"CODE"}
    // 형태로 quote API에 넘긴다. 실제 WS 종목 코드와 동일하게 정규화한다.
    const extended = parseExtendedSymbol(value);
    const withoutCurrencySuffix = String(extended?.symbol ?? extended?.ticker ?? extended?.proName ?? value)
      .trim()
      .split("#", 1)[0]
      .trim();
    const exchangeSeparator = withoutCurrencySuffix.lastIndexOf(":");
    const code = exchangeSeparator >= 0 ? withoutCurrencySuffix.slice(exchangeSeparator + 1).trim() : withoutCurrencySuffix;
    // 국내주식은 차트 심볼이 000660, 실시간 메시지가 A000660처럼
    // 서로 다른 형식을 사용할 수 있다. 해외 티커의 A 접두사는 건드리지 않고
    // 국내 종목 코드 형태(A + 숫자 6자리)만 같은 키로 정규화한다.
    return /^A\d{6}$/i.test(code) ? code.slice(1) : code.toUpperCase();
  }
  function priceFromLevel(level) {
    return asFiniteNumber(
      level && typeof level === "object" ? firstDefined(level, ["price", "value", "bidPrice", "askPrice", "offerPrice"]) : level,
    );
  }
  function volumeFromLevel(level) {
    return level && typeof level === "object" ? asFiniteNumber(firstDefined(level, ["volume", "size", "quantity", "qty"])) : null;
  }
  function readSide(body, side, currency, exchangeRate) {
    const isBid = "bid" === side;
    const isKrw = "KRW" === currency;
    const bookCurrency = String(body?.currency ?? "").toUpperCase();
    const krwPriceKeys = isBid
      ? ["bidPricesKrw", "bidsKrw", "bidPriceKrw"]
      : ["offerPricesKrw", "askPricesKrw", "offersKrw", "asksKrw", "offerPriceKrw", "askPriceKrw"];
    const volumeKeys = isBid
      ? ["bidVolumes", "bidSizes", "bidVolume"]
      : ["offerVolumes", "askVolumes", "offerSizes", "askSizes", "offerVolume", "askVolume"];
    const nativeLevels = toArray(
      firstDefined(
        body,
        isBid ? ["bidPrices", "bids", "bidPrice"] : ["offerPrices", "askPrices", "offers", "asks", "offerPrice", "askPrice"],
      ),
    );
    const krwLevels = toArray(firstDefined(body, krwPriceKeys));
    const selectedLevels = isKrw && krwLevels.length > 0 ? krwLevels : nativeLevels;
    const volumes = toArray(firstDefined(body, volumeKeys));
    const levels = selectedLevels.length > 0 ? selectedLevels : nativeLevels;
    const shouldConvert = isKrw && 0 === krwLevels.length && "KRW" !== bookCurrency;
    let best = null;
    for (let index = 0; index < levels.length; index += 1) {
      const level = levels[index];
      let price = priceFromLevel(level);
      if (null == price || price <= 0) continue;
      if (shouldConvert) {
        if (null == exchangeRate || exchangeRate <= 0) continue;
        price *= exchangeRate;
      }
      const indexedVolume = asFiniteNumber(volumes[index]);
      if (!best || (isBid ? price > best.price : price < best.price))
        best = {
          price,
          volume: indexedVolume ?? volumeFromLevel(level),
          index,
        };
    }
    // 복수 호가에서는 TradingView 네이티브 라인에 표시할 최우선 호가를 고른다.
    return best;
  }
  function inferExchangeRate(book, trade, previousRate) {
    const pairs = [
      [trade?.closeKrwDecimal ?? trade?.closeKrw, trade?.close],
      [trade?.baseKrwDecimal ?? trade?.baseKrw, trade?.base],
    ];
    const nativeBid = toArray(firstDefined(book, ["bidPrices", "bids", "bidPrice"]));
    const krwBid = toArray(firstDefined(book, ["bidPricesKrw", "bidsKrw", "bidPriceKrw"]));
    const nativeAsk = toArray(firstDefined(book, ["offerPrices", "askPrices", "offers", "asks", "offerPrice", "askPrice"]));
    const krwAsk = toArray(
      firstDefined(book, ["offerPricesKrw", "askPricesKrw", "offersKrw", "asksKrw", "offerPriceKrw", "askPriceKrw"]),
    );
    if (nativeBid.length && krwBid.length) pairs.push([priceFromLevel(krwBid[0]), priceFromLevel(nativeBid[0])]);
    if (nativeAsk.length && krwAsk.length) pairs.push([priceFromLevel(krwAsk[0]), priceFromLevel(nativeAsk[0])]);
    for (const [krwValue, nativeValue] of pairs) {
      const krw = asFiniteNumber(krwValue);
      const native = asFiniteNumber(nativeValue);
      if (null != krw && null != native && krw > 0 && native > 0) {
        const rate = krw / native;
        if (Number.isFinite(rate) && rate > 0) return rate;
      }
    }
    return previousRate ?? null;
  }

  function touchEntry(code, patch) {
    const next = {
      ...(bookByCode.get(code) ?? {
        book: null,
        trade: null,
        exchangeRate: null,
        updatedAt: 0,
      }),
      ...patch,
      updatedAt: Date.now(),
    };
    next.exchangeRate = inferExchangeRate(next.book, next.trade, next.exchangeRate);
    // Map의 삽입 순서를 LRU처럼 사용해 장시간 열린 탭의 메모리 사용을 제한한다.
    bookByCode.delete(code);
    bookByCode.set(code, next);
    while (bookByCode.size > MAX_CACHED_SYMBOLS) bookByCode.delete(bookByCode.keys().next().value);
    return next;
  }
  function resolveBidAskPrices(record) {
    const entry = bookByCode.get(record.code);
    if (!entry?.book) return null;
    let currency = "";
    try {
      currency = String(record.model?.mainSeries?.()?.symbolInfo?.()?.currency_code ?? entry.book.currency ?? "").toUpperCase();
    } catch {
      currency = String(entry.book.currency ?? "").toUpperCase();
    }
    const { bid, ask, locked } = (function (book, currency, exchangeRate) {
      const bid = readSide(book, "bid", currency, exchangeRate);
      const ask = readSide(book, "ask", currency, exchangeRate);
      return {
        bid,
        ask,
        // KRX/NXT 통합호가가 잠시 같은 가격에 잠기는 경우 가격을 인위적으로
        // 벌리지 않는다. TradingView에는 같은 값 두 개를 그대로 전달한다.
        locked: null != bid && null != ask && bid.price === ask.price,
      };
    })(entry.book, currency, entry.exchangeRate);
    return bid || ask
      ? {
          bid: bid?.price,
          ask: ask?.price,
          locked,
        }
      : null;
  }

  function emitNativeRecord(record) {
    const prices = resolveBidAskPrices(record);
    if (prices)
      try {
        record.callback(
          record.symbol,
          {
            bid: prices.bid,
            ask: prices.ask,
          },
          null,
        );
      } catch (error) {
        warn("매수·매도 호가선 갱신에 실패했습니다.", error);
      }
  }
  function emitNativeCode(code) {
    for (const record of [...nativeRealtimeSubscriptions]) if (record.code === code) emitNativeRecord(record);
  }
  function enforceChart(chart) {
    const visibleProperty = (function (chart) {
      try {
        const model = chart?._chartWidget?.model?.()?.model?.();
        const properties = model?.mainSeries?.()?.properties?.();
        return properties?.child?.("bidAsk")?.child?.("visible") ?? null;
      } catch {
        return null;
      }
    })(chart);
    const labelsProperty = (function (chart) {
      try {
        const model = chart?._chartWidget?.model?.()?.model?.();
        return model?.properties?.()?.childs?.()?.scalesProperties?.childs?.()?.showBidAskLabels ?? null;
      } catch {
        return null;
      }
    })(chart);
    let handledInternally = false;
    let changed = false;
    if (visibleProperty) {
      handledInternally = true;
      try {
        if (true !== visibleProperty.value?.()) {
          visibleProperty.setValue(true);
          changed = true;
        }
      } catch {
        // 공개 override API로 이어서 시도한다.
        handledInternally = false;
      }
    }
    if (labelsProperty) {
      handledInternally = true;
      try {
        if (true !== labelsProperty.value?.()) {
          labelsProperty.setValue(true);
          changed = true;
        }
      } catch {
        handledInternally = false;
      }
    }
    if (handledInternally) return changed;
    try {
      chart?.applyOverrides?.(BID_ASK_OVERRIDES);
      return true;
    } catch {
      return false;
    }
  }
  async function loadBidAskClass(frameWindow) {
    const existing = bidAskClassByWindow.get(frameWindow);
    if (existing) return existing;
    const pending = (async () => {
      const webpackRequire = (function loadTradingViewRuntime() {
        const cached = tradingViewRequireByWindow.get(frameWindow);
        if (cached) return cached;
        const chunks = frameWindow?.webpackChunktradingview;
        if (!chunks?.push) {
          throw new Error("TradingView webpack runtime is not ready");
        }
        let webpackRequire = null;
        const runtimeChunkId = `toss_bidask_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        chunks.push([
          [runtimeChunkId],
          {},
          (require) => {
            webpackRequire = require;
          },
        ]);
        if (typeof webpackRequire !== "function") throw new Error("TradingView webpack require capture failed");
        tradingViewRequireByWindow.set(frameWindow, webpackRequire);
        return webpackRequire;
      })();
      const findClass = () => {
        for (const [moduleId, factory] of Object.entries(webpackRequire.m ?? {})) {
          if (!/\bBidAsk\s*:/.test(readFactorySource(factory) ?? "")) continue;
          const candidate = webpackRequire(moduleId)?.BidAsk;
          if (typeof candidate === "function") return candidate;
        }
        return null;
      };
      // 청크/모듈 번호는 버전마다 바뀐다 (v27: 2650/13042, v32: 33599/235618).
      // 현재 iframe의 런타임이 가진 청크 이름과 export로 찾아 잘못된 URL 요청을 피한다.
      const mappedChunkId = readFactorySource(webpackRequire.u)?.match(
        /["']?(\d+)["']?\s*:\s*["']trading-custom-sources["']/,
      )?.[1];
      // 일부 런타임은 u를 언어 치환 함수로 감싸므로 원래 이름 맵이 보이지 않는다.
      // 지원 버전의 후보도 실제 파일 이름이 일치할 때만 로드한다.
      const chunkId = [mappedChunkId, 33599, 2650].filter((id) => id != null).map(Number).find((id) => {
        const filename = webpackRequire.u?.(id) ?? "";
        return !filename.includes("undefined") && /^trading-custom-sources\.[\w.-]+\.js$/.test(filename);
      });
      let BidAsk = findClass();
      if (!BidAsk) {
        if (chunkId == null) throw new Error("TradingView trading-custom-sources chunk was not found");
        await webpackRequire.e(chunkId);
        BidAsk = findClass();
      }
      if (!BidAsk) throw new Error("TradingView BidAsk export was not found");
      if (chunkId === 33599) {
        // v32는 Bid/Ask 라벨 번역도 분리했다. 소스만 로드하면 시세를 받은 뒤
        // 가격축 렌더링 중에 번역 모듈을 찾지 못해 차트가 멈춘다.
        const labelsFilename = webpackRequire.u(3696);
        if (labelsFilename.includes("undefined") || !/^[\w-]+\.3696\.[\w.-]+\.js$/.test(labelsFilename)) {
          throw new Error("TradingView BidAsk labels chunk was not found");
        }
        await webpackRequire.e(3696);
      }
      return BidAsk;
    })();
    bidAskClassByWindow.set(frameWindow, pending);
    try {
      return await pending;
    } catch (error) {
      bidAskClassByWindow.delete(frameWindow); // 지연 초기화/일시적인 청크 로드 실패 후 재시도한다.
      throw error;
    }
  }
  function createBidAskProvider(model) {
    const records = new Map();
    return {
      subscribeRealtime(symbol, callback) {
        const previous = records.get(callback);
        if (previous) nativeRealtimeSubscriptions.delete(previous);
        const record = {
          model,
          symbol: String(symbol),
          code: normalizeCode(symbol),
          callback,
        };
        records.set(callback, record);
        nativeRealtimeSubscriptions.add(record);
        queueMicrotask(() => {
          if (records.get(callback) === record) emitNativeRecord(record);
        });
      },
      unsubscribeRealtime(_symbol, callback) {
        const record = records.get(callback);
        if (record) {
          nativeRealtimeSubscriptions.delete(record);
          records.delete(callback);
        }
      },
    };
  }

  async function installNativeSource(record, chart) {
    const model = chart?._chartWidget?.model?.()?.model?.();
    if (!model) return false;
    if (model.hasCustomSource?.("bidask")) return true;
    const frameWindow = record.frame?.contentWindow;
    if (!frameWindow) return false;
    const BidAsk = await loadBidAskClass(frameWindow);
    if (!record.frame.isConnected) return false;
    if (model.hasCustomSource?.("bidask")) return true;
    const provider = createBidAskProvider(model);
    const series = model.mainSeries();
    const originalCurrencyCheck = series.isConvertedToOtherCurrency;
    const originalUnitCheck = series.isConvertedToOtherUnit;
    try {
      series.isConvertedToOtherCurrency = () => false;
      series.isConvertedToOtherUnit = () => false;
      model.addCustomSource("bidask", (id, chartModel) => {
        const source = new BidAsk(id, chartModel, provider, void 0);
        (function (source, model) {
          const events = model.mainSeries().dataEvents();
          events.symbolResolved().unsubscribeAll(source);
          events.symbolError().unsubscribeAll(source);
          source._createTradedSymbol = function () {
            const series = model.mainSeries();
            const symbolInfo = series.symbolInfo();
            const symbol =
              symbolInfo?.pro_name ?? symbolInfo?.full_name ?? symbolInfo?.name ?? series.proSymbol?.() ?? this._symbol ?? null;
            if (symbol !== this._symbol) {
              this._clearTradedSymbol();
              if (!(null == symbol || this._hibernated.value())) this._initTradedSymbol(symbol);
            }
          };
          events.symbolResolved().subscribe(source, source._createTradedSymbol);
          events.symbolError().subscribe(source, source._createTradedSymbol);
          source._createTradedSymbol();
        })(source, chartModel);
        return source;
      });
    } finally {
      series.isConvertedToOtherCurrency = originalCurrencyCheck;
      series.isConvertedToOtherUnit = originalUnitCheck;
    }
    state.nativeSourcesInstalled += 1;
    state.lastError = null;
    return true;
  }
  function patchTransport(id, frame) {
    const transport = window[id];
    if (!transport || typeof transport !== "object") return;
    let record = transportRecords.get(id);
    if (record && record.transport === transport) {
      if (frame) record.frame = frame;
    } else {
      record = {
        id,
        frame,
        transport,
      };
      transportRecords.set(id, record);
    }
    const iframe = record.frame ?? document.getElementById(id);
    const api = iframe?.contentWindow?.tradingViewApi;
    if (!api) return;
    let count = 0;
    try {
      count = api.chartsCount?.() ?? 0;
    } catch {
      return;
    }
    for (let index = 0; index < count; index += 1)
      try {
        const chart = api.chart(index);
        enforceChart(chart);
        const model = chart?._chartWidget?.model?.()?.model?.();
        if (!model || model.hasCustomSource?.("bidask")) continue;
        record.nativeSourcePromises ??= new WeakMap();
        if (!record.nativeSourcePromises.has(model) && performance.now() >= (record.retryAfter ?? 0)) {
          const promise = installNativeSource(record, chart).then((installed) => {
            if (!installed) record.nativeSourcePromises.delete(model);
          }).catch((error) => {
            record.nativeSourcePromises.delete(model);
            record.retryAfter = performance.now() + 5_000;
            const message = String(error);
            state.lastError = message;
            if (record.lastError !== message) warn("차트에 매수·매도 호가선을 추가하지 못했습니다.", error);
            record.lastError = message;
          });
          record.nativeSourcePromises.set(model, promise);
        }
      } catch {
        // iframe가 레이아웃을 바꾸는 중이면 다음 탐색에서 다시 처리한다.
      }
  }
  function scanTradingViewTransports() {
    if (runtime.navigationWorkPaused()) return;
    const liveIds = new Set();
    for (const frame of document.querySelectorAll('iframe[id^="tradingview_"]')) if (frame.id) liveIds.add(frame.id);
    for (const id of liveIds) patchTransport(id, document.getElementById(id));
    for (const [id, record] of transportRecords) {
      const frame = record.frame;
      if (!(window[id] || (frame && frame.isConnected))) transportRecords.delete(id);
    }
  }
  Object.defineProperty(window, "__tossNativeBidAsk", {
    configurable: true,
    value: {
      installed: true,
    },
  });
  runtime.workerHub.onMessage(function (messageData) {
    const destination = String(messageData?.data?.destination ?? messageData?.destination ?? "");
    const bookMatch = destination.match(/\/bidoffer\/([^?/#]+)/i);
    const tradeMatch = destination.match(/\/trade\/([^?/#]+)/i);
    if (!bookMatch && !tradeMatch) return;
    const body = parseWorkerBody(messageData);
    if (body) {
      if (bookMatch) {
        const code = normalizeCode(body.code ?? bookMatch[1]);
        if (!code) return;
        touchEntry(code, {
          book: body,
        });
        emitNativeCode(code);
        return;
      }
      if (tradeMatch) {
        const code = normalizeCode(body.code ?? tradeMatch[1]);
        if (!code) return;
        touchEntry(code, {
          trade: body,
        });
        emitNativeCode(code);
      }
    }
  });
  (function () {
    scanTradingViewTransports();
    const root = document.documentElement;
    if (root && typeof MutationObserver === "function")
      new MutationObserver((mutations) => {
        for (const mutation of mutations)
          for (const node of mutation.addedNodes)
            if (
              node instanceof Element &&
              (node.matches('iframe[id^="tradingview_"]') || node.querySelector('iframe[id^="tradingview_"]'))
            ) {
              queueMicrotask(scanTradingViewTransports);
              return;
            }
      }).observe(root, {
        childList: true,
        subtree: true,
      });
    // DOM 변경으로 포착되지 않는 차트 전환만 저빈도 탐색으로 보완한다.
    setInterval(scanTradingViewTransports, 500);
  })();
}
