const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadSources(files, exports, globals = {}) {
  const source = files.map((file) => read(`src/${file}.js`)).join('\n');
  return vm.runInNewContext(`(() => { ${source}\nreturn { ${exports} }; })()`, globals);
}

test('the installable userscript matches the current sources from any working directory', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--check'], {
    cwd: __dirname,
    stdio: 'pipe',
  });
});

test('settings retain valid preferences, reject malformed groups and keep defaults independent', () => {
  const { normalizeSettings } = loadSources(['settings'], 'normalizeSettings', {
    window: {}, structuredClone,
    localStorage: { getItem: () => '{invalid JSON' },
  });
  const result = normalizeSettings(JSON.parse(`{
    "modules": {"enableTick": true, "bidAsk": "false", "unknown": true},
    "midQuote": null,
    "enableSec": {"presets": [5, 1, 5], "maxTicksPerSymbol": 1500},
    "enableTick": {"presets": [10, 2000, 10, 30]},
    "noWait": {"intervalMs": 5000},
    "__proto__": {"injected": true}
  }`));
  assert.equal(result.modules.enableTick, true);
  assert.equal(result.modules.bidAsk, true);
  assert.equal(result.modules.unknown, undefined);
  assert.equal(result.injected, undefined);
  assert.equal(result.midQuote.showVolume, true);
  assert.deepEqual(plain(result.enableSec.presets), [1, 5]);
  assert.deepEqual(plain(result.enableTick.presets), [10, 30]);
  assert.equal(result.noWait.intervalMs, 1000);
  result.enableSec.presets.push(42);
  assert.deepEqual(plain(normalizeSettings(null).enableSec.presets), [1, 3, 5, 10, 15, 30, 60]);
});

test('the shared worker parser accepts both transport shapes and ignores malformed bodies', () => {
  const { parseWorkerBody } = loadSources(['core/messages'], 'parseWorkerBody');
  const body = { code: 'A005930', close: 100 };
  assert.equal(parseWorkerBody({ message: { body } }), body);
  assert.deepEqual(plain(parseWorkerBody({ data: { message: { body: JSON.stringify(body) } } })), body);
  assert.equal(parseWorkerBody({ data: { message: { body: '{invalid' } } }), null);
  assert.equal(parseWorkerBody({ message: { body: null } }), null);
});

test('second bars retain OHLCV, currency separation and cache invalidation after a late trade', () => {
  const api = loadSources(['core/numbers', 'local-charts/trade-store', 'local-charts/bars'],
    'createTradeStore, cachedAggregateSeconds');
  const store = api.createTradeStore({
    maxTicksPerSymbol: 1000, maxSymbolBuckets: 2,
    currentInstrumentCode: () => 'TEST', onError: assert.fail,
  });
  const add = (time, price, priceKrw, volume) => store.addTick('TEST', {
    time, priceUsd: price, priceKrw, volume, isTrade: true,
  });
  add(1000, 10, 100, 2);
  add(3000, 12, 120, 3);
  add(5000, 9, 90, 4);
  const bucket = store.getBucket('TEST');
  const initial = api.cachedAggregateSeconds(bucket, {}, 5);
  assert.deepEqual(plain(initial), [
    { time: 0, open: 10, high: 12, low: 10, close: 12, volume: 5 },
    { time: 5000, open: 9, high: 9, low: 9, close: 9, volume: 4 },
  ]);
  assert.equal(api.cachedAggregateSeconds(bucket, {}, 5), initial);
  assert.equal(api.cachedAggregateSeconds(bucket, { currency_code: 'KRW' }, 5)[0].close, 120);
  add(2000, 8, 80, 1);
  const updated = api.cachedAggregateSeconds(bucket, {}, 5);
  assert.notEqual(updated, initial);
  assert.deepEqual(plain(updated[0]), { time: 0, open: 10, high: 12, low: 8, close: 12, volume: 6 });
  assert.equal(initial[0].low, 10);
});

test('trade storage protects the current symbol and isolates failing and removed listeners', () => {
  const { createTradeStore } = loadSources(['local-charts/trade-store'], 'createTradeStore');
  const errors = [], received = [];
  const store = createTradeStore({
    maxTicksPerSymbol: 1000, maxSymbolBuckets: 2,
    currentInstrumentCode: () => 'CURRENT', onError: (error) => errors.push(error),
  });
  store.onTick(() => { throw Error('listener failed'); });
  const stop = store.onTick((code) => received.push(code));
  const tick = { time: 1000, priceUsd: 10, volume: 1, isTrade: true };
  store.addTick('CURRENT', tick);
  store.addTick('OLD', tick);
  stop();
  store.addTick('NEW', tick);
  assert.equal(store.hasBucket('CURRENT'), true);
  assert.equal(store.hasBucket('OLD'), false);
  assert.equal(store.hasBucket('NEW'), true);
  assert.deepEqual(received, ['CURRENT', 'OLD']);
  assert.equal(errors.length, 3);
});

test('webpack transformations survive downstream push installation and array reassignment', () => {
  const original = () => 'original';
  const replacement = () => 'replacement';
  const window = { webpackChunk_N_E: [[[1], { first: original }]] };
  const { runtime } = loadSources(['core/runtime'], 'runtime', {
    window, VERSION: 'test', settings: {}, navigationWorkPaused() {}, console,
  });
  runtime.webpackHub.transformFactories(() => replacement);
  assert.equal(window.webpackChunk_N_E[0][1].first, replacement);
  let calls = 0;
  const previous = window.webpackChunk_N_E.push;
  window.webpackChunk_N_E.push = function (...chunks) {
    calls++;
    return previous(...chunks);
  };
  assert.equal(window.webpackChunk_N_E.push([[2], { second: original }]), 2);
  assert.equal(calls, 1);
  assert.equal(window.webpackChunk_N_E[1][1].second, replacement);
  window.webpackChunk_N_E = [];
  window.webpackChunk_N_E.push([[3], { third: original }]);
  assert.equal(window.webpackChunk_N_E[0][1].third, replacement);
});

test('default modules initialize at document-start and duplicate loads leave the runtime intact', () => {
  const errors = [], warnings = [], events = [];
  const context = vm.createContext({
    structuredClone, URL,
    console: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
    localStorage: { getItem: () => null },
    location: { pathname: '/stocks/A005930/order', href: 'https://www.tossinvest.com/stocks/A005930/order' },
    performance: { now: () => 0 },
    document: {
      documentElement: null,
      addEventListener: (name) => events.push(name),
      querySelectorAll: () => [],
    },
    setTimeout() {}, setInterval() {},
  });
  context.window = context;
  context.top = context;
  context.self = context;
  const source = read('dist/BetterTossInvest.user.js');
  vm.runInContext(source, context);
  const runtime = context.__TOSS_INTEGRATED__;
  assert.equal(runtime.version, read('src/metadata.txt').match(/^\/\/ @version\s+(\S+)/m)[1]);
  for (const [key, module] of Object.entries(runtime.modules)) {
    assert.equal(module.initialized, module.enabled, key);
    assert.equal(module.lastError, null, key);
  }
  assert.deepEqual(errors, []);
  const eventCount = events.length;
  vm.runInContext(source, context);
  assert.equal(context.__TOSS_INTEGRATED__, runtime);
  assert.equal(events.length, eventCount);
  assert.equal(warnings.length, 1);
});
