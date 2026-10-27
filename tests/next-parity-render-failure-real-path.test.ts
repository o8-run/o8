import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';

// The browser is real; native process/PNG seams are bounded fixtures. The existing
// GPUI and production-route suites independently exercise the native renderer.
const browser = [process.env.O8_PARITY_BROWSER, chromium.executablePath(), '/usr/bin/chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(path => path && existsSync(path));
const entry = resolve('scripts/parity/next.mjs');
type Fault = 'healthy' | 'pageerror' | 'console' | 'boundary' | 'boundary-reset' | 'http404' | 'http500' | 'late-http500' | 'surface-fetch500' | 'native-blank' | 'native-error' | 'native-receipt-error';

function fixture(fault: Fault) {
  const root = mkdtempSync(join(tmpdir(), 'o8-parity-render-'));
  const bin = join(root, 'bin');
  const output = join(root, 'output');
  mkdirSync(bin);
  const script = (name: string, body: string) => {
    const file = join(bin, name);
    writeFileSync(file, `#!${process.execPath}\n${body}\n`);
    chmodSync(file, 0o700);
    return file;
  };
  const count = join(root, 'frames');
  script('import', `const fs=require('node:fs'); const file=process.argv.at(-1).slice(4);
    const width=file.includes('1440x900')?1440:1024; const height=width===1440?900:720;
    const png=Buffer.alloc(24); Buffer.from('89504e470d0a1a0a','hex').copy(png);
    png.writeUInt32BE(width,16);png.writeUInt32BE(height,20);fs.writeFileSync(file,png);
    fs.writeFileSync(${JSON.stringify(count)},String(Number(fs.existsSync(${JSON.stringify(count)})?fs.readFileSync(${JSON.stringify(count)}):0)+1));`);
  script('identify', `const fs=require('node:fs');console.log(${fault === 'native-blank'} && Number(fs.readFileSync(${JSON.stringify(count)}))===2?1:100);`);
  script('xrefresh', '');
  script('xdotool', "if(process.argv[2]==='search')console.log('12345');");
  script('tesseract', `console.log(${JSON.stringify(fault === 'native-error' ? 'Local server unavailable. Retry.' : 'o8 next fixture ready')});`);
  script('convert', "require('node:fs').copyFileSync(process.argv[2],process.argv.at(-1));");
  const native = script('native', 'setInterval(()=>{},1000);');
  const nativeTest = script('native-test', `require('node:fs').writeFileSync(require('node:path').join(process.env.O8_PARITY_ROOT,'native-metrics.json'),JSON.stringify({metrics:{},errors:${JSON.stringify(fault === 'native-receipt-error' ? ['settings-error'] : [])}}));`);
  const acted = join(root, 'acted');
  const action = fault === 'pageerror' ? "document.body.innerHTML='<h1>Fixture failed to render</h1>'; setTimeout(()=>{throw new Error('fixture render exception')},0);"
    : fault === 'console' ? "console.error('fixture app render exception');"
      : fault === 'boundary' ? "document.documentElement.dataset.o8MountError='1';document.body.innerHTML='<strong>Dashboard failed to mount</strong>';"
        : fault === 'boundary-reset' ? "document.documentElement.dataset.o8MountError='1';delete document.documentElement.dataset.o8MountError;"
          : fault === 'late-http500' ? "location.href='/dashboard?failed=1';"
            : fault === 'surface-fetch500' ? "fetch('/dashboard?failed=1');" : '';
  const host = join(root, 'web-host.mjs');
  writeFileSync(host, `import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs';
    const script=${JSON.stringify(`window.addEventListener('o8:open-pr-conversation',()=>{fetch('/acted');${action}});`)};
    const server=createServer((req,res)=>{
      if(req.url==='/acted'){writeFileSync(${JSON.stringify(acted)},'post-hydration action');res.end('ok');return;}
      if(req.url==='/_next/static/chunks/app/fixture.js'){res.setHeader('content-type','text/javascript');res.end(script);return;}
      if(req.url.includes('failed=1')||${fault === 'http500'}){res.writeHead(500).end('Fixture route error');return;}
      if(${fault === 'http404'}){res.writeHead(404).end('Missing fixture route');return;}
      res.setHeader('content-type','text/html');res.end('<!doctype html><html data-o8-dashboard-hydrated="1" data-palette="dark" data-surface="glass"><body><main data-o8-workspace style="height:500px">Fixture surface ready<strong>Something went wrong</strong><textarea>Draft</textarea></main><script src="/_next/static/chunks/app/fixture.js"></script></body></html>');
    });server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({webOrigin:'http://127.0.0.1:'+server.address().port})));`);
  return { root, output, acted, run: () => spawnSync(process.execPath, [entry, '--only', 'session', '--webHost', host,
    '--binary', native, '--nativeTest', nativeTest, '--browser', browser!, '--output', output], {
    encoding: 'utf8', timeout: 45_000, env: { ...process.env, DISPLAY: ':parity-fixture', PATH: `${bin}:${process.env.PATH}` },
  }) };
}

it.each<Fault>(['pageerror', 'console', 'boundary', 'boundary-reset', 'http404', 'http500', 'late-http500', 'surface-fetch500', 'native-blank', 'native-error', 'native-receipt-error'])(
  'the capture CLI rejects %s on a named fixture surface', fault => {
    expect(browser, 'Install the parity browser before running capture regressions').toBeTruthy();
    const f = fixture(fault);
    try {
      const result = f.run();
      if (['pageerror', 'console', 'boundary', 'boundary-reset', 'late-http500', 'surface-fetch500'].includes(fault)) expect(existsSync(f.acted)).toBe(true);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('session');
      const report = JSON.parse(readFileSync(join(f.output, 'report.json'), 'utf8'));
      expect(report.crashes).toBeGreaterThan(0);
      expect(report.cases[0].crash).toContain('session');
      const reason = fault === 'pageerror' ? 'uncaught browser page error' : fault === 'console' ? 'application console error'
        : fault.startsWith('boundary') ? 'browser error boundary' : fault === 'native-blank' ? 'native capture is blank'
          : fault.startsWith('native-') ? 'native capture is an error frame' : fault === 'http404' ? 'HTTP 404' : 'HTTP 500';
      const logs = result.stdout.match(/Local diagnostics retained under (.+)/)?.[1];
      const diagnostic = logs && existsSync(join(logs, 'capture-error.log')) ? readFileSync(join(logs, 'capture-error.log'), 'utf8') : '';
      expect(report.cases[0].crash, result.stdout + result.stderr + diagnostic).toContain(reason);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000,
);

it('keeps a healthy fixture surface successful through the same CLI and real browser', () => {
  expect(browser).toBeTruthy();
  const f = fixture('healthy');
  try {
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(f.acted)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.output, 'report.json'), 'utf8')).crashes).toBe(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 60_000);
