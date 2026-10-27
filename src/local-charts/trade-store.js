function isCountedTrade(tick) {
  return tick.isTrade === true && tick.volume > 0;
}

function createTradeStore({ maxTicksPerSymbol, maxSymbolBuckets, currentInstrumentCode, onError }) {
  const tickBuckets = new Map();
  const tickListeners = new Set();

  function getBucket(code) {
    let bucket = tickBuckets.get(code);
    if (!bucket) {
      while (tickBuckets.size >= maxSymbolBuckets) {
        const currentCode = currentInstrumentCode();
        let oldestCode = tickBuckets.keys().next().value;
        for (const candidate of tickBuckets.keys())
          if (candidate !== currentCode) {
            oldestCode = candidate;
            break;
          }
        if (null == oldestCode) break;
        tickBuckets.delete(oldestCode);
      }
      bucket = {
        ticks: [],
        seen: new Set(),
        version: 0,
        aggregateCache: new Map(),
        tradeOffset: 0,
        tickTimeAnchors: new Map(),
        discardedThrough: null,
        lastMutation: "append",
      };
      tickBuckets.set(code, bucket);
    }
    return bucket;
  }
  function tickIdentity(tick) {
    const utcDay = Math.floor(tick.time / 86_400_000);
    return null != tick.cumulativeVolume
      ? `${utcDay}|cum:${tick.cumulativeVolume}`
      : [tick.time, tick.priceUsd ?? "", tick.priceKrw ?? "", tick.volume].join("|");
  }
  function notifyTick(code, tick) {
    for (const listener of tickListeners)
      try {
        listener(code, tick);
      } catch (error) {
        onError(error);
      }
  }
  function compareTicks(left, right) {
    return left.time - right.time ||
      (left.cumulativeVolume != null && right.cumulativeVolume != null ? left.cumulativeVolume - right.cumulativeVolume : 0);
  }
  function insertTick(bucket, tick) {
    const last = bucket.ticks[bucket.ticks.length - 1];
    bucket.lastMutation = !last || compareTicks(last, tick) <= 0 ? "append" : "insert";
    if (bucket.lastMutation === "append") bucket.ticks.push(tick);
    else {
      let low = 0;
      let high = bucket.ticks.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareTicks(bucket.ticks[middle], tick) <= 0) low = middle + 1;
        else high = middle;
      }
      bucket.ticks.splice(low, 0, tick);
      bucket.tickTimeAnchors.clear();
    }
  }

  function trimBucket(bucket) {
    if (bucket.ticks.length <= maxTicksPerSymbol) return;
    const removeCount = Math.max(Math.min(5_000, Math.floor(maxTicksPerSymbol / 10)), bucket.ticks.length - maxTicksPerSymbol);
    const removed = bucket.ticks.splice(0, removeCount);
    for (const oldTick of removed) {
      bucket.seen.delete(tickIdentity(oldTick));
      if (isCountedTrade(oldTick)) bucket.tradeOffset += 1;
    }
    bucket.discardedThrough = removed.at(-1);
    for (const [count, anchors] of bucket.tickTimeAnchors) {
      const firstGroup = Math.floor(bucket.tradeOffset / count) - 1;
      for (const group of anchors.keys()) if (group < firstGroup) anchors.delete(group);
    }
  }

  function addTick(code, tick, notify = true) {
    if (!code || !tick || !Number.isFinite(tick.time)) return false;
    if (!Number.isFinite(tick.volume) || tick.volume < 0) return false;
    if (!Number.isFinite(tick.priceUsd) && !Number.isFinite(tick.priceKrw)) return false;
    const bucket = getBucket(code);
    if (bucket.discardedThrough && compareTicks(tick, bucket.discardedThrough) <= 0) return false;
    const identity = tickIdentity(tick);
    if (bucket.seen.has(identity)) return false;
    bucket.seen.add(identity);
    insertTick(bucket, tick);
    trimBucket(bucket);
    bucket.version += 1;
    bucket.aggregateCache.clear();
    if (notify) notifyTick(code, tick);
    return true;
  }

  return {
    getBucket, addTick, notifyTick,
    hasBucket: (code) => tickBuckets.has(code),
    onTick(listener) {
      tickListeners.add(listener);
      return () => tickListeners.delete(listener);
    },
  };
}
