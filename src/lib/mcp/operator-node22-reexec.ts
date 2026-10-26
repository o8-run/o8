import { spawnSync } from 'node:child_process';
import { workerParentEnvironment } from '../providers/worker-environment';

import { buildNode22ReexecPlan, NODE22_REEXEC_GUARD } from './operator-node22-locator';
import {
  LAUNCH_AGENT_HEALTHY_UPTIME_MS,
  LAUNCH_AGENT_STARTED_AT_ENV,
  markLaunchAgentHealthy,
  recordLaunchAgentStart,
  resolveLaunchAgentLabel,
} from './launch-agent-crash-counter';

const NODE22_CHECKED = 'O8_MCP_NODE22_CHECKED';

// This is the earliest dependency-light seam in both source and bundled
// entrypoints. Launchd children have ppid 1; ordinary MCP client children are
// ignored, so only KeepAlive churn contributes to the counter. The marker is
// inherited by a Node 22 re-exec so the long-lived child can reset the sequence
// after proving it stayed alive.
const launchAgentLabel = resolveLaunchAgentLabel();
let launchAgentStartedAtMs = Number(process.env[LAUNCH_AGENT_STARTED_AT_ENV]);
if (process.ppid === 1) {
  launchAgentStartedAtMs = Date.now();
  recordLaunchAgentStart({ label: launchAgentLabel, nowMs: launchAgentStartedAtMs });
  process.env[LAUNCH_AGENT_STARTED_AT_ENV] = String(launchAgentStartedAtMs);
}
if (Number.isFinite(launchAgentStartedAtMs) && launchAgentStartedAtMs > 0) {
  setTimeout(() => {
    markLaunchAgentHealthy({
      label: launchAgentLabel,
      startedAtMs: launchAgentStartedAtMs,
    });
  }, LAUNCH_AGENT_HEALTHY_UPTIME_MS).unref();
}

/**
 * Synchronous on purpose — no top-level await. This module is imported by
 * operator-mcp-server.ts, which tsx compiles as CommonJS when run from the
 * repo (no `"type": "module"`), and CJS output rejects top-level await
 * outright: the original async version crash-looped every source-launched
 * MCP start (the com.rainwater.mcp-o8 LaunchAgent logged 102 failed starts
 * in one day, KeepAlive respawning a module-load crash). A re-exec shim has
 * to block module evaluation until the child exits anyway, so spawnSync is
 * the honest shape; the bundled ESM path is indifferent.
 */
function reexecOnNode22IfNeeded(): void {
  if (process.env[NODE22_CHECKED] === '1') {
    return;
  }
  process.env[NODE22_CHECKED] = '1';

  const plan = buildNode22ReexecPlan();
  if (plan.action === 'proceed') {
    return;
  }
  if (plan.action === 'warn') {
    console.error(`[o8 operator MCP] ${plan.message}`);
    return;
  }

  const result = spawnSync(plan.nodePath, plan.argv, {
    windowsHide: true,
    env: {
      ...workerParentEnvironment(process.env),
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      // Explicit local transport/bootstrap inputs survive the interpreter hop;
      // unrelated parent exports and the provider-store master key do not.
      ...Object.fromEntries([
        'O8_API_BASE', 'O8_API_TOKEN', 'O8_WS_TOKEN', 'O8_WORKER_TOKEN',
        'O8_MCP_TRANSPORT', 'O8_MCP_PORT', 'O8_MCP_NO_ORPHAN_KILL', 'O8_MCP_WORKER_ONLY', 'O8_MCP_TOOL_LOADING',
        'O8_BUNDLED_MCP_PATH', 'O8_BUNDLED_MCP_DIR', 'O8_NODE_BIN', LAUNCH_AGENT_STARTED_AT_ENV,
      ].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
      [NODE22_REEXEC_GUARD]: '1', [NODE22_CHECKED]: '1',
    },
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[o8 operator MCP] failed to re-exec on Node 22 at ${plan.nodePath}: ${result.error.message}; continuing on Node ${process.versions.node}`);
    return;
  }
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

reexecOnNode22IfNeeded();
