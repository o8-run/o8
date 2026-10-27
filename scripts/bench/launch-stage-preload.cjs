// Timing observer for disposable launch measurements, loaded before server entry.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { performance } = require('node:perf_hooks');

const data = process.env.O8_DATA_DIR;
const entry = path.basename(process.argv[1] || '');
if (data && /^(server\.js|ws-server\.mjs)$/.test(entry)) {
  const directory = path.join(data, 'launch-profile');
  fs.mkdirSync(directory, { recursive: true });
  const role = entry === 'server.js' ? 'http' : 'realtime';
  const stem = path.join(directory, `${role}-${process.pid}`);
  const listeners = [], requests = [], children = [], modules = new Map(), stack = [];
  const { AsyncLocalStorage } = require('node:async_hooks');
  const context = new AsyncLocalStorage();
  const epoch = () => performance.timeOrigin + performance.now();
  const emit = http.Server.prototype.emit;
  let stopped = false, session, originalLoad, restoreChildren;
  http.Server.prototype.emit = function (event, req, res, ...rest) {
    if (event === 'listening') listeners.push({ epochMs: epoch() });
    if (event === 'request' && requests.length < 512) {
      const route = String(req.url || '').split('?')[0];
      if (/^\/(?:[a-z0-9/-]*|_next\/static\/[a-zA-Z0-9/._-]+)$/.test(route)) {
        const row = { route, startEpochMs: epoch(), caller: String(req.headers.accept || '').includes('text/html') ? 'webview' : 'background' };
        requests.push(row);
        const finish = complete => {
          if (row.endEpochMs) return;
          Object.assign(row, { endEpochMs: epoch(), complete, status: res.statusCode,
            encoding: res.getHeader('content-encoding') || null,
            contentLength: Number(res.getHeader('content-length')) || null });
        };
        res.once('finish', () => finish(true));
        res.once('close', () => finish(false));
      }
    }
    if (event === 'request') return context.run(String(req.url || '').split('?')[0], () => emit.call(this, event, req, res, ...rest));
    return emit.call(this, event, req, res, ...rest);
  };

  if (process.env.O8_LAUNCH_CPU_PROFILE === '1') {
    const cp = require('node:child_process');
    const originalSpawn = cp.ChildProcess.prototype.spawn;
    const originals = new Map();
    const record = command => {
      if (children.length >= 512) return null;
      const row = { command: path.basename(String(command || '')), route: context.getStore() || null,
        startEpochMs: epoch(), stack: new Error().stack.split('\n').slice(3, 8) };
      children.push(row);
      return row;
    };
    cp.ChildProcess.prototype.spawn = function (options) {
      const row = record(options.file);
      try { return originalSpawn.call(this, options); }
      finally {
        if (row) {
          row.spawnMs = epoch() - row.startEpochMs;
          this.once('exit', () => { row.endEpochMs = epoch(); });
          this.once('error', () => { row.endEpochMs = epoch(); });
        }
      }
    };
    for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
      originals.set(name, cp[name]);
      cp[name] = function (command, ...args) {
        const row = record(command);
        try { return originals.get(name).call(this, command, ...args); }
        finally { if (row) { row.endEpochMs = epoch(); row.spawnMs = row.endEpochMs - row.startEpochMs; } }
      };
    }
    require('node:module').syncBuiltinESMExports();
    restoreChildren = () => {
      cp.ChildProcess.prototype.spawn = originalSpawn;
      for (const [name, original] of originals) cp[name] = original;
      require('node:module').syncBuiltinESMExports();
    };
    const Module = require('node:module');
    originalLoad = Module._load;
    Module._load = function (request, parent, ...rest) {
      const frame = { start: performance.now(), children: 0 };
      stack.push(frame);
      try { return originalLoad.call(this, request, parent, ...rest); }
      finally {
        const elapsed = performance.now() - frame.start;
        stack.pop();
        if (stack.length) stack.at(-1).children += elapsed;
        const owner = `${parent?.filename || '<entry>'}:${request}`;
        const row = modules.get(owner) || { owner, inclusiveMs: 0, exclusiveMs: 0, calls: 0, firstEpochMs: performance.timeOrigin + frame.start };
        row.inclusiveMs += elapsed;
        row.exclusiveMs += elapsed - frame.children;
        row.calls++;
        modules.set(owner, row);
      }
    };
    const { Session } = require('node:inspector');
    session = new Session();
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.start');
  }

  function save() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    http.Server.prototype.emit = emit;
    if (originalLoad) require('node:module')._load = originalLoad;
    restoreChildren?.();
    fs.writeFileSync(`${stem}.timing.json`, JSON.stringify({ role, entry, timeOrigin: performance.timeOrigin,
      stoppedEpochMs: epoch(), listeners, requests, children,
      modules: [...modules.values()].sort((a, b) => b.exclusiveMs - a.exclusiveMs).slice(0, 64) }));
    if (session) session.post('Profiler.stop', (error, result) => {
      if (!error && result?.profile) fs.writeFileSync(`${stem}.cpuprofile`, JSON.stringify(result.profile));
      session.disconnect();
    });
  }
  const timer = setInterval(() => { if (fs.existsSync(path.join(directory, 'stop'))) save(); }, 100);
  timer.unref();
  process.once('exit', save);
}
