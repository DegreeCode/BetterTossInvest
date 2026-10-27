function onDocumentReady(callback) {
  if (document.documentElement) callback();
  else document.addEventListener("DOMContentLoaded", callback, { once: true });
}

function readFactorySource(factory) {
  if (typeof factory !== "function") return null;
  try {
    return Function.prototype.toString.call(factory);
  } catch {
    return null;
  }
}

function rewriteFactory(factory, moduleId, transform, state, label) {
  const source = readFactorySource(factory);
  if (source === null) return null;
  try {
    const rewritten = transform(source);
    if (typeof rewritten !== "string" || rewritten === source) return null;
    const compiled = (0, eval)(`(${rewritten})`);
    if (!state.patchedModules.includes(String(moduleId))) state.patchedModules.push(String(moduleId));
    return compiled;
  } catch (error) {
    state.lastError = `${label} 모듈 변환 실패: ${String(error)}`;
    return null; // 번들 형식 또는 CSP가 바뀌면 원래 모듈을 보존한다.
  }
}

function configureChartFeatures(options, { enable = [], disable = [] }) {
  const enabled = new Set(Array.isArray(options.enabled_features) ? options.enabled_features : []);
  const disabled = new Set(Array.isArray(options.disabled_features) ? options.disabled_features : []);
  for (const feature of enable) {
    enabled.add(feature);
    disabled.delete(feature);
  }
  for (const feature of disable) {
    disabled.add(feature);
    enabled.delete(feature);
  }
  return { ...options, enabled_features: [...enabled], disabled_features: [...disabled] };
}

function createChartHub() {
  const features = new Map();
  const constructors = new WeakMap();
  const wrappers = new WeakSet();
  const namespaces = new WeakSet();
  const state = { patchedModules: [], lastError: null };
  let started = false;

  function report(feature, error) {
    runtime.modules[feature.key].lastError = `차트 연결 실패: ${String(error)}`;
    console.error(`[BetterTossInvest] ${feature.key}`, error);
  }

  function wrapWidget(original) {
    if (typeof original !== "function" || wrappers.has(original)) return original;
    if (constructors.has(original)) return constructors.get(original);
    function BetterTossWidget(...args) {
      const applied = [];
      if (isPlainObject(args[0])) {
        for (const feature of features.values()) {
          try {
            if (feature.accept && !feature.accept(args[0])) continue;
            args[0] = feature.transformOptions(args[0]);
            applied.push(feature);
          } catch (error) {
            report(feature, error);
          }
        }
      }
      const newTarget = new.target === BetterTossWidget ? original : new.target;
      const widget = Reflect.construct(original, args, newTarget || original);
      for (const feature of applied) {
        try {
          feature.onCreated?.(widget);
        } catch (error) {
          report(feature, error);
        }
      }
      return widget;
    }
    Object.setPrototypeOf(BetterTossWidget, original);
    BetterTossWidget.prototype = original.prototype;
    constructors.set(original, BetterTossWidget);
    wrappers.add(BetterTossWidget);
    return BetterTossWidget;
  }

  function watchProperty(target, key, transform) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    // 사이트 소유 접근자/읽기 전용 프로퍼티는 유지하고 webpack 경로로 보완한다.
    if (descriptor?.get || descriptor?.set || descriptor?.writable === false) {
      transform(target[key]);
      return;
    }
    if (descriptor && !descriptor.configurable) {
      target[key] = transform(target[key]);
      return;
    }
    let value = transform(target[key]);
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: () => value,
      set: (next) => { value = transform(next); },
    });
  }

  function patchNamespace(namespace) {
    if (!namespace || (typeof namespace !== "object" && typeof namespace !== "function")) return namespace;
    if (namespaces.has(namespace)) return namespace;
    try {
      watchProperty(namespace, "widget", wrapWidget);
      namespaces.add(namespace);
    } catch (error) {
      state.lastError = `TradingView 연결 실패: ${String(error)}`;
    }
    return namespace;
  }

  return {
    state,
    add(feature) { features.set(feature.key, feature); },
    wrapWidget,
    start() {
      if (started || features.size === 0) return;
      started = true;
      runtime.webpackHub.transformFactories((factory, moduleId) => rewriteFactory(factory, moduleId, (source) => {
        if (!source.includes("datafeed") || !source.includes("disabled_features")) return null;
        // v32의 ES 모듈은 widget을 HL 같은 이름으로 내보낸다.
        // 이름이 바뀐 생성자는 datafeed/library_path 옵션으로 식별한다.
        return source.replace(
          /new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(\s*\{(?=[^{}]*\bdatafeed\s*:)(?=[^{}]*\blibrary_path\s*:)|new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.widget)\s*\(\s*\{/g,
          (_match, constructor, legacyConstructor) =>
            `new (window.__TOSS_INTEGRATED__.chartHub.wrapWidget(${constructor ?? legacyConstructor}))({`,
        );
      }, state, "차트"));
      try {
        watchProperty(window, "TradingView", patchNamespace);
      } catch (error) {
        state.lastError = `TradingView 연결 실패: ${String(error)}`;
      }
      // 전역 후킹을 보완하기 위해 지연 로드를 제한된 횟수로 확인한다.
      for (const delay of [25, 100, 500, 1_500, 5_000, 10_000]) {
        setTimeout(() => patchNamespace(window.TradingView), delay);
      }
    },
  };
}

function initializeModule(key, install) {
  const state = runtime.modules[key] = { enabled: settings.modules[key], initialized: false, lastError: null };
  if (!state.enabled) return;
  try {
    install(state);
    state.initialized = true;
  } catch (error) {
    state.lastError = `초기화 실패: ${String(error)}`;
    console.error(`[BetterTossInvest] ${key}`, error);
  }
}
