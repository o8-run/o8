import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-discovered-resume-')));
const home = path.join(root, 'home');
const codexHome = path.join(home, '.codex');
const privateHome = path.join(root, 'o8-private-codex');
const rolloutDir = path.join(codexHome, 'sessions', '2026', '11', '03');
const threadId = '11111111-2222-4333-8444-555555555555';
const rollout = path.join(rolloutDir, `rollout-2026-11-03T12-00-00-${threadId}.jsonl`);
const receipt = path.join(root, 'resume.json');
const binary = path.join(home, '.npm-global', 'bin', 'codex');
mkdirSync(rolloutDir, { recursive: true });
mkdirSync(privateHome, { recursive: true });
mkdirSync(path.dirname(binary), { recursive: true });
writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`);
writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
const args = process.argv.slice(2);
const file = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '03', ${JSON.stringify(path.basename(rollout))});
const resumed = fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).payload.id === args[args.indexOf('resume') + 1];
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args, home: process.env.CODEX_HOME, resumed }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: resumed ? 'Resumed the saved conversation.' : 'Started fresh.' } }));
console.log(JSON.stringify({ type: 'thread.started', thread_id: resumed ? ${JSON.stringify(threadId)} : 'fresh-thread' }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`, { mode: 0o755 });

vi.stubEnv('HOME', home);
vi.stubEnv('CODEX_HOME', privateHome);
vi.stubEnv('O8_CODEX_BIN', binary);
vi.spyOn(os, 'homedir').mockReturnValue(home);
// A discovered database can refer to a rollout written outside o8's private home.
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
execFileSync('sqlite3', [path.join(privateHome, 'state_5.sqlite'), `
  CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT,
    git_branch TEXT, git_sha TEXT, git_origin_url TEXT, first_user_message TEXT, model TEXT, archived INTEGER);
  INSERT INTO threads VALUES (${sqlString(threadId)}, 'Fixture', ${sqlString(root)}, 1,
    ${sqlString(rollout)}, '', '', '', 'Original task', '', 0);
`]);

const { resumeDiscoveredCodexSession } = await import('@/lib/codex/discovered-resume');
const { codexRuntime } = await import('@/lib/runtimes/codex');
const { ensureCodexOrchestratorSession, sendToCodexOrchestrator } = await import('@/lib/lane/codex-orchestrator-session');
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('discovered Codex resume through a real launch and rollout', () => {
  it.each(['codex:', 'codex-discovered:'])('resumes %s with the rollout home instead of the private home', async (prefix) => {
    const result = await resumeDiscoveredCodexSession(`${prefix}${threadId}`, 'Continue the original task');
    expect(result).toMatchObject({ ok: true, responseText: 'Resumed the saved conversation.' });
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
      home: codexHome, resumed: true, args: ['exec', 'resume', threadId, 'Continue the original task', '--json', '--dangerously-bypass-approvals-and-sandbox'],
    });
  });

  it('uses the rollout home through the runtime adapter too', async () => {
    expect(await codexRuntime.resume(`codex:${threadId}`, 'Continue')).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ home: codexHome, resumed: true });
  });

  it('makes the external rollout available to the private orchestrator home', async () => {
    execFileSync('git', ['init', '-q', root]);
    copyFileSync(path.join(privateHome, 'state_5.sqlite'), path.join(codexHome, 'state_5.sqlite'));
    vi.stubEnv('CODEX_HOME', codexHome);
    const session = ensureCodexOrchestratorSession(root, 'external-thread-chat');
    session.threadId = threadId;
    const events: OrchestratorEvent[] = [];
    await sendToCodexOrchestrator(session, 'Continue', event => events.push(event), {
      model: 'gpt-5.5', serviceTier: 'default', orchestrationMode: 'fleet',
    });
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    const launch = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(launch.resumed).toBe(true);
    expect(launch.home).not.toBe(codexHome);
    expect(realpathSync(path.join(launch.home, path.relative(codexHome, rollout)))).toBe(rollout);
    expect(session.threadId).toBe(threadId);
    // Reusing the same link must also preserve the original thread.
    await sendToCodexOrchestrator(session, 'Continue again', event => events.push(event), {
      model: 'gpt-5.5', serviceTier: 'default', orchestrationMode: 'fleet',
    });
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(session.threadId).toBe(threadId);
    vi.stubEnv('CODEX_HOME', privateHome);
  });

  it('explains a missing rollout would start fresh and launches neither resume entry point', async () => {
    rmSync(rollout);
    rmSync(receipt, { force: true });
    for (const resume of [resumeDiscoveredCodexSession, codexRuntime.resume]) {
      expect(await resume(`codex:${threadId}`, 'Continue')).toMatchObject({
        ok: false, note: expect.stringContaining('start fresh'),
      });
    }
    expect(() => readFileSync(receipt)).toThrow();
  });

  it('reports a missing external rollout before the orchestrator can start fresh', async () => {
    vi.stubEnv('CODEX_HOME', codexHome);
    const session = ensureCodexOrchestratorSession(root, 'missing-external-thread');
    session.threadId = threadId;
    const events: OrchestratorEvent[] = [];
    await sendToCodexOrchestrator(session, 'Continue', event => events.push(event), {
      model: 'gpt-5.5', serviceTier: 'default', orchestrationMode: 'fleet',
    });
    expect(events).toContainEqual({ type: 'error', error: expect.stringContaining('start fresh') });
    expect(() => readFileSync(receipt)).toThrow();
    expect(session.threadId).toBe(threadId);
    vi.stubEnv('CODEX_HOME', privateHome);
  });
});
