function installHollowCandles(moduleState) {
  const state = Object.assign(moduleState, { patchedModules: [], restoredCharts: 0 });
  const HOLLOW_CANDLE_STYLE = 9;
  runtime.webpackHub.transformFactories((factory, moduleId) => rewriteFactory(factory, moduleId, (source) => {
    if (!source.includes("hollowCandleStyle") && !source.includes("HollowCandle") && !source.includes("hollowCandles")) return null;

    // 토스의 초기 차트 상태와 색상 테마별 스타일 목록만 수정한다.
    // drawBody=true여도 상승봉은 TradingView의 isBarHollow 규칙에 따라 비워진다.
    // 일반 캔들/하이킨아시의 drawBody 및 사용자가 고른 색상은 보존한다.
    let rewritten = source.replace(
      /\bhollowCandleStyle\s*:\s*\{[^{}]*\}|\[\s*[A-Za-z_$][\w$]*\.HollowCandle\s*,\s*\{[^{}]*\}\s*\]/g,
      (style) => style.replace(/\bdrawBody\s*:\s*(?:!1|false)(?=\s*[,}])/g, "drawBody:!0"),
    );
    rewritten = rewritten.replace(
      /(\[\s*[A-Za-z_$][\w$]*\.HollowCandle\s*\]\s*:\s*)(["'])투명\s*캔들\2/g,
      '$1"할로우 캔들"',
    );
    // 새 차트 UI는 숫자 키 대신 value/label 목록을 사용한다.
    rewritten = rewritten.replace(
      /(\bvalue\s*:\s*["']hollowCandles["']\s*,\s*label\s*:\s*)(["'])투명\s*캔들\2/g,
      '$1"할로우 캔들"',
    );
    return rewritten;
  }, state, "할로우 캔들"));

  function restoreLoadedHollowCandles() {
    if (document.hidden || runtime.navigationWorkPaused()) return;
    // 저장된 레이아웃에는 drawBody=false가 남아 있을 수 있다.
    // iframe 재생성/다중 차트/레이아웃 복원을 함께 처리하고 실제로 다른 값만 갱신한다.
    for (const frame of document.querySelectorAll('iframe[id^="tradingview_"]')) {
      let api;
      let count;
      try {
        api = frame.contentWindow?.tradingViewApi;
        count = api?.chartsCount?.() ?? 0;
      } catch {
        continue; // 아직 준비되지 않았거나 접근할 수 없는 iframe은 건너뛴다.
      }
      for (let index = 0; index < count; index += 1) {
        try {
          const series = api.chart(index)?.getSeries?.();
          if (
            series?.chartStyleProperties?.(HOLLOW_CANDLE_STYLE)?.drawBody === false &&
            typeof series.setChartStyleProperties === "function"
          ) {
            series.setChartStyleProperties(HOLLOW_CANDLE_STYLE, { drawBody: true });
            state.restoredCharts += 1;
          }
        } catch {
          // 차트 생성/제거 도중이면 다음 탐색에서 다시 확인한다.
        }
      }
    }
  }
  // 틱마다 DOM을 감시하지 않고, 저장 상태와 지연 로드된 차트만 낮은 빈도로 보완한다.
  setInterval(restoreLoadedHollowCandles, 1_000);
  document.addEventListener("visibilitychange", restoreLoadedHollowCandles);
  restoreLoadedHollowCandles();
}
