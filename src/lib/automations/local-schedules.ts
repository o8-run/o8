import { execFile } from '@/lib/providers/child-process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const LIMIT = 500;
const TIMEOUT_MS = 5_000;

export interface LocalScheduleJob {
  id: string;
  name: string;
  agentId: 'launchd' | 'cron' | 'codex';
  enabled: boolean;
  readOnly: true;
  schedule: { kind: 'cron' | 'every' | 'unknown'; expr: string | null; tz: null; everyMs: number | null; at: null; label: string | null };
  nextRunAt: null;
  lastRunAt: null;
  lastRunStatus: null;
  lastDeliveryStatus: null;
}

type Schedule = LocalScheduleJob['schedule'];
const schedule = (partial: Partial<Schedule>): Schedule => ({
  kind: 'unknown', expr: null, tz: null, everyMs: null, at: null, label: null, ...partial,
});
const job = (source: LocalScheduleJob['agentId'], key: string, name: string, enabled: boolean, when: Schedule): LocalScheduleJob => ({
  id: `${source}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
  name: name.slice(0, 160), agentId: source, enabled, readOnly: true, schedule: when,
  nextRunAt: null, lastRunAt: null, lastRunStatus: null, lastDeliveryStatus: null,
});

interface LaunchdPlist {
  Label?: unknown;
  Disabled?: unknown;
  StartInterval?: unknown;
  StartCalendarInterval?: unknown;
}

function calendarField(entry: Record<string, unknown>, name: string): string {
  const value = entry[name];
  return typeof value === 'number' && Number.isInteger(value) ? String(value) : '*';
}

/** Only the label and timing leave this function: commands and env can hold secrets. */
export function launchdJob(plist: LaunchdPlist, disabled: ReadonlySet<string>): LocalScheduleJob | null {
  if (typeof plist.Label !== 'string' || !plist.Label) return null;
  const enabled = plist.Disabled !== true && !disabled.has(plist.Label);
  if (typeof plist.StartInterval === 'number' && plist.StartInterval > 0) {
    return job('launchd', plist.Label, plist.Label, enabled, schedule({ kind: 'every', everyMs: plist.StartInterval * 1000 }));
  }
  const calendar = [plist.StartCalendarInterval].flat().filter((entry): entry is Record<string, unknown> => (
    typeof entry === 'object' && entry !== null));
  if (!calendar.length) return null;
  const expr = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'].map(name => calendarField(calendar[0]!, name)).join(' ');
  return job('launchd', plist.Label, plist.Label, enabled, calendar.length === 1
    ? schedule({ kind: 'cron', expr })
    : schedule({ label: `${calendar.length} calendar times` }));
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
    return [job('cron', line, program, true, when)];
  });
}

function tomlString(source: string, key: string): string | null {
  const match = new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`, 'm').exec(source);
  return match ? match[1]!.replace(/\\(.)/g, '$1') : null;
}

export function rruleLabel(rrule: string | null): string | null {
  if (!rrule) return null;
  const part = (name: string) => new RegExp(`[:;]${name}=([^;]+)`).exec(rrule)?.[1] ?? null;
  const frequency = part('FREQ')?.toLowerCase();
  if (!frequency) return null;
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
  return job('codex', key, name, status === 'ACTIVE', schedule({ label: rruleLabel(tomlString(source, 'rrule')) }));
}

async function launchdJobs(home: string): Promise<LocalScheduleJob[]> {
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
  const jobs: LocalScheduleJob[] = [];
  for (const file of files.slice(0, LIMIT)) {
    try {
      const { stdout } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', join(directory, file)],
        { timeout: TIMEOUT_MS, maxBuffer: 1_000_000 });
      const found = launchdJob(JSON.parse(String(stdout)) as LaunchdPlist, disabled);
      if (found) jobs.push(found);
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
  const results = await Promise.allSettled([launchdJobs(home), crontabJobs(), codexJobs(home)]);
  const jobs = results.flatMap(result => result.status === 'fulfilled' ? result.value : []).slice(0, LIMIT);
  cache = { at: now, jobs };
  return jobs;
}
