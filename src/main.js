// 모든 기능을 등록한 뒤 생성자 후킹을 한 번만 시작한다.
runtime.chartHub = createChartHub();
for (const [key, install] of Object.entries({
  hollowCandles: installHollowCandles,
  indexChartUnlock: installIndexChartUnlock,
  noWait: installFastRealtime,
  enableSec: installLocalCharts,
  enableTick: installLocalCharts,
  midQuote: installMidQuote,
  bidAsk: installBidAsk,
})) initializeModule(key, install);
runtime.chartHub.start();
onDocumentReady(mountSettings);
