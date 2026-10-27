function createTickChartTimeCompatibility({ ticksEnabled, isTickResolution }, state) {
  const charts = new WeakSet();
  const converters = new WeakSet();
  const scales = new WeakSet();
  const timezoneFormatters = new Map();
  state.tickTimeConvertersPatched = 0;
  state.tickTimeScalesPatched = 0;

  function userTime(time, timezone) {
    const milliseconds = Math.round(time * 1_000);
    if (timezone === "Etc/UTC" || timezone === "UTC") return milliseconds;
    let formatter = timezoneFormatters.get(timezone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone, calendar: "gregory", numberingSystem: "latn",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      });
      timezoneFormatters.set(timezone, formatter);
    }
    const parts = Object.fromEntries(formatter.formatToParts(milliseconds)
      .filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
      ((milliseconds % 1_000) + 1_000) % 1_000);
  }

  function patchScale(chart, DateConstructor) {
    const scale = chart.getTimeScale?.()?._timeScale;
    if (!scale || scales.has(scale) || typeof scale.indexToUserTime !== "function" ||
        typeof scale.indexToTimePoint !== "function") return;
    const indexToUserTime = scale.indexToUserTime;
    scale.indexToUserTime = function (index, ...args) {
      if (isTickResolution(chart.resolution()) != null) {
        const time = this.indexToTimePoint(index);
        const selectedTimezone = chart.getTimezoneApi?.()?.getTimezone?.();
        let timezone = typeof selectedTimezone === "string" ? selectedTimezone : selectedTimezone?.id;
        if (!timezone || timezone === "exchange") {
          timezone = chart._chartWidget?.model?.()?.model?.()?.mainSeries?.()?.symbolInfo?.()?.timezone;
        }
        if (typeof time === "number" && Number.isFinite(time) && timezone) {
          try {
            // Tick marks may be absent or second-rounded inside a burst. They
            // are labels, not a reliable source for a candle's hover time.
            return new DateConstructor(userTime(time, timezone));
          } catch {
            // Unknown/custom timezones keep the library's own conversion.
          }
        }
      }
      return indexToUserTime.call(this, index, ...args);
    };
    scales.add(scale);
    state.tickTimeScalesPatched += 1;
  }

  function patchChart(chart, widget) {
    if (!chart || charts.has(chart) || typeof chart._getTimeConverter !== "function") return chart;
    const getTimeConverter = chart._getTimeConverter;
    chart._getTimeConverter = function (...args) {
      patchScale(chart, widget._iFrame?.contentWindow?.Date ?? Date);
      const converter = getTimeConverter.apply(this, args);
      if (!converter || converters.has(converter) ||
          typeof converter.convertTimePointIndexToPublicTime !== "function" ||
          typeof converter.convertTimePointIndexToInternalTime !== "function") return converter;
      const convertPublicTime = converter.convertTimePointIndexToPublicTime;
      converter.convertTimePointIndexToPublicTime = function (index, ...args) {
        if (isTickResolution(chart.resolution()) != null) {
          // Toss enables end_of_period_timescale_marks. Its public-time
          // converter then uses the timezone-adjusted axis label, which drops
          // milliseconds and can point outside every bar in a burst. Tick bars
          // already have unique UTC timestamps: use the selected bar's time.
          const time = this.convertTimePointIndexToInternalTime(index);
          if (typeof time === "number" && Number.isFinite(time)) return time;
        }
        return convertPublicTime.call(this, index, ...args);
      };
      converters.add(converter);
      state.tickTimeConvertersPatched += 1;
      return converter;
    };
    charts.add(chart);
    return chart;
  }

  return function patchWidget(widget) {
    if (!ticksEnabled) return;
    // Install before the site subscribes to crossHairMoved/getEntityValues,
    // including charts added later when switching to a multi-chart layout.
    for (const method of ["chart", "activeChart"]) {
      if (typeof widget[method] !== "function") continue;
      const original = widget[method];
      widget[method] = function (...args) {
        return patchChart(original.apply(this, args), widget);
      };
    }
  };
}
