import { PHASE_PRODUCTION_BUILD } from 'next/constants';

function warnOptionalStartupFailure(stage: 'telemetry' | 'transcript-repair'): void {
  try {
    // Fixed stage labels only: exception contents can contain private data.
    console.warn('[startup] Optional initialization failed; continuing startup.', { stage });
  } catch {
    // A failed diagnostic must not turn optional initialization into a boot failure.
  }
}

/**
 * Next.js 16 instrumentation hook — runs once when the server starts.
 *
 * Only runs on the `nodejs` runtime (server). Edge runtime skips this — the
 * Q&A pipeline is server-only and never reaches Edge.
 */

export async function register(): Promise<void> {
  // Keep Node-only imports inside this branch: webpack still collects imports
  // after an early return when it builds this hook for the Edge runtime.
  if (process.env.NEXT_RUNTIME === 'nodejs') {

    // Windows resolves a bare command name against the CURRENT DIRECTORY before
    // PATH — for CreateProcess and for cmd.exe alike. o8 runs tools like `npx
    // tsc` with the cwd set to an agent's worktree, so a repo containing
    // `npx.cmd` at its root would be executed by us, with our privileges, during
    // provisioning and at the merge gate. Fork PRs are untrusted input by policy,
    // and this needs no agent cooperation at all to fire.
    //
    // Setting this once at server start covers every present and future spawn,
    // including sites that never route through cliInvocation — strictly better
    // coverage than hardening call sites one at a time. It only removes the
    // current directory from EXECUTABLE lookup; explicit paths still work.
    if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';

    // Local crash observers are needed before requests. All optional imports live
    // behind the existing protected startup action, outside the health graph.
    try {
      const { installProcessCrashCapture } = await import('@/lib/telemetry/crash-capture');
      installProcessCrashCapture('next-server');
    } catch {
      warnOptionalStartupFailure('telemetry');
    }
    if (process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD) {
      // Optional voice preparation must never hold up server registration.
      void import('@/lib/tts/ensure-edge-tts')
        .then(({ ensureEdgeTtsInstalled }) => ensureEdgeTtsInstalled())
        .catch(() => { console.warn('[startup] Optional voice preparation failed.'); });
      const { scheduleNextServerStartup } = await import('@/lib/startup/schedule');
      scheduleNextServerStartup();
    }
  }
}
