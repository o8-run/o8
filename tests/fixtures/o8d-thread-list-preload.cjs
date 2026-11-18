// Test-only counters and GitHub boundary. Local readers, auth, canonical
// projection and SQLite remain real. Never imported by production entrypoints.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
Module.register(pathToFileURL(path.join(__dirname,'o8d-thread-list-loader.mjs')).href);
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const directory = process.env.CORTEX_IDE_DATA_DIR;
const controlPath = path.join(directory, 'thread-list-control.json');
const counterPath = path.join(directory, 'thread-list-counters.jsonl');
if (process.env.NODE_ENV !== 'test' || fs.readFileSync(path.join(directory,'fixture-owner'),'utf8') !== 'o8d-native-read/v1') throw new Error('Owned thread-list fixture required');
function control() { try { return JSON.parse(fs.readFileSync(controlPath,'utf8')); } catch { return {}; } }
function count(name, ids) {
  const context = scope.getStore(); if (!context?.active) return;
  const settings = control();
  fs.appendFileSync(counterPath, JSON.stringify({ nonce: settings.nonce, phase: context.phase, name, ...(ids ? { ids } : {}) }) + '\n');
}
const readdir = fs.readdirSync;
fs.readdirSync = function (target, ...args) {
  if (scope.getStore() && String(target) === path.join(directory,'chat-history') && new Error().stack.includes('listThoughtHistoryFileStats')) count('listThoughtHistoryFileStats');
  return readdir.call(this,target,...args);
};
Module.syncBuiltinESMExports();
const original = Module._load; const wrapped = new WeakMap();
Module._load = function (request, parent, isMain) {
  const actual = original.call(this,request,parent,isMain);
  let filename; try { filename = Module._resolveFilename(request,parent); } catch { return actual; }
  if (typeof filename !== 'string' || !filename.includes('/src/lib/') || !actual || (typeof actual !== 'object' && typeof actual !== 'function')) return actual;
  if (wrapped.has(actual)) return wrapped.get(actual);
  const names = {
    '/mobile/orchestrator-thread-history.ts': ['listMobileOrchestratorThreads'],
    '/bots/network-projection.ts': ['projectAllNetworkThreads'],
    '/repos/thread-git-context.ts': ['threadGitContext'],
    '/inbox/store.ts': ['inboxProjection'],
    '/mobile/linked-work.ts': ['lookupLinkedWork'],
    '/inbox/parked-workspaces.ts': ['createParkedWorkspaceContext'],
    '/mobile/pull-request-projection.ts': ['mobileThreadPullRequests'],
  };
  if (filename.endsWith('/ws-server/native-http-routes.ts')) {
    const result = { ...actual, handleNativeHttp: function(req,...args) {
      if (!req.url?.split('?')[0].endsWith('/api/mobile/orchestrator/threads')) return actual.handleNativeHttp(req,...args);
      const phase = req.headers['x-o8d-session-read'] === 'authorize' ? 'admission' : req.headers['x-o8d-session-read'] === 'compose-threads/1' ? 'compose' : 'typescript';
      const settings=control();
      if (phase==='admission' && args[2]===true && (settings.missingGrant || settings.malformedGrant || settings.oversizedBodyGrant || settings.wrongVersionGrant)) {
        const res=args[0];
        if (settings.missingGrant) res.writeHead(204).end();
        else res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(settings.oversizedBodyGrant ? ' '.repeat(1024*1024+1) : JSON.stringify({version:settings.wrongVersionGrant?2:1,defaultsContext:{threadList:{machineDisplayName:12}}}));
        return Promise.resolve(true);
      }
      fs.writeFileSync(path.join(directory,'thread-list-private-port'), String(req.socket.localPort));
      const context={phase,active:true};
      return scope.run(context,async()=>{try{return await actual.handleNativeHttp(req,...args);}finally{context.active=false;}});
    } }; wrapped.set(actual,result); return result;
  }
  if (filename.endsWith('/ws-server/native-thread-list-compose.ts')) {
    const result = { ...actual, composeNativeThreadList: async function(req,authenticated) {
      const response = await actual.composeNativeThreadList(req,authenticated);
      if (authenticated && control().composeTransportFailure) req.socket.destroy();
      return response;
    } }; wrapped.set(actual,result); return result;
  }
  if (filename.endsWith('/mobile/machine-name.ts')) {
    const result = { ...actual, localMachineName: () => scope.getStore()?.phase === 'admission' && control().oversizedGrant ? 'x'.repeat(16*1024+1) : actual.localMachineName() };
    wrapped.set(actual,result); return result;
  }
  if (filename.endsWith('/github-broker/index.ts')) {
    const result = { ...actual, fetchGitHubPullRequestDetail: async function(repository,number) {
      count('fetchGitHubPullRequestDetail',[repository,String(number)]);
      if (repository !== 'fixture/thread-list') throw new Error('Unexpected fixture repository');
      return { number,title: 'Fixture PR',state: 'OPEN',mergedAt: null,draft: false,updatedAt: '2026-11-01T00:00:00.000Z',changedFiles: 7,statusCheckRollup: [] };
    } }; wrapped.set(actual,result); return result;
  }
  for (const [suffix,functions] of Object.entries(names)) if (filename.endsWith(suffix)) {
    const result = { ...actual };
    for (const name of functions) result[name] = function(...args) {
      count(name,name === 'mobileThreadPullRequests' ? args[0] : undefined);
      if (name === 'mobileThreadPullRequests' && control().prThrows) return Promise.reject(new Error('Fixture PR projection failure'));
      const result=actual[name](...args);
      if(name==='projectAllNetworkThreads') require('../../src/lib/bots/network-health.ts').recordNetworkProjectionHealth('thoughts-source-network',control().networkHealthError?new Error('Fixture projection failure'):null);
      return result;
    };
    wrapped.set(actual,result); return result;
  }
  return actual;
};
