import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { acquireReleaseLock } from './ship-preflight.mjs';
import { releaseBuildProfile } from './release-build-profile.mjs';

const WORKER_FLAG = '--broadcast-worker';
const DEFAULT_POST_TIMEOUT_MS = 5_000;

const DEFAULT_STAGE_MARKERS = [
  {
    text: '[sign-and-notarize] zipping for notarization',
    label: 'App signed',
    nextStage: 'notary submission',
  },
  {
    text: '[sign-and-notarize] submitting to Apple notary',
    label: 'Submitted to the notary',
    nextStage: 'notarization',
  },
  {
    text: '[sign-and-notarize] done. app and DMG are notarized',
    label: 'Stapled',
    nextStage: 'release publication',
  },
  {
    text: '[release] published ',
    label: 'Release published',
    nextStage: 'version publication',
  },
  {
    text: '[release-mirror] mirrored ',
    label: 'Version live',
    nextStage: 'release completion',
  },
];

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function runBestEffort(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {}
      finish();
    }, timeoutMs);
    timer.unref();

    try {
      child = spawn(command, args, { stdio: 'ignore' });
      child.once('error', finish);
      child.once('exit', finish);
    } catch {
      finish();
    }
  });
}

async function runWorker() {
  const command = process.env.O8_RELEASE_BROADCAST_CLI?.trim() || 'o8';
  const timeoutMs = parsePositiveInteger(
    process.env.O8_RELEASE_BROADCAST_TIMEOUT_MS,
    DEFAULT_POST_TIMEOUT_MS,
  );
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    try {
      const args = JSON.parse(line);
      if (Array.isArray(args) && args.every((arg) => typeof arg === 'string')) {
        await runBestEffort(command, args, timeoutMs);
      }
    } catch {}
  }
}

export function createShipBroadcast(version) {
  let child = null;
  let input = null;
  const scriptPath = fileURLToPath(import.meta.url);
  const workerEnv = { ...process.env };
  delete workerEnv.APPLE_PASSWORD;
  delete workerEnv.TAURI_SIGNING_PRIVATE_KEY;
  delete workerEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;

  try {
    child = spawn(process.execPath, [scriptPath, WORKER_FLAG], {
      detached: true,
      env: workerEnv,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.once('error', () => {});
    child.unref();
    input = child.stdin;
    input.on('error', () => {});
    input.unref?.();
  } catch {}

  const enqueue = (args) => {
    try {
      input?.write(`${JSON.stringify(args)}\n`);
    } catch {}
  };

  return {
    stage(label) {
      enqueue([
        'broadcast',
        'focus',
        `Shipping v${version}`,
        '--goal',
        label,
      ]);
    },
    failure(stage) {
      enqueue([
        'broadcast',
        'post',
        '--kind',
        'commentary',
        '--as',
        'release',
        `Ship v${version} failed during ${stage}.`,
      ]);
    },
    close() {
      enqueue(['broadcast', 'focus', '--clear']);
      try {
        input?.end();
      } catch {}
      input = null;
      child = null;
    },
  };
}

export function defaultShipPlan(root, env = process.env) {
  return {
    preflight: { command: process.execPath, args: [join(root, 'scripts/ship-preflight.mjs')] },
    prepare: [{ command: process.execPath, args: [join(root, 'scripts/detach-stale-dmg.mjs')] }],
    build: env.O8_RELEASE_APP_HANDOFF?.trim()
      ? { command: process.execPath, args: [join(root, 'scripts/import-release-app.mjs')] }
      : { command: 'npm', args: ['run', 'tauri:build:stable-macos'] },
    notarize: { command: 'npm', args: ['run', 'sign-and-notarize'] },
    publish: { command: process.execPath, args: [join(root, 'scripts/release.mjs')] },
    alwaysCleanup: [
      { command: process.execPath, args: [join(root, 'scripts/detach-stale-dmg.mjs')] },
    ],
    successOnlyCleanup: [
      {
        command: process.execPath,
        args: [join(root, 'scripts/postship-cleanup.mjs'), '--best-effort'],
      },
    ],
  };
}

function readShipPlan(root) {
  if (process.env.O8_RELEASE_TEST_MODE !== '1') return defaultShipPlan(root);
  const planPath = process.env.O8_RELEASE_TEST_PLAN?.trim();
  if (!planPath) throw new Error('O8_RELEASE_TEST_PLAN is required in release test mode.');
  return JSON.parse(readFileSync(planPath, 'utf8'));
}

function mirrorOutput(stream, destination, onLine) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    destination.write(chunk);
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => {
    if (buffered) onLine(buffered);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChildGroup(child, firstSignal = 'SIGTERM') {
  if (!child?.pid) return;
  const signal = (nextSignal) => {
    try {
      if (process.platform === 'win32') child.kill(nextSignal);
      else process.kill(-child.pid, nextSignal);
    } catch {}
  };
  signal(firstSignal);
  await sleep(750);
  signal('SIGTERM');
  await sleep(750);
  signal('SIGKILL');
}

function runCommand(spec, root, options = {}) {
  const {
    onLine = () => {},
    baseEnv = process.env,
    label = spec?.command ?? 'release command',
  } = options;
  return new Promise((resolve, reject) => {
    if (!spec) {
      resolve();
      return;
    }
    let child;
    let interruptedBy = null;
    let settled = false;
    const startedAt = Date.now();
    const heartbeatMs = parsePositiveInteger(
      process.env.O8_RELEASE_HEARTBEAT_MS,
      60_000,
    );
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[release] ${label} heartbeat (${elapsed}s)`);
    }, heartbeatMs);
    heartbeat.unref();
    const removeSignalHandlers = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      clearInterval(heartbeat);
    };
    const onInterrupt = (signal) => {
      if (interruptedBy) return;
      interruptedBy = signal;
      void stopChildGroup(child, signal);
    };
    const onSigint = () => onInterrupt('SIGINT');
    const onSigterm = () => onInterrupt('SIGTERM');
    try {
      child = spawn(spec.command, spec.args ?? [], {
        cwd: root,
        detached: process.platform !== 'win32',
        env: { ...baseEnv, ...(spec.env ?? {}) },
        stdio: ['inherit', 'pipe', 'pipe'],
      });
    } catch (error) {
      removeSignalHandlers();
      reject(error);
      return;
    }
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    console.log(`[release] ${label} started`);
    mirrorOutput(child.stdout, process.stdout, onLine);
    mirrorOutput(child.stderr, process.stderr, onLine);
    child.once('error', async (error) => {
      if (settled) return;
      settled = true;
      await stopChildGroup(child);
      removeSignalHandlers();
      reject(error);
    });
    child.once('exit', async (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0 || signal || interruptedBy) await stopChildGroup(child);
      removeSignalHandlers();
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (code === 0 && !signal && !interruptedBy) {
        console.log(`[release] ${label} completed in ${seconds}s`);
        resolve();
      } else {
        reject(new Error(
          `${spec.command} exited ${interruptedBy ? `after ${interruptedBy}` : signal ? `on ${signal}` : `with code ${code ?? 'unknown'}`} after ${seconds}s`,
        ));
      }
    });
  });
}

/** The operator's runtime directory, resolved before the build redirect. */
function operatorDataDir(env) {
  return env.O8_OPERATOR_DATA_DIR
    || env.O8_DATA_DIR
    || env.CORTEX_IDE_DATA_DIR
    || join(env.HOME || homedir(), '.o8');
}

/**
 * The environment every ship step runs under.
 *
 * O8_DATA_DIR is redirected at a retained build lifecycle directory so the release cannot
 * read or write the operator's live runtime state. O8_OPERATOR_DATA_DIR then
 * names where that state actually lives, because the publish step still has to
 * find one operator credential — the external intake read token. Before it
 * existed, publish resolved that token against the empty build directory and
 * reported it unconfigured on every ship.
 */
export function buildWorkflowEnv(buildDataDir, env = process.env) {
  return {
    ...env,
    O8_DATA_DIR: buildDataDir,
    CORTEX_IDE_DATA_DIR: buildDataDir,
    O8_OPERATOR_DATA_DIR: operatorDataDir(env),
  };
}

export async function runShipWorkflow({ root, version, publisher }) {
  const plan = readShipPlan(root);
  if (publisher) plan.publish = { command: process.execPath, args: [join(root, 'scripts', publisher)] };
  const lock = acquireReleaseLock();
  let buildDataDir;
  try {
    buildDataDir = releaseBuildProfile(root, process.env, { release: true }).profile;
  } catch (error) {
    lock.release();
    throw error;
  }
  const workflowEnv = buildWorkflowEnv(buildDataDir);
  const broadcast = createShipBroadcast(version);
  const emitted = new Set();
  let activeStage = 'pre-release cleanup';
  let mirrorFailed = false;
  let shipSucceeded = false;

  const emitMilestone = (marker) => {
    if (emitted.has(marker.label)) return;
    emitted.add(marker.label);
    broadcast.stage(marker.label);
    activeStage = marker.nextStage;
  };

  const consumeMilestone = (line) => {
    for (const marker of DEFAULT_STAGE_MARKERS) {
      if (line.includes(marker.text)) emitMilestone(marker);
    }
    if (line.includes('[release-mirror] failed to mirror')) {
      mirrorFailed = true;
      activeStage = 'version publication';
    }
  };

  try {
    activeStage = 'preflight';
    await runCommand(plan.preflight, root, {
      baseEnv: workflowEnv,
      label: 'preflight',
    });

    for (const command of plan.prepare ?? []) {
      await runCommand(command, root, {
        baseEnv: workflowEnv,
        label: 'pre-release cleanup',
      });
    }

    activeStage = 'build';
    broadcast.stage('Build started');
    emitted.add('Build started');
    await runCommand(plan.build, root, {
      onLine: consumeMilestone,
      baseEnv: workflowEnv,
      label: 'build',
    });

    activeStage = 'app signing';
    await runCommand(plan.notarize, root, {
      onLine: consumeMilestone,
      baseEnv: workflowEnv,
      label: 'sign and notarize',
    });
    for (const marker of DEFAULT_STAGE_MARKERS.slice(0, 3)) emitMilestone(marker);

    activeStage = 'release publication';
    await runCommand(plan.publish, root, {
      onLine: consumeMilestone,
      baseEnv: workflowEnv,
      label: 'publish',
    });
    emitMilestone(DEFAULT_STAGE_MARKERS[3]);
    if (mirrorFailed) {
      broadcast.failure('version publication');
    } else {
      emitMilestone(DEFAULT_STAGE_MARKERS[4]);
    }
    shipSucceeded = true;
  } catch (error) {
    broadcast.failure(activeStage);
    throw error;
  } finally {
    const cleanupCommands = [
      ...(plan.alwaysCleanup ?? []),
      ...(shipSucceeded ? plan.successOnlyCleanup ?? [] : []),
    ];
    for (const command of cleanupCommands) {
      try {
        await runCommand(command, root, {
          baseEnv: workflowEnv,
          label: 'post-ship cleanup',
        });
      } catch (error) {
        console.warn(`[release] post-ship cleanup skipped: ${error?.message ?? error}`);
      }
    }
    broadcast.close();
    // Generated output, holds and banks still reference this lifecycle profile.
    lock.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === WORKER_FLAG) {
  await runWorker();
}
