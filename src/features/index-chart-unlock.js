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
