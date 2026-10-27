function installFastRealtime(moduleState) {
  const ORIGINAL_BATCH_INTERVALS = new Set([100, 200]);
  const FRAME_INTERVAL = Math.min(1_000, Math.max(8, Math.round(settings.noWait.intervalMs)));
  const state = Object.assign(moduleState, {
    version: VERSION,
    intervalMs: FRAME_INTERVAL,
    active: false,
  });
  Object.defineProperty(window, "__TOSS_FAST_REALTIME__", {
    configurable: true,
    value: state,
  });
  function looksLikeRealtimeFactory(source) {
    return (
      source.includes("throttleInterval") &&
      source.includes("backgroundSubscribed") &&
      source.includes("lastMessage") &&
      source.includes("globalTimer") &&
      source.includes("getIsConnected") &&
      /\.d\([^,]+,\{\s*[A-Za-z_$][\w$]*:\(\)=>[A-Za-z_$][\w$]*\s*\}\)/.test(source)
    );
  }
  state.patchedModules = [];
  state.adjustOptions = (options) => {
    const requestedInterval = options?.throttleInterval ?? 200;
    return ORIGINAL_BATCH_INTERVALS.has(requestedInterval)
      ? { ...options, throttleInterval: FRAME_INTERVAL }
      : options;
  };
  runtime.webpackHub.transformFactories((factory, moduleId) => {
    const replacement = rewriteFactory(factory, moduleId, (source) => {
      if (!looksLikeRealtimeFactory(source)) return null;
      // React.use/useContext, 오류 처리, 메시지 검증 및 구독 해제는 사이트 구현을 유지한다.
      // 구독 시 전달되는 배치 간격만 변경한다.
      return source.replace(
        /\bsubscribe:\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)=>\{/g,
        (match, _destination, _callback, options) =>
          `${match}${options}=window.__TOSS_INTEGRATED__.modules.noWait.adjustOptions(${options});`,
      );
    }, state, "실시간 시세");
    if (replacement) state.active = true;
    return replacement;
  });
  // 사이트 구조 변경으로 대상 모듈을 찾지 못하면 한 번만 알린다.
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      if (!state.active) console.warn("[TossFastRealtime] realtime client module was not found. The Toss bundle may have changed.");
    },
    {
      once: true,
    },
  );
}
