import { scope } from './scope';
import { cancelSymonWatch, listSymonWatches } from '@/lib/automations/symon-watch';
import { required, trim, type Args } from './transport';
export async function watchTarget(args: Args, signal: AbortSignal) {
  const repo = await scope(args, signal);
  const id = required(args, 'id');
  const watch = listSymonWatches(trim(args, '__symonSessionId') || null).find(w => w.id === id);
  if (!watch) throw new Error('watch not found in the active session');
  if (repo && watch.repoPath !== repo.path) throw new Error('watch is outside the active repo scope');
  return watch;
}
export async function watches(tool: string, args: Args, signal: AbortSignal) {
  signal.throwIfAborted();
  if (tool === 'symon_watch_list') {
    const repo = await scope(args, signal);
    const watches = listSymonWatches(trim(args, '__symonSessionId') || null).filter(w => !repo || w.repoPath === repo.path);
    return { ok: true, count: watches.length, watches };
  }
  const target = await watchTarget(args, signal);
  signal.throwIfAborted();
  const watch = cancelSymonWatch(target.id);
  if (!watch) throw new Error('watch not found');
  return { ok: true, cancelled: true, watch };
}
