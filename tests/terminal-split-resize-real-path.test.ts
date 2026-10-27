import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { spawn, type IPty } from 'node-pty';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

// This owns its browser, loopback listener and disposable PTY. It never attaches
// to an installed app. Native input remains a separate reproduction step.
it('preserves exact input, prompts and results through mounted split resizing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'o8-split-resize-'));
  const bundle = path.join(directory, 'fixture.js');
  const records: Array<{ input: string[]; output: string[]; sizes: number[][] }> = [];
  const terminals = new Set<IPty>();
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await build({ absWorkingDir: process.cwd(), bundle: true, format: 'esm', platform: 'browser', outfile: bundle,
      define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic',
      plugins: [{ name: 'fixture-theme', setup(builder) {
        builder.onResolve({ filter: /\/theme\/context$/ }, () => ({ path: 'theme', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useTheme=()=>({themeId:"light-solid"});', loader: 'js' }));
      } }],
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React, { useEffect, useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { XtermPanel } from './src/components/desktop/workspace-terminal/XtermPanel';
        function Fixture() {
          const ref = useRef(null);
          const [socket, setSocket] = useState(null);
          useEffect(() => {
            const connection = new WebSocket('ws://' + location.host);
            connection.onopen = () => setSocket(connection);
            connection.onmessage = event => ref.current?.writeData(JSON.parse(event.data).data);
            window.readTerminal = () => ref.current?.readText();
            return () => connection.close();
          }, []);
          const send = (type, data) => socket.send(JSON.stringify({ type, ...data }));
          return <main style={{ display: 'flex', height: 480 }}>
            <section style={{ width: 240 }}>Conversation</section>
            <section id="terminal" style={{ width: 640, display: 'flex', flexDirection: 'column' }}>
              {socket ? <XtermPanel ref={ref} tmuxSession="split-fixture" visible screenReaderMode
                sendTerminalAttach={(id, cols, rows) => send('attach', { cols, rows })}
                sendTerminalInput={(id, data) => send('input', { data })}
                sendTerminalResize={(id, cols, rows) => send('resize', { cols, rows })}
                sendTerminalDetach={() => {}} /> : null}
            </section>
          </main>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      ` },
    });
    const [script, css] = await Promise.all([readFile(bundle), readFile(require.resolve('@xterm/xterm/css/xterm.css'))]);
    server.on('request', (request, response) => {
      response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : request.url === '/xterm.css' ? 'text/css' : 'text/html');
      response.end(request.url === '/fixture.js' ? script : request.url === '/xterm.css' ? css
        : '<html><head><link rel="stylesheet" href="/xterm.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
    });
    sockets.on('connection', socket => {
      let terminal: IPty | undefined;
      const record = { input: [] as string[], output: [] as string[], sizes: [] as number[][] };
      records.push(record);
      socket.on('message', raw => {
        const message = JSON.parse(String(raw)) as { type: string; cols: number; rows: number; data: string };
        if (message.type === 'attach' && !terminal) {
          terminal = spawn('/bin/bash', ['--noprofile', '--norc'], { cols: message.cols, rows: message.rows,
            name: 'xterm-256color', cwd: directory, env: { TERM: 'xterm-256color', PATH: process.env.PATH!, PS1: '$ ' } });
          terminals.add(terminal);
          terminal.onData(data => { record.output.push(data); if (socket.readyState === 1) socket.send(JSON.stringify({ data: Buffer.from(data).toString('base64') })); });
        } else if (message.type === 'input') {
          record.input.push(message.data); terminal?.write(message.data);
        } else if (message.type === 'resize') {
          record.sizes.push([message.cols, message.rows]); terminal?.resize(message.cols, message.rows);
        }
      });
      socket.on('close', () => terminal?.kill());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: resolveBrowserPath() ?? undefined, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const screen = () => page.evaluate(() => (window as unknown as { readTerminal: () => string }).readTerminal());
    await expect.poll(screen).toBe('$');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('python3 -q'); await page.keyboard.press('Enter');
    await expect.poll(screen).toContain('>>>');
    const expressions = ['round(10.2345, 2)', 'sum((7, 11))'];
    for (const [index, expression] of expressions.entries()) {
      await page.keyboard.type(expression.slice(0, 8));
      for (const width of [300, 180, 700, 240, 640]) {
        const before = records[0].sizes.length;
        await page.locator('#terminal').evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px`; }, width);
        await expect.poll(() => records[0].sizes.length).toBeGreaterThan(before);
      }
      await page.keyboard.type(expression.slice(8)); await page.keyboard.press('Enter');
      await expect.poll(screen).toContain(index === 0 ? '10.23' : '18');
    }
    expect(records[0].input.join('')).toBe('python3 -q\rround(10.2345, 2)\rsum((7, 11))\r');
    expect(await screen()).toBe('$ python3 -q\n>>> round(10.2345, 2)\n10.23\n>>> sum((7, 11))\n18\n>>>');
    expect(records[0].output.join('')).toContain('10.23\r\n');
    expect(records[0].output.join('')).toContain('18\r\n');
    expect(records[0].sizes.length).toBeGreaterThanOrEqual(10);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    for (const terminal of terminals) { try { terminal.kill(); } catch { /* Already exited. */ } }
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
