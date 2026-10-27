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
    else input.value = path.endsWith(".presets") ? current.join(", ") : String(current ?? "");
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
        ["틱 단위 차트", "modules.enableTick", "수집한 개별 체결을 설정한 건수로 묶어 틱봉을 만듭니다. 주기 메뉴에서 초·분봉과 함께 선택합니다."],
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
      "초봉·틱봉",
      [
        [
          "표시할 시간 단위 (초, 쉼표로 구분)",
          "enableSec.presets",
          "시간 단위 메뉴에 추가할 1~60초 주기를 쉼표로 구분해 입력합니다. 예: 1, 3, 5, 10",
          "text",
        ],
        [
          "틱봉 체결 건수 (쉼표로 구분)",
          "enableTick.presets",
          "봉 하나로 묶을 체결 건수를 입력합니다. 예: 10, 30, 100, 300, 1000. 최대 10000이며 체결 보관 수를 넘을 수 없습니다.",
          "text",
        ],
        [
          "종목별 최대 체결 내역 수",
          "enableSec.maxTicksPerSymbol",
          "초봉·틱봉 생성을 위해 종목별로 메모리에 보관할 최근 체결 데이터의 최대 개수입니다.",
          "number",
          {
            min: 1_000,
            max: 200_000,
          },
        ],
        [
          "최대 보관 종목 수",
          "enableSec.maxSymbolBuckets",
          "초봉·틱봉용 체결 데이터를 동시에 보관할 종목 수의 최대값입니다.",
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
          : path.endsWith(".presets")
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
