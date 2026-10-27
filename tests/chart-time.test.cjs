const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/local-charts/chart-time.js'), 'utf8');
const createCompatibility = vm.runInNewContext(`${source}\ncreateTickChartTimeCompatibility;`);
const base = Date.parse('2026-10-28T01:00:00Z');

function fixture({ enabled = true, times = [base, base + 1, base + 2, base + 999], timezone = 'Asia/Seoul' } = {}) {
  let resolution = '10T';
  const state = {};
  class FrameDate extends Date {}
  const scale = {
    indexToTimePoint(index) { return times[index] == null ? null : times[index] / 1000; },
    // Reproduce missing/second-rounded tick-mark entries with end-of-period labels.
    indexToUserTime(index) { return index % 2 ? null : new FrameDate(base + 32401000); },
  };
  const converter = {
    convertTimePointIndexToInternalTime(index) { return scale.indexToTimePoint(index); },
    convertTimePointIndexToPublicTime(index) {
      const date = scale.indexToUserTime(index);
      return date == null ? null : date.getTime() / 1000;
    },
  };
  const chart = {
    resolution: () => resolution,
    getTimeScale: () => ({ _timeScale: scale }),
    getTimezoneApi: () => ({ getTimezone: () => ({ id: timezone }) }),
    _getTimeConverter: () => converter,
  };
  const widget = { _iFrame: { contentWindow: { Date: FrameDate } }, chart: () => chart, activeChart: () => chart };
  const patch = createCompatibility({ ticksEnabled: enabled, isTickResolution: (value) => /^\d+T$/.test(value) ? 10 : null }, state);
  return { patch, widget, chart, converter, scale, state, FrameDate, setResolution(value) { resolution = value; } };
}

test('every same-second tick candle retains a distinct UTC hover key and matching volume', () => {
  const times = Array.from({ length: 20 }, (_, index) => base + index);
  const f = fixture({ times });
  const candles = new Map(times.map((time, index) => [time / 1000, { volume: index + 1 }]));
  assert.equal(candles.get(f.converter.convertTimePointIndexToPublicTime(0)), undefined);
  assert.equal(f.converter.convertTimePointIndexToPublicTime(1), null);
  f.patch(f.widget);
  const converter = f.widget.chart()._getTimeConverter();
  const hoverKeys = times.map((_, index) => converter.convertTimePointIndexToPublicTime(index));
  assert.equal(new Set(hoverKeys).size, times.length);
  assert.deepEqual(hoverKeys.map((time) => candles.get(time).volume), times.map((_, index) => index + 1));
  assert.equal(f.state.tickTimeConvertersPatched, 1);
});

test('missing tick-mark entries still produce millisecond-precise local axis times', () => {
  const f = fixture();
  f.patch(f.widget);
  f.widget.activeChart()._getTimeConverter();
  for (let index = 0; index < 4; index++) {
    const date = f.scale.indexToUserTime(index);
    assert.ok(date instanceof f.FrameDate);
    assert.equal(date.getTime(), [base, base + 1, base + 2, base + 999][index] + 32400000);
  }
});

test('time correction respects the selected timezone including daylight-saving transitions', () => {
  const times = [Date.parse('2026-11-01T05:59:59.999Z'), Date.parse('2026-11-01T06:00:00.001Z')];
  const f = fixture({ times, timezone: 'America/New_York' });
  f.patch(f.widget);
  f.widget.chart()._getTimeConverter();
  assert.equal(f.scale.indexToUserTime(0).toISOString(), '2026-11-01T01:59:59.999Z');
  assert.equal(f.scale.indexToUserTime(1).toISOString(), '2026-11-01T01:00:00.001Z');
  assert.equal(f.converter.convertTimePointIndexToPublicTime(0), times[0] / 1000);
  assert.equal(f.converter.convertTimePointIndexToPublicTime(1), times[1] / 1000);
});

test('UTC, legacy string timezones and exchange timezones preserve the selected candle', () => {
  for (const [selected, exchange, offset] of [
    ['UTC', null, 0],
    ['Asia/Seoul', null, 32400000],
    [{ id: 'exchange' }, 'America/New_York', -14400000],
  ]) {
    const f = fixture();
    f.chart.getTimezoneApi = () => ({ getTimezone: () => selected });
    f.chart._chartWidget = { model: () => ({ model: () => ({ mainSeries: () => ({ symbolInfo: () => ({ timezone: exchange }) }) }) }) };
    f.patch(f.widget);
    f.widget.chart()._getTimeConverter();
    assert.equal(f.scale.indexToUserTime(1).getTime(), base + 1 + offset);
    assert.equal(f.converter.convertTimePointIndexToPublicTime(1), (base + 1) / 1000);
  }
});

test('minute, second and daily modes keep native time behavior when switching away from ticks', () => {
  const f = fixture();
  const originalPublic = f.converter.convertTimePointIndexToPublicTime;
  const originalUser = f.scale.indexToUserTime;
  f.patch(f.widget);
  f.widget.chart()._getTimeConverter();
  for (const resolution of ['1', '5S', '1D', '1W']) {
    f.setResolution(resolution);
    assert.equal(f.converter.convertTimePointIndexToPublicTime(0), originalPublic.call(f.converter, 0));
    assert.equal(f.scale.indexToUserTime(0).getTime(), originalUser.call(f.scale, 0).getTime());
    assert.equal(f.scale.indexToUserTime(1), null);
  }
  f.setResolution('100T');
  assert.equal(f.converter.convertTimePointIndexToPublicTime(1), (base + 1) / 1000);
  assert.equal(f.scale.indexToUserTime(1).getTime(), base + 1 + 32400000);
});

test('later layout charts are patched once and unavailable times or timezones fall back safely', () => {
  const first = fixture(), second = fixture({ timezone: 'Unsupported/Timezone' });
  const widget = { chart: (index) => index === 1 ? second.chart : first.chart, activeChart: () => first.chart };
  first.patch(widget);
  widget.chart(0)._getTimeConverter();
  widget.activeChart()._getTimeConverter();
  widget.chart(1)._getTimeConverter();
  widget.chart(1)._getTimeConverter();
  assert.equal(first.state.tickTimeConvertersPatched, 2);
  assert.equal(first.state.tickTimeScalesPatched, 2);
  assert.equal(second.converter.convertTimePointIndexToPublicTime(1), (base + 1) / 1000);
  assert.equal(second.scale.indexToUserTime(1), null);
  assert.equal(first.converter.convertTimePointIndexToPublicTime(100), base / 1000 + 32401);
  assert.equal(first.scale.indexToUserTime(100).getTime(), base + 32401000);
  assert.equal(first.scale.indexToUserTime(101), null);
});

test('disabled tick mode and unsupported chart APIs remain untouched', () => {
  const f = fixture({ enabled: false });
  const chartMethod = f.widget.chart;
  const converterMethod = f.chart._getTimeConverter;
  f.patch(f.widget);
  assert.equal(f.widget.chart, chartMethod);
  assert.equal(f.chart._getTimeConverter, converterMethod);
  const chart = {};
  const widget = { chart: () => chart };
  fixture().patch(widget);
  assert.equal(widget.chart(), chart);
});
