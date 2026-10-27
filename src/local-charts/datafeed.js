function createLocalDatafeed({ state, trades, resolutions, scanLoadedTrades, scheduleTickChartReset }) {
  const { secondsEnabled, ticksEnabled, SECOND_MULTIPLIERS, MAX_TICKS_PER_SYMBOL,
    isSecondsResolution, isTickResolution, supportsTickBars, symbolCode, patchResolutionList } = resolutions;
  const { getBucket } = trades;
  const customSubscriptions = new Map();
  const wrappedDatafeeds = new WeakMap();

  function subscribeSecondsBars(symbolInfo, seconds, onRealtime, listenerGuid) {
    const code = symbolCode(symbolInfo);
    const bucket = getBucket(code);
    const useKrw = wantsKrw(symbolInfo);
    const initialBars = cachedAggregateSeconds(bucket, symbolInfo, seconds);
    let lastBar = initialBars[initialBars.length - 1] ?? null;
    const interval = 1_000 * seconds;
    let deliveryFrame = null;
    let disposed = false;
    const deliverLatestBar = () => {
      deliveryFrame = null;
      if (!disposed && lastBar)
        onRealtime({
          ...lastBar,
        });
    };
    const listener = (incomingCode, tick) => {
      if (incomingCode !== code) return;
      const price = tickPrice(tick, useKrw);
      if (null == price) return;
      const time = Math.floor(tick.time / interval) * interval;
      if (!lastBar || time > lastBar.time) {
        lastBar = createBar(time, price, tick.volume);
      } else {
        if (time !== lastBar.time) return;
        // Keep every raw tick in OHLCV, but ask TradingView to redraw at most
        // once per display frame. This removes the high-volume seconds lag.
        lastBar = updateBar({ ...lastBar }, price, tick.volume);
      }
      if (deliveryFrame == null && !disposed)
        deliveryFrame =
          typeof requestAnimationFrame === "function" ? requestAnimationFrame(deliverLatestBar) : setTimeout(deliverLatestBar, 16);
    };
    const stopListening = trades.onTick(listener);
    customSubscriptions.set(listenerGuid, () => {
      disposed = true;
      stopListening();
      if (null != deliveryFrame) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(deliveryFrame);
        clearTimeout(deliveryFrame);
        deliveryFrame = null;
      }
    });
  }

  function subscribeTickBars(symbolInfo, count, onRealtime, listenerGuid, onResetCache) {
    const code = symbolCode(symbolInfo);
    const bucket = getBucket(code);
    const useKrw = wantsKrw(symbolInfo);
    const initial = cachedAggregateTickBars(bucket, symbolInfo, count);
    let lastBar = initial.bars.at(-1) ? { ...initial.bars.at(-1) } : null;
    let lastCount = initial.lastCount;
    let ordinal = initial.ordinal;
    let version = bucket.version;
    let deliveryFrame = null;
    let disposed = false;
    let resetting = false;
    const pendingBars = new Map();
    const reset = () => {
      resetting = true;
      pendingBars.clear();
      onResetCache?.();
      scheduleTickChartReset(code, count);
    };
    const deliver = () => {
      deliveryFrame = null;
      if (disposed || resetting) return;
      const bars = [...pendingBars.values()];
      pendingBars.clear();
      // 한 프레임에 여러 틱봉이 완성되어도 중간 봉을 생략하지 않는다.
      for (const bar of bars) {
        if (disposed || resetting) break;
        onRealtime({ ...bar });
      }
    };
    const listener = (incomingCode, tick) => {
      if (incomingCode !== code || disposed || resetting) return;
      if (bucket.version !== version + 1 || bucket.lastMutation !== "append") {
        // 과거 체결이 뒤늦게 추가되면 묶음 경계가 달라질 수 있으므로 로컬 캐시를 다시 읽는다.
        reset();
        return;
      }
      version = bucket.version;
      if (!isCountedTrade(tick)) return;
      const price = tickPrice(tick, useKrw);
      const group = Math.floor(ordinal / count);
      const position = ordinal % count;
      ordinal += 1;
      if (position === 0) {
        lastBar = createBar(tickBarTime(bucket, count, group, tick.time), price, tick.volume);
      } else if (lastBar && lastCount === position) {
        lastBar = updateBar({ ...lastBar }, price, tick.volume);
      } else {
        // 보관 한도로 첫 묶음의 일부만 남아 있으면 다음 완전한 묶음부터 표시한다.
        lastCount = position + 1;
        return;
      }
      lastCount = position + 1;
      pendingBars.set(lastBar.time, lastBar);
      if (pendingBars.size > MAX_TICKS_PER_SYMBOL) {
        // 백그라운드 탭에서 RAF가 멈춘 동안에도 배달 대기열의 메모리를 제한한다.
        reset();
        return;
      }
      if (deliveryFrame == null) deliveryFrame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(deliver) : setTimeout(deliver, 16);
    };
    const stopListening = trades.onTick(listener);
    customSubscriptions.set(listenerGuid, () => {
      disposed = true;
      stopListening();
      pendingBars.clear();
      if (deliveryFrame != null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(deliveryFrame);
        clearTimeout(deliveryFrame);
      }
    });
  }
  function wrapDatafeed(datafeed) {
    if (!datafeed || typeof datafeed !== "object") return datafeed;
    const existing = wrappedDatafeeds.get(datafeed);
    if (existing) return existing;
    const overrides = Object.create(null);
    const originalOnReady = datafeed.onReady?.bind(datafeed);
    const originalResolveSymbol = datafeed.resolveSymbol?.bind(datafeed);
    const originalGetBars = datafeed.getBars?.bind(datafeed);
    const originalSubscribeBars = datafeed.subscribeBars?.bind(datafeed);
    const originalUnsubscribeBars = datafeed.unsubscribeBars?.bind(datafeed);
    if (originalOnReady)
      overrides.onReady = (callback) =>
        originalOnReady((configuration) => {
          callback({
            ...configuration,
            supported_resolutions: patchResolutionList(configuration?.supported_resolutions),
          });
        });
    if (originalResolveSymbol)
      overrides.resolveSymbol = (name, onResolved, onError, extension) =>
        originalResolveSymbol(
          name,
          (info) => onResolved({
            ...info,
            has_seconds: secondsEnabled || !!info?.has_seconds,
            has_ticks: supportsTickBars(info) || !!info?.has_ticks,
            __btiLocalTickBars: supportsTickBars(info),
            build_seconds_from_ticks: false,
            seconds_multipliers: secondsEnabled ? [...SECOND_MULTIPLIERS] : info?.seconds_multipliers,
            supported_resolutions: patchResolutionList(info?.supported_resolutions, info),
          }),
          onError,
          extension,
        );
    if (originalGetBars)
      overrides.getBars = (symbolInfo, resolution, periodParams, onResult, onError) => {
        const seconds = secondsEnabled ? isSecondsResolution(resolution) : null;
        const count = ticksEnabled ? isTickResolution(resolution) : null;
        if (ticksEnabled && /^\d+T$/.test(String(resolution)) && count == null) {
          setTimeout(() => onError?.("지원하지 않는 틱봉 주기입니다."), 0);
          return;
        }
        if (seconds == null && count == null) return originalGetBars(symbolInfo, resolution, periodParams, onResult, onError);
        // Deliberately do not call Toss's original getBars here. This is the
        // invariant that prevents historical candle API requests for seconds/ticks.
        scanLoadedTrades();
        const bucket = getBucket(symbolCode(symbolInfo));
        let bars = count != null ? cachedAggregateTickBars(bucket, symbolInfo, count).bars : cachedAggregateSeconds(bucket, symbolInfo, seconds);
        const from = finiteNumber(periodParams?.from);
        const to = finiteNumber(periodParams?.to);
        if (to != null) bars = bars.filter((bar) => bar.time < 1_000 * to);
        const countBack = finiteNumber(periodParams?.countBack);
        if (countBack != null && countBack > 0) bars = bars.slice(-Math.floor(countBack));
        else if (from != null) bars = bars.filter((bar) => bar.time >= 1_000 * from);
        bars = bars.map((bar) => ({ ...bar }));
        setTimeout(
          () =>
            onResult(bars, {
              noData: 0 === bars.length,
            }),
          0,
        );
      };
    if (originalSubscribeBars)
      overrides.subscribeBars = (symbolInfo, resolution, onRealtime, listenerGuid, onResetCache) => {
        customSubscriptions.get(listenerGuid)?.();
        customSubscriptions.delete(listenerGuid);
        const seconds = secondsEnabled ? isSecondsResolution(resolution) : null;
        const count = ticksEnabled ? isTickResolution(resolution) : null;
        if (count != null) return subscribeTickBars(symbolInfo, count, onRealtime, listenerGuid, onResetCache);
        if (ticksEnabled && /^\d+T$/.test(String(resolution))) return;
        if (null == seconds) return originalSubscribeBars(symbolInfo, resolution, onRealtime, listenerGuid, onResetCache);
        return subscribeSecondsBars(symbolInfo, seconds, onRealtime, listenerGuid);
      };
    overrides.unsubscribeBars = (listenerGuid) => {
      const unsubscribe = customSubscriptions.get(listenerGuid);
      if (unsubscribe) {
        unsubscribe();
        customSubscriptions.delete(listenerGuid);
        return;
      }
      return originalUnsubscribeBars?.(listenerGuid);
    };
    const proxy = new Proxy(datafeed, {
      get(target, property) {
        if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    wrappedDatafeeds.set(datafeed, proxy);
    state.datafeedsPatched += 1;
    return proxy;
  }

  return wrapDatafeed;
}
