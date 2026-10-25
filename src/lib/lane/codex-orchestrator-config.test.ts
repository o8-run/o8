import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { parse } from 'smol-toml';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrchestratorEvent } from './orchestrator-stream-events';

const root = mkdtempSync(join(tmpdir(), 'o8-codex-orchestrator-config-'));
const userHome = join(root, 'user');
const userCodexHome = join(userHome, '.codex');
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const originalHome = process.env.HOME;
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalCodexBin = process.env.O8_CODEX_BIN;
const originalCrashSurvival = process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR;
const originalArgsPath = process.env.O8_TEST_CODEX_ARGS_PATH;

mkdirSync(userCodexHome, { recursive: true });
mkdirSync(repoPath, { recursive: true });
process.env.HOME = userHome;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = '0';

const { mergeCodexMcpConfig, prepareCodexHome } = await import('./codex-orchestrator-config');
const { ensureCodexOrchestratorSession, sendToCodexOrchestrator } = await import('./codex-orchestrator-session');

beforeEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  writeFileSync(join(userCodexHome, 'config.toml'), [
    'model = "gpt-5.5"',
    '',
    '[features]',
    'web_search = true',
    '',
  ].join('\n'));
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
  if (originalCodexBin === undefined) delete process.env.O8_CODEX_BIN;
  else process.env.O8_CODEX_BIN = originalCodexBin;
  if (originalCrashSurvival === undefined) delete process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR;
  else process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = originalCrashSurvival;
  if (originalArgsPath === undefined) delete process.env.O8_TEST_CODEX_ARGS_PATH;
  else process.env.O8_TEST_CODEX_ARGS_PATH = originalArgsPath;
  rmSync(root, { recursive: true, force: true });
});

function writeModelsCache(slugs: string[]): void {
  writeFileSync(join(userCodexHome, 'models_cache.json'), JSON.stringify({
    models: slugs.map((slug) => ({ slug })),
  }));
}

function readGeneratedConfig(codexHome: string): {
  raw: string;
  parsed: Record<string, unknown>;
} {
  const raw = readFileSync(join(codexHome, 'config.toml'), 'utf8');
  return { raw, parsed: parse(raw) as Record<string, unknown> };
}

async function readCortexTeamFromGeneratedServer(
  server: { command: string; args: string[]; env: Record<string, string> },
  cwd: string,
): Promise<{ tools: string[]; team: { id: string } | null }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...server.env, NODE_OPTIONS: '--conditions=react-server' };
    delete env.CORTEX_IDE_DATA_DIR;
    const child = spawn(server.command, server.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let tools: string[] = [];
    let settled = false;
    const finish = (error?: Error, team?: { id: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve({ tools, team: team ?? null });
    };
    const timeout = setTimeout(() => finish(new Error(`Generated MCP server timed out: ${stderr.slice(0, 500)}`)), 20_000);
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`Generated MCP server exited ${code}: ${stderr.slice(0, 500)}`));
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line) as {
          id?: number;
          result?: { tools?: Array<{ name: string }>; content?: Array<{ text?: string }> };
        };
        if (message.id === 2) tools = message.result?.tools?.map((tool) => tool.name) ?? [];
        if (message.id === 3) {
          const status = JSON.parse(message.result?.content?.[0]?.text ?? '{}') as { team?: { id: string } | null };
          finish(undefined, status.team);
        }
      } catch { /* Ignore non-protocol logging. */ }
    });
    for (const request of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cortex_shared_team_status', arguments: {} } },
    ]) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

describe('Codex orchestrator home model config', () => {
  it('replaces inherited MCP tables while preserving provider, project, feature, and custom endpoint settings', () => {
    const inherited = [
      'model_provider = "fixture-provider"',
      'custom_base_url = "http://127.0.0.1:43123/v1"',
      '',
      '[features]',
      'web_search = true',
      '',
      '[model_providers.fixture-provider]',
      'name = "Fixture provider"',
      'base_url = "http://127.0.0.1:43123/v1"',
      '',
      '[projects."/tmp/review-fixture"]',
      'trust_level = "trusted"',
      '',
      '[mcp_servers.unrelated]',
      'command = "unrelated-server"',
      '',
      '[mcp_servers."quoted.server"]',
      'command = "quoted-server"',
      '',
      '[mcp_servers."bracket]server".env] # a bracket inside a quoted key is valid TOML',
      'FIXTURE = "value"',
      '',
      '[mcp_servers_backup]',
      'preserved = true',
    ].join('\n');

    const merged = mergeCodexMcpConfig(inherited, {
      'app-external': {
        type: 'stdio',
        command: 'app-external-server',
        args: ['--stdio'],
      },
    });
    const parsed = parse(merged) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      model_provider: 'fixture-provider',
      custom_base_url: 'http://127.0.0.1:43123/v1',
      features: { web_search: true },
      model_providers: {
        'fixture-provider': {
          name: 'Fixture provider',
          base_url: 'http://127.0.0.1:43123/v1',
        },
      },
      projects: { '/tmp/review-fixture': { trust_level: 'trusted' } },
      mcp_servers_backup: { preserved: true },
    });
    expect(parsed.mcp_servers).toEqual({
      'app-external': {
        command: 'app-external-server',
        args: ['--stdio'],
      },
    });
    expect(merged).not.toContain('unrelated-server');
    expect(merged).not.toContain('quoted-server');
    expect(merged).not.toContain('bracket]server');
  });

  it.each([
    [
      'an escaped quoted root key',
      '["mcp\\u005fservers"."escaped.server"]\ncommand = "escaped-server"',
      'escaped',
    ],
    [
      'a dotted-key definition',
      'mcp_servers.dotted.command = "dotted-server"',
      'dotted',
    ],
    [
      'an inline-table definition',
      'mcp_servers = { inline = { command = "inline-server" } }',
      'inline',
    ],
  ])('removes inherited MCP configuration expressed as %s through the generated home', (_label, inheritedMcp, threadSuffix) => {
    const topLevelMcp = inheritedMcp.startsWith('mcp_servers');
    writeFileSync(join(userCodexHome, 'config.toml'), [
      ...(topLevelMcp ? [inheritedMcp, ''] : []),
      'model_provider = "fixture-provider"',
      '',
      '[model_providers.fixture-provider]',
      'base_url = "http://127.0.0.1:43123/v1"',
      'instructions = """',
      '[mcp_servers.header-looking-text]',
      '[plugins.header-looking-text]',
      'remains part of the string',
      '"""',
      ...(!topLevelMcp ? ['', inheritedMcp] : []),
    ].join('\n'));

    const prepared = prepareCodexHome(repoPath, 'full', 'gpt-5.6-sol', `thoughts-mcp-${threadSuffix}`);
    const parsed = readGeneratedConfig(prepared.codexHome).parsed as {
      model_providers: { 'fixture-provider': { instructions: string } };
      mcp_servers: Record<string, unknown>;
    };

    expect(parsed.model_providers['fixture-provider'].instructions)
      .toContain('[mcp_servers.header-looking-text]');
    expect(parsed.model_providers['fixture-provider'].instructions)
      .toContain('[plugins.header-looking-text]');
    expect(parsed.mcp_servers).not.toHaveProperty('escaped.server');
    expect(parsed.mcp_servers).not.toHaveProperty('dotted');
    expect(parsed.mcp_servers).not.toHaveProperty('inline');
    expect(parsed.mcp_servers).toEqual(expect.objectContaining({
      operator: expect.any(Object),
      cortex: expect.any(Object),
    }));
  });

  it('fails closed with the parser diagnostic when inherited TOML is invalid', () => {
    expect(() => mergeCodexMcpConfig('[features]\ninvalid = [', {}))
      .toThrow(/Unable to isolate inherited MCP configuration:[\s\S]*unfinished array/i);
  });

  it('binds each o8 chat to a separate MCP config for Fast worker placement', () => {
    const first = prepareCodexHome(repoPath, 'full', 'gpt-6-astra', 'thoughts-team-a');
    const second = prepareCodexHome(repoPath, 'full', 'gpt-6-astra', 'thoughts-team-b');
    expect(first.codexHome).not.toBe(second.codexHome);
    expect(readGeneratedConfig(first.codexHome).raw).toContain('CORTEX_THREAD_ID = "thoughts-team-a"');
    expect(readGeneratedConfig(second.codexHome).raw).toContain('CORTEX_THREAD_ID = "thoughts-team-b"');
    // Codex isolates subprocess environments. Both MCP servers must read the
    // same app data dir as Next so Fast team receipts and auth stay reachable.
    expect(readGeneratedConfig(first.codexHome).raw.split(`O8_DATA_DIR = "${dataDir}"`)).toHaveLength(3);
  });

  it('starts the emitted Fast MCP server from another checkout and reads the persisted team', async () => {
    const foreignRepo = join(root, 'foreign-repo');
    mkdirSync(foreignRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: foreignRepo });
    writeFileSync(join(foreignRepo, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: foreignRepo });
    execFileSync('git', ['-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'fixture'], { cwd: foreignRepo });
    const { ensureSharedCheckoutTeam } = await import('@/lib/orchestrator/shared-checkout-team');
    const team = await ensureSharedCheckoutTeam({ repoPath: foreignRepo, parentThreadId: 'thoughts-emitted-mcp', dataDir });
    const prepared = prepareCodexHome(foreignRepo, 'full', 'gpt-6-sol', 'thoughts-emitted-mcp');
    const config = readGeneratedConfig(prepared.codexHome);
    const servers = config.parsed.mcp_servers as Record<string, {
      command: string; args: string[]; env: Record<string, string>;
    }>;

    expect(servers.cortex.env.O8_DATA_DIR).toBe(dataDir);
    const result = await readCortexTeamFromGeneratedServer(servers.cortex, foreignRepo);
    expect(result.tools).toContain('cortex_launch_agent');
    expect(result.team?.id).toBe(team.id);
  }, 45_000);

  it('writes the Astra default through the generated orchestrator config path', () => {
    writeModelsCache(['gpt-6-astra', 'gpt-5.6-sol']);

    const prepared = prepareCodexHome(repoPath);
    const config = readGeneratedConfig(prepared.codexHome);

    expect(prepared).toMatchObject({ model: 'gpt-6-astra', note: null });
    expect(config.parsed.model).toBe('gpt-6-astra');
    expect(config.raw).toContain('[features]');
    expect(config.raw).toContain('[mcp_servers.');
  });

  it('falls back to Sol with a visible note when the persisted models cache lacks Astra', () => {
    writeModelsCache(['gpt-5.6-sol', 'gpt-5.6-terra']);

    const prepared = prepareCodexHome(repoPath);
    const config = readGeneratedConfig(prepared.codexHome);

    expect(prepared.model).toBe('gpt-5.6-sol');
    expect(prepared.note).toContain('Host models cache does not list gpt-6-astra');
    expect(config.parsed.model).toBe('gpt-5.6-sol');
    expect(config.raw).toContain(`# o8: ${prepared.note}`);
    expect(config.raw).not.toContain('model = "gpt-5.5"');
  });

  it('launches the real session path on Sol and streams the cache fallback note', async () => {
    writeModelsCache(['gpt-5.6-sol', 'gpt-5.6-terra']);
    const argsPath = join(root, 'codex-args.txt');
    const codexBin = join(root, 'codex-fixture');
    writeFileSync(codexBin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo "codex-cli 0.150.0"',
      '  exit 0',
      'fi',
      `printf "%s\\n" "$@" > '${argsPath.replaceAll("'", "'\"'\"'")}'`,
    ].join('\n'), { mode: 0o700 });
    chmodSync(codexBin, 0o700);
    process.env.O8_CODEX_BIN = codexBin;
    process.env.O8_TEST_CODEX_ARGS_PATH = argsPath;
    const events: OrchestratorEvent[] = [];
    const session = ensureCodexOrchestratorSession(process.cwd(), 'thoughts-astra-fallback');

    await sendToCodexOrchestrator(session, 'Exercise the cached fallback.', (event) => {
      events.push(event);
    }, { model: 'gpt-6-astra' });

    expect(events).toContainEqual({
      type: 'thinking',
      text: expect.stringContaining('Host models cache does not list gpt-6-astra'),
    });
    const args = readFileSync(argsPath, 'utf8').split('\n');
    expect(args).toContain('model=gpt-5.6-sol');
    expect(args).not.toContain('model=gpt-6-astra');
  });
});
