import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
const helpCapture = join(root, 'help-calls.jsonl');
let binaryTimestamp = Math.floor(Date.now() / 1000);
const binary = join(root, 'lead.cjs');
const oldHelp = '  --thinking <level>  Thinking level: off | minimal | low | medium | high\n                      | xhigh | adaptive | max\n  --timeout <seconds>  Turn timeout\n';
const currentHelp = oldHelp.replace('adaptive | max', 'adaptive | max | ultra where supported');
mkdirSync(repo);
mkdirSync(join(root, '.openclaw'));
vi.stubEnv('HOME', root);
vi.stubEnv('O8_DATA_DIR', join(root, 'data'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', join(root, 'data'));
vi.stubEnv('O8_OPENCLAW_BIN', binary);
const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
const { openclawBackend } = await import('@/lib/lane/orchestrator-backends/openclaw');
function turns(): string[][] {
  return existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
function setContract(contract: { text?: string; fail?: boolean; version?: string; versionFail?: boolean }) {
  writeFileSync(help, JSON.stringify(contract));
  binaryTimestamp += 1;
  utimesSync(binary, binaryTimestamp, binaryTimestamp);
}
function helpCalls(): number {
  return existsSync(helpCapture) ? readFileSync(helpCapture, 'utf8').trim().split('\n').filter(Boolean).length : 0;
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
if(args.includes('--version')){
 const contract=JSON.parse(fs.readFileSync(${JSON.stringify(help)},'utf8'));
 if(contract.versionFail){process.exit(1);}
 console.log(contract.version??'2026.10.7');process.exit(0);
}
if(args.includes('--help')){
 fs.appendFileSync(${JSON.stringify(helpCapture)},JSON.stringify(args)+'\\n');
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
  rmSync(helpCapture, { force: true });
  vi.stubEnv('O8_OPENCLAW_BIN', binary);
  invalidateCliCache('openclaw');
  setContract({ text: oldHelp });
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
  setContract(contract);
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
  setContract({ text: currentHelp });
  const events = await turn('ultra');
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  const args = turns().at(-1)!;
  expect(args[args.indexOf('--thinking') + 1]).toBe('ultra');
  expect(events).toContainEqual({ type: 'turn_receipt', leadModel: 'fixture/model', effort: 'ultra' });
});

it('shares one help read across 14 unchanged launches', async () => {
  for (let launch = 0; launch < 14; launch += 1) {
    expect((await turn('high')).filter(event => event.type === 'error')).toEqual([]);
  }
  expect(turns()).toHaveLength(14);
  expect(helpCalls()).toBe(1);
});
it('invalidates cached choices when the selected executable changes modification time', async () => {
  setContract({ text: currentHelp });
  expect((await turn('ultra')).some(event => event.type === 'error')).toBe(false);
  setContract({ text: oldHelp });
  expect(await turn('ultra')).toContainEqual(expect.objectContaining({ type: 'error', code: 'effort_cli_incompatible' }));
  expect(turns()).toHaveLength(1);
  expect(helpCalls()).toBe(2);
});

it.each([{ version: '' }, { versionFail: true }])('does not reuse help when the reported version is unavailable: %j', async version => {
  setContract({ text: currentHelp, ...version });
  expect((await turn('ultra')).some(event => event.type === 'error')).toBe(false);
  writeFileSync(help, JSON.stringify({ text: oldHelp, ...version }));
  const events = await turn('ultra');
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'effort_cli_incompatible' }));
  expect(events.some(event => event.type === 'turn_receipt')).toBe(false);
  expect(gateway).toHaveBeenCalledTimes(1);
  expect(turns()).toHaveLength(1);
  expect(helpCalls()).toBe(2);
});
it('keeps equal modification times for different executable paths separate', async () => {
  setContract({ text: currentHelp });
  expect((await turn('ultra')).some(event => event.type === 'error')).toBe(false);
  const other = join(root, 'other-lead.cjs'); copyFileSync(binary, other);
  const info = statSync(binary); utimesSync(other, info.atime, info.mtime);
  writeFileSync(help, JSON.stringify({ text: oldHelp }));
  vi.stubEnv('O8_OPENCLAW_BIN', other);
  invalidateCliCache('openclaw');
  expect(await turn('ultra')).toContainEqual(expect.objectContaining({ type: 'error', code: 'effort_cli_incompatible' }));
  expect(turns()).toHaveLength(1);
  expect(helpCalls()).toBe(2);
});

it('retries a failed help probe without requiring another executable modification', async () => {
  setContract({ fail: true });
  expect(await turn('high')).toContainEqual(expect.objectContaining({ type: 'error', code: 'effort_cli_incompatible' }));
  writeFileSync(help, JSON.stringify({ text: oldHelp }));
  expect((await turn('high')).some(event => event.type === 'error')).toBe(false);
  expect(turns()).toHaveLength(1);
  expect(helpCalls()).toBe(2);
});

it.each(['inode', 'size', 'version'] as const)('invalidates cached choices when executable %s changes with preserved mtime', async identity => {
  setContract({ text: currentHelp });
  expect((await turn('ultra')).some(event => event.type === 'error')).toBe(false);
  const before = statSync(binary);
  const source = readFileSync(binary, 'utf8');
  if (identity === 'inode') {
    const replacement = join(root, 'replacement-lead.cjs');
    writeFileSync(replacement, source, { mode: 0o700 });
    utimesSync(replacement, before.atime, before.mtime);
    renameSync(replacement, binary);
  } else if (identity === 'size') {
    writeFileSync(binary, source + '\n// Changed executable size.\n');
    utimesSync(binary, before.atime, before.mtime);
  }
  writeFileSync(help, JSON.stringify({ text: oldHelp, version: identity === 'version' ? '2026.10.8' : '2026.10.7' }));
  const after = statSync(binary);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.ino === before.ino).toBe(identity !== 'inode');
  expect(after.size === before.size).toBe(identity !== 'size');
  const events = await turn('ultra');
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'effort_cli_incompatible' }));
  expect(events.some(event => event.type === 'turn_receipt')).toBe(false);
  expect(gateway).toHaveBeenCalledTimes(1);
  expect(turns()).toHaveLength(1);
  expect(helpCalls()).toBe(2);
});

it.each([
  '  --thinking <level>  Thinking level: | |\n  --timeout <seconds>  Turn timeout\n',
  '  --thinking <level>  Thinking level: temporarily unavailable\n  --timeout <seconds>  Turn timeout\n',
  'Usage: agent [options]\n',
])('retries empty or unparseable help after repair without changing executable identity: %j', async text => {
  setContract({ text });
  const before = statSync(binary);
  const events = await turn('high');
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'effort_cli_incompatible' }));
  expect(events.some(event => event.type === 'turn_receipt')).toBe(false);
  expect(turns()).toEqual([]);
  expect(gateway).not.toHaveBeenCalled();
  writeFileSync(help, JSON.stringify({ text: oldHelp }));
  const after = statSync(binary);
  expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);
  expect((await turn('high')).some(event => event.type === 'error')).toBe(false);
  expect(turns()).toHaveLength(1);
  expect(helpCalls()).toBe(2);
});
