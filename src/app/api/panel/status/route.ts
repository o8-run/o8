import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  currentShippedDarkAuditStatus,
} from '@/lib/operator/shipped-dark-receipt';
import { persistentTerminalsEnabled } from '@/lib/terminal/tmux';
import { currentPersistentTerminalHealth } from '@/lib/terminal/persistence-health';

// #926 / F40 follow-up: the CLI and other agents need a stable way to read
// the running server's version. sync-version.mjs keeps package.json#version
// in lockstep with Cargo.toml + tauri.conf.json, so reading it once at module
// load is authoritative. Cached so the liveness probe stays fast.
let cachedVersion: string | null = null;
function readServerVersion(): string | null {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : '';
  } catch {
    cachedVersion = '';
  }
  return cachedVersion || null;
}

function readBuildGitSha(): string | null {
  const value = process.env.O8_BUILD_GIT_SHA?.trim() ?? '';
  return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function readBuildMode(): 'packaged' | 'production' | 'development' {
  if (process.env.O8_PACKAGED_APP === '1') return 'packaged';
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

/**
 * The build fingerprint (version, commit, platform, Node version) answers only
 * a request from this machine or one carrying the operator bearer. Anyone else
 * on the network learns only that an o8 server is here.
 */
export async function GET(req: NextRequest) {
  if (requirePanelAuth(req)) {
    return NextResponse.json({ product: 'o8' });
  }
  return NextResponse.json({
    product: 'o8',
    connected: false,
    gatewayUrl: null,
    version: readServerVersion(),
    buildGitSha: readBuildGitSha(),
    buildMode: readBuildMode(),
    platform: process.platform,
    nodeVersion: process.version,
    mode: 'local-cli',
    runtime: 'codex+claude-code',
    terminalPersistence: currentPersistentTerminalHealth(persistentTerminalsEnabled()),
    shippedDarkAudit: currentShippedDarkAuditStatus(),
  });
}
