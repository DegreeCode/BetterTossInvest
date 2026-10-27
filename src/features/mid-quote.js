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
  function ensureMidQuoteStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `\n          [data-bti-mid-info-hidden] {\n            display: none !important;\n          }\n          [${VOLUME_ATTRIBUTE}] {\n            display: inline-block;\n            max-width: min(24vw, 86px);\n            margin-inline-start: 6px;\n            overflow: hidden;\n            color: currentColor;\n            font-size: 11px;\n            font-variant-numeric: tabular-nums;\n            line-height: 1.2;\n            text-overflow: ellipsis;\n            vertical-align: baseline;\n            white-space: nowrap;\n          }\n          [data-bti-mid-order-host] {\n            position: relative;\n            z-index: 1;\n            display: grid;\n            width: 100%;\n            min-width: 0;\n          }\n          [data-bti-mid-order-center] {\n            flex: 0 0 auto !important;\n            height: auto !important;\n            margin-block: 0 !important;\n            background: none !important;\n          }\n          [data-bti-mid-order-grid] {\n            grid-template-rows: minmax(0, 1fr) var(--bti-mid-order-height, auto) minmax(0, 1fr) !important;\n          }\n          [${ORDER_ROW_ATTRIBUTE}] {\n            box-sizing: border-box;\n            display: grid !important;\n            grid-template-columns: minmax(0, 1fr) minmax(104px, 1.2fr) minmax(0, 1fr);\n            width: 100%;\n            min-width: 0;\n            min-height: ${ROW_HEIGHT}px;\n            align-items: center;\n            padding: 0;\n            border-block: 1px solid rgba(128, 128, 128, .14);\n            background: rgba(128, 128, 128, .07);\n            font-variant-numeric: tabular-nums;\n          }\n          [${ORDER_ROW_ATTRIBUTE}][data-side="offer"] {\n            color: var(--wts-adaptive-blue600, #3182f6);\n          }\n          [${ORDER_ROW_ATTRIBUTE}][data-side="bid"] {\n            color: var(--wts-adaptive-red600, #f04452);\n          }\n          [${ORDER_ROW_ATTRIBUTE}][data-side="neutral"] {\n            color: var(--wts-adaptive-grey700, #4e5968);\n          }\n          [${ORDER_ROW_ATTRIBUTE}] > span {\n            position: relative;\n            display: flex;\n            height: 100%;\n            align-items: center;\n            overflow: visible;\n          }\n          [data-bti-mid-price] {\n            box-sizing: border-box;\n            width: fit-content;\n            max-width: 100%;\n            min-width: min(100%, 100px);\n            overflow: hidden;\n            align-self: stretch;\n            justify-self: center;\n            display: flex;\n            position: relative;\n            flex-direction: column;\n            align-items: center;\n            justify-content: center;\n            padding-inline: 5px;\n            text-overflow: ellipsis;\n            white-space: nowrap;\n          }\n          [${ORDER_ROW_ATTRIBUTE}] > span:first-child {\n            justify-content: flex-end;\n          }\n          [${ORDER_ROW_ATTRIBUTE}] > span:last-child {\n            justify-content: flex-start;\n          }\n          [${ORDER_ROW_ATTRIBUTE}][data-current="true"] > [data-bti-mid-price]::before {\n            content: "";\n            position: absolute;\n            inset: 0;\n            border-radius: 8px;\n            box-shadow: inset 0 0 0 1px var(--wts-adaptive-grey700, #4e5968);\n          }\n          [data-bti-mid-price-line] {\n            display: flex;\n            max-width: 100%;\n            min-width: 0;\n            align-items: center;\n            justify-content: center;\n            gap: 3px;\n          }\n          [data-bti-mid-price-line] > b {\n            min-width: 0;\n            overflow: hidden;\n            font-size: 14px;\n            font-weight: 600;\n            line-height: 1.25;\n            text-overflow: ellipsis;\n          }\n          [data-bti-mid-price] > small {\n            margin-top: -2px;\n            font-size: 11px;\n            font-weight: 500;\n            line-height: 1.25;\n          }\n          [data-bti-mid-market] {\n            position: static;\n            flex: 0 0 auto;\n            padding: 1px 2px;\n            border-radius: 3px;\n            background: var(--wts-adaptive-grey100, #f2f4f6);\n            color: var(--wts-adaptive-grey600, #6b7684);\n            font-size: 8px;\n            font-weight: 600;\n            line-height: 1.2;\n          }\n          [data-bti-mid-volume-bar] {\n            position: relative;\n            height: 24px;\n            min-width: 0;\n          }\n          [data-bti-mid-volume-bar][data-side="offer"] {\n            border-radius: 6px 0 0 6px;\n            background: var(--wts-adaptive-blue50, #e8f3ff);\n          }\n          [data-bti-mid-volume-bar][data-side="bid"] {\n            border-radius: 0 6px 6px 0;\n            background: var(--wts-adaptive-red50, #ffeeee);\n          }\n          [data-bti-mid-volume-bar] > span {\n            position: absolute;\n            top: 3px;\n            font-size: 12px;\n            font-weight: 400;\n            white-space: nowrap;\n          }\n          [data-bti-mid-volume-bar][data-side="offer"] > span {\n            right: 6px;\n          }\n          [data-bti-mid-volume-bar][data-side="bid"] > span {\n            left: 6px;\n          }\n        `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildMidQuoteRows(book) {
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
  }

  function renderMidQuoteRows(rows, currentPrice, basePrice) {
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
            bar.hidden = !visible;
          if (!visible) continue;
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
  }

  function render() {
    renderFrame = 0;
    const routeCode = currentDomesticCode();
    const currentBook = bookByCode.get(routeCode);
    if (!routeCode) {
      removeEnhancements();
      return;
    }
    ensureMidQuoteStyles();
    if (!currentBook) {
      removeEnhancements();
      updateNativeInfo([]);
      return;
    }
    const rows = buildMidQuoteRows(currentBook);
    updateNativeInfo(rows);
    const trade = tradeByCode.get(routeCode);
    renderMidQuoteRows(
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
      const body = parseWorkerBody(messageData);
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
