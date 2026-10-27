const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(require('node:path').join(__dirname, '../dist/BetterTossInvest.user.js'), 'utf8');

function boot(enabled = {}, pathname = '/stocks/A005930/order', stored = {}, globals = {}) {
  const timers = [], intervals = [], frames = [], warnings = [];
  let now = 0;
  class SharedWorker {
    constructor() {
      this.port = { addEventListener(_event, handler) { this.receive = handler; } };
    }
  }
  const context = vm.createContext({
    console: { error: (...args) => warnings.push(args), warn: (...args) => warnings.push(args) },
    structuredClone, URL, SharedWorker, queueMicrotask,
    localStorage: { getItem: () => JSON.stringify({ ...stored, modules: {
      bidAsk: false, midQuote: false, hollowCandles: false,
      indexChartUnlock: false, enableSec: false, enableTick: false, noWait: false, ...enabled,
    } }) },
    location: { pathname, href: `https://www.tossinvest.com${pathname}` },
    performance: { now: () => now },
    document: {
      readyState: 'loading', title: '', hidden: false, documentElement: null,
      addEventListener() {},
      querySelectorAll: (selector) => selector.startsWith('iframe') ? frames : [],
      getElementById: (id) => frames.find((frame) => frame.id === id),
    },
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout() {},
    setInterval: (fn, ms) => (intervals.push({ fn, ms }), intervals.length),
    requestAnimationFrame: (fn) => (timers.push({ fn, ms: 0 }), timers.length),
    cancelAnimationFrame() {},
    ...globals,
  });
  context.window = context;
  context.self = context;
  context.top = context;
  vm.runInContext(source, context);
  return {
    context, frames, intervals, warnings,
    runtime: context.__TOSS_INTEGRATED__,
    advance(ms) { now += ms; },
    flushTimers() {
      for (const timer of timers.splice(0)) if (timer.ms === 0) timer.fn();
    },
    transform(factory) {
      context.factory = factory;
      vm.runInContext('webpackChunk_N_E.push([[123456], { sample: factory }])', context);
      return context.webpackChunk_N_E.at(-1)[1].sample;
    },
  };
}

function widgetFactory(harness, expression) {
  harness.context.CapturedWidget = class {
    constructor(options) { this.options = options; }
    onChartReady() {}
  };
  const factory = vm.runInContext(`(module) => {
    const tv = { HL: CapturedWidget, widget: CapturedWidget };
    module.exports = ${expression};
  }`, harness.context);
  const result = {};
  harness.transform(factory)(result);
  return result.exports;
}

for (const [name, expression] of [
  ['v32 renamed export', 'new tv.HL({container:"chart",datafeed:window.feed,library_path:"/library/",disabled_features:["seconds_resolution","header_widget"]})'],
  ['v27 widget with nested options', 'new tv.widget({symbol:"A005930",custom:{nested:true},datafeed:window.feed,disabled_features:["seconds_resolution","header_widget"]})'],
]) {
  test(`${name}: seconds and index features share one constructor wrapper`, () => {
    const h = boot({ enableSec: true, indexChartUnlock: true }, '/indices/KOSPI');
    h.context.feed = { onReady(cb) { cb({ supported_resolutions: ['1D'] }); } };
    const widget = widgetFactory(h, expression);
    assert.ok(widget instanceof h.context.CapturedWidget);
    assert.ok(widget.options.enabled_features.includes('seconds_resolution'));
    assert.ok(widget.options.enabled_features.includes('header_widget'));
    assert.ok(!widget.options.disabled_features.includes('header_widget'));
    let resolutions;
    widget.options.datafeed.onReady((config) => { resolutions = config.supported_resolutions; });
    assert.ok(resolutions.includes('1D') && resolutions.includes('1S') && resolutions.includes('60S'));
    assert.equal(h.runtime.modules.enableSec.widgetsCaptured, 1);
    assert.equal(h.runtime.modules.indexChartUnlock.widgetOptionsPatched, 1);
  });
}

test('renamed constructors without chart options are preserved', () => {
  const h = boot({ indexChartUnlock: true }, '/indices/KOSPI');
  widgetFactory(h, 'new tv.HL({container:"other",disabled_features:[],note:"datafeed"})');
  assert.equal(h.runtime.modules.indexChartUnlock.widgetOptionsPatched, 0);
});

test('seconds history stays local; regular history still delegates to Toss', () => {
  const h = boot({ enableSec: true });
  let historicalCalls = 0;
  h.context.feed = { getBars() { historicalCalls++; }, onReady() {} };
  const widget = widgetFactory(h, 'new tv.HL({container:"chart",datafeed:window.feed,library_path:"/library/",disabled_features:[]})');
  let result;
  widget.options.datafeed.getBars({ name: 'A005930' }, '1S', {}, (bars, meta) => { result = { bars, meta }; });
  h.flushTimers();
  assert.equal(historicalCalls, 0);
  assert.equal(result.bars.length, 0);
  assert.equal(result.meta.noData, true);
  widget.options.datafeed.getBars({ name: 'A005930' }, '1', {}, () => {});
  assert.equal(historicalCalls, 1);
});

test('React.use realtime hook preserves site behavior and only adjusts default intervals', () => {
  const h = boot({ noWait: true });
  // The updated bundle reads context through React.use instead of useContext.
  const factory = vm.runInContext(`(module,exports,require)=>{
    require.d(exports,{A:()=>hook});
    const React=require(1);
    const hook=()=>{const {globalTimer}=React.use({});return {
      getIsConnected:()=>true,
      subscribe:(destination,callback,options)=>{
        const {throttleInterval=200,backgroundSubscribed=false}=options??{};
        if(destination==="invalid")throw Error("site validation");
        return {throttleInterval,backgroundSubscribed,lastMessage:"original",unsubscribe:globalTimer};
      }
    }};
  }`, h.context);
  const requireModule = () => ({ use: () => ({ globalTimer: 'original cleanup' }) });
  requireModule.d = (exports, getters) => {
    for (const key in getters) Object.defineProperty(exports, key, { get: getters[key] });
  };
  const exports = {};
  h.transform(factory)({}, exports, requireModule);
  const client = exports.A();
  for (const options of [undefined, {}, { throttleInterval: 100 }, { throttleInterval: 200 }]) {
    assert.equal(client.subscribe('test', () => {}, options).throttleInterval, 16);
  }
  const custom = client.subscribe('test', () => {}, { throttleInterval: 350, backgroundSubscribed: true });
  assert.equal(custom.throttleInterval, 350);
  assert.equal(custom.backgroundSubscribed, true);
  assert.equal(custom.lastMessage, 'original');
  assert.equal(custom.unsubscribe, 'original cleanup');
  assert.throws(() => client.subscribe('invalid', () => {}), /site validation/);
  assert.equal(h.runtime.modules.noWait.active, true);
});

test('unrelated application factories are not rewritten as realtime hooks', () => {
  const h = boot({ noWait: true });
  const factory = vm.runInContext(`(m,e,r)=>{
    r.d(e,{default:()=>app,other:()=>app});
    const app={globalTimer:true,getIsConnected:true,throttleInterval:200,backgroundSubscribed:false,lastMessage:null,
      subscribe:(a,b,c)=>{return c}};
  }`, h.context);
  assert.equal(h.transform(factory), factory);
  assert.equal(h.runtime.modules.noWait.active, false);
});

function addChart(h, { chunk = 33599, failOnce = false, failChunk = chunk, ready = true, runtimeReady = true, preloaded = false } = {}) {
  const requests = [], subscriptions = [];
  let failed = false, modelReady = ready, labelsReady = false;
  const property = { value: () => true };
  const events = { symbolResolved: () => ({ unsubscribeAll() {}, subscribe() {} }), symbolError: () => ({ unsubscribeAll() {}, subscribe() {} }) };
  const model = {
    source: null,
    hasCustomSource() { return !!this.source; },
    mainSeries: () => ({
      properties: () => ({ child: () => ({ child: () => property }) }),
      dataEvents: () => events,
      symbolInfo: () => ({ name: 'A005930' }),
    }),
    properties: () => ({ childs: () => ({ scalesProperties: { childs: () => ({ showBidAskLabels: property }) } }) }),
    addCustomSource(_name, create) { this.source = create('bidask', this); },
  };
  class BidAsk {
    constructor(_id, _model, provider) {
      if (chunk === 33599) assert.ok(labelsReady, "labels must load before installing a v32 source");
      this._symbol = null;
      this._hibernated = { value: () => false };
      this.provider = provider;
    }
    _clearTradedSymbol() { this._symbol = null; }
    _initTradedSymbol(symbol) { this._symbol = symbol; subscriptions.push(symbol); }
  }
  const requireModule = (id) => {
    assert.equal(String(id), '987654'); // The export is discovered; old module 13042 is never requested.
    return { BidAsk };
  };
  requireModule.m = {};
  const register = () => { requireModule.m[987654] = function (m, e, r) { r.d(e, { BidAsk: () => null }); }; };
  if (preloaded) register();
  // Simulates the language wrapper around webpack's URL lookup: no name map in toString().
  requireModule.u = (id) => id === chunk ? 'trading-custom-sources.test.js' : id === 3696 && chunk === 33599 ? 'ko.3696.test.js' : `${id}.undefined.js`;
  requireModule.e = async (id) => {
    requests.push(id);
    assert.ok(id === chunk || (chunk === 33599 && id === 3696));
    if (failOnce && id === failChunk && !failed) { failed = true; throw Error('temporary chunk failure'); }
    if (id === 3696) { labelsReady = true; return; }
    register();
  };
  const chunks = { push(payload) { payload[2](requireModule); } };
  const frame = {
    id: `tradingview_test_${h.frames.length}`, isConnected: true,
    contentWindow: {
      tradingViewApi: { chartsCount: () => 1, chart: () => chart },
      webpackChunktradingview: runtimeReady ? chunks : undefined,
    },
  };
  const chart = { _chartWidget: { model: () => ({ model: () => modelReady ? model : null }) }, applyOverrides() {} };
  h.frames.push(frame);
  h.context[frame.id] = {};
  return { frame, model, requests, subscriptions, requireModule, makeReady: () => { modelReady = true; }, runtimeReady: () => { frame.contentWindow.webpackChunktradingview = chunks; } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const scan = (h) => h.intervals.find((timer) => timer.ms === 500).fn();

for (const chunk of [2650, 33599]) {
  test(`bid/ask selects the verified v${chunk === 2650 ? 27 : 32} chunk and discovers its export`, async () => {
    const h = boot({ bidAsk: true });
    const chart = addChart(h, { chunk });
    scan(h);
    await settle();
    assert.deepEqual(chart.requests, chunk === 33599 ? [33599, 3696] : [2650]);
    assert.deepEqual(chart.subscriptions, ['A005930']);
    assert.equal(h.runtime.modules.bidAsk.nativeSourcesInstalled, 1);
    scan(h);
    await settle();
    assert.deepEqual(chart.requests, chunk === 33599 ? [33599, 3696] : [2650]);
  });
}

test('bid/ask reuses a loaded export without downloading a chunk', async () => {
  const h = boot({ bidAsk: true });
  const chart = addChart(h, { preloaded: true, chunk: 2650 });
  scan(h);
  await settle();
  assert.ok(chart.model.source);
  assert.deepEqual(chart.requests, []);
});

test('bid/ask retries after chart initialization, runtime initialization and a failed download', async () => {
  const h = boot({ bidAsk: true });
  const chart = addChart(h, { ready: false, runtimeReady: false, failOnce: true });
  scan(h);
  await settle();
  chart.makeReady();
  scan(h);
  await settle();
  chart.runtimeReady();
  h.advance(5000);
  scan(h);
  await settle();
  assert.equal(chart.model.source, null);
  assert.deepEqual(chart.requests, [33599]);
  h.advance(5000);
  scan(h);
  await settle();
  assert.ok(chart.model.source);
  assert.deepEqual(chart.requests, [33599, 33599, 3696]);
  assert.equal(h.runtime.modules.bidAsk.lastError, null);
});

test('unsupported chart runtimes do not request undefined files or flood warnings', async () => {
  const h = boot({ bidAsk: true });
  const chart = addChart(h, { chunk: 99999 });
  for (let i = 0; i < 3; i++) {
    scan(h);
    await settle();
    h.advance(5000);
  }
  assert.deepEqual(chart.requests, []);
  assert.equal(h.warnings.length, 1);
});


test('v32 waits for label translations and retries a failed translation download', async () => {
  const h = boot({ bidAsk: true });
  const chart = addChart(h, { failOnce: true, failChunk: 3696 });
  scan(h);
  await settle();
  assert.equal(chart.model.source, null);
  assert.deepEqual(chart.requests, [33599, 3696]);
  h.advance(5000);
  scan(h);
  await settle();
  assert.ok(chart.model.source);
  assert.deepEqual(chart.requests, [33599, 3696, 3696]);
});

test('a known chunk with a missing filename hash is never requested', async () => {
  const h = boot({ bidAsk: true });
  const chart = addChart(h);
  chart.requireModule.u = () => 'trading-custom-sources.undefined.js';
  scan(h);
  await settle();
  assert.deepEqual(chart.requests, []);
  assert.equal(chart.model.source, null);
});

function nativeResolutionList(h) {
  const factory = vm.runInContext(`(m,t,r)=>{
    r.d(t,{bB:()=>short,aK:()=>all,Lq:()=>labels,Ve:()=>minutes});
    let minutes=["1","3","5","10","15","30","60","120","240"],short=[...minutes],days=["1D","1W","1M","12M"],all=[...short,...days],labels={"1D":"일"};
  }`, h.context);
  const exports = {};
  const requireModule = { d(target, defs) { for(const key in defs) Object.defineProperty(target,key,{get:defs[key]}); } };
  h.transform(factory)({}, exports, requireModule);
  return exports;
}

test('native UI lists include seconds without changing the original minute resolutions', () => {
  const h = boot({ enableSec: true });
  const lists = nativeResolutionList(h);
  assert.equal(lists.Ve.length, 9);
  assert.ok(!lists.Ve.includes('5S'));
  assert.ok(!lists.bB.includes('5S') && lists.bB.includes('5'));
  assert.equal(lists.bB.length,9);
  assert.ok(lists.aK.includes('5S') && lists.aK.includes('1D'));
  assert.equal(new Set(lists.bB).size, lists.bB.length);
});

function nativeControlsHarness(ui, legacy = false) {
  const hooks = new Map(), selected = [], types = new Map();
  let active, index, resolution = '1';
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }; },
    useState(initial) {
      const slot=index++;
      if (!(slot in active)) active[slot]=typeof initial==='function'?initial():initial;
      const state=active;
      return [state[slot],value=>{state[slot]=typeof value==='function'?value(state[slot]):value;}];
    },
    useRef(initial) { const slot=index++;return active[slot]??(active[slot]={current:initial}); },
    useEffect(callback,deps) {
      const slot=index++,previous=active[slot];
      if(!previous||deps.some((value,i)=>!Object.is(value,previous[i]))) {active[slot]=deps;callback();}
    },
  };
  function Button() {}
  function Dropdown() {}
  Object.assign(Dropdown,{Trigger:'trigger',Content:'content',Item:'item'});
  const outside=new Map();
  let kind;
  const useOutside=(_ref,callback)=>outside.set(kind,callback);
  const render=()=>{
    const tree=ui.render(React,Button,Dropdown,useOutside,{resolution,onSelect:value=>{selected.push(value);resolution=value;},legacy});
    const groups={};
    for(const child of tree.props.children.filter(Boolean)) {
      kind=child.props.kind;
      if(types.get(kind)!==child.type) { hooks.set(kind,[]);types.set(kind,child.type); }
      active=hooks.get(kind);index=0;
      const root=child.type(child.props),[trigger,content]=root.props.children;
      groups[kind]={root,button:legacy?trigger.props.render:trigger.props.children,items:content.props.children,closeOutside:outside.get(kind)};
    }
    return groups;
  };
  return {render,selected,setResolution:value=>{resolution=value;},getResolution:()=>resolution,Button,Dropdown};
}

for(const legacy of [true,false]) {
  test(`${legacy?'v27':'v32'}: separate seconds/tick controls use native components and independent remembered selections`,()=>{
    const h=boot({enableSec:true,enableTick:true});
    const ui=nativeControlsHarness(h.runtime.localCharts.resolutionUi,legacy);
    let groups=ui.render();
    assert.equal(groups.seconds.root.type,ui.Dropdown);
    assert.equal(groups.seconds.button.type,ui.Button);
    assert.equal(groups.seconds.button.props.children,'초봉 ∨');
    assert.equal(groups.ticks.button.props.children,'틱봉 ∨');
    assert.equal(groups.seconds.button.props.size,'small');
    assert.ok(groups.seconds.items.every(item=>item.props['data-resolution-value'].endsWith('S')));
    assert.ok(groups.ticks.items.every(item=>item.props['data-resolution-value'].endsWith('T')));
    groups.seconds.button.props.onClick();
    assert.equal(ui.render().seconds.root.props.open,true);
    groups.seconds.items.find(item=>item.props['data-resolution-value']==='5S').props.onSelect();
    groups=ui.render();
    assert.equal(ui.getResolution(),'5S');
    assert.equal(groups.seconds.button.props['data-selected'],'true');
    assert.equal(groups.ticks.button.props['data-selected'],'false');
    assert.equal(groups.seconds.button.props[legacy?'variantTheme':'variant'],legacy?'weak-neutral':'fill');
    assert.equal(groups.seconds.items.find(item=>item.props['data-resolution-value']==='5S').props.check,true);
    groups.ticks.items.find(item=>item.props['data-resolution-value']==='100T').props.onSelect();
    groups=ui.render();
    assert.equal(groups.seconds.button.props.children,'5초 ∨');
    assert.equal(groups.seconds.button.props['data-selected'],'false');
    assert.equal(groups.ticks.button.props.children,'100틱 ∨');
    assert.equal(groups.ticks.button.props['data-selected'],'true');
    ui.setResolution('1D');groups=ui.render();
    assert.equal(groups.seconds.button.props['data-selected'],'false');
    assert.equal(groups.ticks.button.props['data-selected'],'false');
    groups.seconds.button.props.onClick();
    assert.equal(ui.getResolution(),'5S');
    groups=ui.render();groups.seconds.button.props.onClick();
    assert.equal(ui.render().seconds.root.props.open,true);
    ui.render().seconds.root.props.onOpenChange(false);
    assert.equal(ui.render().seconds.root.props.open,false);
    groups=ui.render();groups.seconds.button.props.onClick();groups=ui.render();groups.seconds.closeOutside();
    assert.equal(ui.render().seconds.root.props.open,false);
    assert.deepEqual(ui.selected,['5S','100T','5S']);
  });
}

test('external resolution changes update only the matching separate control',()=>{
  const h=boot({enableSec:true,enableTick:true});
  const ui=nativeControlsHarness(h.runtime.localCharts.resolutionUi);
  ui.setResolution('15S');let groups=ui.render();
  assert.equal(groups.seconds.button.props.children,'15초 ∨');
  ui.setResolution('300T');groups=ui.render();
  assert.equal(groups.seconds.button.props.children,'15초 ∨');
  assert.equal(groups.seconds.button.props['aria-pressed'],false);
  assert.equal(groups.ticks.button.props.children,'300틱 ∨');
  assert.equal(groups.ticks.button.props['aria-pressed'],true);
  ui.setResolution('3');groups=ui.render();
  assert.equal(groups.seconds.button.props['aria-pressed'],false);
  assert.equal(groups.ticks.button.props['aria-pressed'],false);
  assert.deepEqual(ui.selected,[]);
});

test('feature toggles hide the corresponding separate control',()=>{
  const seconds=boot({enableSec:true});
  const ticks=boot({enableTick:true});
  assert.deepEqual(Object.keys(nativeControlsHarness(seconds.runtime.localCharts.resolutionUi).render()),['seconds']);
  assert.deepEqual(Object.keys(nativeControlsHarness(ticks.runtime.localCharts.resolutionUi).render()),['ticks']);
});

test('index charts without a Toss minute dropdown expose the native TradingView resolution menu', () => {
  const h = boot({ enableSec: true, indexChartUnlock: true }, '/indices/KOSPI');
  h.context.feed = {};
  const widget = widgetFactory(h, 'new tv.HL({container:"chart",datafeed:window.feed,library_path:"/library/",disabled_features:["header_resolutions"]})');
  assert.ok(widget.options.enabled_features.includes('header_resolutions'));
  assert.ok(widget.options.enabled_features.includes('header_widget'));
  assert.ok(!widget.options.disabled_features.includes('header_resolutions'));
});

function localBarsHarness({ modules = { enableTick: true }, stored = {}, pathname, code = 'A005930', symbolType, globals = {} } = {}) {
  const h = boot(modules, pathname, stored, globals);
  let historyCalls = 0, nativeSubscriptions = 0, nativeUnsubscribes = 0;
  h.context.feed = {
    onReady(callback) { callback({ supported_resolutions: ['1', '1D'] }); },
    resolveSymbol(name, callback) { callback({ name, ticker: name, type: symbolType ?? (pathname?.startsWith('/indices/') ? 'index' : 'stock'), currency_code: 'KRW' }); },
    getBars() { historyCalls++; }, subscribeBars() { nativeSubscriptions++; }, unsubscribeBars() { nativeUnsubscribes++; },
  };
  const widget = widgetFactory(h, 'new tv.HL({container:"chart",datafeed:window.feed,library_path:"/library/",disabled_features:[]})');
  const feed = widget.options.datafeed;
  const worker = new h.context.SharedWorker('test-worker');
  const base = Date.parse('2026-10-27T01:00:00.000Z');
  let sequence = 0;
  function send({ price = 100, volume = 1, cumulativeVolume, time, symbol = code, destination = 'trade' } = {}) {
    sequence++;
    worker.port.receive({ data: { scope: 'send', type: 'messageReceived', data: {
      destination: `/topic/stock/${destination}/${symbol}`,
      message: { body: JSON.stringify({ code: symbol, dt: new Date(time ?? base + sequence).toISOString(), closeKrw: price, volume, cumulativeVolume: cumulativeVolume ?? sequence }) },
    } } });
  }
  function history(resolution, params = {}, symbol = code) {
    let result;
    feed.getBars({ name: symbol, ticker: symbol, currency_code: 'KRW' }, resolution, params, (bars, meta) => { result = { bars, meta }; });
    h.flushTimers();
    return result;
  }
  return { ...h, feed, widget, send, history, base, calls: () => ({ historyCalls, nativeSubscriptions, nativeUnsubscribes }) };
}

test('tick bars work independently of seconds and advertise native tick support', () => {
  const h = localBarsHarness();
  assert.ok(h.widget.options.enabled_features.includes('tick_resolution'));
  assert.ok(!h.widget.options.enabled_features.includes('seconds_resolution'));
  let config, info;
  h.feed.onReady((value) => { config = value; });
  h.feed.resolveSymbol('A005930', (value) => { info = value; });
  assert.ok(config.supported_resolutions.includes('100T'));
  assert.ok(!config.supported_resolutions.includes('1S'));
  assert.equal(info.has_ticks, true);
  assert.equal(info.__btiLocalTickBars, true);
  assert.equal(info.build_seconds_from_ticks, false);
  assert.equal(h.runtime.localCharts.resolutionUi.label('300T'), '300틱');
  assert.ok(h.runtime.localCharts.resolutionUi.withSeconds(['1']).includes('100T'));
});

test('v27 iframe bootstrap runs before library scripts and is limited to enabled tick charts', () => {
  for (const enabled of [false,true]) {
    const h=boot({enableSec:true,enableTick:enabled});
    const factory=vm.runInContext(`module=>{
      const version="TT v27.001";
      const widget={_render(){return '<html><head><meta charset="utf-8"><script src="library.js"></script></head></html>'}};
      module.exports=widget._render();
    }`,h.context);
    const result={};h.transform(factory)(result);
    assert.equal(result.exports.includes('localCharts.patchTickRuntime(window)'),enabled);
    if(enabled)assert.ok(result.exports.indexOf('localCharts.patchTickRuntime')<result.exports.indexOf('src="library.js"'));
  }
});

function legacyTickFactory(h) {
  return vm.runInContext(`(module,exports,require)=>{
    require.d(exports,{findSuitableResolutionToBuildFrom:()=>select,untouched:()=>42});
    const Interval=require(1).Interval;
    function select(resolution,info){
      const interval=Interval.parse(resolution);
      if(interval.isTicks())return !info["is-tickbars-available"]||interval.multiplier()>1?
        {error:true,errorMessage:"unsupported ticks"}:{error:false,resolution:"1T"};
      return {error:false,resolution:"original:"+resolution};
    }
  }`,h.context);
}

function runLegacyTickFactory(factory) {
  const exports={};
  const require=()=>({Interval:{parse:r=>({isTicks:()=>/^\d+T$/.test(r),multiplier:()=>parseInt(r,10)})}});
  require.d=(target,definitions)=>{for(const key in definitions)Object.defineProperty(target,key,{get:definitions[key]});};
  factory({},exports,require);
  return exports;
}

test('v27 admits preaggregated N-tick data only for the local feed and preserves native decisions', () => {
  const h=localBarsHarness();
  const payload=[[1],{legacy:legacyTickFactory(h)}];
  const frame={webpackChunktradingview:[payload]};
  h.runtime.localCharts.patchTickRuntime(frame);
  const exports=runLegacyTickFactory(payload[1].legacy),select=exports.findSuitableResolutionToBuildFrom;
  const local={__btiLocalTickBars:true,'is-tickbars-available':true};
  for(const resolution of ['1T','10T','30T','100T','300T','1000T']){
    assert.equal(select(resolution,local).error,false);
    assert.equal(select(resolution,local).resolution,resolution);
  }
  assert.equal(select('100T',{'is-tickbars-available':true}).error,true);
  assert.equal(select('100T',{...local,'is-tickbars-available':false}).error,true);
  assert.equal(select('10001T',local).error,true);
  for(const resolution of ['1','5S','1D'])assert.equal(select(resolution,local).resolution,`original:${resolution}`);
  assert.equal(exports.untouched,42);
  assert.equal(exports.findSuitableResolutionToBuildFrom,select);
  assert.deepEqual(Array.from(h.runtime.localCharts.legacyTickCompatibility.resolutionModules),['legacy']);
});

test('v27 tick hook survives webpack runtime push installation and chunk array reassignment', () => {
  const h=localBarsHarness(),frame={};
  h.runtime.localCharts.patchTickRuntime(frame);
  h.runtime.localCharts.patchTickRuntime(frame);
  frame.webpackChunktradingview=[];
  let received;
  frame.webpackChunktradingview.push=chunk=>{received=chunk;return 7;};
  const factory=legacyTickFactory(h),payload=[[2],{legacy:factory}];
  assert.equal(frame.webpackChunktradingview.push(payload),7);
  assert.equal(received,payload);
  assert.notEqual(payload[1].legacy,factory);
  assert.equal(runLegacyTickFactory(payload[1].legacy).findSuitableResolutionToBuildFrom('30T',
    {__btiLocalTickBars:true,'is-tickbars-available':true}).resolution,'30T');
});

test('tick compatibility leaves newer resolution selectors unchanged', () => {
  const h=localBarsHarness(),frame={};
  h.runtime.localCharts.patchTickRuntime(frame);
  const factory=vm.runInContext('(m,e,r)=>{r.d(e,{findSuitableResolutionToBuildFrom:()=>select});function select(resolution){return resolution}}',h.context);
  const payload=[[3],{modern:factory}];frame.webpackChunktradingview.push(payload);
  assert.equal(payload[1].modern,factory);
});

test('N-tick history groups trade events rather than shares and includes a partial last bar', () => {
  const h = localBarsHarness();
  [10,12,9,15,14].forEach((price, i) => h.send({ price, volume: [100,2,3,4,500][i] }));
  const { bars } = h.history('3T');
  assert.equal(bars.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(bars)), [
    { time:h.base+1,open:10,high:12,low:9,close:9,volume:105 },
    { time:h.base+4,open:15,high:15,low:14,close:14,volume:504 },
  ]);
  assert.equal(h.calls().historyCalls, 0);
  h.history('1');
  assert.equal(h.calls().historyCalls, 1);
});

test('duplicate trades are ignored while distinct trades at the same timestamp form separate bars', () => {
  const h = localBarsHarness();
  for (let i=1;i<=6;i++) {
    h.send({ price:100+i,time:h.base,cumulativeVolume:i });
    h.send({ price:100+i,time:h.base,cumulativeVolume:i });
  }
  const bars=h.history('2T').bars;
  assert.equal(bars.length,3);
  assert.deepEqual(Array.from(bars,b=>b.close),[102,104,106]);
  assert.deepEqual(Array.from(bars,b=>b.time),[h.base,h.base+1,h.base+2]);
});

test('bursty tick updates deliver every completed bar and cancel on unsubscribe', () => {
  const h = localBarsHarness();
  const delivered=[];
  h.feed.subscribeBars({name:'A005930',currency_code:'KRW'},'2T',bar=>delivered.push(bar),'ticks',()=>{});
  for(let i=1;i<=7;i++)h.send({price:100+i});
  h.flushTimers();
  assert.deepEqual(delivered.map(b=>b.close),[102,104,106,107]);
  assert.equal(h.calls().nativeSubscriptions,0);
  const snapshot=h.history('2T').bars;
  assert.deepEqual(delivered.map(b=>[b.open,b.high,b.low,b.close,b.volume]),Array.from(snapshot,b=>[b.open,b.high,b.low,b.close,b.volume]));
  h.send({price:108});
  h.feed.unsubscribeBars('ticks');
  h.flushTimers();
  assert.equal(delivered.length,4);
  assert.equal(h.calls().nativeUnsubscribes,0);
});

test('realtime tick bars continue the partial history bar instead of counting it again', () => {
  const h=localBarsHarness();
  h.send({price:10,volume:5});h.send({price:12,volume:2});
  const first=h.history('3T').bars[0];
  const delivered=[];
  h.feed.subscribeBars({name:'A005930',currency_code:'KRW'},'3T',bar=>delivered.push(bar),'partial',()=>{});
  h.send({price:9,volume:3});h.send({price:15,volume:4});
  h.flushTimers();
  assert.equal(delivered.length,2);
  assert.equal(delivered[0].time,first.time);
  assert.deepEqual([delivered[0].open,delivered[0].high,delivered[0].low,delivered[0].close,delivered[0].volume],[10,12,9,9,10]);
  assert.equal(delivered[1].open,15);
});

test('tick bars ignore zero-volume messages and quote updates', () => {
  const h=localBarsHarness();
  h.send({price:500,volume:0});
  h.send({price:600,destination:'quote'});
  h.send({price:10,volume:500});
  h.send({price:12,volume:300});
  const bars=h.history('2T').bars;
  assert.equal(bars.length,1);
  assert.deepEqual([bars[0].open,bars[0].close,bars[0].volume],[10,12,800]);
});

test('tick history honors exclusive to and countBack even for sparse/closed sessions', () => {
  const h=localBarsHarness();
  for(let i=0;i<6;i++)h.send({price:100+i,time:h.base+i*1000});
  const bars=h.history('2T',{from:(h.base+3600000)/1000,to:(h.base+4000)/1000,countBack:2}).bars;
  assert.equal(bars.length,2);
  assert.deepEqual(Array.from(bars,b=>b.time),[h.base,h.base+2000]);
  assert.equal(h.calls().historyCalls,0);
});

test('late trades reset local tick history and are inserted in chronological order', () => {
  const h=localBarsHarness();
  h.send({price:10,time:h.base+1000,cumulativeVolume:1});
  h.send({price:30,time:h.base+3000,cumulativeVolume:3});
  let resets=0;
  h.feed.subscribeBars({name:'A005930',currency_code:'KRW'},'2T',()=>{},'late',()=>resets++);
  h.send({price:20,time:h.base+2000,cumulativeVolume:2});
  h.flushTimers();
  assert.equal(resets,1);
  assert.deepEqual(Array.from(h.history('2T').bars,b=>[b.open,b.close]),[[10,20],[30,30]]);
  assert.equal(h.calls().historyCalls,0);
});

test('eviction retains tick group boundaries and does not resurrect discarded trades', () => {
  const h=localBarsHarness({stored:{enableSec:{maxTicksPerSymbol:1000}}});
  let resets=0;
  h.feed.subscribeBars({name:'A005930',currency_code:'KRW'},'3T',()=>{},'trim',()=>resets++);
  for(let i=0;i<1000;i++)h.send({price:i+1,time:h.base+i,cumulativeVolume:i+1});
  const before=h.history('3T').bars.at(-1);
  h.send({price:1001,time:h.base+1000,cumulativeVolume:1001});
  const bars=h.history('3T').bars;
  assert.equal(bars[0].open,103); // The first 100 trades were evicted; skip the incomplete group at 100..101.
  assert.equal(bars.at(-1).time,before.time);
  assert.equal(bars.at(-1).open,1000);
  h.send({price:1,time:h.base,cumulativeVolume:1});
  assert.equal(resets,0);
  assert.equal(h.history('3T').bars.length,bars.length);
});

test('tick subscriptions for different symbols do not consume each other’s trades', () => {
  const h=localBarsHarness();
  h.history('2T',{},'A000660'); // Register the second chart's local bucket.
  const first=[],second=[];
  h.feed.subscribeBars({name:'A005930',currency_code:'KRW'},'2T',bar=>first.push(bar),'first',()=>{});
  h.feed.subscribeBars({name:'A000660',currency_code:'KRW'},'2T',bar=>second.push(bar),'second',()=>{});
  h.send({price:10,symbol:'A005930'});h.send({price:20,symbol:'A000660'});
  h.send({price:11,symbol:'A005930'});h.send({price:21,symbol:'A000660'});
  h.flushTimers();
  assert.deepEqual(first.map(b=>[b.open,b.close]),[[10,11]]);
  assert.deepEqual(second.map(b=>[b.open,b.close]),[[20,21]]);
});

test('indices do not advertise execution-count tick bars', () => {
  const h=localBarsHarness({pathname:'/indices/KOSPI',code:'KOSPI'});
  let info;h.feed.resolveSymbol('KOSPI',value=>info=value);
  assert.equal(info.has_ticks,false);
  assert.ok(!info.supported_resolutions.some(r=>r.endsWith('T')));
  assert.ok(!h.runtime.localCharts.resolutionUi.withSeconds(['1']).some(r=>r.endsWith('T')));
});

for (const code of ['RFU.NQc1', 'RFU.ESc1', 'RFU.RTYc1']) {
  test(`${code}: futures advertise ticks despite the index route and symbol type`, () => {
    const h=localBarsHarness({pathname:`/indices/${code}`,code});
    let config,info;
    h.feed.onReady(value=>config=value);
    h.feed.resolveSymbol(`INDEX:${code}`,value=>info=value);
    assert.equal(info.type,'index');
    assert.equal(info.has_ticks,true);
    assert.ok(config.supported_resolutions.includes('100T'));
    assert.ok(info.supported_resolutions.includes('100T'));
    assert.ok(h.runtime.localCharts.resolutionUi.withSeconds(['1']).includes('100T'));
  });
}

test('futures index-topic messages aggregate locally and ignore duplicate, untimed and zero-volume updates', () => {
  const code='RFU.NQc1',h=localBarsHarness({pathname:`/indices/${code}`,code});
  const worker=new h.context.SharedWorker('future-worker');
  const send=body=>worker.port.receive({data:{scope:'send',type:'messageReceived',data:{
    destination:`/topic/v1/us/stock/index/${code}`,message:{body:JSON.stringify({code,...body})},
  }}});
  const dt=new Date(h.base).toISOString();
  const first={dt,close:29764,volume:1,cumulativeVolume:364115};
  send(first);send(first);
  send({dt,close:29764.25,volume:5,cumulativeVolume:364120});
  send({dt,close:99999,volume:0,cumulativeVolume:364120});
  send({close:99999,volume:1,cumulativeVolume:364121});
  assert.deepEqual(Array.from(h.history('2T').bars,b=>[b.open,b.high,b.low,b.close,b.volume]),
    [[29764,29764.25,29764,29764.25,6]]);
  const live=[];
  h.feed.subscribeBars({name:'INDEX:RFU.NQC1',currency_code:'USD'},'2T',bar=>live.push(bar),'future',()=>{});
  send({dt,close:29764.5,volume:2,cumulativeVolume:364122});
  send({dt,close:29764.75,volume:3,cumulativeVolume:364125});
  h.flushTimers();
  assert.deepEqual(live.map(b=>[b.open,b.close,b.volume]),[[29764.5,29764.75,5]]);
  const bars=h.history('2T').bars;
  assert.equal(bars.length,2);
  assert.ok(bars[1].time>bars[0].time);
  assert.equal(h.calls().historyCalls,0);
  assert.equal(h.calls().nativeSubscriptions,0);
});

test('late futures messages reset the matching uppercase TradingView symbol', () => {
  const code='RFU.NQc1',h=localBarsHarness({pathname:`/indices/${code}`,code});
  let resets=0;
  h.widget.chartsCount=()=>1;
  h.widget.chart=()=>({symbol:()=> 'INDEX:RFU.NQC1',resolution:()=> '2T',resetData:()=>resets++});
  h.send({destination:'index',time:h.base+1,cumulativeVolume:1});
  h.send({destination:'index',time:h.base+3,cumulativeVolume:3});
  h.feed.subscribeBars({name:'INDEX:RFU.NQC1'},'2T',()=>{},'late-future',()=>{});
  h.send({destination:'index',time:h.base+2,cumulativeVolume:2});
  h.flushTimers();
  assert.equal(resets,1);
  assert.equal(h.history('2T',{},'INDEX:RFU.NQC1').bars.length,2);
});

test('a future resolved as index can also expose ticks outside the index route', () => {
  const h=localBarsHarness({symbolType:'index'});
  let info;
  h.feed.resolveSymbol('INDEX:RFU.NQc1',value=>info=value);
  assert.equal(info.has_ticks,true);
  h.feed.resolveSymbol('INDEX:COMP.NAI',value=>info=value);
  assert.equal(info.has_ticks,false);
});

test('enabling both local chart modes installs a single datafeed wrapper', () => {
  const h=localBarsHarness({modules:{enableSec:true,enableTick:true}});
  assert.equal(h.runtime.localCharts.datafeedsPatched,1);
  assert.equal(h.runtime.localCharts.widgetsCaptured,1);
  assert.ok(h.widget.options.enabled_features.includes('seconds_resolution'));
  assert.ok(h.widget.options.enabled_features.includes('tick_resolution'));
  assert.equal(h.runtime.modules.enableTick.sharedState,h.runtime.localCharts);
});

test('existing ticks responses are observed once and aggregated without any additional request', async () => {
  let requests=0,clones=0;
  const base=Date.parse('2026-10-27T01:00:00Z');
  const response={clone(){clones++;return{json:async()=>({data:[3,2,1].map(i=>({dt:new Date(base+i).toISOString(),closeKrw:100+i,volume:i,cumulativeVolume:i}))})}}};
  const h=localBarsHarness({globals:{fetch:async()=>{requests++;return response;}}});
  assert.equal(await h.context.fetch('https://example.test/api/v2/stock-prices/A005930/ticks'),response);
  await settle();
  const bars=h.history('2T').bars;
  assert.equal(requests,1);assert.equal(clones,1);
  assert.deepEqual(Array.from(bars,b=>[b.open,b.close,b.volume]),[[101,102,3],[103,103,3]]);
  assert.equal(h.calls().historyCalls,0);
});

test('tick preset settings are normalized and are independent of second presets', () => {
  const h=localBarsHarness({stored:{enableTick:{presets:[300,30,30,0,-2,1.5,'100',10001]},enableSec:{presets:[5,15]}}});
  assert.deepEqual(Array.from(h.runtime.settings.enableTick.presets),[30,100,300]);
  const options=h.runtime.localCharts.resolutionUi.withSeconds(['1']);
  assert.deepEqual(Array.from(options),['30T','100T','300T','1']);
  assert.equal(h.runtime.localCharts.resolutionUi.label('100T'),'100틱');
});

test('empty or unsupported tick history never falls through to Toss candle APIs', () => {
  const h=localBarsHarness();
  assert.equal(h.history('100T').meta.noData,true);
  let error;
  h.feed.getBars({name:'A005930'},'10001T',{},()=>{},value=>{error=value;});
  h.feed.subscribeBars({name:'A005930'},'10001T',()=>{},'invalid',()=>{});
  h.flushTimers();
  assert.match(error,/틱봉/);
  assert.deepEqual(h.calls(),{historyCalls:0,nativeSubscriptions:0,nativeUnsubscribes:0});
});

test('reusing a subscription id for minutes disposes the previous local tick listener', () => {
  const h=localBarsHarness();let updates=0;
  h.feed.subscribeBars({name:'A005930'},'100T',()=>updates++,'reuse',()=>{});
  h.feed.subscribeBars({name:'A005930'},'1',()=>{},'reuse',()=>{});
  h.send();h.flushTimers();
  assert.equal(updates,0);assert.equal(h.calls().nativeSubscriptions,1);
});

test('a paused render loop has a bounded tick delivery queue and requests a local reset', () => {
  const h=localBarsHarness({stored:{enableSec:{maxTicksPerSymbol:1000}}});let resets=0,updates=0;
  h.feed.subscribeBars({name:'A005930'},'1T',()=>updates++,'background',()=>resets++);
  for(let i=0;i<1100;i++)h.send({price:100+i});
  h.flushTimers();
  assert.equal(resets,1);assert.equal(updates,0);
  assert.equal(h.calls().historyCalls,0);
});
