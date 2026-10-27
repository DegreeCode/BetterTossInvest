function installLocalResolutionControls(state, resolutions) {
  const { secondsEnabled, SECOND_PRESETS, TICK_RESOLUTIONS,
    isSecondsResolution, isTickResolution, supportsTickBars } = resolutions;

  // 토스의 실제 Button/Dropdown 컴포넌트와 주기 변경 콜백을 사용한다.
  const resolutionUiPath = "window.__TOSS_INTEGRATED__.localCharts.resolutionUi";
  const controlTypes = new WeakMap();
  state.nativeControlModules = [];
  state.uiMode = "native-separate";
  state.resolutionUi = {
    withSeconds(list) {
      return [...new Set([
        ...(supportsTickBars() ? TICK_RESOLUTIONS : []),
        ...(secondsEnabled ? SECOND_PRESETS.map((seconds) => `${seconds}S`) : []),
        ...list,
      ])];
    },
    label(resolution) {
      const seconds = isSecondsResolution(resolution), count = isTickResolution(resolution);
      return count != null ? `${count}틱` : seconds != null ? `${seconds}초` : `${resolution}분`;
    },
    isIntraday(resolution) {
      return isTickResolution(resolution) != null || isSecondsResolution(resolution) != null || /^\d+$/.test(String(resolution));
    },
    render(React, Button, Dropdown, useOutsideClick, props) {
      let buttons = controlTypes.get(React);
      if (!buttons) controlTypes.set(React, buttons = new WeakMap());
      let dropdowns = buttons.get(Button);
      if (!dropdowns) buttons.set(Button, dropdowns = new WeakMap());
      let Control = dropdowns.get(Dropdown);
      if (!Control) {
        Control = function LocalResolutionControl({ kind, values, resolution, onSelect, legacy }) {
          const element = React.createElement;
          const selected = kind === "seconds" ? isSecondsResolution(resolution) != null : isTickResolution(resolution) != null;
          const unit = kind === "seconds" ? "초봉" : "틱봉";
          const storageKey = `${SETTINGS_KEY}:last:${kind}:${location.pathname}`;
          const [open, setOpen] = React.useState(false);
          const [last, setLast] = React.useState(() => {
            try {
              const stored = localStorage.getItem(storageKey);
              return values.includes(stored) ? stored : null;
            } catch { return null; }
          });
          const menuRef = React.useRef(null);
          const triggerRef = React.useRef(null);
          const lastResolution = values.includes(last) ? last : null;
          const displayResolution = selected ? String(resolution) : lastResolution;
          const label = displayResolution ? state.resolutionUi.label(displayResolution) : unit;
          useOutsideClick(menuRef, () => setOpen(false), { ignoreSelectors: [`[data-bti-timeframe-trigger="${kind}"]`] });
          React.useEffect(() => {
            setOpen(false);
            if (selected) {
              setLast(String(resolution));
              try { localStorage.setItem(storageKey, String(resolution)); } catch {}
            }
          }, [resolution, selected, storageKey]);
          React.useEffect(() => {
            if (!open) return;
            const closeOnEscape = (event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
            };
            document.addEventListener("keydown", closeOnEscape, true);
            return () => document.removeEventListener("keydown", closeOnEscape, true);
          }, [open]);
          const button = element(Button, {
            type: "button", size: "small", disabled: resolution == null,
            ...(legacy ? { variantTheme: selected ? "weak-neutral" : "clear-neutral", customProps: { root: { onPointerDownCapture: (event) => event.stopPropagation() } } }
              : { variant: selected ? "fill" : "clear", onPointerDownCapture: (event) => event.stopPropagation() }),
            "data-bti-timeframe-trigger": kind,
            "data-resolution-value": displayResolution ?? "",
            "data-selected": String(selected),
            "aria-pressed": selected,
            onClick: (event) => {
              if (event?.currentTarget) triggerRef.current = event.currentTarget;
              if (!selected && lastResolution) { setOpen(false); onSelect(lastResolution); }
              else setOpen((value) => !value);
            },
          }, `${label} ∨`);
          return element(Dropdown, { open, size: "small", onOpenChange: (value) => { if (!value) setOpen(false); } },
            element(Dropdown.Trigger, legacy ? { render: button } : { trigger: "click", children: button }),
            element(Dropdown.Content, {
              ref: menuRef, "data-overlay-type": "Dropdown", "data-overlay-name": "Resolutions",
              "data-section-name": "Dropdown__Resolutions",
              "data-bti-timeframe-menu": kind,
            }, values.map((value) => element(Dropdown.Item, {
              key: value, selectType: "single", check: String(resolution) === value,
              "data-resolution-value": value, "data-selected": String(String(resolution) === value),
              onSelect: () => { setLast(value); setOpen(false); onSelect(value); },
            }, state.resolutionUi.label(value)))),
          );
        };
        dropdowns.set(Dropdown, Control);
      }
      return React.createElement(React.Fragment, null,
        supportsTickBars() ? React.createElement(Control, { ...props, key: "ticks", kind: "ticks", values: TICK_RESOLUTIONS }) : null,
        secondsEnabled ? React.createElement(Control, { ...props, key: "seconds", kind: "seconds", values: SECOND_PRESETS.map((value) => `${value}S`) }) : null,
      );
    },
  };
  const nativeUiState = { patchedModules: state.nativeControlModules, lastError: null };
  runtime.webpackHub.transformFactories((factory, moduleId) => {
    const replacement = rewriteFactory(factory, moduleId, (source) => {
      // 지원 주기 검증에는 초/틱을 추가하되 분봉 버튼의 목록과 마지막 분봉 값은 보존한다.
      if (/\bbB:\(\)=>/.test(source) && /\baK:\(\)=>/.test(source) && /\bLq:\(\)=>/.test(source)) {
        return source.replace(
          /(\b[A-Za-z_$][\w$]*=)(\[\.\.\.[A-Za-z_$][\w$]*,\.\.\.[A-Za-z_$][\w$]*\])(?=,)/,
          `$1${resolutionUiPath}.withSeconds($2)`,
        );
      }
      const isV2 = source.includes('"data-chart-v2-resolution-controls"');
      const isLegacyMain = source.includes('"data-parent-name":"Resolutions"') && source.includes(".resolutions");
      if (isV2 || isLegacyMain) {
        const marker = isV2 ? source.indexOf('"data-chart-v2-resolution-controls"') : source.indexOf('className:');
        const regionStart = isV2 ? source.lastIndexOf("function ", marker) : 0;
        const region = source.slice(regionStart);
        const react = region.match(/\(0,([A-Za-z_$][\w$]*)\.useState\)/)?.[1];
        const outside = region.match(/\(0,([A-Za-z_$][\w$]*)\.j\)\(/)?.[1];
        const dropdown = region.match(/children:\[\(0,[A-Za-z_$][\w$]*\.FD\)\(([A-Za-z_$][\w$]*\.t),\{open:/)?.[1];
        const button = region.match(/\(([A-Za-z_$][\w$]*\.t),\{"data-tossinvest-log":"Button"/)?.[1];
        const resolution = isV2 ? region.match(/selectedResolution:([A-Za-z_$][\w$]*)/)?.[1]
          : region.match(/([A-Za-z_$][\w$]*)\.resolutions/)?.[1];
        const onSelect = isV2 ? region.match(/onSelectResolution:([A-Za-z_$][\w$]*)/)?.[1]
          : resolution && `(value)=>${resolution}.resolutions?.setResolution(value)`;
        if (!react || !outside || !dropdown || !button || !resolution || !onSelect) return null;
        const insertion = source.indexOf("children:[", marker);
        if (insertion < 0) return null;
        const selected = isV2 ? resolution : `${resolution}.resolutions?.resolution`;
        const render = `${resolutionUiPath}.render(${react},${button},${dropdown},${outside}.j,{resolution:${selected},onSelect:${onSelect},legacy:${!isV2}}),`;
        return source.slice(0, insertion + 10) + render + source.slice(insertion + 10);
      }
      // 보조 차트의 '주기 변경' 메뉴는 기존 통합 목록을 유지한다.
      if (!/\.bB\.map\(/.test(source) || !/"data-overlay-name":"(?:Resolutions|PaneSwitcherResolutions)"/.test(source)) return null;
      return source.replace(/([A-Za-z_$][\w$]*)\.bB\.(map|includes)\(/g, `${resolutionUiPath}.withSeconds($1.bB).$2(`)
        .replace(/`\$\{([^{}]+)\}분( ∨)?`/g, (_match, value, arrow) => `${resolutionUiPath}.label(${value})${arrow ? '+" ∨"' : ""}`)
        .replace(/children:\[([A-Za-z_$][\w$]*),"분"\]/g, `children:[${resolutionUiPath}.label($1)]`);
    }, nativeUiState, "주기 메뉴");
    if (nativeUiState.lastError) state.lastError = nativeUiState.lastError;
    return replacement;
  });
}
