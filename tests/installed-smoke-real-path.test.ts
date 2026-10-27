import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const roots: string[] = [];
const command = join(process.cwd(), 'scripts/smoke-installed.mjs');
function fixture(failure = '') {
  const root = mkdtempSync(join(tmpdir(), 'o8-installed-smoke-'));
  roots.push(root);
  const audit = join(root, 'audit.json');
  const version = '0.1.900';
  const app = `#!${process.execPath}
const fs = require('node:fs'), net = require('node:net'), http = require('node:http');
const { WebSocketServer } = require(${JSON.stringify(require.resolve('ws'))});
const failure = ${JSON.stringify(failure)}, version = '${version}';
const token = require('node:crypto').randomBytes(32).toString('hex');
fs.writeFileSync(process.env.O8_TAURI_MCP_SOCKET + '.token', token);
fs.writeFileSync(process.env.O8_DATA_DIR + '/ws-token', token);
fs.writeFileSync(${JSON.stringify(audit)}, JSON.stringify({ home: process.env.HOME, data: process.env.O8_DATA_DIR,
  config: process.env.XDG_CONFIG_HOME, libraryPath: process.env.LD_LIBRARY_PATH, fixtureA: process.env.O8_CODEX_BIN, fixtureB: process.env.O8_CLAUDE_CODE_BIN }));
const native = net.createServer(s => { let buffer = ''; s.on('data', b => { buffer += b; let at;
 while ((at=buffer.indexOf('\\n'))>=0) { const m=JSON.parse(buffer.slice(0,at)); buffer=buffer.slice(at+1);
 if (failure==='first-window') continue;
 s.write(JSON.stringify({ id:m.id,success:true,data:{result:JSON.stringify({ready:true, version:failure==='version'?'0.1.800':version})}})+'\\n');
 } }); });
if(failure==='no-mcp') fs.writeFileSync(process.env.O8_DATA_DIR+'/installed-smoke-window.json', JSON.stringify({ready:true, version, runId:process.env.O8_INSTALLED_SMOKE_RUN}));
else native.listen(process.env.O8_TAURI_MCP_SOCKET);
const ws = new WebSocketServer({port:Number(process.env.O8_WS_PORT),host:'127.0.0.1'});
ws.on('connection', s => s.on('message', b => { const m=JSON.parse(b);
 const data={repoPath:m.repoPath,threadId:m.threadId,backend:m.backend};
 if(m.type==='orchestrator-subscribe') s.send(JSON.stringify({channel:'orchestrator',event:'status',data:{...data,status:'ready',snapshot:true}}));
 if(m.type==='orchestrator-send') {
  if(failure===m.backend+'-chat') return s.send(JSON.stringify({channel:'orchestrator',event:'error',data}));
  const text=m.message.match(/o8_smoke_[a-f0-9-]+/)[0];
  s.send(JSON.stringify({channel:'orchestrator',event:'output',data:{...data,text}}));
  s.send(JSON.stringify({channel:'orchestrator',event:'status',data:{...data,status:'ready',voiceTerminal:{outcome:'completed',text}}}));
 }
}));
let workerText='';
const api=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;
 res.setHeader('Content-Type','application/json');
 if(req.url==='/api/runtime/launch') {
  if(failure==='worker-dispatch'){res.statusCode=500;return res.end('{}');}
  workerText=JSON.parse(raw).prompt.match(/o8_smoke_[a-f0-9-]+/)[0];
  return res.end(JSON.stringify({ok:true,surfaceId:'codex-owned:smoke'}));
 }
 if(req.url.startsWith('/api/runtime/transcript')) return res.end(JSON.stringify({transcript:[{role:'assistant',text:workerText}]}));
 if(req.url.startsWith('/api/runtime/inventory')) return res.end(JSON.stringify({agents:[{sessionKey:'codex-owned:smoke',status:'idle'}]}));
 res.statusCode=404;res.end('{}');
});api.listen(Number(process.env.O8_API_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.O8_DATA_DIR+'/api-port',process.env.O8_API_PORT));
`;
  const artifact = join(root, 'o8.AppImage');
  writeFileSync(artifact, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]!=='--appimage-extract')process.exit(2);
fs.mkdirSync('squashfs-root/usr/bin',{recursive:true});
fs.writeFileSync('squashfs-root/usr/bin/o8',Buffer.from('${Buffer.from(app).toString('base64')}','base64'),{mode:0o700});
`);
  chmodSync(artifact, 0o700);
  const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  const manifest = join(root, 'beta.json');
  writeFileSync(manifest, JSON.stringify({ channel: 'beta', version, platforms: {}, installers: [
    { url: `https://github.com/o8-run/o8/releases/download/v${version}/o8.AppImage`, sha256 },
  ] }));
  const receipt = join(root, 'receipt.json');
  return { root, artifact, manifest, receipt, audit, sha256, app };
}
function run(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}, preload?: string) {
  return spawnSync(process.execPath, [...(preload ? ['--import', preload] : []), command, '--artifact', f.artifact, '--manifest', f.manifest, '--receipt', f.receipt, '--timeout-ms', '1500'], {
    cwd: f.root, encoding: 'utf8', timeout: 20_000,
    env: { NODE_ENV: 'test', PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ...extra },
  });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('unpacks and launches the installed artifact with disposable state and reports fixture providers', () => {
  const f = fixture();
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(f.receipt, 'utf8'))).toMatchObject({ status: 'passed', version: '0.1.900', artifactSha256: f.sha256,
    providers: { codex: 'fixture', claude: 'fixture', worker: 'fixture' },
  });
  const audit = JSON.parse(readFileSync(f.audit, 'utf8'));
  expect(audit.home).not.toBe(process.env.HOME);
  expect(audit.data).not.toBe(process.env.O8_DATA_DIR);
  expect(existsSync(audit.home)).toBe(false);
  expect(existsSync(audit.data)).toBe(false);
});
it.each(['first-window', 'version', 'codex-chat', 'claude-chat', 'worker-dispatch'])('names the failed %s step and leaves no passing receipt', step => {
  const f = fixture(step);
  const result = run(f);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(step === 'version' ? 'first-window' : step);
  if (existsSync(f.receipt)) expect(JSON.parse(readFileSync(f.receipt, 'utf8')).status).not.toBe('passed');
});
it('reports discovered installed CLIs without silently choosing fixtures', () => {
  const f = fixture();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  for (const name of ['codex', 'claude']) {
    const executable = join(bin, name);
    writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write('fixture executable');\n`, { mode: 0o700 });
  }
  const result = run(f, { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(f.receipt, 'utf8')).providers).toEqual({ codex: 'real', claude: 'real', worker: 'real' });
});

it('mounts a disk image read-only, verifies the copied app and detaches only its temporary mount', () => {
  const f = fixture();
  f.artifact = join(f.root, 'o8.dmg');
  writeFileSync(f.artifact, 'disk image fixture');
  f.sha256 = createHash('sha256').update(readFileSync(f.artifact)).digest('hex');
  const manifest = JSON.parse(readFileSync(f.manifest, 'utf8'));
  manifest.installers = [{ url: 'https://github.com/o8-run/o8/releases/download/v0.1.900/o8.dmg', sha256: f.sha256 }];
  writeFileSync(f.manifest, JSON.stringify(manifest));
  const source = join(f.root, 'o8.app');
  mkdirSync(join(source, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(source, 'Contents/MacOS/o8'), f.app, { mode: 0o700 });
  const log = join(f.root, 'platform.jsonl');
  const loader = join(f.root, 'platform-loader.mjs');
  writeFileSync(loader, `export async function load(url, context, next) {
    if(url!=='node:child_process')return next(url,context);
    return {format:'module',shortCircuit:true,source:${JSON.stringify(`
const real=process.getBuiltinModule('node:child_process'), fs=process.getBuiltinModule('node:fs'), path=process.getBuiltinModule('node:path');
export const spawn=real.spawn;
export function execFileSync(command,args,options){
 if(command.endsWith('hdiutil')||command.endsWith('ditto')||command.endsWith('codesign')) {
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command,args})+String.fromCharCode(10));
  if(command.endsWith('hdiutil')&&args[0]==='attach')fs.cpSync(${JSON.stringify(source)},path.join(args[args.indexOf('-mountpoint')+1],'o8.app'),{recursive:true});
  if(command.endsWith('hdiutil')&&args[0]==='detach')fs.rmSync(path.join(args[1],'o8.app'),{recursive:true,force:true});
  if(command.endsWith('ditto'))fs.cpSync(args[0],args[1],{recursive:true});
  return Buffer.from('');
 }
 return real.execFileSync(command,args,options);
}`)}};
  }`);
  const preload = join(f.root, 'platform-register.mjs');
  writeFileSync(preload, `import {register} from 'node:module';register(new URL('./platform-loader.mjs',import.meta.url));Object.defineProperty(process,'platform',{value:'darwin'});`);
  const result = run(f, {}, preload);
  expect(result.status, result.stderr).toBe(0);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls[0].args).toContain('-readonly');
  expect(calls.some(call => call.command.endsWith('codesign') && call.args.includes('--strict'))).toBe(true);
  expect(calls.at(-1).args[0]).toBe('detach');
  expect(existsSync(calls.at(-1).args[1])).toBe(false);
});

it('uses the installed secondary runtime for the worker when only that CLI is present', () => {
  const f = fixture();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nprocess.stdout.write('fixture executable');\n`, { mode: 0o700 });
  const result = run(f, { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(f.receipt, 'utf8'))).toMatchObject({
    providers: { codex: 'fixture', claude: 'real', worker: 'real' }, workerRuntime: 'claude-code',
  });
});

it('accepts a hydrated native-window acknowledgment when the optional control plugin is absent', () => {
  const f = fixture('no-mcp');
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(f.receipt, 'utf8')).steps['first-window']).toBe('passed');
});

it('keeps the supplied Linux runtime library search path inside the isolated launch', () => {
  const f = fixture();
  const libraries = join(f.root, 'runtime-libraries');
  mkdirSync(libraries);
  const result = run(f, { LD_LIBRARY_PATH: libraries });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(f.audit, 'utf8')).libraryPath).toBe(libraries);
});
