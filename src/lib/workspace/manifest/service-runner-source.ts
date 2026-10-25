/** Self-contained supervisor copied into the private run directory; survives server restart. */
export const WORKSPACE_SERVICE_RUNNER_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { connect } = require('node:net');
const configPath = process.argv[2];
const directory = path.dirname(configPath);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const statePath = path.join(directory, 'state.json');
const stopPath = path.join(directory, 'stop');
const abort = new AbortController();
const children = new Set();
const state = { version: 1, generation: config.generation, state: 'starting', services: [], teardown: null };
let stopped = false;
let failure = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function persist() {
  for (const service of state.services) if (service.attempts?.length) Object.assign(service, service.attempts[service.attempts.length - 1]);
  const temporary = statePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}
function publish() {
  try { persist(); } catch { requestStop('Workspace service receipt persistence failed.'); }
}
function requestStop(error) {
  if (error && !failure) failure = error;
  stopped = true;
  abort.abort();
}
process.on('SIGINT', () => requestStop());
process.on('SIGTERM', () => requestStop());
process.on('SIGHUP', () => requestStop());
function exactCwd(relative = '.') {
  const root = fs.realpathSync(config.worktreePath);
  const identity = fs.statSync(root);
  if (root !== config.worktreePath || identity.dev !== config.device || identity.ino !== config.inode) throw new Error('Workspace directory identity changed.');
  const cwd = path.resolve(root, relative);
  const canonical = fs.realpathSync(cwd);
  const inside = path.relative(root, canonical);
  if (canonical !== cwd || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Service cwd escapes the packet worktree.');
  return cwd;
}
function processRows() {
  return execFileSync('ps', ['ax', '-o', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return match && !match[3].startsWith('Z') ? [{ pid: Number(match[1]), group: Number(match[2]), birth: match[4] }] : [];
  });
}
function signal(child, name) {
  if (!child.pid || child.quiet) return;
  const rows = processRows().filter(row => row.group === child.pid);
  if (!rows.length) { child.quiet = true; return; }
  if (!rows.some(row => child.identities.get(row.pid) === row.birth)) throw new Error('Workspace process group ownership changed.');
  for (const row of rows) child.identities.set(row.pid, row.birth);
  try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function terminate(child) {
  if (child.quiet) return Promise.resolve();
  child.termination ||= terminateChild(child);
  return child.termination;
}
async function terminateChild(child) {
  signal(child, 'SIGTERM');
  await sleep(child.shutdownGraceMs ?? config.limits.shutdownGraceMs);
  signal(child, 'SIGKILL');
  await child.settled;
  // Absence after the last signal is required, rather than an acknowledged kill.
  for (let count = 0; count < 40; count++) {
    const rows = processRows().filter(row => row.group === child.pid);
    if (!rows.length) { child.quiet = true; children.delete(child); return; }
    if (rows.some(row => !child.identities.has(row.pid))) throw new Error('Workspace process group settlement is unconfirmed.');
    await sleep(25);
  }
  throw new Error('Workspace process group settlement is unconfirmed.');
}
function start(command, cwd, env, record, timeoutMs, limits = {}) {
  // The owned wrapper remains the group leader after the command exits. A
  // separate pipe reports command completion without abandoning group authority.
  const canonical = exactCwd(cwd);
  const before = fs.statSync(canonical);
  const descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let child;
  try {
    const pinned = fs.fstatSync(descriptor);
    if (before.dev !== pinned.dev || before.ino !== pinned.ino) throw new Error('Workspace command directory changed.');
    // The OS captures cwd before this guard runs. Compare that actual inode to
    // the inherited directory descriptor, then exec without another path walk.
    const guard = [
      "const fs=require('node:fs'); const {spawn}=require('node:child_process');",
      "const expected=JSON.parse(process.argv[1]); const cwd=fs.statSync('.'); const held=fs.fstatSync(4);",
      "if(cwd.dev!==expected.dev || cwd.ino!==expected.ino || held.dev!==cwd.dev || held.ino!==cwd.ino || fs.realpathSync('.')!==expected.canonical) process.exit(78); fs.closeSync(4);",
      "const byte=Buffer.alloc(1); let gate=''; while(fs.readSync(0,byte,0,1,null)>0) { if(byte[0]===10) break; gate+=byte.toString(); if(gate.length>2) process.exit(125); } if(gate!=='go') process.exit(125);",
      "setInterval(()=>{},60000); let done=false; const finish=code=>{if(done)return;done=true;fs.writeSync(3,String(code)+String.fromCharCode(10));};",
      "const child=spawn('/bin/sh',['-c',process.argv[2]],{env:process.env,stdio:['ignore','inherit','inherit']}); child.once('error',()=>finish(127)); child.once('close',(code,signal)=>finish(code===null?128+(require('node:os').constants.signals[signal]||0):code));"
    ].join('');
    child = spawn(process.execPath, ['-e', guard, JSON.stringify({ dev: pinned.dev, ino: pinned.ino, canonical }), command], { cwd: canonical, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe', descriptor] });
  } finally { fs.closeSync(descriptor); }
  child.stdin.on('error', () => { record.error = 'Workspace command gate closed before activation.'; requestStop(record.error); });
  child.once('error', () => { record.error = 'Command could not be started.'; requestStop(record.error); });
  let finish, commandFinish;
  child.settled = new Promise(resolve => { finish = resolve; });
  child.commandSettled = new Promise(resolve => { commandFinish = resolve; });
  child.identities = new Map();
  child.shutdownGraceMs = limits.shutdownGraceMs;
  const identity = processRows().find(row => row.pid === child.pid && row.group === child.pid);
  if (!identity) { child.kill(); throw new Error('Workspace command ownership could not be captured.'); }
  child.identities.set(identity.pid, identity.birth);
  children.add(child);
  record.pid = child.pid;
  record.startedAt = new Date().toISOString();
  record.outputBytes = 0;
  record.exitCode = null;
  record.signal = null;
  let timer;
  if (timeoutMs) timer = setTimeout(() => { record.error = 'Command timed out.'; void terminate(child).catch(() => requestStop('Workspace command timeout could not settle.')); }, timeoutMs);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    record.outputBytes += chunk.length;
    if (record.outputBytes > (limits.outputLimitBytes ?? config.limits.outputLimitBytes)) {
      record.error = 'Command output limit exceeded.';
      void terminate(child).catch(() => requestStop('Workspace output limit could not settle.'));
    }
  });
  let exit = '';
  child.stdio[3].on('data', chunk => {
    exit += chunk.toString();
    if (!/^\d+\n$/.test(exit)) return;
    clearTimeout(timer);
    record.exitCode = Number(exit.trim());
    record.finishedAt = new Date().toISOString();
    commandFinish(); publish();
  });
  child.stdio[3].on('error', () => requestStop('Workspace command exit channel failed.'));
  child.once('close', (_code, signalled) => {
    clearTimeout(timer);
    record.wrapperSignal = signalled;
    if (record.exitCode === null) { record.exitCode = _code; record.signal = signalled; }
    record.finishedAt ||= new Date().toISOString();
    commandFinish(); finish(); publish();
  });
  process.stdout.write('Workspace command started: ' + record.commandId + '\n');
  persist();
  child.stdin.end('go\n');
  return child;
}
async function probe(service) {
  const health = service.health;
  if (!health) return null;
  const started = Date.now();
  const timeoutMs = health.timeoutMs ?? 5000;
  const target = health.http || '127.0.0.1:' + service.port;
  let error;
  do {
    if (stopped) throw new Error('Workspace services cancelled.');
    try {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, timeoutMs - (Date.now() - started)))]);
      if (health.http) {
        const response = await fetch(target, { redirect: 'manual', signal });
        await response.body?.cancel().catch(() => {});
        if (!response.ok) throw new Error('HTTP health probe returned ' + response.status + '.');
      } else {
        await new Promise((resolve, reject) => {
          const socket = connect({ host: '127.0.0.1', port: service.port });
          const onAbort = () => socket.destroy(new Error('TCP health probe cancelled.'));
          signal.addEventListener('abort', onAbort, { once: true });
          socket.once('connect', () => { socket.destroy(); resolve(); });
          socket.once('error', reject);
          socket.once('close', () => signal.removeEventListener('abort', onAbort));
          if (signal.aborted) onAbort();
        });
      }
      return { kind: health.http ? 'http' : 'tcp', target, ok: true, durationMs: Date.now() - started, checkedAt: new Date().toISOString() };
    } catch (caught) { error = caught.message?.startsWith('HTTP health probe returned ') ? caught.message : caught.cause?.code || caught.code || error || 'Health deadline expired.'; }
    await sleep(25);
  } while (Date.now() - started < timeoutMs);
  return { kind: health.http ? 'http' : 'tcp', target, ok: false, durationMs: Date.now() - started, checkedAt: new Date().toISOString(), error };
}
async function launch(service) {
  const record = { name: service.name, commandId: service.commandId, cwd: path.resolve(config.worktreePath, service.cwd || '.'), port: service.port ?? null, environment: service.visibleEnvironment, health: null, restarts: 0, attempts: [] };
  state.services.push(record);
  const retry = async child => {
    if (stopped || record.restarts >= (service.restart?.maxRestarts || 0)) return false;
    record.restarts++;
    await terminate(child);
    await sleep(service.restart.delayMs ?? 100);
    delete record.finishedAt; delete record.error;
    return !stopped;
  };
  const run = async () => {
    const attempt = { commandId: service.commandId };
    record.attempts.push(attempt);
    const child = start(service.command, service.cwd, service.environment, attempt, service.timeoutMs, service);
    try {
      await sleep(10);
      if (attempt.finishedAt) throw new Error('Service ' + service.name + ' exited before readiness.');
      attempt.health = await Promise.race([
        probe(service),
        child.commandSettled.then(() => { throw new Error('Service ' + service.name + ' exited before readiness.'); }),
      ]);
      if (attempt.finishedAt) throw new Error('Service ' + service.name + ' exited before readiness.');
      persist();
      if (attempt.health && !attempt.health.ok) throw new Error('Service ' + service.name + ' failed its health check: ' + attempt.health.error);
    } catch (error) {
      if (await retry(child)) return run();
      throw error;
    }
    void child.commandSettled.then(async () => {
      if (stopped) return;
      if (await retry(child)) await run();
      else requestStop('Service ' + service.name + ' exited unexpectedly.');
    }).catch(() => requestStop('Workspace restart could not settle its prior process.'));
  };
  await run();
}
async function teardown() {
  // Persist the claim before execution: an interrupted teardown is never replayed.
  state.teardown = { state: 'running', startedAt: new Date().toISOString(), commands: [] };
  persist();
  for (const command of config.teardown) {
    const receipt = { commandId: command.commandId };
    state.teardown.commands.push(receipt);
    const child = start(command.command, '.', config.environment, receipt, config.limits.timeoutMs);
    await child.commandSettled;
    await terminate(child);
    if (receipt.exitCode !== 0 || receipt.error) state.teardown.error = 'Teardown command did not complete cleanly.';
  }
  state.teardown.state = state.teardown.error ? 'failed' : 'completed';
  if (state.teardown.error) failure ||= state.teardown.error;
  state.teardown.finishedAt = new Date().toISOString();
  persist();
}
(async () => {
  persist();
  const watcher = setInterval(() => {
    if (fs.existsSync(stopPath)) requestStop();
    try {
      const identity = execFileSync('ps', ['-p', String(config.ownerPid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim();
      if (identity !== config.ownerIdentity) requestStop('Workspace owner changed.');
    } catch { requestStop('Workspace owner exited.'); }
  }, 1000);
  try {
    while (!stopped && !fs.existsSync(path.join(directory, 'activate'))) {
      if (fs.existsSync(stopPath)) requestStop();
      await sleep(25);
    }
    if (fs.existsSync(stopPath)) requestStop();
    for (const service of config.services) {
      if (fs.existsSync(stopPath)) requestStop();
      if (stopped) break;
      await launch(service);
    }
    if (!stopped) { state.state = 'ready'; persist(); }
    while (!stopped) await sleep(25);
  } catch (error) { requestStop(error.message); }
  finally {
    state.state = 'stopping';
    publish();
    try { await Promise.all([...children].map(terminate)); } catch (error) { state.cleanupUnconfirmed = true; state.cleanupError = error.message; failure ||= 'Workspace process settlement is unconfirmed.'; }
    if (!state.cleanupUnconfirmed) { try { await teardown(); } catch { failure ||= 'Workspace teardown failed.'; } }
    try { await Promise.all([...children].map(terminate)); } catch { state.cleanupUnconfirmed = true; failure ||= 'Workspace teardown process settlement is unconfirmed.'; }
    clearInterval(watcher);
    state.state = failure ? 'failed' : 'stopped';
    state.error = failure;
    state.finishedAt = new Date().toISOString();
    publish();
    // Private config may contain scoped command environment; do not retain it.
    try { fs.rmSync(configPath, { force: true }); } catch { /* Settlement still owns process cleanup. */ }
  }
})().catch(() => { process.exitCode = 1; });
`;
