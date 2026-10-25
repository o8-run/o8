import { execFileSync } from '@/lib/providers/child-process';
import { getDataDir } from '@/lib/data-dir-migration';
import { selectOrphanDashSessions, type DashGcOptions, type DashSessionInfo } from '@/lib/terminal/dash-gc';
import { collectPersistedTmuxSessions } from '@/lib/terminal/state-store';
import { DASH_PROFILE_OWNER_OPTION, dashProfileOwnerId } from '@/lib/terminal/dash-session-owner';
import { dashTmuxArgs } from './dash-terminal-persistence';
import { resolveTmuxBinary, sanitizePtyEnv } from './pty-support';

interface DashSessionInventory extends DashSessionInfo {
  profileOwner?: string;
  sessionId: string;
  serverPid: string;
}

/** Full inventory: restoration and snapshots also need legacy sessions. */
export function listDashTmuxSessionsWithAge(): DashSessionInventory[] {
  try {
    const output = execFileSync(
      resolveTmuxBinary(), dashTmuxArgs('list-sessions', '-F', `#{session_name}\t#{session_created}\t#{${DASH_PROFILE_OWNER_OPTION}}\t#{session_id}\t#{pid}`),
      { windowsHide: true, timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: sanitizePtyEnv() as NodeJS.ProcessEnv },
    );
    return output.split('\n').flatMap((line) => {
      const [name, created, profileOwner, sessionId, serverPid] = line.split('\t');
      if (!name?.startsWith('cortex-dash-')) return [];
      const seconds = Number(created);
      return [{ name, createdMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0, profileOwner, sessionId, serverPid }];
    });
  } catch {
    return [];
  }
}

interface ReapDashSessionsOptions extends DashGcOptions {
  dataDir?: string;
  liveSessionNames: Iterable<string>;
  collectAdditionalReferences: () => Iterable<string>;
  beforeKill: (sessionName: string) => void;
}

function retireSession(session: DashSessionInventory, owner: string, interrupt = false): boolean {
  if (!/^\$\d+$/.test(session.sessionId) || !/^[1-9]\d*$/.test(session.serverPid)
    || session.createdMs <= 0) return false;
  const guard = `#{&&:#{==:#{pid},${session.serverPid}},#{&&:#{==:#{session_created},${session.createdMs / 1000}},#{==:#{${DASH_PROFILE_OWNER_OPTION}},${owner}}}}`;
  try {
    const output = execFileSync(resolveTmuxBinary(), dashTmuxArgs('if-shell', '-F', '-t', session.sessionId, guard,
      `${interrupt ? 'send-keys' : 'kill-session'} -t '${session.sessionId}'${interrupt ? ' C-c' : ''} ; display-message -p o8-session-signalled`, ''), {
      windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: sanitizePtyEnv() as NodeJS.ProcessEnv,
    });
    return output.trim() === 'o8-session-signalled';
  } catch { return false; }
}

/** Explicit close uses the same ownership and exact-identity fence as GC. */
export function signalOwnedDashTmuxSession(name: string, signal: string): 'signalled' | 'refused' | 'absent' {
  const session = listDashTmuxSessionsWithAge().find((row) => row.name === name);
  if (!session) return 'absent';
  try {
    const owner = dashProfileOwnerId();
    if (session.profileOwner === owner && retireSession(session, owner, signal === 'SIGINT')) return 'signalled';
  } catch { /* An unresolved profile has no retirement authority. */ }
  return 'refused';
}

/** The bridge's real collector, including durable references and tmux I/O. */
export function reapOrphanDashTmuxSessions(options: ReapDashSessionsOptions): number {
  const dataDir = options.dataDir ?? getDataDir();
  let sessions: DashSessionInventory[];
  let owner: string;
  let referenced: Set<string>;
  try {
    owner = dashProfileOwnerId(dataDir);
    // Filtering belongs only to retirement. Shared restoration inventory must
    // continue to see untagged survivors from earlier versions.
    sessions = listDashTmuxSessionsWithAge().filter((session) => session.profileOwner === owner);
    if (!sessions.length) return 0;
    referenced = collectPersistedTmuxSessions(dataDir);
    for (const name of options.collectAdditionalReferences()) referenced.add(name);
  } catch {
    return 0;
  }
  for (const name of options.liveSessionNames) referenced.add(name);
  const toKill = selectOrphanDashSessions(sessions, referenced, options);
  const byName = new Map(sessions.map(session => [session.name, session]));
  let killed = 0;
  for (const name of toKill) {
    const session = byName.get(name);
    if (!session || !/^\$\d+$/.test(session.sessionId) || !/^[1-9]\d*$/.test(session.serverPid)
      || session.createdMs <= 0) continue;
    options.beforeKill(name);
    // Reused names and restarted servers are new work. Retire only the
    // inventoried server/session identity inside tmux's command queue.
    if (retireSession(session, owner)) killed += 1;
  }
  return killed;
}
