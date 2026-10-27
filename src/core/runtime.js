function createWorkerHub() {
  const messageHandlers = new Set();
  const patchedPorts = new WeakSet();
  const NativeSharedWorker = window.SharedWorker;
  const report = (kind, error) => console.error(`[Toss Integrated] ${kind} handler failed`, error);
  function dispatchWorkerMessage(data, metadata) {
    for (const handler of [...messageHandlers])
      try {
        handler(data, metadata);
      } catch (error) {
        report("SharedWorker", error);
      }
  }
  if (typeof NativeSharedWorker === "function")
    window.SharedWorker = new Proxy(NativeSharedWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget);
        let url = String(args[0] ?? "");
        try {
          url = new URL(args[0], location.href).href;
        } catch {}
        const port = worker.port;
        const metadata = {
          url,
          options: args[1] ?? null,
          createdAt: new Date().toISOString(),
        };
        if (port && !patchedPorts.has(port)) {
          patchedPorts.add(port);
          port.addEventListener.call(
            port,
            "message",
            (event) => {
              dispatchWorkerMessage(event.data, metadata);
            },
            true,
          );
        }
        return worker;
      },
    });
  return {
    onMessage: (handler) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
  };
}

function createWebpackHub() {
  const handlers = new Set();
  const installedArrays = new WeakSet();
  let chunks;
  function dispatch(payload) {
    for (const handler of [...handlers])
      try {
        handler(payload);
      } catch (error) {
        console.error("[Toss Integrated] webpack handler failed", error);
      }
  }
  function install(candidate) {
    if (!Array.isArray(candidate)) candidate = [];
      if (installedArrays.has(candidate)) return candidate;
    for (const payload of candidate) dispatch(payload);
    const descriptor = Object.getOwnPropertyDescriptor(candidate, "push");
    let downstream = candidate.push;
    let insidePush = false;
    const integratedPush = function (...payloads) {
      if (insidePush) return Array.prototype.push.apply(candidate, payloads);
      for (const payload of payloads) dispatch(payload);
      insidePush = true;
      try {
        return downstream.apply(candidate, payloads);
      } finally {
        insidePush = false;
      }
    };
    Object.defineProperty(candidate, "push", {
      configurable: true,
      get: () => integratedPush,
      set(nextPush) {
        if (typeof nextPush === "function" && nextPush !== integratedPush) downstream = (...items) => nextPush.apply(candidate, items);
        else if (descriptor?.set) descriptor.set.call(candidate, nextPush);
      },
    });
    installedArrays.add(candidate);
    return candidate;
  }
  const existingDescriptor = Object.getOwnPropertyDescriptor(window, "webpackChunk_N_E");
  chunks = install(Array.isArray(window.webpackChunk_N_E) ? window.webpackChunk_N_E : []);
  if (!(existingDescriptor && !existingDescriptor.configurable))
    Object.defineProperty(window, "webpackChunk_N_E", {
      configurable: true,
      enumerable: existingDescriptor?.enumerable ?? true,
      get: () => chunks,
      set: (value) => {
        chunks = install(value);
      },
    });
  return {
    add(handler) {
      if (!handlers.has(handler)) {
        handlers.add(handler);
        for (const payload of chunks) handler(payload);
      }
    },
    transformFactories(transform) {
      this.add((chunk) => {
        const modules = chunk?.[1];
        if (!modules || typeof modules !== "object") return;
        for (const [moduleId, factory] of Object.entries(modules)) {
          if (typeof factory !== "function") continue;
          try {
            const replacement = transform(factory, moduleId);
            if (typeof replacement === "function") modules[moduleId] = replacement;
          } catch (error) {
            console.error(`[BetterTossInvest] 모듈 ${moduleId} 변환 실패`, error);
          }
        }
      });
    },
  };
}

const runtime = {
  edition: "release",
  version: VERSION,
  settings,
  modules: {},
  workerHub: createWorkerHub(),
  webpackHub: createWebpackHub(),
  chartHub: null,
  localCharts: null,
  navigationWorkPaused,
  openSettings: null,
};

Object.defineProperty(window, "__TOSS_INTEGRATED__", {
  configurable: false,
  enumerable: false,
  value: runtime,
});
