import { scope } from './scope';
import { request, required, rows, str, type Args } from './transport';
export async function terminalTarget(args: Args, signal: AbortSignal) {
  const name = required(args, 'session_name');
  const repo = await scope(args, signal);
  if (!str(args, 'text')) throw new Error('terminal_send requires a session_name and non-empty text');
  const sessions = rows(await request('/terminal-voice-sessions', signal, undefined, true), 'sessions');
  const session = sessions.find(s => s.name === name);
  if (!session) throw new Error('session not found');
  if (repo && session.cwd !== repo.path) throw new Error('terminal is outside the active repo scope');
  return session;
}
export async function terminals(tool: string, args: Args, signal: AbortSignal) {
  if (tool === 'terminal_list') return request('/terminal-voice-sessions', signal, undefined, true);
  const session = await terminalTarget(args, signal);
  return request('/terminal-voice-input', signal, { sessionName: session.name, text: str(args, 'text'), raw: args.raw === true }, true);
}
