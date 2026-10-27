function installLocalCharts(moduleState) {
  if (runtime.localCharts) {
    moduleState.sharedState = runtime.localCharts;
    return;
  }
  const resolutions = createLocalResolutions();
  const { secondsEnabled, ticksEnabled, normalizeInstrumentCode } = resolutions;
  const state = Object.assign(moduleState, {
    version: VERSION,
    active: true,
    tradingViewPatched: false,
    datafeedsPatched: 0,
    widgetsCaptured: 0,
    webpackChartModules: runtime.chartHub.state.patchedModules,
    activeResolution: null,
    historicalCandleRequestsForSeconds: 0,
    historicalCandleRequestsForTicks: 0,
    source: "existing-tick-response-table-and-websocket",
    lastError: null,
  });
  runtime.localCharts = state;
  Object.defineProperty(window, "__TOSS_LOCAL_SECONDS__", {
    configurable: true,
    enumerable: false,
    value: state,
  });
  const trades = createTradeStore({
    maxTicksPerSymbol: settings.enableSec.maxTicksPerSymbol,
    maxSymbolBuckets: settings.enableSec.maxSymbolBuckets,
    currentInstrumentCode: resolutions.currentInstrumentCode,
    onError: (error) => { state.lastError = String(error); },
  });
  const sources = createTradeSources(trades, resolutions);
  installLegacyTickCompatibility(state, resolutions);
  const chartWidgets = new Set();
  const pendingChartResets = new Map();
  let chartResetTimer = null;
  function scheduleTickChartReset(code, count) {
    const resolution = `${count}T`;
    pendingChartResets.set(JSON.stringify([code, resolution]), { code, resolution });
    if (chartResetTimer != null) return;
    chartResetTimer = setTimeout(() => {
      chartResetTimer = null;
      const requests = [...pendingChartResets.values()];
      pendingChartResets.clear();
      for (const reference of chartWidgets) {
        const widget = reference.deref();
        if (!widget || (widget._iFrame && !widget._iFrame.isConnected)) { chartWidgets.delete(reference); continue; }
        try {
          for (let index = 0; index < widget.chartsCount(); index += 1) {
            const chart = widget.chart(index);
            if (requests.some((request) => request.resolution === String(chart.resolution()) && request.code === normalizeInstrumentCode(chart.symbol()))) {
              chart.resetData();
            }
          }
        } catch {
          // 제거 중인 차트는 다음 위젯으로 넘어간다.
        }
      }
    }, 0);
  }
  const wrapDatafeed = createLocalDatafeed({
    state, trades, resolutions, scanLoadedTrades: sources.scanLoadedTrades, scheduleTickChartReset,
  });
  installLocalResolutionControls(state, resolutions);
  sources.start();
  runtime.chartHub.add({
    key: secondsEnabled ? "enableSec" : "enableTick",
    transformOptions(options) {
      const enabledFeatures = ["custom_resolutions"];
      if (secondsEnabled) enabledFeatures.push("seconds_resolution");
      if (ticksEnabled) enabledFeatures.push("tick_resolution");
      // 별도 분봉 메뉴가 없는 지수 페이지는 TradingView의 기본 주기 메뉴를 사용한다.
      if (/^\/indices\//.test(location.pathname)) enabledFeatures.push("header_widget", "header_resolutions");
      return {
        ...configureChartFeatures(options, { enable: enabledFeatures }),
        datafeed: wrapDatafeed(options.datafeed),
      };
    },
    onCreated(widget) {
      if (ticksEnabled) {
        for (const reference of chartWidgets) {
          const previous = reference.deref();
          if (!previous || (previous._iFrame && !previous._iFrame.isConnected)) chartWidgets.delete(reference);
        }
        chartWidgets.add(new WeakRef(widget));
      }
      state.tradingViewPatched = true;
      state.widgetsCaptured += 1;
      const ready = () => {
        try {
          const chart = widget.activeChart();
          const syncResolution = () => { state.activeResolution = String(chart.resolution()); };
          syncResolution();
          chart.onIntervalChanged?.().subscribe(null, syncResolution);
        } catch (error) {
          state.lastError = String(error);
        }
      };
      if (typeof widget.chartReady === "function") widget.chartReady().then(ready).catch((error) => { state.lastError = String(error); });
      else widget.onChartReady(ready);
    },
  });
}
