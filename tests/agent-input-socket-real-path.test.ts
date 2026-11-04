/** @vitest-environment jsdom */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createO8WebviewToolHandlers } from '@/lib/mcp/o8-webview-tools';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';

const directory = mkdtempSync(join(tmpdir(), 'o8-input-socket-'));
const socketPath = join(directory, 'app.sock');
writeFileSync(`${socketPath}.token`, 'fixture-native-auth');
vi.stubEnv('O8_TAURI_MCP_SOCKET', socketPath);
vi.stubEnv('TAURI_MCP_AUTH_TOKEN', 'fixture-native-auth');
const sockets = new Set<Socket>();
const clients: O8WebviewClient[] = [];
let mode: 'success' | 'timeout' | 'landed' | 'drop' | 'hold' | 'renderer' = 'success';
let writes: Record<string, unknown>[] = [];
let held: (() => void) | undefined;
let commands: string[] = [];
const rust = readFileSync(join(process.cwd(), 'tauri-plugin-mcp/src/tools/webview.rs'), 'utf8');
const nativeScript = /const TYPE_INTO_FOCUSED_JS: &str = r#"([\s\S]*?)"#;/.exec(rust)?.[1];
if (!nativeScript) throw new Error('Production focused typing script was not found');
const nativeWindow = window as typeof window & { __TAURI_INTERNALS__?: { invoke: (command: string, reply: { ok: boolean; data: unknown; error: string | null }) => Promise<void> } };
const scriptTimer = vi.fn(() => 0);
const changes = vi.fn();
function Field({ tag }: { tag: 'input' | 'textarea' }) {
  const [value, setValue] = useState('prefix');
  return createElement('section', {}, createElement(tag, { value, onChange: (event: { currentTarget: { value: string } }) => {
    changes(event.currentTarget.value); setValue(event.currentTarget.value);
  } }), createElement('output', {}, value));
}
const server = createServer(socket => {
  sockets.add(socket);
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      commands.push(request.command);
      expect(request.authToken).toBe('fixture-native-auth'); expect(request.payload.window_label).toBe('main');
      const respond = (success: boolean, data?: unknown, error?: string) => socket.write(JSON.stringify({ id: request.id, success, data, error }) + '\n');
      if (request.command === 'type_into_focused') {
        writes.push(request.payload);
        if (mode === 'renderer') {
          nativeWindow.__TAURI_INTERNALS__ = { invoke: async (command, reply) => {
            expect(command).toBe('mcp_result'); respond(reply.ok, reply.data, reply.error ?? undefined);
          } };
          const code = nativeScript!.replaceAll('{{payload}}', JSON.stringify({ text: request.payload.text, delayMs: request.payload.delay_ms })).replaceAll('{{correlationId}}', JSON.stringify(request.id));
          // Only the extracted production script timer is stalled; jsdom's
          // selection APIs may schedule unrelated selectionchange events.
          void new Function('setTimeout', `return ${code.trim()}`)(scriptTimer);
          continue;
        }
        if (mode === 'drop') { socket.destroy(); continue; }
        if (mode === 'timeout' || mode === 'landed') {
          // Match eval_and_await's production timeout, including its correlation id.
          respond(false, undefined, `eval_and_await failed for type_into_focused: Timeout waiting for ${request.id} response (eval-based)`); continue;
        }
        if (mode === 'hold' && writes.length === 1) { held = () => respond(true, { charsTyped: String(request.payload.text).length }); continue; }
        respond(true, { charsTyped: String(request.payload.text).length });
      } else {
        expect(request.command).toBe('execute_js');
        if (mode === 'renderer') { respond(true, { result: new Function(`return ${request.payload.code}`)() }); continue; }
        const readback = String(request.payload.code).includes('value.endsWith(');
        respond(true, { result: readback ? mode === 'landed' ? 'true' : 'false' : JSON.stringify({ ok: true }) });
      }
    }
  });
});
beforeAll(async () => { await new Promise<void>(resolve => server.listen(socketPath, resolve)); });
beforeEach(() => { mode = 'success'; writes = []; held = undefined; commands = []; changes.mockClear(); scriptTimer.mockClear(); });
afterAll(async () => {
  for (const client of clients) client.dispose(); for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve())); delete nativeWindow.__TAURI_INTERNALS__; vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});
function tool() {
  const client = clients[0] ?? new O8WebviewClient();
  if (clients.length === 0) clients.push(client);
  return createO8WebviewToolHandlers(() => client).o8_view_type;
}
function result(response: Awaited<ReturnType<ReturnType<typeof tool>>>) {
  const content = response.content[0]; if (content.type !== 'text') throw new Error('Expected text result'); return content.text;
}
describe('registered view typing -> authenticated actual client socket', () => {
  it.each([
    ['input', ' literal'], ['input', 'literal '], ['input', ' \tliteral\t '],
    ['textarea', ' literal'], ['textarea', 'literal '], ['textarea', '\n literal\nsuffix \n'],
  ] as const)('preserves literal whitespace in %s through handler/socket/native script/React: %j', async (tag, text) => {
    mode = 'renderer'; Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      act(() => root.render(createElement(Field, { tag })));
      const field = host.querySelector(tag)!; field.focus(); field.setSelectionRange(field.value.length, field.value.length);
      vi.spyOn(field, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 40 } as DOMRect);
      let response: Awaited<ReturnType<ReturnType<typeof tool>>> | undefined;
      await act(async () => { response = await tool()({ text }); });
      expect(response?.isError).not.toBe(true);
      expect(field.value).toBe('prefix' + text); expect(host.querySelector('output')?.textContent).toBe('prefix' + text);
      expect(changes).toHaveBeenCalledExactlyOnceWith('prefix' + text);
      expect(writes).toEqual([{ window_label: 'main', text, delay_ms: 0 }]);
      expect(scriptTimer).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); delete nativeWindow.__TAURI_INTERNALS__; }
  });
  it.each(['', ' ', '\t', '\n', ' \r\n\t ', undefined, 42])('rejects blank or invalid text %j before preparation or native mutation', async text => {
    expect((await tool()({ text })).isError).toBe(true);
    expect(commands).toEqual([]); expect(writes).toEqual([]);
  });
  it('requests the unpaced native mode through the registered tool', async () => {
    const response = await tool()({ text: 'append\nline' });
    expect(response.isError).not.toBe(true); expect(JSON.parse(result(response))).toMatchObject({ ok: true });
    expect(writes).toEqual([{ window_label: 'main', text: 'append\nline', delay_ms: 0 }]);
  });
  it.each(['timeout', 'drop'] as const)('never replays an uncertain %s write', async kind => {
    mode = kind; const response = await tool()({ text: 'unsent-marker' });
    expect(response.isError).toBe(true); expect(writes).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 25)); expect(writes).toHaveLength(1);
  });
  it('retains readback reconciliation after acknowledgement timeout without repeating the write', async () => {
    mode = 'landed'; const response = await tool()({ text: 'unsent-marker' });
    expect(JSON.parse(result(response))).toMatchObject({ ok: true, warning: expect.any(String) }); expect(writes).toHaveLength(1);
  });
  it('keeps concurrent typing serialized until the first acknowledgement', async () => {
    mode = 'hold'; const type = tool(); const first = type({ text: 'first' }); const second = type({ text: 'second' });
    await vi.waitFor(() => expect(held).toBeTypeOf('function'));
    expect(writes.map(write => write.text)).toEqual(['first']); held!();
    await Promise.all([first, second]); expect(writes.map(write => write.text)).toEqual(['first', 'second']);
  });
});
