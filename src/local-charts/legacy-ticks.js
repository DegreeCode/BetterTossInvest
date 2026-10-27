function installLegacyTickCompatibility(state, { ticksEnabled, isTickResolution }) {
  const legacyTickCompatibility = state.legacyTickCompatibility = { patchedModules: [], resolutionModules: [], lastError: null };
  const patchedTickWindows = new WeakSet();
  state.patchTickRuntime = (frameWindow) => {
    if (!ticksEnabled || !frameWindow || patchedTickWindows.has(frameWindow)) return;
    const patchedFactories = new WeakMap();
    const transformChunk = (chunk) => {
      for (const [id, factory] of Object.entries(chunk?.[1] ?? {})) {
        if (typeof factory !== "function") continue;
        const source = readFactorySource(factory) ?? "";
        if (!source.includes("findSuitableResolutionToBuildFrom") || !/\.multiplier\(\)>1/.test(source)) continue;
        let replacement = patchedFactories.get(factory);
        if (!replacement) {
          replacement = function (module, exports, require) {
            const interceptedRequire = new Proxy(require, {
              get(target, key) {
                if (key !== "d") return Reflect.get(target, key);
                return (destination, definitions) => {
                  const originalGetter = definitions.findSuitableResolutionToBuildFrom;
                  if (typeof originalGetter !== "function") return target.d(destination, definitions);
                  let wrapped;
                  target.d(destination, { ...definitions, findSuitableResolutionToBuildFrom: () => {
                    if (!wrapped) {
                      const original = originalGetter();
                      wrapped = function (resolution, info, ...args) {
                        // v27 rejects all N>1 tick intervals before getBars.
                        // Our feed already aggregates N trades, so use that
                        // exact interval only for symbols owned by this feed.
                        if (info?.__btiLocalTickBars === true && info["is-tickbars-available"] && isTickResolution(resolution) != null)
                          return { error: false, resolution: String(resolution) };
                        return original.call(this, resolution, info, ...args);
                      };
                    }
                    return wrapped;
                  } });
                };
              },
            });
            return factory.call(this, module, exports, interceptedRequire);
          };
          patchedFactories.set(factory, replacement);
          if (!legacyTickCompatibility.resolutionModules.includes(id)) legacyTickCompatibility.resolutionModules.push(id);
        }
        chunk[1][id] = replacement;
      }
    };
    const hookedArrays = new WeakSet();
    const install = (candidate) => {
      const chunks = Array.isArray(candidate) ? candidate : [];
      if (hookedArrays.has(chunks)) return chunks;
      for (const chunk of chunks) transformChunk(chunk);
      let downstream = chunks.push, insidePush = false;
      const push = function (...payloads) {
        if (insidePush) return Array.prototype.push.apply(chunks, payloads);
        for (const payload of payloads) transformChunk(payload);
        insidePush = true;
        try { return downstream.apply(chunks, payloads); }
        finally { insidePush = false; }
      };
      Object.defineProperty(chunks, "push", {
        configurable: true, get: () => push,
        set: (next) => { if (typeof next === "function" && next !== push) downstream = next; },
      });
      hookedArrays.add(chunks);
      return chunks;
    };
    let chunks = install(frameWindow.webpackChunktradingview);
    Object.defineProperty(frameWindow, "webpackChunktradingview", {
      configurable: true, get: () => chunks, set: (next) => { chunks = install(next); },
    });
    patchedTickWindows.add(frameWindow);
  };
  if (ticksEnabled) runtime.webpackHub.transformFactories((factory, id) => rewriteFactory(factory, id, (source) => {
    if (!source.includes("TT v27.") || !source.includes("_render(") || !source.includes('<meta charset="utf-8">')) return null;
    // Install inside the iframe before its deferred runtime scripts execute.
    // This also works when TradingView loads the frame through a Blob URL.
    return source.replace('<meta charset="utf-8">', '<meta charset="utf-8"><script>parent.__TOSS_INTEGRATED__.localCharts.patchTickRuntime(window)</script>');
  }, legacyTickCompatibility, "v27 틱봉"));
}
