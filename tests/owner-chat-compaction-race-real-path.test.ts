import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

it('commits one compact boundary when independent route processes summarize the same snapshot', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-owner-compact-race-')));
  const repoPath = join(root, 'repo');
  const binary = join(root, 'summary.mjs');
  const gate = join(root, 'release');
  const started = join(root, 'started');
  const threadId = 'thoughts-owner-race';
  mkdirSync(repoPath);
  mkdirSync(started);
  mkdirSync(join(root, 'chat-history'));
  writeFileSync(join(root, 'repos.json'), JSON.stringify([{ id: 'fixture', name: 'Fixture', path: repoPath }]));
  writeFileSync(join(root, 'operator-defaults.json'), JSON.stringify({ inAppOrchestratorEnabled: true,
    judgmentProvider: 'off', autoTitleInferenceEnabled: false, productTelemetryEnabled: false }));
  const historyPath = join(root, 'chat-history', `${threadId}.json`);
  const messages = Array.from({ length: 10 }, (_, index) => ({ id: `message-${index}`,
    role: index % 2 ? 'assistant' : 'user', content: `Fixture ${index}`, timestamp: index + 1 }));
  writeFileSync(historyPath, JSON.stringify({ repoPath, messages }));
  writeFileSync(binary, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
writeFileSync(${JSON.stringify(started)} + '/' + process.pid, 'ready');
while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 20));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Decisions made: preserve order.'}}));
`);
  chmodSync(binary, 0o700);
  const children = [0, 1].map(index => {
    const child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
      resolve('tests/fixtures/owner-chat-compact-route.ts'), repoPath, threadId, join(root, `result-${index}.json`)], {
      cwd: process.cwd(), env: { ...process.env, O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root,
        CORTEX_IDE_DB_PATH: join(root, 'fixture.db'), O8_CODEX_BIN: binary, O8_IN_APP_ORCHESTRATOR_ENABLED: '1',
        CORTEX_REALTIME_INTERNAL_ORIGIN: 'http://127.0.0.1:1' }, stdio: 'pipe',
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    return { child, exit: once(child, 'exit'), stderr: () => stderr };
  });
  try {
    const { readdirSync } = await import('node:fs');
    await vi.waitFor(() => {
      for (const { child, stderr } of children) if (child.exitCode !== null) throw new Error(stderr());
      expect(readdirSync(started)).toHaveLength(2);
    }, { timeout: 20_000 });
    writeFileSync(gate, 'release');
    for (const { exit, stderr } of children) expect((await exit)[0], stderr()).toBe(0);
    const results = [0, 1].map(index => JSON.parse(readFileSync(join(root, `result-${index}.json`), 'utf8')));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    const stored = JSON.parse(readFileSync(historyPath, 'utf8'));
    expect(stored.messages.filter((message: { type?: string }) => message.type === 'compaction')).toHaveLength(1);
    expect(results.filter(result => result.applied)).toHaveLength(1);
    expect(results.map(result => result.transcript[0].id)[0]).toBe(results[1].transcript[0].id);
    expect(stored.messages.slice(0, messages.length)).toEqual(messages);
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(({ exit }) => exit));
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
