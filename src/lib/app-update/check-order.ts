/** Allocated by the native app before every update check, across all webviews. */
export interface UpdateCheckTicket {
  checkSequence: number;
  checkSession: string;
  channel: 'stable' | 'beta' | 'preview';
  generation: number;
}

export function updateCheckTicket(value: unknown): UpdateCheckTicket | null {
  if (!value || typeof value !== 'object') return null;
  const ticket = value as Partial<UpdateCheckTicket>;
  if (!Number.isSafeInteger(ticket.checkSequence) || ticket.checkSequence! < 1
    || typeof ticket.checkSession !== 'string' || !ticket.checkSession
    || !Number.isSafeInteger(ticket.generation) || ticket.generation! < 0
    || !['stable', 'beta', 'preview'].includes(ticket.channel ?? '')) return null;
  return ticket as UpdateCheckTicket;
}

let latest: UpdateCheckTicket | null = null;
let awaitingChannelCheck = false;
const retiredSessions = new Set<string>();

/** A successful enrollment change invalidates queued events immediately. */
export function invalidateUpdateChecks(): void {
  awaitingChannelCheck = true;
}

export function rememberUpdateCheck(ticket: UpdateCheckTicket): boolean {
  if (retiredSessions.has(ticket.checkSession)) return false;
  if (latest?.checkSession === ticket.checkSession
    && (ticket.checkSequence < latest.checkSequence || ticket.generation < latest.generation)) return false;
  if (latest && latest.checkSession !== ticket.checkSession) retiredSessions.add(latest.checkSession);
  latest = ticket;
  awaitingChannelCheck = false;
  return true;
}

/** Also guards events that were already queued when a newer manual check began. */
export function acceptUpdateCheck(value: unknown): boolean {
  if (awaitingChannelCheck) return false;
  const ticket = updateCheckTicket(value);
  return ticket ? rememberUpdateCheck(ticket) : latest === null;
}

export async function readNativeUpdateCheck(): Promise<UpdateCheckTicket | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const value = await invoke<unknown>('read_update_check_ticket');
  if (value === null) return null;
  const ticket = updateCheckTicket(value);
  if (!ticket) throw new Error('The native update-check ticket is invalid.');
  return ticket;
}

/** Another webview may have started a check before this window receives its event. */
export async function acceptNativeUpdateCheck(value: unknown): Promise<boolean> {
  const ticket = updateCheckTicket(value);
  if (!ticket) return false;
  try {
    const current = await readNativeUpdateCheck();
    if (!current || !rememberUpdateCheck(current)) return false;
    return acceptUpdateCheck(ticket);
  } catch {
    return false;
  }
}
