import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { ResolvedWorkerMcpServer } from '@/lib/mcp/worker-injection';
import { EMBEDDED_CHILD_POLICY_SCRIPT } from './embedded-child-policy';
import { MCP_EXECUTABLE_CHECK_SCRIPT, captureMcpExecutable, verifyMcpExecutable } from './mcp-executable';
import { configuredRuntimeId, stampChildPolicy } from './spawn-environment';
import { PROVIDER_ENV_KEYS, PROVIDER_KEY_ALIASES, GENERIC_ALIASES, SCOPED_ALIASES } from './credential-names';
import { captureMcpConfigReceipts } from './mcp-config-policy';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** External workers spawn these children after the app's own spawn boundary.
 * Retain configured CLI branding, but give only this private helper authority to
 * execute the captured file. Nothing in caller-controlled env selects a payer.
 */
export function guardWorkerMcpLaunch(server: ResolvedWorkerMcpServer, sessionDir: string, cwd: string, pathValue: string): ResolvedWorkerMcpServer {
  const binding = server.executable ?? captureMcpExecutable(server.command, cwd, pathValue);
  verifyMcpExecutable(binding);
  const env = server.env ?? {};
  if (configuredRuntimeId(server.command) === 'codex') {
    // The delayed child must select the same config we check, rather than
    // acquiring the consuming worker's HOME/CODEX_HOME after preparation.
    env.HOME = env.HOME || env.USERPROFILE || process.env.HOME || homedir();
    env.CODEX_HOME = path.resolve(cwd, env.CODEX_HOME || process.env.CODEX_HOME || path.join(env.HOME, '.codex'));
  }
  stampChildPolicy(env);
  const configReceipts = captureMcpConfigReceipts([server.command, ...server.args], env, cwd);
  const directory = mkdtempSync(path.join(sessionDir, 'o8-mcp-launch-'));
  const helper = path.join(directory, 'launch.cjs');
  const basename = path.basename(server.command).replace(/\.(?:exe|com|cmd|bat)$/i, '');
  const command = path.join(directory, basename + (process.platform === 'win32' ? '.cmd' : ''));
  const providerNames = [...PROVIDER_ENV_KEYS, ...Object.values(PROVIDER_KEY_ALIASES).flat(), ...GENERIC_ALIASES, ...Object.keys(SCOPED_ALIASES)];
  const approved = Object.fromEntries(Object.entries(env).map(([name, value]) => [name, digest(value)]));
  writeFileSync(helper, `
${EMBEDDED_CHILD_POLICY_SCRIPT}
${MCP_EXECUTABLE_CHECK_SCRIPT}
try {
  const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const args = process.argv.slice(2);
  if (digest(JSON.stringify(args)) !== ${JSON.stringify(digest(JSON.stringify(server.args)))}) throw new Error('MCP arguments changed.');
  const env = o8AmbientEnvironment();
  // Explicitly unset every inherited provider slot, even when the consuming
  // CLI discards empty env values from the serialized MCP configuration.
  for (const name of ${JSON.stringify(providerNames)}) env[name] = '';
  for (const [name, hash] of Object.entries(${JSON.stringify(approved)})) {
    const value = hash === ${JSON.stringify(digest(''))} ? '' : process.env[name] || '';
    if (digest(value) !== hash) throw new Error('MCP environment changed.');
    env[name] = value;
  }
  ${env.O8_CHILD_CREDENTIAL_POLICY ? `process.env.O8_CHILD_CREDENTIAL_POLICY = ${JSON.stringify(env.O8_CHILD_CREDENTIAL_POLICY)};` : 'delete process.env.O8_CHILD_CREDENTIAL_POLICY;'}
  withO8ChildPolicy(env => {
    const fs = require('node:fs');
    for (const [file, hash] of ${JSON.stringify(configReceipts)}) {
      if (hash === null ? fs.existsSync(file) : !fs.existsSync(file) || fs.statSync(file).size > 4 * 1024 * 1024 || digest(fs.readFileSync(file, 'utf8')) !== hash) throw new Error('MCP configuration changed.');
    }
    const binding = ${JSON.stringify(binding)};
    const target = binding.target;
    const windowsScript = process.platform === 'win32' && !/\\.(exe|com)$/i.test(target);
    const command = windowsScript ? (process.env.ComSpec || 'cmd.exe') : target;
    const argv = windowsScript ? ['/d', '/c', target, ...args] : args;
    verifyMcpExecutable(binding);
    const child = require('node:child_process').spawn(command, argv, { env, cwd: ${JSON.stringify(cwd)}, stdio: 'inherit' });
    child.on('error', () => process.exit(1));
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
  }, { env });
} catch { process.stderr.write('MCP launch refused. Rebuild the configuration and retry.\\n'); process.exit(1); }
`, { mode: 0o600, flag: 'wx' });
  writeFileSync(command, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} "$@"\n`, { mode: 0o700, flag: 'wx' });
  return { ...server, command, env, executable: binding };
}
