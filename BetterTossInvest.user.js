// ==UserScript==
// @name         BetterTossInvest
// @name:ko      BetterTossInvest
// @namespace    better-toss-invest
// @version      1.5.0
// @description  매수·매도 호가선, 국내주식 중간호가, 할로우 캔들 복원, 지수 차트 조작, 초 단위 차트, 화면 갱신 간격 설정 기능을 추가합니다.
// @match        https://www.tossinvest.com/*
// @match        https://tossinvest.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // 설정
  // ---------------------------------------------------------------------------
  const VERSION = "1.5.0";
  const SETTINGS_KEY = "better-toss-invest-settings-v1-release";
  if (window.__TOSS_INTEGRATED__) {
    console.warn("[Toss Integrated] 다른 통합판이 이미 실행 중이라 현재 스크립트를 중단합니다.");
    return;
  }
  const DEFAULTS = {
    modules: {
      bidAsk: true,
      midQuote: true,
      hollowCandles: true,
      indexChartUnlock: true,
      enableSec: false,
      noWait: true,
    },
    bidAsk: {
      maxCachedSymbols: 1_000,
    },
    midQuote: {
      insertIntoOrderBook: false,
      alwaysShow: false,
      compactRows: false,
      showVolume: true,
      hideSideInfo: false,
    },
    enableSec: {
      presets: [1, 3, 5, 10, 15, 30, 60],
      maxTicksPerSymbol: 50_000,
      maxSymbolBuckets: 6,
    },
    noWait: {
      intervalMs: 16,
    },
  };
  const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  }
  function normalizeSettings(value) {
    const settings = (function mergeSettings(base, stored) {
      const result = structuredClone(base);
      const merge = (target, source) => {
        if (isPlainObject(source))
          for (const [key, value] of Object.entries(source))
            if (Object.hasOwn(target, key)) {
              if (isPlainObject(target[key])) {
                if (isPlainObject(value)) merge(target[key], value);
              } else if (typeof target[key] !== "boolean" || typeof value === "boolean") target[key] = value;
            }
      };
      merge(result, stored);
      return result;
    })(DEFAULTS, value);
    for (const key of Object.keys(settings.modules)) settings.modules[key] = !!settings.modules[key];
    for (const key of Object.keys(DEFAULTS.midQuote)) settings.midQuote[key] = !!settings.midQuote[key];
    settings.bidAsk.maxCachedSymbols = clampNumber(settings.bidAsk.maxCachedSymbols, 1_000, 10, 10_000);
    settings.enableSec.maxTicksPerSymbol = clampNumber(settings.enableSec.maxTicksPerSymbol, 50_000, 1_000, 200_000);
    settings.enableSec.maxSymbolBuckets = clampNumber(settings.enableSec.maxSymbolBuckets, 6, 1, 30);
    const presets = Array.isArray(settings.enableSec.presets) ? settings.enableSec.presets : [];
    settings.enableSec.presets = [
      ...new Set(presets.map((item) => clampNumber(item, 0, 1, 60)).filter((item) => item >= 1 && item <= 60)),
    ].sort((a, b) => a - b);
    if (0 === settings.enableSec.presets.length) settings.enableSec.presets = [...DEFAULTS.enableSec.presets];
    settings.noWait.intervalMs = clampNumber(settings.noWait.intervalMs, 16, 8, 1_000);
    return settings;
  }
  const settings = (function loadSettings() {
    try {
      return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null"));
    } catch {
      return normalizeSettings(null);
    }
  })();

  // ---------------------------------------------------------------------------
  // SPA 이동 중 고빈도 작업 일시 정지
  // ---------------------------------------------------------------------------

  let navigationQuietUntil = 0;
  let navigationSourceUrl = "";
  function navigationWorkPaused() {
    const now = performance.now();
    if (now >= navigationQuietUntil) return false;

    // SPA 라우터가 URL을 바꾼 뒤에는 새 화면 초기화에 필요한 짧은 여유만 둔다.
    if (navigationSourceUrl && location.href !== navigationSourceUrl) {
      navigationSourceUrl = location.href;
      navigationQuietUntil = Math.min(navigationQuietUntil, now + 250);
    }
    return true;
  }

  // 토스 내부 링크를 누르면 고빈도 화면 갱신을 잠시 멈춰
  // React 라우터가 메인 스레드를 바로 사용할 수 있게 한다. 새 탭 링크는 제외한다.
  function handleNavigationIntent(event) {
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    try {
      const target = new URL(anchor.href, location.href);
      if (target.origin === location.origin && target.href !== location.href) {
        navigationSourceUrl = location.href;
        navigationQuietUntil = performance.now() + 2_000;
      }
    } catch {
      // 브라우저가 해석할 수 없는 링크는 사이트 원래 동작에 맡긴다.
    }
  }
  // pointerdown 시점부터 잠시 멈추고, 키보드로 링크를 여는 경우는 click 이벤트로 보완한다.
  document.addEventListener("pointerdown", handleNavigationIntent, true);
  document.addEventListener("click", handleNavigationIntent, true);

  // ---------------------------------------------------------------------------
  // 토스 런타임 연결 지점
  // ---------------------------------------------------------------------------

  const runtime = {
    edition: "release",
    version: VERSION,
    settings,
    modules: {},
    workerHub: (function () {
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
    })(),
    webpackHub: (function () {
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
        if ((Array.isArray(candidate) || (candidate = []), installedArrays.has(candidate))) return candidate;
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
    })(),
    chartHub: null,
    navigationWorkPaused,
    openSettings: null,
  };

  // ---------------------------------------------------------------------------
  // 공통 초기화와 TradingView 연결
  // ---------------------------------------------------------------------------

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
          return source.replace(
            /new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.widget\s*\(\s*\{/g,
            (_match, namespace) => `new (window.__TOSS_INTEGRATED__.chartHub.wrapWidget(${namespace}.widget))({`,
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

  // ---------------------------------------------------------------------------
  // BetterTossInvest 설정 화면
  // ---------------------------------------------------------------------------

  function installNativeSettingsTab({ shadow, open, close }) {
    const MODAL_SELECTOR = '[data-overlay-name="통합설정모달"][data-section-name="설정"]';
    const ITEM_SELECTOR = '[data-parent-name="CategorySidebar"]';
    const gear = shadow.getElementById("gear");
    const backdrop = shadow.getElementById("backdrop");
    const panel = shadow.getElementById("panel");
    const panelHeader = panel?.querySelector(":scope > header");
    let frame = null;
    let activeModal = null;
    let activeTab = null;
    let titleRecord = null;
    let nativeStateRecords = [];
    if (!document.getElementById("bti-native-tab-state-style")) {
      const stateStyle = document.createElement("style");
      stateStyle.id = "bti-native-tab-state-style";
      stateStyle.textContent = `
        [data-bti-native-suppressed="true"],
        [data-bti-native-suppressed="true"]::before,
        [data-bti-native-suppressed="true"]::after,
        [data-bti-native-suppressed="true"] * {
          background-color:transparent!important;
          box-shadow:none!important;
        }
      `;
      (document.head ?? document.documentElement).appendChild(stateStyle);
    }
    if ((gear && (gear.hidden = true), panelHeader && (panelHeader.hidden = true), backdrop && panel)) {
      Object.assign(backdrop.style, {
        inset: "auto",
        right: "auto",
        bottom: "auto",
        background: "transparent",
        placeItems: "stretch",
      });
      Object.assign(panel.style, {
        width: "100%",
        height: "100%",
        maxHeight: "none",
        borderRadius: "0",
        boxShadow: "none",
      });
      const themeStyle = document.createElement("style");
      themeStyle.textContent = `
        #panel,.actions{background:var(--bti-native-bg,#fff)!important;color:var(--bti-native-fg,#171b22)!important}
        #panel{font-family:var(--bti-native-font,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif)!important;font-size:var(--bti-native-font-size,14px)!important}
        #panel .content{padding:16px 24px 4px!important}
        #panel fieldset{border:0!important;border-radius:0!important;margin:0 0 24px!important;padding:0!important}
        #panel legend{padding:0!important;margin:0 0 6px!important;color:color-mix(in srgb,var(--bti-native-fg,#171b22) 58%,transparent)!important;font-size:13px!important}
        #panel .row{min-height:52px!important;padding:0 2px;border-bottom:1px solid color-mix(in srgb,var(--bti-native-fg,#171b22) 9%,transparent);font-size:14px!important}
        #panel .row:last-child{border-bottom:0}
        #panel input[type="text"],#panel input[type="number"]{background:transparent!important;color:inherit!important;border-color:color-mix(in srgb,var(--bti-native-fg,#171b22) 18%,transparent)!important}
        #panel input[type="checkbox"]{appearance:none;width:40px!important;height:24px!important;border-radius:999px;background:color-mix(in srgb,var(--bti-native-fg,#171b22) 18%,transparent);position:relative;cursor:pointer;transition:background .15s ease}
        #panel input[type="checkbox"]::after{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:transform .15s ease}
        #panel input[type="checkbox"]:checked{background:#3182f6}
        #panel input[type="checkbox"]:checked::after{transform:translateX(16px)}
        #panel .actions{box-sizing:border-box;min-height:62px;align-items:center;padding:10px 24px!important}
        #panel .actions button{box-sizing:border-box;width:auto;height:40px;min-height:40px;padding:0 14px!important;border-radius:10px!important;font-family:inherit!important;font-size:14px!important;line-height:20px!important;font-weight:600}
      `;
      shadow.appendChild(themeStyle);
    }
    function directText(element) {
      return String(element?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
    }
    function findRightColumn(modal, aside) {
      let current = aside;
      for (; current && current !== modal; ) {
        const parent = current.parentElement;
        if (!parent) break;
        const sibling = [...parent.children].find((candidate) => {
          if (candidate === current || candidate.contains(aside)) return false;
          const rect = candidate.getBoundingClientRect();
          return rect.width >= 320 && rect.height >= 300;
        });
        if (sibling) return sibling;
        current = parent;
      }
      return modal;
    }
    function positionPanel(modal, column) {
      if (!backdrop || !panel) return;
      const modalRect = modal.getBoundingClientRect();
      const columnRect = column.getBoundingClientRect();
      const headerHeight = columnRect.top <= modalRect.top + 8 && columnRect.height > modalRect.height - 90 ? 64 : 0;
      const left = column === modal ? Math.min(200, 0.3 * modalRect.width) : 0;
      const width = column === modal ? modalRect.width - left : columnRect.width;
      if ("static" === getComputedStyle(column).position) column.style.position = "relative";
      if (shadow.host.parentElement !== column) column.appendChild(shadow.host);
      Object.assign(shadow.host.style, {
        position: "absolute",
        left: `${Math.round(left)}px`,
        top: `${headerHeight}px`,
        width: `${Math.round(width)}px`,
        height: `${Math.round(Math.max(0, columnRect.height - headerHeight))}px`,
        zIndex: "2147483647",
      });
      Object.assign(backdrop.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
      });
      const style = getComputedStyle(column);
      const modalStyle = getComputedStyle(modal);
      panel.style.setProperty(
        "--bti-native-bg",
        (function (column, modal) {
          for (const element of [column, modal, document.body]) {
            const value = getComputedStyle(element).backgroundColor;
            if (value && "rgba(0, 0, 0, 0)" !== value && "transparent" !== value) return value;
          }
          return "#fff";
        })(column, modal),
      );
      panel.style.setProperty("--bti-native-fg", style.color || modalStyle.color || "#171b22");
      panel.style.setProperty("--bti-native-font", style.fontFamily || modalStyle.fontFamily || "-apple-system, sans-serif");
      panel.style.setProperty("--bti-native-font-size", style.fontSize || modalStyle.fontSize || "14px");
    }
    function captureTabLook(element) {
      const style = element ? getComputedStyle(element) : null;
      return {
        backgroundColor: style?.backgroundColor || "rgba(0, 0, 0, 0)",
        color: style?.color || "",
        fontWeight: style?.fontWeight || "400",
      };
    }
    function restoreNativeSelection() {
      for (const record of nativeStateRecords) {
        for (const [name, value] of Object.entries(record.attributes))
          if (null == value) record.item.removeAttribute(name);
          else record.item.setAttribute(name, value);
        record.item.removeAttribute("data-bti-native-suppressed");
      }
      nativeStateRecords = [];
    }
    function setTabSelected(tab, selected) {
      tab.dataset.btiSelected = String(selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("aria-checked", String(selected));
      tab.setAttribute("data-state", selected ? "on" : "off");
      const look = selected ? tab.__btiSelectedLook : tab.__btiNormalLook;
      if (look) {
        tab.style.backgroundColor =
          selected && "rgba(0, 0, 0, 0)" === look.backgroundColor ? "color-mix(in srgb,currentColor 9%,transparent)" : look.backgroundColor;
        tab.style.color = look.color;
        tab.style.fontWeight = look.fontWeight;
      } else {
        tab.style.backgroundColor = "";
        tab.style.color = "";
        tab.style.fontWeight = "";
      }
    }
    function hideCustomPanel() {
      close();
      if (activeTab) setTabSelected(activeTab, false);
      restoreNativeSelection();
      if (titleRecord?.node?.isConnected && "BetterTossInvest" === directText(titleRecord.node))
        titleRecord.node.textContent = titleRecord.text;
      titleRecord = null;
    }
    function installIntoModal(modal) {
      const aside = modal.querySelector("aside");
      if (!aside) return null;
      const nativeItems = [...aside.querySelectorAll(ITEM_SELECTOR)].filter((item) => !item.hasAttribute("data-bti-native-tab"));
      if (0 === nativeItems.length) return null;
      let tab = aside.querySelector("[data-bti-native-tab]");
      if (!tab) {
        const template =
          [...nativeItems].reverse().find((item) => "none" !== getComputedStyle(item).pointerEvents) ?? nativeItems[nativeItems.length - 1];
        const selectedSample = nativeItems.find(
          (item) => "on" === item.getAttribute("data-state") || "true" === item.getAttribute("aria-selected"),
        );
        const metricSample = nativeItems.find((item) => "일반" === directText(item)) ?? selectedSample ?? template;
        const previousLabel = directText(template);
        tab = template.cloneNode(true);
        for (const node of [tab, ...tab.querySelectorAll("[id]")]) node.removeAttribute("id");
        tab.setAttribute("data-bti-native-tab", "true");
        tab.setAttribute("data-content-value", "BetterTossInvest");
        tab.setAttribute("value", "better-toss-invest");
        tab.removeAttribute("data-component-id");
        tab.style.pointerEvents = "";
        (function (tab, previousLabel) {
          const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
          const textNodes = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) if (String(node.nodeValue ?? "").trim()) textNodes.push(node);
          const target = textNodes.find((node) => String(node.nodeValue ?? "").trim() === previousLabel) ?? textNodes[textNodes.length - 1];
          if (!target) {
            tab.append("BetterTossInvest");
            return;
          }
          const raw = String(target.nodeValue ?? "");
          target.nodeValue = `${raw.match(/^\s*/)?.[0] ?? ""}BetterTossInvest${raw.match(/\s*$/)?.[0] ?? ""}`;
        })(tab, previousLabel);
        (function (tab) {
          tab.style.setProperty("border-radius", "10px", "important");
          tab.style.setProperty("overflow", "hidden", "important");
        })(tab);
        tab.__btiNormalLook = captureTabLook(template);
        tab.__btiSelectedLook = captureTabLook(selectedSample ?? metricSample);
        setTabSelected(tab, false);
        tab.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          (function (modal, aside, tab) {
            const column = findRightColumn(modal, aside);
            const title = (function (column, modal) {
              const modalRect = modal.getBoundingClientRect();
              const known = new Set(["일반", "거래", "알림", "커뮤니티", "단축키", "보안", "Open API"]);
              return (
                [...column.querySelectorAll("*")]
                  .filter((candidate) => {
                    const rect = candidate.getBoundingClientRect();
                    const isInContentColumn = column !== modal || rect.left >= modalRect.left + Math.min(180, 0.26 * modalRect.width);
                    return (
                      known.has(directText(candidate)) &&
                      isInContentColumn &&
                      rect.width > 0 &&
                      rect.height > 0 &&
                      rect.height <= 64 &&
                      rect.top >= modalRect.top &&
                      rect.top < modalRect.top + 90
                    );
                  })
                  .sort((a, b) => {
                    const aRect = a.getBoundingClientRect();
                    const bRect = b.getBoundingClientRect();
                    return aRect.width * aRect.height - bRect.width * bRect.height;
                  })[0] ?? null
              );
            })(column, modal);
            if (title) {
              titleRecord = {
                node: title,
                text: directText(title),
              };
              title.textContent = "BetterTossInvest";
            }
            restoreNativeSelection();
            for (const item of aside.querySelectorAll(ITEM_SELECTOR))
              if (item !== tab) {
                const selected =
                  "on" === item.getAttribute("data-state") ||
                  "true" === item.getAttribute("aria-selected") ||
                  "true" === item.getAttribute("aria-checked");
                nativeStateRecords.push({
                  item,
                  attributes: {
                    "data-state": item.getAttribute("data-state"),
                    "aria-selected": item.getAttribute("aria-selected"),
                    "aria-checked": item.getAttribute("aria-checked"),
                  },
                });
                if (selected) item.setAttribute("data-bti-native-suppressed", "true");
                item.setAttribute("aria-selected", "false");
                item.setAttribute("aria-checked", "false");
                item.setAttribute("data-state", "off");
              }
            setTabSelected(tab, true);
            positionPanel(modal, column);
            open();
            activeModal = modal;
            activeTab = tab;
          })(modal, aside, tab);
        });
        template.parentElement?.appendChild(tab);
      }
      if (!aside.dataset.btiNativeListener) {
        aside.dataset.btiNativeListener = "true";
        aside.addEventListener(
          "click",
          (event) => {
            const item = event.target instanceof Element ? event.target.closest(ITEM_SELECTOR) : null;
            if (item && !item.hasAttribute("data-bti-native-tab")) hideCustomPanel();
          },
          true,
        );
      }
      return tab;
    }
    function scan() {
      frame = null;
      const modal = document.querySelector(MODAL_SELECTOR);
      if (!modal)
        return (
          activeModal && hideCustomPanel(),
          shadow.host.isConnected || (shadow.host.removeAttribute("style"), document.documentElement.appendChild(shadow.host)),
          (activeModal = null),
          void (activeTab = null)
        );
      const tab = installIntoModal(modal);
      if (tab && activeModal === modal && !backdrop.hidden) {
        activeTab = tab;
        positionPanel(modal, findRightColumn(modal, modal.querySelector("aside")));
      }
    }
    function scheduleScan() {
      if (null == frame) frame = requestAnimationFrame(scan);
    }
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", scheduleScan, {
      passive: true,
    });
    scheduleScan();
    runtime.openSettings = async () => {
      let modal = document.querySelector(MODAL_SELECTOR);
      if (!modal) {
        const trigger = document.querySelector(
          '[data-content-value="설정"][data-clickable="true"],button[aria-label="설정"],button[title="설정"]',
        );
        trigger?.click();
        for (let attempt = 0; attempt < 40 && !modal; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          modal = document.querySelector(MODAL_SELECTOR);
        }
      }
      if (!modal) return false;
      const tab = installIntoModal(modal);
      tab?.click();
      return !!tab;
    };
  }
  function mountSettings() {
    if (!document.documentElement || document.getElementById("toss-integrated-settings-host")) return;
    const host = document.createElement("div");
    host.id = "toss-integrated-settings-host";
    const shadow = host.attachShadow({
      mode: "open",
    });
    shadow.innerHTML = `
      <style>
        :host{all:initial;position:fixed;width:0;height:0;inset:0 auto auto 0;z-index:2147483647}button,input{font:inherit}#gear{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:40px;height:40px;border:1px solid #d8dee8;border-radius:14px;background:#fff;color:#202632;box-shadow:0 5px 22px #0002;cursor:pointer;font-size:19px}#backdrop{position:fixed;inset:0;z-index:2147483647;background:#0007;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171b22}#backdrop[hidden]{display:none}#panel{width:min(620px,calc(100vw - 28px));max-height:min(820px,calc(100vh - 28px));overflow:auto;background:#fff;border-radius:18px;box-shadow:0 22px 70px #0005}header{position:sticky;top:0;background:#fff;padding:20px 22px 14px;border-bottom:1px solid #edf0f4;z-index:1}h2{font-size:19px;margin:0 0 5px}header p,.hint{margin:0;color:#6b7480;font-size:12px}.content{padding:16px 22px 4px}fieldset{border:1px solid #e3e7ed;border-radius:13px;margin:0 0 14px;padding:12px 14px}legend{font-weight:700;font-size:14px;padding:0 6px}.row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(150px,240px);align-items:center;gap:12px;min-height:36px;font-size:13px}.row label:first-child{line-height:1.35}.field-label{justify-self:start;max-width:100%;cursor:help;text-decoration:underline dotted #b0b8c1;text-decoration-thickness:1px;text-underline-offset:3px}.row input[type="text"],.row input[type="number"]{box-sizing:border-box;width:100%;border:1px solid #cfd6df;border-radius:8px;padding:7px 9px}.row input[type="checkbox"]{justify-self:end;width:18px;height:18px}.actions{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:8px;padding:14px 22px;background:#fff;border-top:1px solid #edf0f4}.actions button{border:0;border-radius:9px;padding:9px 14px;cursor:pointer}.secondary{background:#eef1f5;color:#343b45}.primary{background:#2879ff;color:#fff}.danger{margin-right:auto;background:#fff0f0;color:#c0392b}@media(max-width:520px){.row{grid-template-columns:1fr auto}.row input[type="text"],.row input[type="number"]{grid-column:1/-1}.content{padding-inline:14px}header,.actions{padding-inline:16px}}
      </style>
      <button id="gear" title="BetterTossInvest 설정" aria-label="BetterTossInvest 설정">⚙</button>
      <div id="backdrop" hidden>
        <section id="panel" role="dialog" aria-modal="true" aria-labelledby="title">
          <header><h2 id="title">BetterTossInvest 설정</h2><p>저장하면 페이지를 새로고침한 뒤 적용됩니다.</p></header>
          <div class="content" id="content"></div>
          <div class="actions"><button class="danger" id="reset">기본값으로 초기화</button><button class="secondary" id="cancel">취소</button><button class="primary" id="save">저장하고 새로고침</button></div>
        </section>
      </div>`;
    const content = shadow.getElementById("content");
    const tooltip = document.createElement("div");
    const tooltipArrow = document.createElement("span");
    const tooltipText = document.createElement("span");
    tooltip.id = "better-toss-invest-settings-tooltip";
    tooltip.hidden = true;
    tooltip.setAttribute("role", "tooltip");
    Object.assign(tooltip.style, {
      position: "fixed",
      zIndex: "2147483647",
      boxSizing: "border-box",
      width: "max-content",
      maxWidth: "min(340px, calc(100vw - 24px))",
      padding: "8px 10px",
      borderRadius: "8px",
      background: "#202632",
      color: "#fff",
      boxShadow: "0 6px 20px #0004",
      font: '12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      whiteSpace: "normal",
      pointerEvents: "none",
    });
    Object.assign(tooltipArrow.style, {
      position: "absolute",
      width: "0",
      height: "0",
      borderLeft: "6px solid transparent",
      borderRight: "6px solid transparent",
    });
    tooltip.append(tooltipArrow, tooltipText);
    const controls = new Map();
    let tooltipTarget = null;
    const hideTooltip = () => {
      tooltipTarget = null;
      tooltip.hidden = true;
    };
    const setPath = (object, path, value) => {
      const keys = path.split(".");
      const last = keys.pop();
      const target = keys.reduce((value, key) => value[key], object);
      target[last] = value;
    };
    const fieldset = (title) => {
      const element = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = title;
      element.appendChild(legend);
      content.appendChild(element);
      return element;
    };
    const addField = (group, label, path, description, type = "checkbox", attributes = {}) => {
      const row = document.createElement("div");
      row.className = "row";
      const caption = document.createElement("label");
      caption.className = "field-label";
      caption.textContent = label;
      if (description) caption.dataset.description = description;
      const input = document.createElement("input");
      input.type = type;
      input.dataset.path = path;
      input.id = `bti-setting-${path.replace(/[^a-z0-9]+/gi, "-")}`;
      input.setAttribute("aria-label", description ? `${label}. ${description}` : label);
      caption.htmlFor = input.id;
      for (const [key, value] of Object.entries(attributes)) input.setAttribute(key, value);
      const current = ((object, path) => path.split(".").reduce((value, key) => value?.[key], object))(settings, path);
      if ("checkbox" === type) input.checked = !!current;
      else input.value = "enableSec.presets" === path ? current.join(", ") : String(current ?? "");
      controls.set(path, input);
      row.append(caption, input);
      group.appendChild(row);
    };
    const settingGroups = [
      [
        "사용할 기능",
        [
          ["매수·매도 호가선", "modules.bidAsk", "차트에 현재 매수 1호가와 매도 1호가를 실시간 선으로 표시합니다."],
          ["국내주식 중간호가 개선", "modules.midQuote", "국내주식의 KRX·NXT 중간호가 표시 방식과 수량 정보를 개선합니다."],
          ["할로우 캔들 복원", "modules.hollowCandles", "투명캔들을 TradingView 기본 할로우 캔들로 복원합니다. 차트 유형에서 할로우 캔들을 선택하세요."],
          ["지수 차트 조작", "modules.indexChartUnlock", "지수 상세 차트의 이동, 확대·축소, 가격축 조절과 차트 모양 선택을 활성화합니다."],
          ["초 단위 차트", "modules.enableSec", "차트의 시간 단위 메뉴에 선택한 초봉 주기를 추가합니다."],
          ["실시간 시세 갱신", "modules.noWait", "실시간 시세를 설정한 간격으로 묶어 화면에 빠르게 반영합니다."],
        ],
      ],
      [
        "매수·매도 호가선",
        [
          [
            "최대 보관 종목 수",
            "bidAsk.maxCachedSymbols",
            "호가선 표시를 위해 메모리에 보관할 종목별 최신 호가의 최대 개수입니다.",
            "number",
            {
              min: 10,
              max: 10_000,
            },
          ],
        ],
      ],
      [
        "국내주식 중간호가",
        [
          ["호가창 안에 중간호가 표시", "midQuote.insertIntoOrderBook", "KRX·NXT 중간호가를 매도호가와 매수호가 사이에 추가합니다."],
          ["수량 없이도 항상 표시", "midQuote.alwaysShow", "호가 수량이 0이거나 없더라도 유효한 중간호가 가격은 표시합니다."],
          ["중간호가 행 높이 줄이기", "midQuote.compactRows", "호가창 안의 중간호가 행 높이를 40px에서 32px로 줄입니다."],
          ["오른쪽 정보에 수량 표시", "midQuote.showVolume", "오른쪽 기준정보의 중간호가 가격 옆에 우세 수량을 표시합니다."],
          ["오른쪽 중간호가 숨기기", "midQuote.hideSideInfo", "오른쪽 기준정보에서 중간호가 행과 바로 위 구분선을 함께 숨깁니다."],
        ],
      ],
      [
        "초 단위 차트",
        [
          [
            "표시할 시간 단위 (초, 쉼표로 구분)",
            "enableSec.presets",
            "시간 단위 메뉴에 추가할 1~60초 주기를 쉼표로 구분해 입력합니다. 예: 1, 3, 5, 10",
            "text",
          ],
          [
            "종목별 최대 체결 내역 수",
            "enableSec.maxTicksPerSymbol",
            "초봉 생성을 위해 종목별로 메모리에 보관할 최근 체결 데이터의 최대 개수입니다.",
            "number",
            {
              min: 1_000,
              max: 200_000,
            },
          ],
          [
            "최대 보관 종목 수",
            "enableSec.maxSymbolBuckets",
            "초봉용 체결 데이터를 동시에 보관할 종목 수의 최대값입니다.",
            "number",
            {
              min: 1,
              max: 30,
            },
          ],
        ],
      ],
      [
        "실시간 시세 갱신",
        [
          [
            "화면 갱신 간격 (8~1,000ms)",
            "noWait.intervalMs",
            "실시간 시세를 화면에 반영하는 간격입니다. 값이 작을수록 빠르지만 CPU 사용량이 늘 수 있습니다.",
            "number",
            {
              min: 8,
              max: 1_000,
            },
          ],
        ],
      ],
    ];
    for (const [title, fields] of settingGroups) {
      const group = fieldset(title);
      for (const field of fields) addField(group, ...field);
    }
    const backdrop = shadow.getElementById("backdrop");
    const panel = shadow.getElementById("panel");
    const open = () => {
      backdrop.hidden = false;
    };
    const close = () => {
      hideTooltip();
      backdrop.hidden = true;
    };
    shadow.getElementById("gear").addEventListener("click", open);
    shadow.getElementById("cancel").addEventListener("click", close);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
    for (const eventName of ["pointerdown", "mousedown"]) panel.addEventListener(eventName, (event) => event.stopPropagation());
    panel.addEventListener("click", (event) => {
      event.stopPropagation();
      const caption = event.target instanceof Element ? event.target.closest(".field-label[data-description]") : null;
      if (caption && panel.contains(caption)) {
        event.preventDefault();
        if (tooltip.hidden || tooltipTarget !== caption) {
          hideTooltip();
          if (!caption.isConnected || !caption.dataset.description) return;
          tooltipTarget = caption;
          tooltipText.textContent = caption.dataset.description;
          tooltip.hidden = false;
          tooltip.style.left = "12px";
          tooltip.style.top = "12px";
          const targetRect = caption.getBoundingClientRect();
          const tooltipRect = tooltip.getBoundingClientRect();
          const left = Math.min(Math.max(12, targetRect.left), window.innerWidth - tooltipRect.width - 12);
          let top = targetRect.bottom + 8;
          let placement = "bottom";
          if (top + tooltipRect.height > window.innerHeight - 12) {
            top = targetRect.top - tooltipRect.height - 8;
            placement = "top";
          }
          const safeLeft = Math.max(12, left);
          const arrowLeft = Math.min(tooltipRect.width - 18, Math.max(6, targetRect.left + targetRect.width / 2 - safeLeft - 6));
          tooltip.dataset.placement = placement;
          tooltipArrow.style.left = `${arrowLeft}px`;
          tooltipArrow.style.top = "bottom" === placement ? "-6px" : "auto";
          tooltipArrow.style.bottom = "top" === placement ? "-6px" : "auto";
          tooltipArrow.style.borderTop = "top" === placement ? "6px solid #202632" : "0";
          tooltipArrow.style.borderBottom = "bottom" === placement ? "6px solid #202632" : "0";
          tooltip.style.left = `${safeLeft}px`;
          tooltip.style.top = `${Math.max(12, top)}px`;
        } else hideTooltip();
      } else hideTooltip();
    });
    panel.addEventListener("scroll", hideTooltip, {
      passive: true,
    });
    window.addEventListener("resize", hideTooltip, {
      passive: true,
    });
    shadow.addEventListener("keydown", (event) => {
      if ("Escape" === event.key) close();
    });
    shadow.getElementById("reset").addEventListener("click", () => {
      localStorage.removeItem(SETTINGS_KEY);
      location.reload();
    });
    shadow.getElementById("save").addEventListener("click", () => {
      const next = structuredClone(settings);
      for (const [path, input] of controls) {
        let value;
        value =
          "checkbox" === input.type
            ? input.checked
            : "enableSec.presets" === path
              ? input.value.split(",").map((item) => Number(item.trim()))
              : "number" === input.type
                ? Number(input.value)
                : input.value.trim();
        setPath(next, path, value);
      }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(next)));
      location.reload();
    });
    document.documentElement.append(host, tooltip);
    installNativeSettingsTab({
      shadow,
      open,
      close,
    });
  }
  Object.defineProperty(window, "__TOSS_INTEGRATED__", {
    configurable: false,
    enumerable: false,
    value: runtime,
  });

  // ---------------------------------------------------------------------------
  // 할로우 캔들 복원
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // 지수 상세 차트 조작 (Toss Indicator Chart Unlock 통합)
  // ---------------------------------------------------------------------------

  function installIndexChartUnlock(moduleState) {
    const state = Object.assign(moduleState, { widgetOptionsPatched: 0 });
    const enabledFeatures = [
      "header_widget",
      "header_chart_type",
      "chart_scroll",
      "chart_zoom",
      "axis_pressed_mouse_move_scale",
    ];
    const hiddenHeaderItems = [
      "header_symbol_search",
      "header_resolutions",
      "header_compare",
      "header_indicators",
      "header_undo_redo",
      "header_screenshot",
      "header_fullscreen_button",
      "header_settings",
    ];
    runtime.chartHub.add({
      key: "indexChartUnlock",
      accept: () => /^\/indices\//.test(location.pathname),
      transformOptions(options) {
        const patched = configureChartFeatures(options, { enable: enabledFeatures, disable: hiddenHeaderItems });
        state.widgetOptionsPatched += 1;
        return patched;
      },
    });
  }

  // ---------------------------------------------------------------------------
  // 빠른 실시간 시세 반영
  // ---------------------------------------------------------------------------

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
        source.includes("getIsConnected")
      );
    }
    function inspectFactory(factory) {
      const source = readFactorySource(factory);
      if (source === null || !looksLikeRealtimeFactory(source)) return null;
      const aliases = new Map();
      for (const match of source.matchAll(/([A-Za-z_$][\w$]*)=\w+\((\d+)\)/g)) aliases.set(match[1], Number(match[2]));
      const contextMatch = source.match(/\(0,([A-Za-z_$][\w$]*)\.useContext\)\(([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\)/);
      const exportMatch = source.match(/\.d\([^,]+,\{([A-Za-z_$][\w$]*):\(\)=>[A-Za-z_$][\w$]*\}\)/);
      if (!contextMatch || !exportMatch) return null;
      const reactModuleId = aliases.get(contextMatch[1]);
      const contextModuleId = aliases.get(contextMatch[2]);
      return Number.isInteger(reactModuleId) && Number.isInteger(contextModuleId)
        ? {
            reactModuleId,
            contextModuleId,
            contextExport: contextMatch[3],
            hookExport: exportMatch[1],
          }
        : null;
    }
    function createFastRealtimeFactory(metadata) {
      return (_module, exports, webpackRequire) => {
        const React = webpackRequire(metadata.reactModuleId);
        const realtimeContext = webpackRequire(metadata.contextModuleId)[metadata.contextExport];
        const useFastRealtimeClient = () => {
          const { connection, subscribe, globalTimer, connect } = React.useContext(realtimeContext);
          const [, forceUpdate] = React.useReducer((value) => value + 1, 0);
          React.useEffect(() => {
            const removeListener = connection.addListener(() => forceUpdate());
            return () => removeListener();
          }, [connection]);
          return {
            client: React.useMemo(
              () => ({
                getIsConnected: () => connection.getIsConnected(),
                subscribeConnection: (listener) => {
                  const removeListener = connection.addListener((connected) => listener(connected));
                  return () => removeListener();
                },
                subscribe: (destination, onMessages, options) => {
                  const requestedInterval = options?.throttleInterval ?? 200;
                  const backgroundSubscribed = options?.backgroundSubscribed ?? false;
                  const interval = ORIGINAL_BATCH_INTERVALS.has(requestedInterval) ? FRAME_INTERVAL : requestedInterval;
                  let messages = [];
                  let lastFlushedAt = 0;
                  let unsubscribed = false;
                  const flush = () => {
                    if (0 === messages.length) return;
                    const now = Date.now();
                    if (navigationWorkPaused()) {
                      messages = [];
                      lastFlushedAt = now;
                      return;
                    }
                    if (lastFlushedAt + interval > now) return;
                    lastFlushedAt = now;
                    const boundedMessages = messages.length <= 1_000 ? messages : messages.slice(messages.length - 1_000);
                    const lastMessage = boundedMessages[boundedMessages.length - 1];
                    messages = [];
                    onMessages({
                      messages: boundedMessages,
                      lastMessage,
                    });
                  };
                  const clearTimer = globalTimer.setInterval(flush, interval);
                  const rawSubscription = subscribe(
                    destination,
                    (message) => {
                      messages.push(message);
                      if (backgroundSubscribed) flush();
                    },
                    {
                      backgroundSubscribed,
                    },
                  );
                  return {
                    unsubscribe: () => {
                      if (!unsubscribed) {
                        unsubscribed = true;
                        clearTimer();
                        rawSubscription.unsubscribe();
                      }
                    },
                  };
                },
                reconnect: connect,
              }),
              [connect, connection, globalTimer, subscribe],
            ),
            connected: connection.getIsConnected(),
          };
        };
        webpackRequire.d(exports, {
          [metadata.hookExport]: () => useFastRealtimeClient,
        });
      };
    }
    runtime.webpackHub.transformFactories((factory) => {
      const metadata = inspectFactory(factory);
      if (!metadata) return null;
      state.active = true;
      return createFastRealtimeFactory(metadata);
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

  // ---------------------------------------------------------------------------
  // 초 단위 차트
  // ---------------------------------------------------------------------------

  function installSecondsCharts(moduleState) {
    const SECOND_PRESETS = settings.enableSec.presets;
    const MAX_TICKS_PER_SYMBOL = settings.enableSec.maxTicksPerSymbol;
    const MAX_SYMBOL_BUCKETS = settings.enableSec.maxSymbolBuckets;
    const SECOND_RESOLUTIONS = Array.from(
      {
        length: 60,
      },
      (_, index) => `${index + 1}S`,
    );
    const SECOND_MULTIPLIERS = Array.from(
      {
        length: 60,
      },
      (_, index) => String(index + 1),
    );
    const state = Object.assign(moduleState, {
      version: VERSION,
      active: true,
      tradingViewPatched: false,
      datafeedsPatched: 0,
      widgetsCaptured: 0,
      webpackChartModules: runtime.chartHub.state.patchedModules,
      uiMounted: false,
      activeResolution: null,
      historicalCandleRequestsForSeconds: 0,
      source: "existing-tick-response-table-and-websocket",
      lastError: null,
    });
    Object.defineProperty(window, "__TOSS_LOCAL_SECONDS__", {
      configurable: true,
      enumerable: false,
      value: state,
    });
    const tickBuckets = new Map();
    const lastIndexSeedPrices = new Map();
    const indexSeedAttempts = new Map();
    const tickListeners = new Set();
    const customSubscriptions = new Map();
    const wrappedDatafeeds = new WeakMap();
    let capturedWidget = null;
    let controls = null;
    let controlsAnchor = null;
    let controlsRefreshFrame = null;
    let lastObservedPathname = location.pathname;
    let presetDocumentHandlersInstalled = false;
    let scanTimer = null;
    let statusFrame = null;
    let cachedInstrumentPathname = null;
    let cachedInstrumentCode = null;
    function normalizeInstrumentCode(value) {
      let code = String(value ?? "")
        .trim()
        .split(/[?#]/)[0];
      try {
        code = decodeURIComponent(code);
      } catch {
        // Keep the original code when a third-party symbol is not URI-encoded.
      }
      code = code.replace(/^INDEX:/i, "");
      return /^exchange-rate$/i.test(code) ? "EXCHANGE_RATE" : code;
    }
    function currentInstrumentCode() {
      if (cachedInstrumentPathname === location.pathname) return cachedInstrumentCode;
      cachedInstrumentPathname = location.pathname;
      const stockMatch = location.pathname.match(/\/stocks\/([^/]+)/);
      if (stockMatch) return ((cachedInstrumentCode = normalizeInstrumentCode(stockMatch[1])), cachedInstrumentCode);
      const indexMatch = location.pathname.match(/\/indices\/([^/?#]+)/);
      cachedInstrumentCode = indexMatch ? normalizeInstrumentCode(indexMatch[1]) : null;
      return cachedInstrumentCode;
    }
    function finiteNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
    function parseDisplayedNumber(text) {
      if (typeof text !== "string") return null;
      const number = Number(text.replace(/[^0-9.+-]/g, ""));
      return Number.isFinite(number) ? number : null;
    }
    function getBucket(code) {
      let bucket = tickBuckets.get(code);
      if (!bucket) {
        for (; tickBuckets.size >= MAX_SYMBOL_BUCKETS; ) {
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
          state.lastError = String(error);
        }
    }
    function addTick(code, tick, notify = true) {
      if (!code || !tick || !Number.isFinite(tick.time)) return false;
      if (!Number.isFinite(tick.volume) || tick.volume < 0) return false;
      if (!Number.isFinite(tick.priceUsd) && !Number.isFinite(tick.priceKrw)) return false;
      const bucket = getBucket(code);
      const identity = tickIdentity(tick);
      if (bucket.seen.has(identity)) return false;
      bucket.seen.add(identity);
      const last = bucket.ticks[bucket.ticks.length - 1];
      if (!last || last.time <= tick.time) bucket.ticks.push(tick);
      else {
        let low = 0;
        let high = bucket.ticks.length;
        for (; low < high; ) {
          const middle = (low + high) >>> 1;
          if (bucket.ticks[middle].time <= tick.time) low = middle + 1;
          else high = middle;
        }
        bucket.ticks.splice(low, 0, tick);
      }
      if (bucket.ticks.length > MAX_TICKS_PER_SYMBOL) {
        const removeCount = Math.max(5_000, bucket.ticks.length - MAX_TICKS_PER_SYMBOL);
        const removed = bucket.ticks.splice(0, removeCount);
        for (const oldTick of removed) bucket.seen.delete(tickIdentity(oldTick));
      }
      bucket.version += 1;
      if (notify) notifyTick(code, tick);
      return true;
    }
    function parseTableTime(text) {
      const match = String(text)
        .trim()
        .match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
      if (!match) return null;
      const now = new Date();
      const time = new Date(now);
      time.setHours(Number(match[1]), Number(match[2]), Number(match[3]), 0);
      if (time.getTime() > now.getTime() + 21_600_000) time.setDate(time.getDate() - 1);
      return time.getTime();
    }
    function parseIncomingTime(value) {
      if (typeof value === "string" && /^\d{1,2}:\d{2}:\d{2}$/.test(value.trim())) return parseTableTime(value);
      const time = new Date(value ?? "").getTime();
      return Number.isFinite(time) ? time : null;
    }
    function isRealtimeTradesTable(table) {
      let hasTradePrice = false;
      let hasTime = false;
      for (const cell of table.querySelectorAll("thead th")) {
        const text = cell.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (
          (hasTradePrice || (hasTradePrice = text.includes("체결가")),
          hasTime || (hasTime = "시간" === text || text.endsWith(" 시간")),
          hasTradePrice && hasTime)
        )
          return true;
      }
      return false;
    }
    function scanLoadedTrades() {
      scanTimer = null;
      const code = currentInstrumentCode();
      if (!code) return;
      // Index pages have no executions table. Seed one bar from the price that
      // Toss already rendered, then let the existing index WebSocket update it.
      // This reads the DOM/title only and issues no request.
      if (/^\/indices\//.test(location.pathname)) {
        if (
          ((function (code) {
            const titleMatch = document.title.match(/^\s*([+-]?\d[\d,]*(?:\.\d+)?)/);
            const price = titleMatch ? parseDisplayedNumber(titleMatch[1]) : null;
            if (!(null == price || price <= 0))
              if (lastIndexSeedPrices.get(code) !== price) {
                lastIndexSeedPrices.set(code, price);
                addTick(code, {
                  time: Date.now(),
                  volume: 0,
                  cumulativeVolume: null,
                  priceUsd: price,
                  priceKrw: price,
                  source: "loaded-index-summary",
                });
              }
          })(code),
          0 === getBucket(code).ticks.length)
        ) {
          const attempts = (indexSeedAttempts.get(code) ?? 0) + 1;
          indexSeedAttempts.set(code, attempts);
          if (attempts < 20) scheduleTradesScan(250);
        } else indexSeedAttempts.delete(code);
        return;
      }
      let table = null;
      for (const candidate of document.querySelectorAll("table"))
        if (isRealtimeTradesTable(candidate)) {
          table = candidate;
          break;
        }
      if (!table) return;
      const parsed = [];
      for (const row of table.querySelectorAll("tbody tr")) {
        const cells = row.cells;
        if (cells.length < 5) continue;
        const priceText = cells[0].textContent?.trim() ?? "";
        const price = parseDisplayedNumber(priceText);
        const volume = parseDisplayedNumber(cells[1].textContent ?? "");
        const cumulativeVolume = parseDisplayedNumber(cells[3].textContent ?? "");
        const time = parseTableTime(cells[4].textContent ?? "");
        if (null != price && null != volume && null != time)
          parsed.push({
            time,
            volume,
            cumulativeVolume,
            priceUsd: priceText.includes("$") ? price : null,
            priceKrw: priceText.includes("$") ? null : price,
            source: "loaded-trades-table",
          });
      }
      // The table is newest-first. Reverse before the stable time sort so trades
      // sharing the same displayed second retain their chronological direction.
      parsed.reverse().sort((a, b) => a.time - b.time);
      let added = false;
      for (const tick of parsed) added = addTick(code, tick, false) || added;
      if (added) {
        const bucket = getBucket(code);
        const latest = bucket.ticks[bucket.ticks.length - 1];
        if (latest) notifyTick(code, latest);
      }
    }
    function scheduleTradesScan(delay = 30) {
      if (null == scanTimer) scanTimer = setTimeout(scanLoadedTrades, delay);
    }
    function scheduleControlsRefresh(delay = 80) {
      if (null == controlsRefreshFrame)
        controlsRefreshFrame = setTimeout(() => {
          controlsRefreshFrame = null;
          mountControls();
        }, delay);
    }
    function isSecondsResolution(resolution) {
      const match = String(resolution).match(/^(\d+)S$/);
      if (!match) return null;
      const seconds = Number(match[1]);
      return Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : null;
    }
    function symbolCode(symbolInfo) {
      return normalizeInstrumentCode(currentInstrumentCode() ?? symbolInfo?.ticker ?? symbolInfo?.name ?? "");
    }
    function wantsKrw(symbolInfo) {
      return "KRW" === String(symbolInfo?.currency_code ?? symbolInfo?.currencyCode ?? "").toUpperCase();
    }
    function tickPrice(tick, useKrw) {
      return finiteNumber(useKrw ? (tick.priceKrw ?? tick.priceUsd) : (tick.priceUsd ?? tick.priceKrw));
    }
    function cachedAggregateSeconds(bucket, symbolInfo, seconds) {
      const useKrw = wantsKrw(symbolInfo);
      const cacheKey = `${seconds}:${useKrw ? "krw" : "native"}`;
      const cached = bucket.aggregateCache.get(cacheKey);
      if (cached?.version === bucket.version) return cached.bars;
      const bars = (function aggregateTicks(ticks, useKrw, seconds) {
        const interval = 1_000 * seconds;
        const bars = [];
        let current = null;
        for (const tick of ticks) {
          const price = tickPrice(tick, useKrw);
          if (null == price) continue;
          const time = Math.floor(tick.time / interval) * interval;
          if (current && current.time === time) {
            current.high = Math.max(current.high, price);
            current.low = Math.min(current.low, price);
            current.close = price;
            current.volume += tick.volume;
          } else {
            current = {
              time,
              open: price,
              high: price,
              low: price,
              close: price,
              volume: tick.volume,
            };
            bars.push(current);
          }
        }
        return bars;
      })(bucket.ticks, useKrw, seconds);
      bucket.aggregateCache.set(cacheKey, {
        version: bucket.version,
        bars,
      });
      return bars;
    }
    function patchResolutionList(list) {
      return Array.from(new Set([...(Array.isArray(list) ? list.map((resolution) => String(resolution)) : []), ...SECOND_RESOLUTIONS]));
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
            callback(
              (function (configuration) {
                return {
                  ...configuration,
                  supported_resolutions: patchResolutionList(configuration?.supported_resolutions),
                };
              })(configuration),
            );
          });
      if (originalResolveSymbol)
        overrides.resolveSymbol = (name, onResolved, onError, extension) =>
          originalResolveSymbol(
            name,
            (info) =>
              onResolved(
                (function (info) {
                  return {
                    ...info,
                    has_seconds: true,
                    build_seconds_from_ticks: false,
                    seconds_multipliers: [...SECOND_MULTIPLIERS],
                    supported_resolutions: patchResolutionList(info?.supported_resolutions),
                  };
                })(info),
              ),
            onError,
            extension,
          );
      if (originalGetBars)
        overrides.getBars = (symbolInfo, resolution, periodParams, onResult, onError) => {
          const seconds = isSecondsResolution(resolution);
          if (null == seconds) return originalGetBars(symbolInfo, resolution, periodParams, onResult, onError);
          // Deliberately do not call Toss's original getBars here. This is the
          // invariant that prevents any historical candle API request for seconds.
          scanLoadedTrades();
          let bars = cachedAggregateSeconds(getBucket(symbolCode(symbolInfo)), symbolInfo, seconds);
          const from = finiteNumber(periodParams?.from);
          const to = finiteNumber(periodParams?.to);
          if (null != from) bars = bars.filter((bar) => bar.time >= 1_000 * from);
          if (null != to) bars = bars.filter((bar) => bar.time <= 1_000 * to);
          const countBack = finiteNumber(periodParams?.countBack);
          if (null != countBack && bars.length > countBack) bars = bars.slice(-countBack);
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
          const seconds = isSecondsResolution(resolution);
          if (null == seconds) return originalSubscribeBars(symbolInfo, resolution, onRealtime, listenerGuid, onResetCache);
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
            if (!lastBar || time > lastBar.time)
              lastBar = {
                time,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: tick.volume,
              };
            else {
              if (time !== lastBar.time) return;
              // Keep every raw tick in OHLCV, but ask TradingView to redraw at most
              // once per display frame. This removes the high-volume seconds lag.
              lastBar = {
                ...lastBar,
                high: Math.max(lastBar.high, price),
                low: Math.min(lastBar.low, price),
                close: price,
                volume: (lastBar.volume ?? 0) + tick.volume,
              };
            }
            if (!(null != deliveryFrame || disposed))
              deliveryFrame =
                typeof requestAnimationFrame === "function" ? requestAnimationFrame(deliverLatestBar) : setTimeout(deliverLatestBar, 16);
          };
          customSubscriptions.get(listenerGuid)?.();
          tickListeners.add(listener);
          customSubscriptions.set(listenerGuid, () => {
            disposed = true;
            tickListeners.delete(listener);
            if (null != deliveryFrame) {
              if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(deliveryFrame);
              clearTimeout(deliveryFrame);
              deliveryFrame = null;
            }
          });
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
    function scheduleStatusUpdate() {
      if (null == statusFrame)
        statusFrame = requestAnimationFrame(() => {
          if (((statusFrame = null), !controls)) return;
          const activeSeconds = isSecondsResolution(state.activeResolution);
          controls.trigger.textContent = null == activeSeconds ? "초봉 ∨" : `${activeSeconds}초 ∨`;
          controls.trigger.title = state.lastError ?? "초봉 프리셋 선택";
          for (const option of controls.options) {
            const selected = activeSeconds === Number(option.dataset.seconds);
            option.dataset.selected = String(selected);
            option.setAttribute("aria-selected", String(selected));
          }
        });
    }
    function findIntervalButton() {
      const buttons = Array.from(document.querySelectorAll("button"));
      const minuteButton = buttons.find((button) => /^\s*\d+\s*분(?:\s|$)/.test(button.textContent ?? ""));
      if (minuteButton) return minuteButton;
      if (/^\/indices\//.test(location.pathname)) {
        const rangeButtons = buttons.filter((button) => /^\s*\d+\s*(?:일|주일|개월|년)\s*$/.test(button.textContent ?? ""));
        return rangeButtons[rangeButtons.length - 1] ?? null;
      }
      return null;
    }
    function placeControlsAtAnchor(container, anchor) {
      const host = anchor?.parentElement;
      if (!container || !host) return;
      const isMinuteDropdown = /^\s*\d+\s*분(?:\s|$)/.test(anchor.textContent ?? "");
      host.insertBefore(container, isMinuteDropdown ? anchor : anchor.nextSibling);
    }
    function positionControls() {
      if (!controls?.container) return;
      const anchor = findIntervalButton() ?? controlsAnchor;
      if (anchor) {
        controlsAnchor = anchor;
        placeControlsAtAnchor(controls.container, anchor);
        positionPresetMenu();
      }
    }
    function positionPresetMenu() {
      if (!controls?.menu || controls.menu.hidden) return;
      const rect = controls.trigger.getBoundingClientRect();
      controls.menu.style.left = `${Math.max(8, rect.left)}px`;
      controls.menu.style.top = `${rect.bottom + 5}px`;
    }
    function closePresetMenu() {
      if (controls?.menu) {
        controls.menu.hidden = true;
        controls.trigger.setAttribute("aria-expanded", "false");
      }
    }
    function bindOriginalTimeframeButtons() {
      for (const button of document.querySelectorAll("button"))
        if (/^\s*(?:\d+\s*분|일|주|월|년|\d+\s*(?:일|주일|개월|년))(?:\s|$)/.test(button.textContent ?? ""))
          if (!button.__tossLocalSecondsBound) {
            Object.defineProperty(button, "__tossLocalSecondsBound", {
              configurable: true,
              value: true,
            });
            button.addEventListener("click", () => {
              state.activeResolution = null;
              state.lastError = null;
              closePresetMenu();
              scheduleStatusUpdate();
            });
          }
    }
    function mountControls() {
      if (!document.documentElement) return;
      function ensureControlsStyle() {
        if (document.getElementById("toss-local-seconds-style")) return;
        const style = document.createElement("style");
        style.id = "toss-local-seconds-style";
        style.textContent = `
        #toss-local-seconds-controls {
          flex: 0 0 auto;
          position: relative;
          z-index: 100;
          pointer-events: auto !important;
          user-select: none;
          touch-action: manipulation;
        }
        #toss-local-seconds-menu,
        #toss-local-seconds-menu * {
          pointer-events: auto !important;
        }
        #toss-local-seconds-menu {
          display: flex;
          flex-direction: column;
          position: fixed;
          z-index: 2147483000;
          min-width: 104px;
          box-sizing: border-box;
          padding: 6px;
          border: 1px solid rgba(143, 149, 158, .18);
          border-radius: 12px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, .14);
          background: var(--wts-adaptive-background, #fff);
          font-family: "Toss Product Sans", sans-serif;
        }
        #toss-local-seconds-menu[hidden] {
          display: none !important;
        }
        #toss-local-seconds-menu button {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          height: 34px;
          box-sizing: border-box;
          padding: 0 10px;
          border: 0;
          border-radius: 8px;
          color: var(--wts-adaptive-grey800, #4e5968);
          background: transparent;
          font-size: 13px;
          font-weight: 600;
          text-align: left;
          cursor: pointer;
        }
        #toss-local-seconds-menu button:hover,
        #toss-local-seconds-menu button[data-selected="true"] {
          background: var(--wts-adaptive-greyOpacity100, rgba(2, 32, 71, .05));
        }
        #toss-local-seconds-menu button[data-selected="true"]::after {
          content: "✓";
          color: var(--wts-blue500, #3182f6);
          font-size: 13px;
        }
      `;
        (document.head ?? document.documentElement).appendChild(style);
      }
      ensureControlsStyle();
      const existing = document.getElementById("toss-local-seconds-controls");
      if (existing && controls) {
        state.uiMounted = true;
        bindOriginalTimeframeButtons();
        positionControls();
        return;
      }
      existing?.remove();
      controls?.menu?.remove();
      controls = null;
      const intervalButton = findIntervalButton();
      const host = intervalButton?.parentElement;
      if (!intervalButton || !host) return;
      if (((controlsAnchor = intervalButton), !document.body)) return;
      const container = document.createElement("button");
      container.id = "toss-local-seconds-controls";
      container.type = "button";
      container.className = intervalButton.className;
      container.textContent = "초봉 ∨";
      container.draggable = false;
      container.setAttribute("aria-haspopup", "listbox");
      container.setAttribute("aria-expanded", "false");
      container.setAttribute("aria-label", "초봉 프리셋 선택");
      const stopPanelInteraction = (event) => event.stopPropagation();
      for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "dblclick"])
        container.addEventListener(eventName, stopPanelInteraction);
      container.addEventListener("click", (event) => {
        event.stopPropagation();
        if (controls?.menu) {
          controls.menu.hidden = !controls.menu.hidden;
          controls.trigger.setAttribute("aria-expanded", String(!controls.menu.hidden));
          positionPresetMenu();
        }
      });
      const menu = document.createElement("div");
      menu.id = "toss-local-seconds-menu";
      menu.hidden = true;
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", "초봉 프리셋");
      for (const eventName of ["pointerdown", "mousedown", "click"]) menu.addEventListener(eventName, stopPanelInteraction);
      const options = SECOND_PRESETS.map((seconds) => {
        const option = document.createElement("button");
        option.type = "button";
        option.dataset.seconds = String(seconds);
        option.textContent = `${seconds}초`;
        option.setAttribute("role", "option");
        option.addEventListener("click", (event) => {
          event.stopPropagation();
          state.lastError = null;
          (function (seconds) {
            const value = Math.max(1, Math.min(60, Math.trunc(Number(seconds))));
            scanLoadedTrades();
            const chart = capturedWidget?.activeChart?.();
            if (!chart?.setResolution)
              return ((state.lastError = "TradingView 차트가 아직 준비되지 않았습니다."), void scheduleStatusUpdate());
            try {
              chart.setResolution(`${value}S`);
              state.activeResolution = `${value}S`;
              localStorage.setItem("toss-local-seconds-value", String(value));
              scheduleStatusUpdate();
            } catch (error) {
              state.lastError = String(error);
              scheduleStatusUpdate();
            }
          })(seconds);
          closePresetMenu();
        });
        menu.appendChild(option);
        return option;
      });
      placeControlsAtAnchor(container, intervalButton);
      document.body.appendChild(menu);
      controls = {
        container,
        trigger: container,
        menu,
        options,
      };
      state.uiMounted = true;
      if (!presetDocumentHandlersInstalled) {
        presetDocumentHandlersInstalled = true;
        document.addEventListener(
          "pointerdown",
          (event) => {
            if (controls?.menu && !controls.menu.hidden)
              if (!(controls.trigger.contains(event.target) || controls.menu.contains(event.target))) closePresetMenu();
          },
          true,
        );
        document.addEventListener(
          "keydown",
          (event) => {
            if ("Escape" === event.key) closePresetMenu();
          },
          true,
        );
      }
      bindOriginalTimeframeButtons();
      positionControls();
      scheduleStatusUpdate();
    }
    runtime.workerHub.onMessage(function (data) {
      if (!data || "send" !== data.scope || "messageReceived" !== data.type) return;
      const code = currentInstrumentCode();
      const destination = String(data.data?.destination ?? "");
      const body = data.data?.message?.body;
      if (!code || typeof body !== "string") return;
      const normalizedCode = normalizeInstrumentCode(code);
      const destinationCode = normalizeInstrumentCode(destination.split("/").pop());
      if (destinationCode && destinationCode.toUpperCase() !== normalizedCode.toUpperCase()) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return;
      }
      const isIndicatorUpdate = /\/stock\/index\//.test(destination) || /^\/indices\//.test(location.pathname);
      if (
        ![normalizeInstrumentCode(parsed?.code ?? parsed?.productCode ?? parsed?.stockCode), destinationCode]
          .filter(Boolean)
          .some((candidate) => candidate.toUpperCase() === normalizedCode.toUpperCase())
      )
        return;
      const parsedTime = new Date(parsed?.dt ?? "").getTime();
      const time = Number.isFinite(parsedTime) ? parsedTime : isIndicatorUpdate ? Date.now() : NaN;
      const close = finiteNumber(parsed?.close);
      const closeKrw = finiteNumber(parsed?.closeKrw);
      const volume = finiteNumber(parsed?.volume) ?? (isIndicatorUpdate ? 0 : null);
      if (!(!Number.isFinite(time) || null == volume || (null == close && null == closeKrw)))
        addTick(code, {
          time,
          volume,
          cumulativeVolume: finiteNumber(parsed?.cumulativeVolume),
          priceUsd: close,
          priceKrw: closeKrw,
          session: parsed?.session,
          source: "existing-websocket",
        });
    });
    (function () {
      if (typeof window.fetch !== "function" || window.fetch.__tossLocalSecondsTapped) return;
      const originalFetch = window.fetch;
      async function observedFetch(...args) {
        const response = await originalFetch.apply(this, args);
        try {
          const input = args[0];
          const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url ?? response?.url ?? "");
          if (/\/api\/v2\/stock-prices\/[^/?]+\/ticks(?:\?|$)/.test(url))
            response
              .clone()
              .json()
              .then((payload) =>
                (function (url, payload) {
                  const match = String(url).match(/\/api\/v2\/stock-prices\/([^/?]+)\/ticks(?:\?|$)/);
                  if (!match) return;
                  const code = decodeURIComponent(match[1]);
                  const rows = Array.isArray(payload)
                    ? payload
                    : Array.isArray(payload?.data)
                      ? payload.data
                      : Array.isArray(payload?.body)
                        ? payload.body
                        : null;
                  if (!rows) return;
                  const ticks = rows
                    .map((row) => ({
                      time: parseIncomingTime(row?.dt ?? row?.time),
                      volume: finiteNumber(row?.volume),
                      cumulativeVolume: finiteNumber(row?.cumulativeVolume),
                      priceUsd: finiteNumber(row?.close),
                      priceKrw: finiteNumber(row?.closeKrw),
                      session: row?.session,
                      source: "existing-ticks-response",
                    }))
                    .filter((tick) => null != tick.time && null != tick.volume);
                  // Toss's ticks endpoint is newest-first.
                  ticks.reverse().sort((a, b) => a.time - b.time);
                  let added = false;
                  for (const tick of ticks) added = addTick(code, tick, false) || added;
                  if (added) {
                    const bucket = getBucket(code);
                    const latest = bucket.ticks[bucket.ticks.length - 1];
                    if (latest) notifyTick(code, latest);
                  }
                })(url, payload),
              )
              .catch(() => {});
        } catch {
          // Observing the already-issued response must never affect Toss's request.
        }
        return response;
      }
      Object.setPrototypeOf(observedFetch, originalFetch);
      Object.defineProperty(observedFetch, "__tossLocalSecondsTapped", {
        value: true,
      });
      window.fetch = observedFetch;
    })();
    runtime.chartHub.add({
      key: "enableSec",
      transformOptions(options) {
        return {
          ...configureChartFeatures(options, { enable: ["seconds_resolution", "custom_resolutions"] }),
          datafeed: wrapDatafeed(options.datafeed),
        };
      },
      onCreated(widget) {
        capturedWidget = widget;
        state.tradingViewPatched = true;
        state.widgetsCaptured += 1;
        try {
          widget.onChartReady(() => {
            mountControls();
            scheduleStatusUpdate();
          });
        } catch {
          setTimeout(mountControls, 0);
        }
      },
    });
    (function () {
      const start = () => {
        scheduleTradesScan();
        mountControls();
        new MutationObserver(() => {
          if (lastObservedPathname !== location.pathname)
            return ((lastObservedPathname = location.pathname), scheduleTradesScan(120), void scheduleControlsRefresh(80));
          // Price text changes no longer trigger a whole-document table/button
          // scan. Only recover the UI if React actually replaced its toolbar.
          if (!controls?.container?.isConnected) scheduleControlsRefresh(120); // The DOM table is only a fallback when the already-issued ticks fetch
          // was missed. Stop scanning once any data exists for this stock.
          const code = currentInstrumentCode();
          if (/^\/(?:stocks|indices)\//.test(location.pathname) && code && 0 === getBucket(code).ticks.length) scheduleTradesScan(250);
        }).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
        window.addEventListener(
          "resize",
          () => {
            positionControls();
            positionPresetMenu();
          },
          {
            passive: true,
          },
        );
        window.addEventListener("scroll", positionPresetMenu, {
          passive: true,
        });
      };
      onDocumentReady(start);
    })();
  }

  // ---------------------------------------------------------------------------
  // 국내주식 중간호가 개선
  // ---------------------------------------------------------------------------

  function installMidQuote() {
    const BOOK_LIST_PAIRS = [
      ["SellOrderBookKrComp", "BuyOrderBookKrComp"],
      ["SellOrderBookNarrowKr", "BuyOrderBookNarrowKr"],
    ];
    const VOLUME_ATTRIBUTE = "data-bti-mid-volume";
    const ORDER_ROW_ATTRIBUTE = "data-bti-mid-order-row";
    const STYLE_ID = "better-toss-mid-quote-style";
    const ALL_ENHANCEMENT_SELECTOR = `[${VOLUME_ATTRIBUTE}], [data-bti-mid-info-hidden], [data-bti-mid-order-host], [data-bti-mid-order-center], [data-bti-mid-order-grid]`;
    const VISIBLE_ENHANCEMENT_SELECTOR = `[${VOLUME_ATTRIBUTE}], [data-bti-mid-order-host], [data-bti-mid-info-hidden]`;
    const OWN_NODE_SELECTOR = `[${VOLUME_ATTRIBUTE}], [data-bti-mid-order-host], [${ORDER_ROW_ATTRIBUTE}]`;
    const OWN_CONTAINER_SELECTOR = `[${VOLUME_ATTRIBUTE}], [data-bti-mid-order-host]`;
    const SHOW_VOLUME = settings.midQuote.showVolume;
    const INSERT_INTO_ORDER_BOOK = settings.midQuote.insertIntoOrderBook;
    const ALWAYS_SHOW = settings.midQuote.alwaysShow;
    const HIDE_SIDE_INFO = settings.midQuote.hideSideInfo;
    const ROW_HEIGHT = settings.midQuote.compactRows ? 32 : 40;
    const numberFormat = new Intl.NumberFormat("ko-KR", {
      maximumFractionDigits: 4,
    });
    const bookByCode = new Map();
    const tradeByCode = new Map();
    let renderFrame = 0;
    let resumeTimer = 0;
    let observer = null;
    let cachedDomesticPathname = null;
    let cachedDomesticCode = "";
    function normalizeCode(value) {
      const code = String(value ?? "")
        .trim()
        .toUpperCase();
      return /^A[0-9A-Z]{6}$/.test(code) ? code.slice(1) : code;
    }
    function currentDomesticCode() {
      if (cachedDomesticPathname === location.pathname) return cachedDomesticCode;
      cachedDomesticPathname = location.pathname;
      const match = location.pathname.match(/^\/stocks\/([^/?#]+)\/order(?:\/|$)/i);
      if (!match) {
        cachedDomesticCode = "";
        return cachedDomesticCode;
      }
      const routeCode = decodeURIComponent(match[1]).toUpperCase();
      cachedDomesticCode = /^A[0-9A-Z]{6}$/.test(routeCode) ? normalizeCode(routeCode) : "";
      return cachedDomesticCode;
    }
    function finiteNumber(value) {
      const number = Number(typeof value === "string" ? value.replaceAll(",", "") : value);
      return Number.isFinite(number) ? number : null;
    }
    function nonNegativeInteger(value) {
      const number = finiteNumber(value);
      return null === number ? 0 : Math.max(0, Math.round(number));
    }
    function dominantVolume(row) {
      return "bid" === row.side ? row.bidVolume : "offer" === row.side ? row.offerVolume : Math.max(row.bidVolume, row.offerVolume);
    }
    function volumeLabel(row, accessible = false) {
      const volume = numberFormat.format(dominantVolume(row));
      return accessible ? `${"bid" === row.side ? "매수" : "offer" === row.side ? "매도" : "중립"} ${volume}주` : volume;
    }
    function changeLabel(price, basePrice) {
      if (null === basePrice || basePrice <= 0) return "";
      const percent = ((price - basePrice) / basePrice) * 100;
      return `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
    }
    function touchLimitedMap(map, key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > 30) map.delete(map.keys().next().value);
    }
    function clearGridLayout(element) {
      element.removeAttribute("data-bti-mid-order-grid");
      element.style.removeProperty("--bti-mid-order-height");
    }
    function removeEnhancements() {
      for (const element of document.querySelectorAll(ALL_ENHANCEMENT_SELECTOR))
        if (element.hasAttribute(VOLUME_ATTRIBUTE) || element.hasAttribute("data-bti-mid-order-host")) element.remove();
        else {
          element.removeAttribute("data-bti-mid-info-hidden");
          element.removeAttribute("data-bti-mid-order-center");
          if (element.hasAttribute("data-bti-mid-order-grid")) clearGridLayout(element);
        }
    }
    function labelElement(row) {
      for (const element of row.querySelectorAll("*"))
        if (0 === element.children.length && "중간호가" === element.textContent.trim()) return element;
      return null;
    }
    function updateNativeInfo(rows) {
      const active = new Set();
      const hiddenRows = new Set();
      const infoRowGroups = [];
      for (const list of document.querySelectorAll('ul[data-list-name="QuotesInfoKr"]')) {
        const infoRows = [];
        for (const row of list.children) {
          if (!(row instanceof HTMLElement)) continue;
          const label = labelElement(row);
          if (label)
            if (
              (infoRows.push({
                row,
                label,
              }),
              HIDE_SIDE_INFO)
            ) {
              row.setAttribute("data-bti-mid-info-hidden", "");
              hiddenRows.add(row);
              const separator = row.previousElementSibling;
              if (separator?.matches("hr")) {
                separator.setAttribute("data-bti-mid-info-hidden", "");
                hiddenRows.add(separator);
              }
            } else row.removeAttribute("data-bti-mid-info-hidden");
        }
        infoRowGroups.push(infoRows);
      }
      if (
        (document.querySelectorAll("[data-bti-mid-info-hidden]").forEach((element) => {
          if (!hiddenRows.has(element)) element.removeAttribute("data-bti-mid-info-hidden");
        }),
        SHOW_VOLUME && !HIDE_SIDE_INFO)
      ) {
        for (const infoRows of infoRowGroups) {
          const unusedIndexes = new Set(rows.keys());
          for (const { row, label } of infoRows) {
            let valueRoot = row;
            for (const child of row.children) if (!child.contains(label)) valueRoot = child;
            const valueCopy = valueRoot.cloneNode(true);
            valueCopy.querySelectorAll?.(`[${VOLUME_ATTRIBUTE}]`).forEach((element) => element.remove());
            const nativePrice = finiteNumber(valueCopy.textContent);
            const styleText = valueRoot.getAttribute?.("style") ?? "";
            const hintedSide = styleText.includes("blue") ? "offer" : styleText.includes("red") ? "bid" : null;
            let matchedIndex;
            let priceMatch;
            let fallbackIndex;
            for (const index of unusedIndexes)
              if (
                (null == fallbackIndex && (fallbackIndex = index),
                rows[index].price === nativePrice &&
                  (null == priceMatch && (priceMatch = index), !hintedSide || rows[index].side === hintedSide))
              ) {
                matchedIndex = index;
                break;
              }
            if (null == matchedIndex) matchedIndex = priceMatch ?? fallbackIndex;
            const data = rows[matchedIndex];
            if (!data) continue;
            unusedIndexes.delete(matchedIndex);
            let volume = valueRoot.querySelector(`:scope > [${VOLUME_ATTRIBUTE}]`);
            if (!volume) {
              volume = document.createElement("span");
              volume.setAttribute(VOLUME_ATTRIBUTE, "");
              valueRoot.appendChild(volume);
            }
            const compactLabel = volumeLabel(data);
            const fullLabel = volumeLabel(data, true);
            if (volume.textContent !== compactLabel) volume.textContent = compactLabel;
            if (volume.title !== fullLabel) volume.title = fullLabel;
            if (volume.getAttribute("aria-label") !== fullLabel) volume.setAttribute("aria-label", fullLabel);
            active.add(volume);
          }
        }
        document.querySelectorAll(`[${VOLUME_ATTRIBUTE}]`).forEach((element) => {
          if (!active.has(element)) element.remove();
        });
      } else document.querySelectorAll(`[${VOLUME_ATTRIBUTE}]`).forEach((element) => element.remove());
    }
    function createVolumeCell() {
      const cell = document.createElement("span");
      const bar = document.createElement("div");
      bar.setAttribute("data-bti-mid-volume-bar", "");
      bar.appendChild(document.createElement("span"));
      cell.appendChild(bar);
      return cell;
    }
    function createPriceCell() {
      const cell = document.createElement("div");
      cell.setAttribute("data-bti-mid-price", "");
      const line = document.createElement("div");
      line.setAttribute("data-bti-mid-price-line", "");
      const market = document.createElement("span");
      market.setAttribute("data-bti-mid-market", "");
      line.append(market, document.createElement("b"));
      cell.append(line, document.createElement("small"));
      return cell;
    }
    function cleanupOrderBook(activeHosts, activeCenters, activeGrids) {
      for (const element of document.querySelectorAll(
        "[data-bti-mid-order-host], [data-bti-mid-order-center], [data-bti-mid-order-grid]",
      ))
        if (element.hasAttribute("data-bti-mid-order-host")) {
          if (!activeHosts?.has(element)) element.remove();
        } else {
          if (element.hasAttribute("data-bti-mid-order-center") && !activeCenters?.has(element))
            element.removeAttribute("data-bti-mid-order-center");
          if (element.hasAttribute("data-bti-mid-order-grid") && !activeGrids?.has(element)) clearGridLayout(element);
        }
    }
    function render() {
      renderFrame = 0;
      const routeCode = currentDomesticCode();
      const currentBook = bookByCode.get(routeCode);
      if (!routeCode) {
        removeEnhancements();
        return;
      }
      (function ensureMidQuoteStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `\n          [data-bti-mid-info-hidden] {\n            display: none !important;\n          }\n          [${VOLUME_ATTRIBUTE}] {\n            display: inline-block;\n            max-width: min(24vw, 86px);\n            margin-inline-start: 6px;\n            overflow: hidden;\n            color: currentColor;\n            font-size: 11px;\n            font-variant-numeric: tabular-nums;\n            line-height: 1.2;\n            text-overflow: ellipsis;\n            vertical-align: baseline;\n            white-space: nowrap;\n          }\n          [data-bti-mid-order-host] {\n            position: relative;\n            z-index: 1;\n            display: grid;\n            width: 100%;\n            min-width: 0;\n          }\n          [data-bti-mid-order-center] {\n            flex: 0 0 auto !important;\n            height: auto !important;\n            margin-block: 0 !important;\n            background: none !important;\n          }\n          [data-bti-mid-order-grid] {\n            grid-template-rows: minmax(0, 1fr) var(--bti-mid-order-height, auto) minmax(0, 1fr) !important;\n          }\n          [${ORDER_ROW_ATTRIBUTE}] {\n            box-sizing: border-box;\n            display: grid !important;\n            grid-template-columns: minmax(0, 1fr) minmax(104px, 1.2fr) minmax(0, 1fr);\n            width: 100%;\n            min-width: 0;\n            min-height: ${ROW_HEIGHT}px;\n            align-items: center;\n            padding: 0;\n            border-block: 1px solid rgba(128, 128, 128, .14);\n            background: rgba(128, 128, 128, .07);\n            font-variant-numeric: tabular-nums;\n          }\n          [${ORDER_ROW_ATTRIBUTE}][data-side="offer"] {\n            color: var(--wts-adaptive-blue600, #3182f6);\n          }\n          [${ORDER_ROW_ATTRIBUTE}][data-side="bid"] {\n            color: var(--wts-adaptive-red600, #f04452);\n          }\n          [${ORDER_ROW_ATTRIBUTE}][data-side="neutral"] {\n            color: var(--wts-adaptive-grey700, #4e5968);\n          }\n          [${ORDER_ROW_ATTRIBUTE}] > span {\n            position: relative;\n            display: flex;\n            height: 100%;\n            align-items: center;\n            overflow: visible;\n          }\n          [data-bti-mid-price] {\n            box-sizing: border-box;\n            width: fit-content;\n            max-width: 100%;\n            min-width: min(100%, 100px);\n            overflow: hidden;\n            align-self: stretch;\n            justify-self: center;\n            display: flex;\n            position: relative;\n            flex-direction: column;\n            align-items: center;\n            justify-content: center;\n            padding-inline: 5px;\n            text-overflow: ellipsis;\n            white-space: nowrap;\n          }\n          [${ORDER_ROW_ATTRIBUTE}] > span:first-child {\n            justify-content: flex-end;\n          }\n          [${ORDER_ROW_ATTRIBUTE}] > span:last-child {\n            justify-content: flex-start;\n          }\n          [${ORDER_ROW_ATTRIBUTE}][data-current="true"] > [data-bti-mid-price]::before {\n            content: "";\n            position: absolute;\n            inset: 0;\n            border-radius: 8px;\n            box-shadow: inset 0 0 0 1px var(--wts-adaptive-grey700, #4e5968);\n          }\n          [data-bti-mid-price-line] {\n            display: flex;\n            max-width: 100%;\n            min-width: 0;\n            align-items: center;\n            justify-content: center;\n            gap: 3px;\n          }\n          [data-bti-mid-price-line] > b {\n            min-width: 0;\n            overflow: hidden;\n            font-size: 14px;\n            font-weight: 600;\n            line-height: 1.25;\n            text-overflow: ellipsis;\n          }\n          [data-bti-mid-price] > small {\n            margin-top: -2px;\n            font-size: 11px;\n            font-weight: 500;\n            line-height: 1.25;\n          }\n          [data-bti-mid-market] {\n            position: static;\n            flex: 0 0 auto;\n            padding: 1px 2px;\n            border-radius: 3px;\n            background: var(--wts-adaptive-grey100, #f2f4f6);\n            color: var(--wts-adaptive-grey600, #6b7684);\n            font-size: 8px;\n            font-weight: 600;\n            line-height: 1.2;\n          }\n          [data-bti-mid-volume-bar] {\n            position: relative;\n            height: 24px;\n            min-width: 0;\n          }\n          [data-bti-mid-volume-bar][data-side="offer"] {\n            border-radius: 6px 0 0 6px;\n            background: var(--wts-adaptive-blue50, #e8f3ff);\n          }\n          [data-bti-mid-volume-bar][data-side="bid"] {\n            border-radius: 0 6px 6px 0;\n            background: var(--wts-adaptive-red50, #ffeeee);\n          }\n          [data-bti-mid-volume-bar] > span {\n            position: absolute;\n            top: 3px;\n            font-size: 12px;\n            font-weight: 400;\n            white-space: nowrap;\n          }\n          [data-bti-mid-volume-bar][data-side="offer"] > span {\n            right: 6px;\n          }\n          [data-bti-mid-volume-bar][data-side="bid"] > span {\n            left: 6px;\n          }\n        `;
        (document.head || document.documentElement).appendChild(style);
      })();
      if (!currentBook) {
        removeEnhancements();
        updateNativeInfo([]);
        return;
      }
      const rows = (function buildMidQuoteRows(book) {
        const prices = Array.isArray(book?.midPrices) ? book.midPrices : [];
        const bidVolumes = Array.isArray(book?.midBidVolumes) ? book.midBidVolumes : [];
        const offerVolumes = Array.isArray(book?.midOfferVolumes) ? book.midOfferVolumes : [];
        const rows = [];
        for (let index = 0; index < Math.min(2, prices.length); index += 1) {
          const price = finiteNumber(prices[index]);
          const bidVolume = nonNegativeInteger(bidVolumes[index]);
          const offerVolume = nonNegativeInteger(offerVolumes[index]);
          if (!(null === price || price <= 0 || (!ALWAYS_SHOW && bidVolume === offerVolume)))
            rows.push({
              price,
              bidVolume,
              offerVolume,
              market: 0 === index ? "KRX" : "NXT",
              side: bidVolume === offerVolume ? "neutral" : bidVolume > offerVolume ? "bid" : "offer",
            });
        }
        let maxVolume = 1;
        for (const values of [book?.bidVolumes, book?.offerVolumes])
          if (Array.isArray(values)) for (const value of values) maxVolume = Math.max(maxVolume, nonNegativeInteger(value));
        for (const row of rows) maxVolume = Math.max(maxVolume, dominantVolume(row));
        return rows.map((row) => ({
          ...row,
          volumePercent: Math.min(100, (dominantVolume(row) / maxVolume) * 100),
        }));
      })(currentBook);
      updateNativeInfo(rows);
      const trade = tradeByCode.get(routeCode);
      (function renderMidQuoteRows(rows, currentPrice, basePrice) {
        const active = new Set();
        const activeCenters = new Set();
        const activeGrids = new Set();
        if (!INSERT_INTO_ORDER_BOOK || 0 === rows.length) {
          cleanupOrderBook();
          return;
        }
        const middleHeight = rows.length * ROW_HEIGHT + "px";
        for (const [sellName, buyName] of BOOK_LIST_PAIRS)
          for (const sellList of document.querySelectorAll(`ul[data-list-name="${sellName}"]`)) {
            const center = sellList.nextElementSibling;
            const buyList = center?.nextElementSibling;
            if (!center || !buyList?.matches(`ul[data-list-name="${buyName}"]`)) continue;
            center.setAttribute("data-bti-mid-order-center", "");
            activeCenters.add(center);
            const orderGrid = center.parentElement;
            const layoutRoot = orderGrid?.parentElement;
            const sideGrid =
              layoutRoot &&
              [...layoutRoot.children].find(
                (candidate) =>
                  candidate !== orderGrid &&
                  candidate instanceof HTMLElement &&
                  (candidate.querySelector('ul[data-list-name="QuotesInfoKr"]') ||
                    candidate.querySelector('ul[data-list-name="TradingStrengthKr"]')),
              );
            for (const grid of [orderGrid, sideGrid])
              if (grid) {
                grid.setAttribute("data-bti-mid-order-grid", "");
                grid.style.setProperty("--bti-mid-order-height", middleHeight);
                activeGrids.add(grid);
              }
            let host = center.querySelector(":scope > [data-bti-mid-order-host]");
            if (!host) {
              host = document.createElement("div");
              host.setAttribute("data-bti-mid-order-host", "");
              center.appendChild(host);
            }
            const existingRows = [...host.querySelectorAll(`:scope > [${ORDER_ROW_ATTRIBUTE}]`)];
            rows.forEach((data, index) => {
              let row = existingRows[index];
              if (!row) {
                row = document.createElement("div");
                row.setAttribute(ORDER_ROW_ATTRIBUTE, "");
                row.append(createVolumeCell(), createPriceCell(), createVolumeCell());
                host.appendChild(row);
              }
              if (
                !(
                  3 === row.children.length &&
                  row.firstElementChild?.querySelector("[data-bti-mid-volume-bar]") &&
                  row.children[1]?.matches("[data-bti-mid-price]") &&
                  row.children[1]?.querySelector(":scope > [data-bti-mid-price-line]")
                )
              )
                row.replaceChildren(createVolumeCell(), createPriceCell(), createVolumeCell());
              if (row.dataset.side !== data.side) row.dataset.side = data.side;
              const isCurrent = String(null !== currentPrice && data.price === currentPrice);
              if (row.dataset.current !== isCurrent) row.dataset.current = isCurrent;
              const percentText = changeLabel(data.price, basePrice);
              const title = `${data.market} 중간호가 ${numberFormat.format(data.price)}원${percentText ? ` · ${percentText}` : ""} · ${volumeLabel(data, true)}`;
              if (row.title !== title) row.title = title;
              const [leftVolume, priceCell, rightVolume] = row.children;
              const leftBar = leftVolume.firstElementChild;
              const rightBar = rightVolume.firstElementChild;
              const market = priceCell.querySelector("[data-bti-mid-market]");
              const price = priceCell.querySelector("b");
              const change = priceCell.querySelector("small");
              const priceText = numberFormat.format(data.price);
              const volumeText = volumeLabel(data);
              if (market.textContent !== data.market) market.textContent = data.market;
              if (price.textContent !== priceText) price.textContent = priceText;
              if (change.textContent !== percentText) change.textContent = percentText;
              for (const [bar, side] of [
                [leftBar, "offer"],
                [rightBar, "bid"],
              ]) {
                const visible = data.side === side;
                if (((bar.hidden = !visible), !visible)) continue;
                bar.dataset.side = side;
                const width = `${data.volumePercent}%`;
                if (bar.style.width !== width) bar.style.width = width;
                if (bar.firstElementChild.textContent !== volumeText) bar.firstElementChild.textContent = volumeText;
              }
            });
            existingRows.slice(rows.length).forEach((row) => row.remove());
            active.add(host);
          }
        cleanupOrderBook(active, activeCenters, activeGrids);
      })(
        rows,
        trade?.currentPrice ?? finiteNumber(currentBook.currentPrice ?? currentBook.close),
        trade?.basePrice ?? finiteNumber(currentBook.basePrice ?? currentBook.base),
      );
    }
    function scheduleRender() {
      if (!renderFrame)
        if (runtime.navigationWorkPaused()) {
          if (!resumeTimer)
            resumeTimer = window.setTimeout(() => {
              resumeTimer = 0;
              scheduleRender();
            }, 300);
        } else renderFrame = requestAnimationFrame(render);
    }
    function isEnhancementNode(node) {
      return node instanceof Element && node.matches(OWN_NODE_SELECTOR);
    }
    function handlePageMutations(mutations) {
      if (currentDomesticCode() || document.querySelector(VISIBLE_ENHANCEMENT_SELECTOR))
        for (const mutation of mutations)
          if (!(mutation.target instanceof Element && mutation.target.closest(OWN_CONTAINER_SELECTOR)))
            for (const nodes of [mutation.addedNodes, mutation.removedNodes])
              for (const node of nodes)
                if (!isEnhancementNode(node)) {
                  scheduleRender();
                  return;
                }
    }
    function observePage() {
      if (document.documentElement && !observer) {
        observer = new MutationObserver(handlePageMutations);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
        scheduleRender();
      }
    }
    if (SHOW_VOLUME || INSERT_INTO_ORDER_BOOK || HIDE_SIDE_INFO) {
      runtime.workerHub.onMessage(function (messageData) {
        const destination = String(messageData?.data?.destination ?? messageData?.destination ?? "");
        const bookMatch = destination.match(/\/bidoffer\/([^?/#]+)/i);
        const tradeMatch = destination.match(/\/trade\/([^?/#]+)/i);
        const match = bookMatch ?? tradeMatch;
        if (!match) return;
        const body = (function parseWorkerBody(messageData) {
          const body = messageData?.data?.message?.body ?? messageData?.message?.body;
          if (typeof body === "string")
            try {
              return JSON.parse(body);
            } catch {
              return null;
            }
          return body && typeof body === "object" ? body : null;
        })(messageData);
        if (!body) return;
        const code = normalizeCode(match[1]);
        if (code) {
          if (bookMatch) touchLimitedMap(bookByCode, code, body);
          else {
            const currentPrice = finiteNumber(body.closeKrw ?? body.close ?? body.currentPrice ?? body.price);
            if (null === currentPrice) return;
            const previous = tradeByCode.get(code);
            const basePrice =
              finiteNumber(body.baseKrw ?? body.base ?? body.basePrice ?? body.previousClose ?? body.prevClose) ??
              previous?.basePrice ??
              null;
            touchLimitedMap(tradeByCode, code, {
              currentPrice,
              basePrice,
            });
          }
          if (code === currentDomesticCode()) scheduleRender();
        }
      });
      onDocumentReady(observePage);
    }
  }

  // ---------------------------------------------------------------------------
  // TradingView 매수·매도 호가선
  // ---------------------------------------------------------------------------

  function installBidAsk() {
    if (window.top !== window.self) return;
    if (window.__tossNativeBidAsk?.installed) return;
    const MAX_CACHED_SYMBOLS = settings.bidAsk.maxCachedSymbols;
    const bookByCode = new Map();
    const transportRecords = new Map();
    const nativeRealtimeSubscriptions = new Set();
    const tradingViewRequireByWindow = new WeakMap();
    const BID_ASK_OVERRIDES = Object.freeze({
      "mainSeriesProperties.bidAsk.visible": true,
      "scalesProperties.showBidAskLabels": true,
    });
    function warn(...args) {
      console.warn("[Toss Native Bid/Ask]", ...args);
    }
    function asFiniteNumber(value) {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value === "string" && "" !== value.trim()) {
        const parsed = Number(value.replaceAll(",", ""));
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    }
    function firstDefined(object, keys) {
      for (const key of keys) if (null != object?.[key]) return object[key];
    }
    function toArray(value) {
      return Array.isArray(value) ? value : null == value ? [] : [value];
    }
    function normalizeCode(symbol) {
      const value = String(symbol ?? "").trim();
      if (!value) return "";
      // Charting Library는 통화가 붙은 심볼을 ={"currency-id":"KRW","symbol":"CODE"}
      // 형태로 quote API에 넘긴다. 실제 WS 종목 코드와 동일하게 정규화한다.
      const extended = (function (symbol) {
        const value = String(symbol ?? "").trim();
        if (!value.startsWith("=")) return null;
        try {
          const parsed = JSON.parse(value.slice(1));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      })(value);
      const withoutCurrencySuffix = String(extended?.symbol ?? extended?.ticker ?? extended?.proName ?? value)
        .trim()
        .split("#", 1)[0]
        .trim();
      const exchangeSeparator = withoutCurrencySuffix.lastIndexOf(":");
      const code = exchangeSeparator >= 0 ? withoutCurrencySuffix.slice(exchangeSeparator + 1).trim() : withoutCurrencySuffix; // 국내주식은 차트 심볼이 000660, 실시간 메시지가 A000660처럼
      // 서로 다른 형식을 사용할 수 있다. 해외 티커의 A 접두사는 건드리지 않고
      // 국내 종목 코드 형태(A + 숫자 6자리)만 같은 키로 정규화한다.
      return /^A\d{6}$/i.test(code) ? code.slice(1) : code.toUpperCase();
    }
    function priceFromLevel(level) {
      return asFiniteNumber(
        level && typeof level === "object" ? firstDefined(level, ["price", "value", "bidPrice", "askPrice", "offerPrice"]) : level,
      );
    }
    function volumeFromLevel(level) {
      return level && typeof level === "object" ? asFiniteNumber(firstDefined(level, ["volume", "size", "quantity", "qty"])) : null;
    }
    function readSide(body, side, currency, exchangeRate) {
      const isBid = "bid" === side;
      const isKrw = "KRW" === currency;
      const bookCurrency = String(body?.currency ?? "").toUpperCase();
      const krwPriceKeys = isBid
        ? ["bidPricesKrw", "bidsKrw", "bidPriceKrw"]
        : ["offerPricesKrw", "askPricesKrw", "offersKrw", "asksKrw", "offerPriceKrw", "askPriceKrw"];
      const volumeKeys = isBid
        ? ["bidVolumes", "bidSizes", "bidVolume"]
        : ["offerVolumes", "askVolumes", "offerSizes", "askSizes", "offerVolume", "askVolume"];
      const nativeLevels = toArray(
        firstDefined(
          body,
          isBid ? ["bidPrices", "bids", "bidPrice"] : ["offerPrices", "askPrices", "offers", "asks", "offerPrice", "askPrice"],
        ),
      );
      const krwLevels = toArray(firstDefined(body, krwPriceKeys));
      const selectedLevels = isKrw && krwLevels.length > 0 ? krwLevels : nativeLevels;
      const volumes = toArray(firstDefined(body, volumeKeys));
      const levels = selectedLevels.length > 0 ? selectedLevels : nativeLevels;
      const shouldConvert = isKrw && 0 === krwLevels.length && "KRW" !== bookCurrency;
      let best = null;
      for (let index = 0; index < levels.length; index += 1) {
        const level = levels[index];
        let price = priceFromLevel(level);
        if (null == price || price <= 0) continue;
        if (shouldConvert) {
          if (null == exchangeRate || exchangeRate <= 0) continue;
          price *= exchangeRate;
        }
        const indexedVolume = asFiniteNumber(volumes[index]);
        if (!(best && !(isBid ? price > best.price : price < best.price)))
          best = {
            price,
            volume: indexedVolume ?? volumeFromLevel(level),
            index,
          };
      }
      // 복수 호가에서는 TradingView 네이티브 라인에 표시할 최우선 호가를 고른다.
      return best;
    }
    function touchEntry(code, patch) {
      const next = {
        ...(bookByCode.get(code) ?? {
          book: null,
          trade: null,
          exchangeRate: null,
          updatedAt: 0,
        }),
        ...patch,
        updatedAt: Date.now(),
      };
      for (
        next.exchangeRate = (function (book, trade, previousRate) {
          const pairs = [
            [trade?.closeKrwDecimal ?? trade?.closeKrw, trade?.close],
            [trade?.baseKrwDecimal ?? trade?.baseKrw, trade?.base],
          ];
          const nativeBid = toArray(firstDefined(book, ["bidPrices", "bids", "bidPrice"]));
          const krwBid = toArray(firstDefined(book, ["bidPricesKrw", "bidsKrw", "bidPriceKrw"]));
          const nativeAsk = toArray(firstDefined(book, ["offerPrices", "askPrices", "offers", "asks", "offerPrice", "askPrice"]));
          const krwAsk = toArray(
            firstDefined(book, ["offerPricesKrw", "askPricesKrw", "offersKrw", "asksKrw", "offerPriceKrw", "askPriceKrw"]),
          );
          if (nativeBid.length && krwBid.length) pairs.push([priceFromLevel(krwBid[0]), priceFromLevel(nativeBid[0])]);
          if (nativeAsk.length && krwAsk.length) pairs.push([priceFromLevel(krwAsk[0]), priceFromLevel(nativeAsk[0])]);
          for (const [krwValue, nativeValue] of pairs) {
            const krw = asFiniteNumber(krwValue);
            const native = asFiniteNumber(nativeValue);
            if (null != krw && null != native && krw > 0 && native > 0) {
              const rate = krw / native;
              if (Number.isFinite(rate) && rate > 0) return rate;
            }
          }
          return previousRate ?? null;
        })(next.book, next.trade, next.exchangeRate),
          // Map의 삽입 순서를 LRU처럼 사용해 장시간 열린 탭의 메모리 사용을 제한한다.
          bookByCode.delete(code),
          bookByCode.set(code, next);
        bookByCode.size > MAX_CACHED_SYMBOLS;

      )
        bookByCode.delete(bookByCode.keys().next().value);
      return next;
    }
    function emitNativeRecord(record) {
      const prices = (function resolveBidAskPrices(record) {
        const entry = bookByCode.get(record.code);
        if (!entry?.book) return null;
        let currency = "";
        try {
          currency = String(record.model?.mainSeries?.()?.symbolInfo?.()?.currency_code ?? entry.book.currency ?? "").toUpperCase();
        } catch {
          currency = String(entry.book.currency ?? "").toUpperCase();
        }
        const { bid, ask, locked } = (function (book, currency, exchangeRate) {
          const bid = readSide(book, "bid", currency, exchangeRate);
          const ask = readSide(book, "ask", currency, exchangeRate);
          return {
            bid,
            ask,
            // KRX/NXT 통합호가가 잠시 같은 가격에 잠기는 경우 가격을 인위적으로
            // 벌리지 않는다. TradingView에는 같은 값 두 개를 그대로 전달한다.
            locked: null != bid && null != ask && bid.price === ask.price,
          };
        })(entry.book, currency, entry.exchangeRate);
        return bid || ask
          ? {
              bid: bid?.price,
              ask: ask?.price,
              locked,
            }
          : null;
      })(record);
      if (prices)
        try {
          record.callback(
            record.symbol,
            {
              bid: prices.bid,
              ask: prices.ask,
            },
            null,
          );
        } catch (error) {
          warn("매수·매도 호가선 갱신에 실패했습니다.", error);
        }
    }
    function emitNativeCode(code) {
      for (const record of [...nativeRealtimeSubscriptions]) if (record.code === code) emitNativeRecord(record);
    }
    function enforceChart(chart) {
      const visibleProperty = (function (chart) {
        try {
          const model = chart?._chartWidget?.model?.()?.model?.();
          const properties = model?.mainSeries?.()?.properties?.();
          return properties?.child?.("bidAsk")?.child?.("visible") ?? null;
        } catch {
          return null;
        }
      })(chart);
      const labelsProperty = (function (chart) {
        try {
          const model = chart?._chartWidget?.model?.()?.model?.();
          return model?.properties?.()?.childs?.()?.scalesProperties?.childs?.()?.showBidAskLabels ?? null;
        } catch {
          return null;
        }
      })(chart);
      let handledInternally = false;
      let changed = false;
      if (visibleProperty) {
        handledInternally = true;
        try {
          if (true !== visibleProperty.value?.()) {
            visibleProperty.setValue(true);
            changed = true;
          }
        } catch {
          // 공개 override API로 이어서 시도한다.
          handledInternally = false;
        }
      }
      if (labelsProperty) {
        handledInternally = true;
        try {
          if (true !== labelsProperty.value?.()) {
            labelsProperty.setValue(true);
            changed = true;
          }
        } catch {
          handledInternally = false;
        }
      }
      if (handledInternally) return changed;
      try {
        chart?.applyOverrides?.(BID_ASK_OVERRIDES);
        return true;
      } catch {
        return false;
      }
    }
    async function installNativeSource(record, chart) {
      const model = chart?._chartWidget?.model?.()?.model?.();
      if (!model || model.hasCustomSource?.("bidask")) return;
      const frameWindow = record.frame?.contentWindow;
      if (!frameWindow) return;
      const webpackRequire = await (function loadTradingViewRuntime(frameWindow) {
        const cached = tradingViewRequireByWindow.get(frameWindow);
        if (cached) return cached;
        const promise = new Promise((resolve, reject) => {
          const chunks = frameWindow?.webpackChunktradingview;
          if (!chunks?.push) {
            reject(new Error("TradingView webpack runtime is not ready"));
            return;
          }
          let webpackRequire = null;
          const runtimeChunkId = `toss_bidask_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          chunks.push([
            [runtimeChunkId],
            {},
            (require) => {
              webpackRequire = require;
            },
          ]);
          if (typeof webpackRequire === "function") resolve(webpackRequire);
          else reject(new Error("TradingView webpack require capture failed"));
        });
        tradingViewRequireByWindow.set(frameWindow, promise);
        return promise;
      })(frameWindow);
      await webpackRequire.e(2650);
      const BidAsk = webpackRequire(13042)?.BidAsk;
      if (typeof BidAsk !== "function" || model.hasCustomSource?.("bidask")) return;
      const provider = (function createBidAskProvider(model) {
        const records = new Map();
        return {
          subscribeRealtime(symbol, callback) {
            const previous = records.get(callback);
            if (previous) nativeRealtimeSubscriptions.delete(previous);
            const record = {
              model,
              symbol: String(symbol),
              code: normalizeCode(symbol),
              callback,
            };
            records.set(callback, record);
            nativeRealtimeSubscriptions.add(record);
            queueMicrotask(() => {
              if (records.get(callback) === record) emitNativeRecord(record);
            });
          },
          unsubscribeRealtime(_symbol, callback) {
            const record = records.get(callback);
            if (record) {
              nativeRealtimeSubscriptions.delete(record);
              records.delete(callback);
            }
          },
        };
      })(model);
      const series = model.mainSeries();
      const originalCurrencyCheck = series.isConvertedToOtherCurrency;
      const originalUnitCheck = series.isConvertedToOtherUnit;
      try {
        series.isConvertedToOtherCurrency = () => false;
        series.isConvertedToOtherUnit = () => false;
        model.addCustomSource("bidask", (id, chartModel) => {
          const source = new BidAsk(id, chartModel, provider, void 0);
          (function (source, model) {
            const events = model.mainSeries().dataEvents();
            events.symbolResolved().unsubscribeAll(source);
            events.symbolError().unsubscribeAll(source);
            source._createTradedSymbol = function () {
              const series = model.mainSeries();
              const symbolInfo = series.symbolInfo();
              const symbol =
                symbolInfo?.pro_name ?? symbolInfo?.full_name ?? symbolInfo?.name ?? series.proSymbol?.() ?? this._symbol ?? null;
              if (symbol !== this._symbol) {
                this._clearTradedSymbol();
                if (!(null == symbol || this._hibernated.value())) this._initTradedSymbol(symbol);
              }
            };
            events.symbolResolved().subscribe(source, source._createTradedSymbol);
            events.symbolError().subscribe(source, source._createTradedSymbol);
            source._createTradedSymbol();
          })(source, chartModel);
          return source;
        });
      } finally {
        series.isConvertedToOtherCurrency = originalCurrencyCheck;
        series.isConvertedToOtherUnit = originalUnitCheck;
      }
    }
    function patchTransport(id, frame) {
      const transport = window[id];
      if (!transport || typeof transport !== "object") return;
      let record = transportRecords.get(id);
      if (record && record.transport === transport) {
        if (frame) record.frame = frame;
      } else {
        record = {
          id,
          frame,
          transport,
        };
        transportRecords.set(id, record);
      }
      const iframe = record.frame ?? document.getElementById(id);
      const api = iframe?.contentWindow?.tradingViewApi;
      if (!api) return;
      let count = 0;
      try {
        count = api.chartsCount?.() ?? 0;
      } catch {
        return;
      }
      for (let index = 0; index < count; index += 1)
        try {
          const chart = api.chart(index);
          if (
            (enforceChart(chart),
            record.nativeSourcePromises || (record.nativeSourcePromises = new WeakMap()),
            !record.nativeSourcePromises.has(chart))
          ) {
            const promise = installNativeSource(record, chart).catch((error) => {
              record.nativeSourcePromises.delete(chart);
              warn("차트에 매수·매도 호가선을 추가하지 못했습니다.", error);
            });
            record.nativeSourcePromises.set(chart, promise);
          }
        } catch {
          // iframe가 레이아웃을 바꾸는 중이면 다음 탐색에서 다시 처리한다.
        }
    }
    function scanTradingViewTransports() {
      if (runtime.navigationWorkPaused()) return;
      const liveIds = (function () {
        const ids = new Set();
        for (const frame of document.querySelectorAll('iframe[id^="tradingview_"]')) if (frame.id) ids.add(frame.id);
        return ids;
      })();
      for (const id of liveIds) patchTransport(id, document.getElementById(id));
      for (const [id, record] of transportRecords) {
        const frame = record.frame;
        if (!(window[id] || (frame && frame.isConnected))) transportRecords.delete(id);
      }
    }
    Object.defineProperty(window, "__tossNativeBidAsk", {
      configurable: true,
      value: {
        installed: true,
      },
    });
    runtime.workerHub.onMessage(function (messageData) {
      const destination = String(messageData?.data?.destination ?? messageData?.destination ?? "");
      const bookMatch = destination.match(/\/bidoffer\/([^?/#]+)/i);
      const tradeMatch = destination.match(/\/trade\/([^?/#]+)/i);
      if (!bookMatch && !tradeMatch) return;
      const body = (function parseWorkerBody(messageData) {
        const body = messageData?.data?.message?.body ?? messageData?.message?.body;
        if (typeof body === "string")
          try {
            return JSON.parse(body);
          } catch {
            return null;
          }
        return body && typeof body === "object" ? body : null;
      })(messageData);
      if (body) {
        if (bookMatch) {
          const code = normalizeCode(body.code ?? bookMatch[1]);
          if (!code) return;
          touchEntry(code, {
            book: body,
          });
          emitNativeCode(code);
          return;
        }
        if (tradeMatch) {
          const code = normalizeCode(body.code ?? tradeMatch[1]);
          if (!code) return;
          touchEntry(code, {
            trade: body,
          });
          emitNativeCode(code);
        }
      }
    });
    (function () {
      scanTradingViewTransports();
      const root = document.documentElement;
      if (root && typeof MutationObserver === "function")
        new MutationObserver((mutations) => {
          for (const mutation of mutations)
            for (const node of mutation.addedNodes)
              if (
                node instanceof Element &&
                (node.matches('iframe[id^="tradingview_"]') || node.querySelector('iframe[id^="tradingview_"]'))
              ) {
                queueMicrotask(scanTradingViewTransports);
                return;
              }
        }).observe(root, {
          childList: true,
          subtree: true,
        });
      // DOM 변경으로 포착되지 않는 차트 전환만 저빈도 탐색으로 보완한다.
      setInterval(scanTradingViewTransports, 500);
    })();
  }

  // 모든 기능을 등록한 뒤 생성자 후킹을 한 번만 시작한다.
  runtime.chartHub = createChartHub();
  for (const [key, install] of Object.entries({
    hollowCandles: installHollowCandles,
    indexChartUnlock: installIndexChartUnlock,
    noWait: installFastRealtime,
    enableSec: installSecondsCharts,
    midQuote: installMidQuote,
    bidAsk: installBidAsk,
  })) initializeModule(key, install);
  runtime.chartHub.start();
  onDocumentReady(mountSettings);
})();
