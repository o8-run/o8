import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';

// The wire fields documented by #5405, in the existing JSONL capture format.
// This is source-derived; the original private CLI capture is not in the repo.
const capture = readFileSync(join(import.meta.dirname, 'fixtures/claude-background-agents.source-derived.jsonl'), 'utf8');
const lines = capture.trim().split('\n');
const root = mkdtempSync(join(tmpdir(), 'o8-background-agents-'));
const repo = join(root, 'repo');
const binary = join(root, 'claude-peer');
const project = join(root, 'claude', 'projects', 'fixture');
const log = join(project, 'background-agents-fixture.jsonl');
mkdirSync(project, { recursive: true });
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], { cwd: repo });
vi.stubEnv('CLAUDE_HOME', join(root, 'claude'));
vi.stubEnv('O8_CLAUDE_CODE_BIN', binary);
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');

// Only the provider executable is replaced. Resident spawn, stdout parsing,
// warm reuse and the desktop's backend entry point remain real.
writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('2.1.0'); process.exit(0); }
const lines = ${JSON.stringify(lines)};
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const gate = JSON.parse(line).message.content;
  for (let i = 0; i < lines.length; i++) {
    if (i >= 5) {
      const stage = i === 5 ? 'first' : i === 6 ? 'second' : 'end';
      while (!fs.existsSync(gate + '-' + stage)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    console.log(lines[i]);
  }
  fs.writeFileSync(gate + '-written', 'done');
});
`, { mode: 0o755 });

const { claudeBackend } = await import('@/lib/lane/orchestrator-backends/claude');
const { getOrchestratorSession, reloadOrchestratorSession } = await import('@/lib/lane/orchestrator-session');
const { sendOrchestratorBackendTurn } = await import('@/lib/lane/orchestrator-send-entry');
const { GET } = await import('@/app/api/orchestrator/packet-transcript/route');
const threadId = 'thoughts-background-agents';
afterAll(() => {
  reloadOrchestratorSession(repo, threadId);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('background agent completion through lead transports', () => {
  it.each(['pipe', 'log'])('finishes each agent during cold and warm resident turns over %s', async transport => {
    reloadOrchestratorSession(repo, threadId);
    vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', transport === 'log' ? '1' : '0');
    let pid: number | undefined;
    for (const turn of ['cold', 'warm']) {
      const gate = join(root, `${transport}-${turn}`);
      const events: OrchestratorEvent[] = [];
      const work = sendOrchestratorBackendTurn(claudeBackend, repo, gate, event => events.push(event), {
        threadId, model: 'claude-opus-4-8', thinkingEffort: 'adaptive',
      }, 'fleet');
      const results = () => events.filter(event => event.type === 'tool_result');
      try {
        await vi.waitFor(() => expect(events.filter(event => event.type === 'tool_use')).toHaveLength(2));
        const currentPid = getOrchestratorSession(repo, threadId)?.proc?.pid;
        expect(currentPid).toBeTypeOf('number');
        if (pid) expect(currentPid).toBe(pid);
        pid = currentPid;
        expect(results()).toEqual([]);
        writeFileSync(`${gate}-first`, 'go');
        await vi.waitFor(() => expect(results()).toMatchObject([
          { id: 'date-agent', name: 'Agent', output: 'The date agent finished.' },
        ]));
        expect(claudeBackend.peekSession(repo, undefined, threadId)?.status).toBe('busy');
        expect(events.some(event => event.type === 'done')).toBe(false);
        writeFileSync(`${gate}-second`, 'go');
        await vi.waitFor(() => expect(results()).toMatchObject([
          { id: 'date-agent' }, { id: 'uname-agent', name: 'Agent', output: 'The uname agent finished.' },
        ]));
        expect(events.some(event => event.type === 'done')).toBe(false);
      } finally {
        for (const stage of ['first', 'second', 'end']) writeFileSync(`${gate}-${stage}`, 'go');
        await work;
      }
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      await vi.waitFor(() => expect(existsSync(`${gate}-written`)).toBe(true));
    }
  });

  const read = async () => {
    const response = await GET(new NextRequest('http://localhost/api/orchestrator/packet-transcript?sessionKey=claude-code:background-agents-fixture', {
      headers: { host: 'localhost' },
    }));
    expect(response.status).toBe(200);
    return (await response.json()).events as TranscriptEvent[];
  };
  const results = (events: TranscriptEvent[]) => events.filter(event => event.type === 'tool_result');

  it('replays each saved agent answer while the other agent still has no result', async () => {
    writeFileSync(log, lines.slice(0, 5).join('\n') + '\n');
    const launch = await read();
    expect(launch.filter(event => event.type === 'tool_call')).toHaveLength(2);
    expect(results(launch)).toEqual([]);
    // Old replay returned launch notices here, which #5405 kept working. Each
    // notification must carry its agent's answer before the turn settles.
    appendFileSync(log, lines[5] + '\n');
    expect(results(await read())).toMatchObject([
      { callId: 'date-agent', tool: 'Agent', summary: 'The date agent finished.', ok: true },
    ]);
    appendFileSync(log, lines[6] + '\n');
    expect(results(await read())).toMatchObject([
      { callId: 'date-agent', summary: 'The date agent finished.' },
      { callId: 'uname-agent', summary: 'The uname agent finished.' },
    ]);
    appendFileSync(log, lines.slice(7).join('\n') + '\n');
    expect(results(await read())).toHaveLength(2);
  });

  it('keeps legacy launch notices when saved history has no task lifecycle events', async () => {
    writeFileSync(log, [lines[1], lines[4], lines[8]].join('\n') + '\n');
    expect(results(await read())).toMatchObject([
      { callId: 'date-agent', summary: 'Async agent launched successfully. agentId: date-task' },
      { callId: 'uname-agent', summary: 'Async agent launched successfully. agentId: uname-task' },
    ]);
  });

  it.each(['failed', 'stopped'])('replays a %s notification with the shared parser outcome', async status => {
    const notification = { ...JSON.parse(lines[5]), status, summary: 'Agent ended.' };
    writeFileSync(log, [...lines.slice(0, 5), JSON.stringify(notification)].join('\n') + '\n');
    expect(results(await read())).toMatchObject([
      { callId: 'date-agent', tool: 'Agent', summary: 'Agent ended.', ok: status === 'stopped' },
    ]);
  });
});
