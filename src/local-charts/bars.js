function wantsKrw(symbolInfo) {
  return "KRW" === String(symbolInfo?.currency_code ?? symbolInfo?.currencyCode ?? "").toUpperCase();
}
function tickPrice(tick, useKrw) {
  return finiteNumber(useKrw ? (tick.priceKrw ?? tick.priceUsd) : (tick.priceUsd ?? tick.priceKrw));
}

function createBar(time, price, volume) {
  return { time, open: price, high: price, low: price, close: price, volume };
}

function updateBar(bar, price, volume) {
  bar.high = Math.max(bar.high, price);
  bar.low = Math.min(bar.low, price);
  bar.close = price;
  bar.volume = (bar.volume ?? 0) + volume;
  return bar;
}

function aggregateSeconds(ticks, useKrw, seconds) {
  const interval = 1_000 * seconds;
  const bars = [];
  let current = null;
  for (const tick of ticks) {
    const price = tickPrice(tick, useKrw);
    if (price == null) continue;
    const time = Math.floor(tick.time / interval) * interval;
    if (current && current.time === time) {
      updateBar(current, price, tick.volume);
    } else {
      current = createBar(time, price, tick.volume);
      bars.push(current);
    }
  }
  return bars;
}

function cachedAggregateSeconds(bucket, symbolInfo, seconds) {
  const useKrw = wantsKrw(symbolInfo);
  const cacheKey = `seconds:${seconds}:${useKrw ? "krw" : "native"}`;
  const cached = bucket.aggregateCache.get(cacheKey);
  if (cached?.version === bucket.version) return cached.bars;
  const bars = aggregateSeconds(bucket.ticks, useKrw, seconds);
  bucket.aggregateCache.set(cacheKey, {
    version: bucket.version,
    bars,
  });
  return bars;
}
function tickBarTime(bucket, count, group, actualTime) {
  let anchors = bucket.tickTimeAnchors.get(count);
  if (!anchors) bucket.tickTimeAnchors.set(count, anchors = new Map());
  if (!anchors.has(group)) anchors.set(group, Math.max(actualTime, (anchors.get(group - 1) ?? -Infinity) + 1));
  return anchors.get(group);
}
function cachedAggregateTickBars(bucket, symbolInfo, count) {
  const useKrw = wantsKrw(symbolInfo);
  const key = `ticks:${count}:${useKrw ? "krw" : "native"}`;
  const cached = bucket.aggregateCache.get(key);
  if (cached?.version === bucket.version) return cached;
  const bars = [];
  let ordinal = bucket.tradeOffset;
  let lastCount = 0;
  let current = null;
  const firstCompleteGroup = Math.ceil(bucket.tradeOffset / count);
  for (const tick of bucket.ticks) {
    if (!isCountedTrade(tick)) continue;
    const group = Math.floor(ordinal / count);
    const position = ordinal % count;
    ordinal += 1;
    if (group < firstCompleteGroup) continue; // 보관 한도로 앞부분이 잘린 첫 봉은 표시하지 않는다.
    const price = tickPrice(tick, useKrw);
    if (position === 0) {
      current = createBar(tickBarTime(bucket, count, group, tick.time), price, tick.volume);
      bars.push(current);
    } else {
      updateBar(current, price, tick.volume);
    }
    lastCount = position + 1;
  }
  const result = { bars, lastCount, ordinal, version: bucket.version };
  bucket.aggregateCache.set(key, result);
  return result;
}
