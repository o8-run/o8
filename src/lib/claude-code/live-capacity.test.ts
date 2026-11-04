import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClaudeUsageCapacity, readClaudeAccountCapacity, readLiveClaudeRuntimeCapacity, resetClaudeCapacityForTests } from './live-capacity';
import { claudeCodeRuntime } from '@/lib/runtimes/claude-code';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-capacity-'));
const fixture = path.resolve('tests/fixtures/claude-capacity-control.mjs');
chmodSync(fixture, 0o755);
// Worker children inherit only allowlisted names; the fixture reads these test knobs.
beforeEach(() => { vi.stubEnv('O8_WORKER_ENV_ALLOW', 'O8_CLAUDE_CAPACITY_TEST_AUDIT,O8_CLAUDE_CAPACITY_TEST_MODE'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetClaudeCapacityForTests(); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('Claude account usage', () => {
  it('reads actual correlated control responses without prompts, hooks, tools, or saved sessions', async () => {
    const audit = path.join(root, 'audit.jsonl');
    vi.stubEnv('O8_CLAUDE_CAPACITY_TEST_AUDIT', audit);
    const result = await readLiveClaudeRuntimeCapacity({ binaryPath: fixture, cwd: root, timeoutMs: 2_000 });
    expect(result).toMatchObject({ runtime: 'claude-code', confidence: 'exact', status: 'available', source: 'structured-cli' });
    expect(result.buckets.map(bucket => bucket.usedRatio)).toEqual([0.15, 0.59, 0.22]);
    expect(JSON.stringify(result)).not.toMatch(/private-plan|private@example/);
    const rows = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0].args).toContain('--no-session-persistence');
    expect(rows[0].args).toContain('{"disableAllHooks":true}');
    expect(rows[0].args).toContain('--strict-mcp-config');
    expect(rows[0].cwd).toBe(realpathSync(root));
    expect(rows.slice(1).map(row => row.request.subtype)).toEqual(['initialize', 'get_usage']);
    expect(rows[2].request.skip_behaviors).toBe(true);
    expect(rows.every(row => row.type !== 'user')).toBe(true);
  });

  it('observes a worker through its pinned config directory and identity', async () => {
    const { claudeCodeOwnedAdapter } = await import('./owned');
    const audit = path.join(root, 'pinned-worker-audit.jsonl');
    const configHomeRef = path.join(root, 'pinned-config');
    vi.stubEnv('O8_CLAUDE_CODE_BIN', fixture);
    vi.stubEnv('O8_CLAUDE_CAPACITY_TEST_AUDIT', audit);
    const session = { identity: { id: 'pinned-worker', label: 'Fixture identity', configHomeRef } } as import('@/lib/runtimes/shared/owned-session/types').OwnedSessionRecord;
    const observed = await claudeCodeOwnedAdapter.observeCapacity!(session);
    expect(observed).toMatchObject({ identityId: 'pinned-worker', runtime: 'claude-code', confidence: 'exact' });
    const first = JSON.parse(readFileSync(audit, 'utf8').split('\n')[0]);
    expect(first.configDir).toBe(configHomeRef);
  });

  it('bounds a stalled CLI and rejects malformed quota percentages', async () => {
    vi.stubEnv('O8_CLAUDE_CAPACITY_TEST_MODE', 'timeout');
    await expect(readLiveClaudeRuntimeCapacity({ binaryPath: fixture, cwd: root, timeoutMs: 100 })).rejects.toThrow('unavailable');
    vi.stubEnv('O8_CLAUDE_CAPACITY_TEST_MODE', 'malformed');
    await expect(readLiveClaudeRuntimeCapacity({ binaryPath: fixture, cwd: root, timeoutMs: 2_000 })).rejects.toThrow('unavailable');
  });

  it('keeps missing quota unknown and distinguishes unsupported subscription logins', () => {
    expect(parseClaudeUsageCapacity({ rate_limits_available: true, rate_limits: null })).toMatchObject({ status: 'unavailable', reason: 'quota_not_reported', buckets: [] });
    expect(parseClaudeUsageCapacity({ rate_limits_available: false })).toMatchObject({ status: 'unavailable', reason: 'subscription_limits_unsupported', buckets: [] });
    expect(parseClaudeUsageCapacity({ rate_limits_available: true, rate_limits: { five_hour: { utilization: null }, seven_day: { utilization: 0, resets_at: 'invalid' } } }).buckets).toMatchObject([{ usedRatio: 0, resetsAt: null }]);
    expect(() => parseClaudeUsageCapacity({ rate_limits_available: true, rate_limits: { five_hour: { utilization: -1 } } })).toThrow();
  });

  it('reaches the real runtime adapter, coalesces reads, and retains stale limits after a refresh failure', async () => {
    vi.stubEnv('O8_CLAUDE_CODE_BIN', fixture);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-08T20:00:00Z'));
    const [first, same] = await Promise.all([claudeCodeRuntime.getCapacity!(), readClaudeAccountCapacity()]);
    expect(first).toBe(same);
    expect(first.confidence).toBe('exact');
    vi.stubEnv('O8_CLAUDE_CAPACITY_TEST_MODE', 'malformed');
    expect(await readClaudeAccountCapacity()).toBe(first);
    clock.mockReturnValue(Date.parse('2026-10-08T20:02:00Z'));
    expect(await readClaudeAccountCapacity()).toMatchObject({ status: 'stale', observedAt: first.observedAt, buckets: first.buckets });
    vi.stubEnv('O8_CLAUDE_CAPACITY_TEST_MODE', 'unsupported');
    clock.mockReturnValue(Date.parse('2026-10-08T20:04:00Z'));
    expect(await readClaudeAccountCapacity()).toMatchObject({ status: 'unavailable', reason: 'subscription_limits_unsupported', buckets: [] });
  });
});
