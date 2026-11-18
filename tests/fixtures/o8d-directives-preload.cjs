// Owned fixture counters only. Canonical auth, scopes, parser and writers stay real.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const directory = process.env.CORTEX_IDE_DATA_DIR;
if (process.env.NODE_ENV !== 'test' || fs.readFileSync(path.join(directory, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') throw Error('Owned directives fixture required');
Module.register(require('node:url').pathToFileURL(path.join(__dirname, 'o8d-directives-loader.mjs')).href);
const settings = () => { try { return JSON.parse(fs.readFileSync(path.join(directory, 'directives-control.json'), 'utf8')); } catch { return {}; } };
const count = name => {
  const ctx = scope.getStore();
  if (ctx?.active) fs.appendFileSync(path.join(directory, 'directives-counters.jsonl'), JSON.stringify({ nonce: settings().nonce, phase: ctx.phase, name }) + '\n');
};
const readdir = fs.readdirSync;
fs.readdirSync = function(target, ...args) {
  if (String(target) === path.join(directory, 'directives')) count('directivesScan');
  return readdir.call(this, target, ...args);
};
Module.syncBuiltinESMExports();
const load = Module._load, cache = new WeakMap();
Module._load = function(request, parent, isMain) {
  const actual = load.call(this, request, parent, isMain);
  let file; try { file = Module._resolveFilename(request, parent); } catch { return actual; }
  if (!actual || typeof actual !== 'object') return actual;
  if (cache.has(actual)) return cache.get(actual);
  if (file.endsWith('/cortex/directives/parse.ts')) {
    const wrapped = { ...actual, parseDirectiveFile(...args) { count('parseDirectiveFile'); return actual.parseDirectiveFile(...args); } };
    cache.set(actual, wrapped); return wrapped;
  }
  if (file.endsWith('/ws-server/native-directives-completion.ts')) {
    const wrapped = { ...actual, completeNativeDirectives(req, ...args) {
      count('completionReceipt');
      if (settings().discardResult) {
        const iterator = req.iterator.bind(req);
        req.iterator = async function* (...opts) { for await (const chunk of iterator(...opts)) { void chunk; } yield Buffer.from('{"version":1,"durationMs":1,"body":null}'); };
      }
      return Promise.resolve(actual.completeNativeDirectives(req, ...args)).then(response => {
        if (settings().completionTransportFailure) req.socket.destroy();
        return response;
      });
    } }; cache.set(actual, wrapped); return wrapped;
  }
  if (!file.endsWith('/ws-server/native-http-routes.ts')) return actual;
  const wrapped = { ...actual, handleNativeHttp(req, ...args) {
    if (req.url?.split('?')[0] !== '/api/cortex/directives') return actual.handleNativeHttp(req, ...args);
    const admission = req.headers['x-o8d-session-read'] === 'authorize' && args[2] === true;
    const ctx = { active: true, phase: admission ? 'admission' : 'typescript' };
    if (admission) {
      const res = args[0], writeHead = res.writeHead;
      res.writeHead = function(status, headers) {
        if (status === 204 && headers['x-o8d-defaults-context']) {
          count('scopeGrant'); const control = settings();
          const value = JSON.parse(Buffer.from(headers['x-o8d-defaults-context'], 'base64').toString());
          if (control.missingGrant) delete value.directivesScope;
          if (control.malformedGrant) value.directivesScope = { version: 2 };
          if (control.oversizedGrant) value.directivesScope.projectIds = Array(129).fill('fixture');
          headers['x-o8d-defaults-context'] = Buffer.from(JSON.stringify(value)).toString('base64');
        }
        return writeHead.call(this, status, headers);
      };
    }
    return scope.run(ctx, async () => { try { return await actual.handleNativeHttp(req, ...args); } finally { ctx.active = false; } });
  } };
  cache.set(actual, wrapped); return wrapped;
};
