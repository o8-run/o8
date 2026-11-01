import { execFile } from '@/lib/providers/child-process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const LIMIT = 500;
const TIMEOUT_MS = 5_000;

export interface LocalScheduleJob {
  id: string;
  name: string;
  agentId: 'launchd' | 'cron' | 'codex';
  /** The raw label, for telling two jobs apart. */
  source: string;
  /** What runs, in words: never a command line. */
  detail: string | null;
  enabled: boolean;
  /** launchd jobs can be run and paused here; the others belong to their own tool. */
  readOnly: boolean;
  schedule: { kind: 'cron' | 'every' | 'unknown'; expr: string | null; tz: null; everyMs: number | null; at: null; label: string | null };
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: 'running' | 'ok' | 'failed' | null;
  lastDeliveryStatus: null;
  lastExitCode: number | null;
}

type Schedule = LocalScheduleJob['schedule'];
const schedule = (partial: Partial<Schedule>): Schedule => ({
  kind: 'unknown', expr: null, tz: null, everyMs: null, at: null, label: null, ...partial,
});
const job = (source: LocalScheduleJob['agentId'], key: string, name: string, enabled: boolean, when: Schedule,
  extra: Partial<LocalScheduleJob> = {}): LocalScheduleJob => ({
  id: `${source}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
  name: name.slice(0, 160), agentId: source, source: name.slice(0, 160), detail: null, enabled, readOnly: true,
  schedule: when, nextRunAt: null, lastRunAt: null, lastRunStatus: null, lastDeliveryStatus: null, lastExitCode: null,
  ...extra,
});

interface LaunchdPlist {
  Label?: unknown;
  Disabled?: unknown;
  StartInterval?: unknown;
  StartCalendarInterval?: unknown;
  Program?: unknown;
  ProgramArguments?: unknown;
  StandardOutPath?: unknown;
  StandardErrorPath?: unknown;
}

const INTERPRETER = /^(?:ba|z|da)?sh$|^env$|^python[\d.]*$|^node$|^ruby$|^perl$|^osascript$/;
const GENERIC = /^(?:run|main|index|start)\.\w+$/;
const SAFE_NAME = /^[\w.@+-]{1,60}$/;

/** "com.o8.bookmarks-daily" reads as "Bookmarks daily". */
export function launchdTitle(label: string): string {
  const parts = label.split('.');
  const words = (parts.length > 2 ? parts.slice(2) : parts).join(' ').replace(/[-_]+/g, ' ').trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : label;
}

/** Only a script's own name: arguments and full paths can hold secrets. */
export function launchdDetail(plist: LaunchdPlist): string | null {
  const argv = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments.filter(v => typeof v === 'string') as string[]
    : typeof plist.Program === 'string' ? [plist.Program] : [];
  const first = argv[0];
  if (!first) return null;
  const script = INTERPRETER.test(basename(first)) ? argv.slice(1).find(arg => !arg.startsWith('-')) : first;
  if (!script || script.includes('=')) return null;
  const name = basename(script);
  if (!SAFE_NAME.test(name)) return null;
  const folder = basename(dirname(script));
  return `Runs ${GENERIC.test(name) && SAFE_NAME.test(folder) && folder !== '.' ? `${folder}/${name}` : name}`;
}

/** The next time a launchd calendar entry fires, within a year. */
export function nextCalendarRun(entry: Record<string, unknown>, now: number): number | null {
  const number = (key: string) => typeof entry[key] === 'number' ? entry[key] as number : null;
  const [minute, hour, day, month, weekday] = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'].map(number);
  if (hour === null) {
    const at = new Date(now);
    at.setSeconds(0, 0);
    at.setMinutes(minute ?? at.getMinutes() + 1);
    if (at.getTime() <= now) at.setHours(at.getHours() + 1);
    return at.getTime();
  }
  for (let offset = 0; offset < 366; offset++) {
    const at = new Date(now);
    at.setDate(at.getDate() + offset);
    at.setHours(hour!, minute ?? 0, 0, 0);
    const matches = at.getTime() > now && (day === null || at.getDate() === day)
      && (month === null || at.getMonth() + 1 === month) && (weekday === null || at.getDay() === weekday % 7);
    if (matches) return at.getTime();
  }
  return null;
}

export interface LaunchdState { pid: boolean; exit: number | null }

export function parseLaunchctlList(output: string): Map<string, LaunchdState> {
  const states = new Map<string, LaunchdState>();
  for (const line of output.split('\n').slice(1)) {
    const [pid, status, label] = line.split('\t');
    if (label) states.set(label.trim(), { pid: pid !== '-', exit: Number.isFinite(Number(status)) ? Number(status) : null });
  }
  return states;
}

function calendarField(entry: Record<string, unknown>, name: string): string {
  const value = entry[name];
  return typeof value === 'number' && Number.isInteger(value) ? String(value) : '*';
}

/** Label, timing and the script's own name leave this function; commands and env never do. */
export function launchdJob(plist: LaunchdPlist, disabled: ReadonlySet<string>,
  states?: ReadonlyMap<string, LaunchdState>, lastRunAt: number | null = null, now = Date.now()): LocalScheduleJob | null {
  if (typeof plist.Label !== 'string' || !plist.Label) return null;
  const state = states?.get(plist.Label);
  const enabled = plist.Disabled !== true && !disabled.has(plist.Label) && (!states || state !== undefined);
  const extra: Partial<LocalScheduleJob> = {
    source: plist.Label, detail: launchdDetail(plist), readOnly: false, lastRunAt,
    lastRunStatus: state?.pid ? 'running' : state?.exit === 0 && lastRunAt ? 'ok' : state?.exit ? 'failed' : null,
    lastExitCode: state?.exit || null,
  };
  const name = launchdTitle(plist.Label);
  if (typeof plist.StartInterval === 'number' && plist.StartInterval > 0) {
    const every = plist.StartInterval * 1000;
    return job('launchd', plist.Label, name, enabled, schedule({ kind: 'every', everyMs: every }),
      { ...extra, nextRunAt: enabled ? Math.max((lastRunAt ?? now) + every, now + 1000) : null });
  }
  const calendar = [plist.StartCalendarInterval].flat().filter((entry): entry is Record<string, unknown> => (
    typeof entry === 'object' && entry !== null));
  if (!calendar.length) return null;
  const expr = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'].map(field => calendarField(calendar[0]!, field)).join(' ');
  const next = enabled ? calendar.flatMap(entry => nextCalendarRun(entry, now) ?? []) : [];
  return job('launchd', plist.Label, name, enabled, calendar.length === 1
    ? schedule({ kind: 'cron', expr })
    : schedule({ label: `${calendar.length} calendar times` }), { ...extra, nextRunAt: next.length ? Math.min(...next) : null });
}

/** Never returns the command text; the program's base name identifies the row. */
export function cronJobs(table: string): LocalScheduleJob[] {
  return table.split('\n').flatMap(raw => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) return [];
    const special = /^(@\w+)\s+(\S+)/.exec(line);
    const fields = /^((?:\S+\s+){4}\S+)\s+(\S+)/.exec(line);
    const match = special ?? fields;
    if (!match) return [];
    const program = match[2]!.split('/').pop() || 'cron job';
    const when = special ? schedule({ label: special[1]! }) : schedule({ kind: 'cron', expr: match[1]!.replace(/\s+/g, ' ') });
    return [job('cron', line, program, true, when, { detail: 'Runs from crontab' })];
  });
}

function tomlString(source: string, key: string): string | null {
  const match = new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`, 'm').exec(source);
  return match ? match[1]!.replace(/\\(.)/g, '$1') : null;
}

export function rruleLabel(rrule: string | null): string | null {
  if (!rrule) return null;
  const part = (name: string) => new RegExp(`(?:^|[:;])${name}=([^;]+)`).exec(rrule)?.[1] ?? null;
  const frequency = part('FREQ')?.toLowerCase();
  if (!frequency) return null;
  const every = Number(part('INTERVAL') ?? 1);
  const unit = { minutely: 'minute', hourly: 'hour' }[frequency];
  if (unit) return every > 1 ? `Every ${every} ${unit}s` : `Every ${unit}`;
  const hour = part('BYHOUR');
  const minute = part('BYMINUTE');
  const time = hour && minute && /^\d+$/.test(hour) && /^\d+$/.test(minute)
    ? ` at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` : '';
  return `${frequency[0]!.toUpperCase()}${frequency.slice(1)}${time}`;
}

/** Prompts stay out of the row; they can quote anything. */
export function codexJob(key: string, source: string): LocalScheduleJob | null {
  const name = tomlString(source, 'name');
  if (!name) return null;
  const status = tomlString(source, 'status');
  return job('codex', key, name, status === 'ACTIVE', schedule({ label: rruleLabel(tomlString(source, 'rrule')) }),
    { source: key, detail: 'Managed in Codex' });
}

const handles = new Map<string, { label: string; path: string }>();

async function newestWrite(plist: LaunchdPlist): Promise<number | null> {
  const paths = [plist.StandardOutPath, plist.StandardErrorPath].filter((p): p is string => typeof p === 'string');
  const times = await Promise.all(paths.map(path => stat(path).then(info => info.mtimeMs, () => 0)));
  const newest = Math.max(0, ...times);
  return newest || null;
}

async function launchdJobs(home: string, now: number): Promise<LocalScheduleJob[]> {
  if (process.platform !== 'darwin') return [];
  const directory = join(home, 'Library', 'LaunchAgents');
  const files = (await readdir(directory).catch(() => [])).filter(file => file.endsWith('.plist'));
  const disabled = new Set<string>();
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const { stdout } = await execFileAsync('launchctl', ['print-disabled', `gui/${uid}`], { timeout: TIMEOUT_MS, maxBuffer: 1_000_000 })
      .catch(() => ({ stdout: '' }));
    for (const match of String(stdout).matchAll(/"([^"]+)"\s*=>\s*(?:true|disabled)/g)) disabled.add(match[1]!);
  }
  const listed = await execFileAsync('launchctl', ['list'], { timeout: TIMEOUT_MS, maxBuffer: 2_000_000 }).catch(() => null);
  const states = listed ? parseLaunchctlList(String(listed.stdout)) : undefined;
  const jobs: LocalScheduleJob[] = [];
  for (const file of files.slice(0, LIMIT)) {
    try {
      const path = join(directory, file);
      const { stdout } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', path],
        { timeout: TIMEOUT_MS, maxBuffer: 1_000_000 });
      const plist = JSON.parse(String(stdout)) as LaunchdPlist;
      const found = launchdJob(plist, disabled, states, await newestWrite(plist), now);
      if (found) {
        handles.set(found.id, { label: found.source, path });
        jobs.push(found);
      }
    } catch { /* One unreadable plist must not hide the rest. */ }
  }
  return jobs;
}

async function crontabJobs(): Promise<LocalScheduleJob[]> {
  if (process.platform === 'win32') return [];
  const { stdout } = await execFileAsync('crontab', ['-l'], { timeout: TIMEOUT_MS, maxBuffer: 1_000_000 })
    .catch(() => ({ stdout: '' }));
  return cronJobs(String(stdout));
}

async function codexJobs(home: string): Promise<LocalScheduleJob[]> {
  const root = join(home, '.codex', 'automations');
  const entries = await readdir(root).catch(() => []);
  const jobs: LocalScheduleJob[] = [];
  for (const entry of entries.slice(0, LIMIT)) {
    const source = await readFile(join(root, entry, 'automation.toml'), 'utf8').catch(() => null);
    const found = source === null ? null : codexJob(entry, source);
    if (found) jobs.push(found);
  }
  return jobs;
}

let cache: { at: number; jobs: LocalScheduleJob[] } | null = null;

/** Read-only discovery. Scheduled polls every 15 seconds, so results are cached. */
export async function readLocalSchedules(now = Date.now()): Promise<LocalScheduleJob[]> {
  if (process.env.O8_LOCAL_SCHEDULES === 'off') return [];
  if (cache && now - cache.at < CACHE_MS) return cache.jobs;
  const home = homedir();
  const results = await Promise.allSettled([launchdJobs(home, now), crontabJobs(), codexJobs(home)]);
  const jobs = results.flatMap(result => result.status === 'fulfilled' ? result.value : []).slice(0, LIMIT);
  cache = { at: now, jobs };
  return jobs;
}

export function launchctlCommands(action: 'run' | 'pause' | 'resume', uid: number, label: string, path: string): string[][] {
  const service = `gui/${uid}/${label}`;
  if (action === 'run') return [['kickstart', service]];
  if (action === 'pause') return [['disable', service], ['bootout', `gui/${uid}`, path]];
  return [['enable', service], ['bootstrap', `gui/${uid}`, path]];
}

/** Acts only on a job this server discovered, never on a label from the client. */
export async function controlLocalSchedule(id: string, action: 'run' | 'pause' | 'resume'): Promise<LocalScheduleJob | null> {
  if (!handles.has(id)) { cache = null; await readLocalSchedules(); }
  const handle = handles.get(id);
  const uid = process.getuid?.();
  if (!handle || uid === undefined) return null;
  for (const args of launchctlCommands(action, uid, handle.label, handle.path)) {
    await execFileAsync('launchctl', args, { timeout: TIMEOUT_MS, maxBuffer: 128_000 });
  }
  cache = null;
  return (await readLocalSchedules()).find(entry => entry.id === id) ?? null;
}
