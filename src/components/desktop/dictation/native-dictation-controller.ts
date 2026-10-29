import { sameVoiceBinding, type VoiceBinding, type VoiceHostPayload } from '@/lib/next/voice-host';
import type { SttEventPayload } from './useNativeDictation';

export type DictationCommand = VoiceHostPayload & VoiceBinding & { hostId: string; requestId: string };
export type DictationFrame = { kind: 'dictation-text' | 'dictation-state'; payload: Record<string, unknown> };
type Run = { command: DictationCommand; sessionId?: number; cancelled: boolean; stopRequested: boolean;
  submit: boolean; stopped: boolean; terminal: boolean; error?: string; stop?: Promise<void>; buffered: SttEventPayload[]; partial?: string; timer?: ReturnType<typeof setTimeout> };
interface NativeDictationDriver {
  ready: Promise<unknown>;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  emit: (frame: DictationFrame) => void;
}

/** The in-window native STT contract, with a binding in place of a DOM target. */
export class NativeDictationController {
  private run: Run | null = null;
  private disposed = false;
  private lastState: DictationFrame | null = null;
  constructor(private driver: NativeDictationDriver) {}
  private state(run: Run, state: 'listening' | 'idle' | 'error', error?: string) {
    const { binding, nonce, threadId, repoPath, hostId, requestId } = run.command;
    this.lastState = { kind: 'dictation-state', payload: { binding, nonce, threadId, repoPath, hostId, requestId, state, ...(error ? { error } : {}) } };
    if (!this.disposed) this.driver.emit(this.lastState);
  }
  private text(run: Run, text: string, final: boolean) {
    const { binding, nonce, threadId, repoPath, hostId, requestId } = run.command;
    this.driver.emit({ kind: 'dictation-text', payload: { binding, nonce, threadId, repoPath, hostId, requestId, text, final } });
  }
  private finish(run: Run) {
    if (this.run !== run) return;
    clearTimeout(run.timer);
    this.run = null;
    this.state(run, run.error ? 'error' : 'idle', run.error);
  }
  command(command: DictationCommand) {
    if (this.disposed) return;
    if (command.action === 'dictation-start') {
      if (this.run) return;
      const run: Run = { command, cancelled: false, stopRequested: false, submit: false, stopped: false, terminal: false, buffered: [] };
      this.lastState = null;
      this.run = run;
      void this.start(run);
    } else if (command.action === 'dictation-stop' && this.run && sameVoiceBinding(this.run.command, command)) {
      const run = this.run;
      run.stopRequested = true; run.submit = command.submit === true;
      if (!run.submit) run.cancelled = true;
      if (run.stopped && run.cancelled) this.finish(run);
      else if (run.sessionId !== undefined) void this.stop(run);
    }
  }
  private async start(run: Run) {
    try {
      await this.driver.ready;
      if (run.cancelled || this.disposed) { this.finish(run); return; }
      const sessionId = await this.driver.invoke<number>('o8_stt_start', { exclusive: true });
      run.sessionId = sessionId;
      if (run.cancelled || this.disposed || run.stopRequested) await this.stop(run);
      else this.state(run, 'listening');
      for (const event of run.buffered.splice(0)) this.event(event);
    } catch (error) {
      run.error ??= run.cancelled ? undefined : error instanceof Error ? error.message : String(error);
      this.finish(run);
    }
  }
  private stop(run: Run): Promise<void> {
    if (run.stop) return run.stop;
    // Exact-session cleanup cannot stop Fn or a newer native capture.
    run.stop = this.driver.invoke<void>('o8_stt_stop', { sessionId: run.sessionId }).then(() => {
      run.stopped = true;
      if (run.cancelled || run.terminal) this.finish(run);
      else run.timer = setTimeout(() => this.abort('No final dictation result was received. Inspect the composer before retrying.'), 120_000);
    }).catch(error => {
      run.error = error instanceof Error ? error.message : String(error);
      this.finish(run);
    });
    return run.stop;
  }
  event(event: SttEventPayload) {
    const run = this.run;
    if (!run || run.cancelled || this.disposed || event.origin !== 'in-window' || event.lane === 'agent'
      || typeof event.sessionId !== 'number') return;
    if (run.sessionId === undefined) {
      if (run.buffered.length === 32) run.buffered.shift();
      run.buffered.push(event); return;
    }
    if (event.sessionId !== run.sessionId || run.terminal) return;
    if (event.type === 'partial' && typeof event.text === 'string' && run.partial !== event.text) {
      run.partial = event.text; this.text(run, event.text, false);
    } else if (event.type === 'polished' && run.stopRequested && run.submit) {
      const text = (event.text ?? event.rawText ?? event.appleText ?? '').trim();
      run.terminal = true;
      if (text) this.text(run, text, true);
      else run.error = 'No speech detected.';
      if (run.stopped) this.finish(run);
    } else if (event.type === 'error') {
      this.abort(event.text ?? 'Dictation failed.');
    }
  }
  abort(error?: string, target?: Partial<DictationCommand>) {
    const run = this.run;
    if (!run || target && (!sameVoiceBinding(run.command, target) || target.requestId !== undefined && target.requestId !== run.command.requestId)) return;
    run.cancelled = true; run.error = error; run.stopRequested = true; run.submit = false;
    if (run.sessionId !== undefined) {
      if (run.stopped) this.finish(run);
      else void this.stop(run);
    }
  }
  replayState(hostId: string) {
    if (this.lastState?.payload.hostId === hostId && !this.disposed) this.driver.emit(this.lastState);
  }
  dispose() { this.disposed = true; this.abort(); }
}
