/** Prepare the separately installed Python CLI; never import its implementation. */
import { spawn } from '@/lib/providers/child-process';

const PYTHON = process.env.O8_TTS_PYTHON || 'python3';
const VERSION_QUERY = "import importlib.metadata as m; print(m.version('edge-tts'))";
type Status = 'unchecked' | 'ready' | 'update_required' | 'unavailable';
type Runner = (args: string[], timeout: number) => Promise<{ ok: boolean; detail: string }>;

const runPython: Runner = (args, timeout) => new Promise(resolve => {
  try {
    const proc = spawn(PYTHON, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout });
    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    proc.on('close', (code, signal) => resolve({ ok: code === 0, detail: code === 0 ? out.trim() : `exit=${code ?? `signal:${signal}`} ${out.trim()}` }));
    proc.on('error', err => resolve({ ok: false, detail: err.message }));
  } catch (err) {
    resolve({ ok: false, detail: String(err) });
  }
});

function compatible(version: string): boolean {
  // Metadata uses PEP 440. Conservatively upgrade prereleases/unknown versions.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:(?:\.post\d+)?(?:\+[-\w.]+)?)?$/.exec(version.trim());
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 7 || (major === 7 && (minor > 3 || (minor === 3 && patch >= 1)));
}

/** Inject the Python/pip runner for hermetic version and retry tests. */
export function createEdgeTtsEnsurer(run: Runner = runPython) {
  let attempted = false;
  let recheckedForbidden = false;
  let inFlight: Promise<void> | null = null;
  let status: Status = 'unchecked';

  async function prepare(): Promise<void> {
    try {
      const installed = await run(['-c', VERSION_QUERY], 10_000);
      if (installed.ok && compatible(installed.detail)) { status = 'ready'; return; }
      status = installed.ok ? 'update_required' : 'unavailable';
      console.log('[tts] Preparing edge-tts>=7.3.1 for the Steffan voice');
      const install = (extra: string[] = []) => run(['-m', 'pip', 'install', '--upgrade', '--quiet', ...extra, 'edge-tts>=7.3.1'], 300_000);
      let result = await install();
      const managed = !result.ok && /externally-managed-environment|break-system-packages/i.test(result.detail);
      if (managed) result = await install(['--break-system-packages']);
      if (!result.ok && /permission denied|not writeable|errno 13/i.test(result.detail)) {
        result = await install([...(managed ? ['--break-system-packages'] : []), '--user']);
      }
      if (result.ok) {
        const verified = await run(['-c', VERSION_QUERY], 10_000);
        status = verified.ok ? (compatible(verified.detail) ? 'ready' : 'update_required') : 'unavailable';
      }
      if (status === 'ready') console.log('[tts] Steffan Python voice ready');
      else console.warn('[tts] Voice preparation failed; system speech remains available.', result.detail.slice(0, 400));
    } catch (err) {
      status = 'unavailable';
      console.warn('[tts] Voice preparation failed (non-fatal):', err);
    }
  }

  return {
    status: () => status,
    ensure(reason?: 'forbidden'): Promise<void> {
      if (inFlight) return inFlight;
      if (reason === 'forbidden') {
        if (recheckedForbidden) return Promise.resolve();
        recheckedForbidden = true;
      } else if (attempted) return Promise.resolve();
      attempted = true;
      inFlight = prepare().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

// Instrumentation and route bundles must not start competing pip installs.
const runtime = globalThis as typeof globalThis & {
  __o8EdgeTtsEnsurer?: ReturnType<typeof createEdgeTtsEnsurer>;
};
const installedVoice = runtime.__o8EdgeTtsEnsurer ??= createEdgeTtsEnsurer();
/** Call without awaiting at startup, on demand, and after a handshake 403. */
export const ensureEdgeTtsInstalled = installedVoice.ensure;
export const getEdgeTtsStatus = installedVoice.status;
