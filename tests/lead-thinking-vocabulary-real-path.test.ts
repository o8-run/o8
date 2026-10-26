import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

const gateway = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/lane/orchestrator-backends/openclaw-gateway', () => ({ ensureOpenclawGateway: gateway }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => {} }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-lead-thinking-vocabulary-')));
const repo = join(root, 'repo');
const capture = join(root, 'argv.jsonl');
const help = join(root, 'help.json');
const binary = join(root, 'lead.cjs');
const oldHelp = '  --thinking <level>  Thinking level: off | minimal | low | medium | high\n                      | xhigh | adaptive | max\n  --timeout <seconds>  Turn timeout\n';
const currentHelp = oldHelp.replace('adaptive | max', 'adaptive | max | ultra where supported');
mkdirSync(repo);
mkdirSync(join(root, '.openclaw'));
vi.stubEnv('HOME', root);
vi.stubEnv('O8_DATA_DIR', join(root, 'data'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', join(root, 'data'));
vi.stubEnv('O8_OPENCLAW_BIN', binary);
const { openclawBackend } = await import('@/lib/lane/orchestrator-backends/openclaw');
function turns(): string[][] {
  return existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function turn(thinkingEffort?: ThinkingEffort) {
  const events: OrchestratorEvent[] = [];
  await openclawBackend.sendTurn(repo, 'Fixture task', event => events.push(event), { agent: 'fixture', thinkingEffort });
  return events;
}
beforeAll(() => {
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(root, '.openclaw', 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'fixture', model: 'fixture/model' }] }, mcp: { servers: { o8: { command: 'fixture' } } } }));
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--version')){console.log('2026.10.7');process.exit(0);}
if(args.includes('--help')){
 const help=JSON.parse(fs.readFileSync(${JSON.stringify(help)},'utf8'));
 if(help.fail){console.error('Fixture help unavailable');process.exit(1);}
 console.log(help.text);process.exit(0);
}
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(args)+'\\n');
console.log(JSON.stringify({payloads:[{text:'Fixture answer'}]}));
`, { mode: 0o700 });
});
beforeEach(() => {
  gateway.mockClear();
  rmSync(capture, { force: true });
  writeFileSync(help, JSON.stringify({ text: oldHelp }));
});
afterAll(async () => {
  (await import('@/lib/db')).closeDb();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it.each([
  { text: oldHelp },
  { text: oldHelp + '\nExample message: discuss ultra reasoning.\n' },
  { fail: true },
])('refuses ultra before a gateway or turn launch without an advertised choice: %j', async contract => {
  writeFileSync(help, JSON.stringify(contract));
  const events = await turn('ultra');
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'effort_cli_incompatible', error: expect.stringMatching(/ultra.*installed CLI/i) }));
  expect(events.some(event => event.type === 'turn_receipt')).toBe(false);
  expect(turns()).toEqual([]);
  expect(gateway).not.toHaveBeenCalled();
});
it.each([undefined, 'adaptive', 'low', 'medium', 'high', 'xhigh', 'max'] as const)('preserves %s at the actual executable and receipt', async effort => {
  const events = await turn(effort);
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  const args = turns().at(-1)!;
  const index = args.indexOf('--thinking');
  expect(index >= 0).toBe(effort !== undefined);
  if (effort) expect(args[index + 1]).toBe(effort);
  expect(events).toContainEqual({ type: 'turn_receipt', leadModel: 'fixture/model', effort: effort ?? 'adaptive' });
});
it('preserves ultra only when the selected executable advertises it', async () => {
  writeFileSync(help, JSON.stringify({ text: currentHelp }));
  const events = await turn('ultra');
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  const args = turns().at(-1)!;
  expect(args[args.indexOf('--thinking') + 1]).toBe('ultra');
  expect(events).toContainEqual({ type: 'turn_receipt', leadModel: 'fixture/model', effort: 'ultra' });
});
