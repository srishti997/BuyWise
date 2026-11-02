import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function storage() {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
}
function load(file, globals = {}, imports = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {}, require: name => imports[name], ...globals };
  vm.runInNewContext(code, context);
  return context.exports;
}
function environment(mode='ab', search='') {
  return { process: { env: { NEXT_PUBLIC_HOMEPAGE_EXPERIMENT: mode } }, window: { location: { search } }, localStorage: storage(), sessionStorage: storage(), crypto: { getRandomValues: arr => { arr[0]=0; return arr; } }, URLSearchParams };
}
test('V2 is default; AB assignments persist across page reloads', () => {
  const env = environment('v2');
  assert.equal(load('src/lib/experiment.ts', env).assignExperiment().variant, 'b');
  env.process.env.NEXT_PUBLIC_HOMEPAGE_EXPERIMENT='ab';
  assert.equal(load('src/lib/experiment.ts', env).assignExperiment().variant, 'a');
  env.crypto.getRandomValues = arr => { arr[0]=1; return arr; };
  assert.equal(load('src/lib/experiment.ts', env).assignExperiment().variant, 'a');
});
test('both random buckets are reachable', () => {
  const env = environment();
  env.crypto.getRandomValues = arr => { arr[0]=1; return arr; };
  assert.equal(load('src/lib/experiment.ts', env).assignExperiment().variant, 'b');
});
test('previews persist through navigation, do not replace real assignment, and reset', () => {
  const env=environment();
  load('src/lib/experiment.ts',env).assignExperiment();
  env.window.location.search='?variant=b';
  assert.equal(load('src/lib/experiment.ts',env).assignExperiment().preview,true);
  env.window.location.search='';
  assert.equal(load('src/lib/experiment.ts',env).assignExperiment().variant,'b');
  env.window.location.search='?variant=reset';
  const result=load('src/lib/experiment.ts',env).assignExperiment();
  assert.equal(result.variant,'a'); assert.equal(result.preview,false);
});
test('blocked storage fails safely and excludes unstable participants', () => {
  const env=environment(); env.sessionStorage.getItem=()=>{throw new Error('blocked');};
  const result=load('src/lib/experiment.ts',env).assignExperiment();
  assert.equal(result.variant,'b'); assert.equal(result.preview,true);
});
test('return path rejects external URLs, backslashes and control characters', () => {
  const {safeReturnPath}=load('src/lib/oauth.ts',{}, {'./api':{}});
  for(const path of ['https://evil.test','//evil.test','/\\evil.test','/\nevil.test','/auth/callback',null]) assert.equal(safeReturnPath(path),'/dashboard');
  assert.equal(safeReturnPath('/product/123?tab=offers'),'/product/123?tab=offers');
});
test('analytics queues early exposure and strips query strings from page locations', () => {
  const env=environment(); env.process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID='G-TEST';
  Object.assign(env.window.location,{pathname:'/',origin:'https://buywise.test'}); env.document={title:'BuyWise'};
  const exp=load('src/lib/experiment.ts',env);
  const analytics=load('src/lib/analytics.ts',env,{'./experiment':exp});
  analytics.track('experiment_exposure');
  const calls=[]; env.window.gtag=(...args)=>calls.push(args);
  analytics.flushAnalytics();
  analytics.pageview('/search?q=private@example.com');
  assert.equal(calls[0][1],'experiment_exposure');
  assert.equal(calls[0][2].variant,'a');
  assert.equal(calls[1][2].page_location,'https://buywise.test/search');
  assert.equal(calls[1][2].page_path,'/search');
});
test('preview and callback traffic never sends custom analytics', () => {
  for(const [search,pathname] of [['?variant=b','/'],['','/auth/callback']]) {
    const env=environment('ab',search); env.process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID='G-TEST';
    Object.assign(env.window.location,{pathname,origin:'https://buywise.test'});
    const calls=[]; env.window.gtag=(...args)=>calls.push(args);
    const exp=load('src/lib/experiment.ts',env);
    const analytics=load('src/lib/analytics.ts',env,{'./experiment':exp});
    analytics.track('login'); assert.equal(calls.length,0);
  }
});

test('v1 rollback overrides saved assignments without overwriting the AB bucket', () => {
  const env = environment();
  env.crypto.getRandomValues = arr => { arr[0] = 1; return arr; };
  assert.equal(load('src/lib/experiment.ts', env).assignExperiment().variant, 'b');
  env.process.env.NEXT_PUBLIC_HOMEPAGE_EXPERIMENT = 'v1';
  const rollback = load('src/lib/experiment.ts', env).assignExperiment();
  assert.equal(rollback.variant, 'a'); assert.equal(rollback.mode, 'v1');
  env.process.env.NEXT_PUBLIC_HOMEPAGE_EXPERIMENT = 'ab';
  assert.equal(load('src/lib/experiment.ts', env).assignExperiment().variant, 'b');
});

test('a new experiment ID isolates assignment and preview storage', () => {
  const env = environment();
  load('src/lib/experiment.ts', env).assignExperiment();
  env.window.location.search = '?variant=a';
  load('src/lib/experiment.ts', env).assignExperiment();
  env.window.location.search = '';
  env.process.env.NEXT_PUBLIC_HOMEPAGE_EXPERIMENT_ID = 'homepage_next';
  env.crypto.getRandomValues = arr => { arr[0] = 1; return arr; };
  const exp = load('src/lib/experiment.ts', env);
  assert.equal(exp.EXPERIMENT_ID, 'homepage_next');
  assert.equal(exp.assignExperiment().variant, 'b');
  assert.equal(exp.assignExperiment().preview, false);
});

function gaEnvironment(mode = 'ab', search = '') {
  const env = environment(mode, search);
  env.process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = 'G-TEST';
  Object.assign(env.window.location, { pathname: '/', origin: 'https://buywise.test' });
  env.document = { title: 'BuyWise' };
  const exp = load('src/lib/experiment.ts', env);
  const analytics = load('src/lib/analytics.ts', env, { './experiment': exp });
  return { env, analytics };
}

test('GA initializes once with cohort metadata before buffered events and loads debug only when requested', () => {
  for (const debug of [false, true]) {
    const { env, analytics } = gaEnvironment();
    env.process.env.NEXT_PUBLIC_GA_DEBUG = String(debug);
    analytics.trackExperimentExposure();
    assert.equal(env.window.gtag, undefined);
    assert.equal(analytics.initializeAnalytics(), true);
    analytics.initializeAnalytics();
    const calls = env.window.dataLayer.map(args => Array.from(args));
    assert.equal(calls.length, 3);
    assert.equal(calls[0][0], 'js'); assert.equal(calls[1][0], 'config');
    assert.equal(calls[1][1], 'G-TEST');
    assert.equal(calls[1][2].send_page_view, false);
    assert.equal(calls[1][2].ui_version, 'old');
    assert.equal(calls[1][2].experiment_mode, 'ab');
    assert.equal(calls[1][2].debug_mode, debug ? true : undefined);
    assert.equal(calls[2][1], 'experiment_exposure');
    analytics.flushAnalytics(); assert.equal(env.window.dataLayer.length, 3);
  }
});

test('exposure is deduplicated across treatment surfaces and absent outside AB or in preview', () => {
  for (const [mode, search, expected] of [['ab', '', 1], ['v1', '', 0], ['v2', '', 0], ['ab', '?variant=a', 0]]) {
    const { env, analytics } = gaEnvironment(mode, search);
    const calls = []; env.window.gtag = (...args) => calls.push(args);
    analytics.trackExperimentExposure();
    env.window.location.pathname = '/search';
    analytics.trackExperimentExposure(); analytics.trackExperimentExposure();
    assert.equal(calls.length, expected);
  }
});

test('conversions retain real experiment assignment even if callers supply conflicting metadata', () => {
  const { env, analytics } = gaEnvironment();
  const calls = []; env.window.gtag = (...args) => calls.push(args);
  analytics.track('create_price_alert', { experiment_id: 'wrong', variant: 'b', ui_version: 'new', experiment_mode: 'v2', product_id: 'p1' });
  assert.equal(calls[0][2].experiment_id, 'homepage_v2_2026_10');
  assert.equal(calls[0][2].variant, 'a');
  assert.equal(calls[0][2].ui_version, 'old');
  assert.equal(calls[0][2].experiment_mode, 'ab');
  assert.equal(calls[0][2].product_id, 'p1');
});

test('initialization excludes previews, unconfigured builds, and callback pages', () => {
  for (const kind of ['preview', 'disabled', 'callback']) {
    const { env, analytics } = gaEnvironment('ab', kind === 'preview' ? '?variant=b' : '');
    if (kind === 'callback') env.window.location.pathname = '/auth/callback';
    let target = analytics;
    if (kind === 'disabled') {
      env.process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = '';
      target = load('src/lib/analytics.ts', env);
    }
    assert.equal(target.initializeAnalytics(), false);
    assert.equal(env.window.dataLayer, undefined);
  }
});

test('callback entry can initialize after navigation to a normal page', () => {
  const { env, analytics } = gaEnvironment();
  env.window.location.pathname = '/auth/callback';
  assert.equal(analytics.initializeAnalytics(), false);
  env.window.location.pathname = '/';
  assert.equal(analytics.initializeAnalytics(), true);
});

test('failed queued sends are isolated and page views remove fragments', () => {
  const { env, analytics } = gaEnvironment();
  analytics.track('first'); analytics.track('second');
  const calls = []; env.window.gtag = (...args) => {
    if (args[1] === 'first') throw Error('blocked');
    calls.push(args);
  };
  assert.doesNotThrow(() => analytics.flushAnalytics());
  assert.equal(calls[0][1], 'second');
  analytics.pageview('/search#private');
  assert.equal(calls[1][2].page_location, 'https://buywise.test/search');
});
