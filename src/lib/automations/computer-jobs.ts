/**
 * Everything scheduled on this Mac, read on demand: the user's launchd agents
 * (files and loaded jobs), system-wide agents and daemons, and the crontab.
 * Read-only. A row carries the program's path and never its arguments or
 * environment, which can hold secrets.
 */
import { execFile } from '@/lib/providers/child-process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { getDataDir } from '@/lib/data-dir-migration';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 5_000;
const LIMIT = 500;
const PARALLEL = 8;
/** A job that stays up counts as running all day. */
const ALWAYS = 86_400;

export type ComputerJobScope = 'user' | 'system-agent' | 'system-daemon' | 'cron';
export type ComputerJobMakerKind = 'o8' | 'app' | 'user' | 'system';
export type ComputerJobAction = 'stop' | 'disable';

export interface ComputerJob {
  id: string;
  label: string;
  scope: ComputerJobScope;
  /** The program's path only: never its arguments or environment. */
  program: string | null;
  /** The plist this job was read from, when there is one. */
  plist: string | null;
  /** Interval, calendar, run at load, keep alive, watch paths, cron. */
  triggers: string[];
  /** Runs a day its schedule implies; null when it runs on an event. */
  runsPerDay: number | null;
  loaded: boolean | null;
  running: boolean;
  pid: number | null;
  /** Runs since launchd loaded it, when launchd reports it. */
  runs: number | null;
  lastExit: string | null;
  disabled: boolean;
  maker: { kind: ComputerJobMakerKind; name: string };
  /** What o8 may do to it: only the user's own launchd jobs and crontab lines. */
  actions: ComputerJobAction[];
  /** Why it has no actions, when that needs saying. */
  readOnlyReason: string | null;
  /** The latest stop or disable o8 made that is not undone yet. */
  undoEntryId: string | null;
}

export interface ComputerJobLogEntry {
  entryId: string;
  at: number;
  jobId: string;
  label: string;
  scope: ComputerJobScope;
  program: string | null;
  action: ComputerJobAction | 'undo';
  /** For an undo: the entry it reverses. */
  undoes?: string;
  /** What reverses this entry. */
  undo?: { command: string; args: string[] } | { crontabLineId: string };
}

/** Every stop, disable and undo o8 made, one JSON line each. */
export function computerJobsLogPath(): string {
  return join(getDataDir(), 'scheduled-job-actions.jsonl');
}

export function readComputerJobsLog(path: string = computerJobsLogPath()): ComputerJobLogEntry[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as ComputerJobLogEntry]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

/** A crontab row's id: the hash of its own line, so an action names that exact line. */
export function crontabLineId(line: string): string {
  return `cron:${createHash('sha256').update(line).digest('hex').slice(0, 16)}`;
}

/** Crontab lines o8 disabled stay in the crontab behind this marker. */
export const CRON_DISABLED_MARKER = '# o8 disabled: ';

export interface ComputerJobsReport {
  jobs: ComputerJob[];
  /** Loaded macOS jobs (com.apple.*) with no plist in the folders read; not listed. */
  hiddenMacosJobs: number;
  /** Open apps launchd started for the session (`application.*`); not scheduled, not listed. */
  hiddenOpenApps: number;
  loginItems: { readable: false; note: string };
  collectedAt: number;
}

export interface ComputerJobsDeps {
  /** Runs a read-only command; null when it fails. */
  run: (command: string, args: string[]) => Promise<string | null>;
  /** Runs a command that changes state; throws when it fails. Only the control path uses it. */
  change: (command: string, args: string[]) => Promise<void>;
  /** The stop, disable and undo log. */
  logPath: string;
  listDir: (path: string) => Promise<string[]>;
  home: string;
  uid: number | null;
  platform: NodeJS.Platform;
  now: () => number;
}

interface Plist {
  Label?: unknown;
  Disabled?: unknown;
  Program?: unknown;
  ProgramArguments?: unknown;
  BundleProgram?: unknown;
  AssociatedBundleIdentifiers?: unknown;
  StartInterval?: unknown;
  StartCalendarInterval?: unknown;
  RunAtLoad?: unknown;
  KeepAlive?: unknown;
  WatchPaths?: unknown;
  QueueDirectories?: unknown;
  StartOnMount?: unknown;
}

export interface DomainState {
  services: Map<string, { pid: number | null; lastExit: string | null }>;
  disabled: Map<string, boolean>;
}

/** `launchctl print <domain>`: the services table and the disabled list. */
export function parseDomainPrint(text: string): DomainState {
  const services: DomainState['services'] = new Map();
  const disabled: DomainState['disabled'] = new Map();
  let block: 'services' | 'disabled' | null = null;
  for (const line of text.split('\n')) {
    if (/^\t[\w ]+ = \{$/.test(line)) {
      block = line.includes('\tservices =') ? 'services' : line.includes('\tdisabled services =') ? 'disabled' : null;
      continue;
    }
    if (/^\t\}/.test(line)) { block = null; continue; }
    if (block === 'services') {
      const match = /^\t\t\s*(\d+)\s+(\S+)\s+(\S.*)$/.exec(line);
      if (match) services.set(match[3]!.trim(), { pid: Number(match[1]) || null, lastExit: match[2] === '-' ? null : match[2]! });
    } else if (block === 'disabled') {
      const match = /^\t\t"([^"]+)" => (\w+)/.exec(line);
      if (match) disabled.set(match[1]!, match[2] === 'disabled' || match[2] === 'true');
    }
  }
  return { services, disabled };
}

export interface ServiceState {
  running: boolean;
  pid: number | null;
  runs: number | null;
  lastExit: string | null;
  program: string | null;
  parentBundle: string | null;
}

/** `launchctl print <domain>/<label>`: only its own top-level fields; arguments and environment stay unread. */
export function parseServicePrint(text: string): ServiceState {
  const field = (name: string) => new RegExp(`^\\t${name} = (.+)$`, 'm').exec(text)?.[1]?.trim() ?? null;
  const pid = Number(field('pid'));
  const runs = Number(field('runs'));
  const lastExit = field('last exit code');
  return {
    running: field('state') === 'running',
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    runs: Number.isInteger(runs) && runs >= 0 ? runs : null,
    lastExit: lastExit && lastExit !== '(never exited)' ? lastExit : null,
    program: field('program'),
    parentBundle: field('parent bundle identifier'),
  };
}

/** The program a plist starts: its path, never the arguments after it. */
export function plistProgram(plist: Plist): string | null {
  if (typeof plist.Program === 'string' && plist.Program) return plist.Program;
  if (Array.isArray(plist.ProgramArguments) && typeof plist.ProgramArguments[0] === 'string') {
    return plist.ProgramArguments[0] || null;
  }
  return typeof plist.BundleProgram === 'string' && plist.BundleProgram ? plist.BundleProgram : null;
}

function calendarRunsPerDay(entry: Record<string, unknown>): number {
  const set = (key: string) => typeof entry[key] === 'number';
  return (set('Minute') ? 1 : 60) * (set('Hour') ? 1 : 24)
    / (set('Weekday') ? 7 : 1) / (set('Day') ? 30 : 1) / (set('Month') ? 12 : 1);
}

function every(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'every day' : `every ${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? 'every hour' : `every ${seconds / 3600} h`;
  if (seconds % 60 === 0) return seconds === 60 ? 'every minute' : `every ${seconds / 60} min`;
  return `every ${seconds} s`;
}

function clock(entry: Record<string, unknown>): string {
  const part = (key: string) => typeof entry[key] === 'number' ? String(entry[key]).padStart(2, '0') : '**';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = typeof entry.Weekday === 'number' ? `${days[entry.Weekday % 7]} ` : '';
  const day = typeof entry.Day === 'number' ? `day ${entry.Day} ` : '';
  return `${weekday}${day}${part('Hour')}:${part('Minute')}`.trim();
}

/** What makes launchd start a job, and how many times a day that implies. */
export function plistTriggers(plist: Plist): { triggers: string[]; runsPerDay: number | null } {
  const triggers: string[] = [];
  let runsPerDay: number | null = null;
  const add = (n: number) => { runsPerDay = (runsPerDay ?? 0) + n; };
  if (plist.KeepAlive === true || (typeof plist.KeepAlive === 'object' && plist.KeepAlive !== null)) {
    triggers.push(plist.KeepAlive === true ? 'keep alive' : 'keep alive (conditional)');
    add(ALWAYS);
  }
  if (typeof plist.StartInterval === 'number' && plist.StartInterval > 0) {
    triggers.push(every(plist.StartInterval));
    add(86_400 / plist.StartInterval);
  }
  const calendar = [plist.StartCalendarInterval].flat()
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
  if (calendar.length) {
    triggers.push(calendar.length === 1 ? `at ${clock(calendar[0]!)}` : `${calendar.length} calendar times`);
    add(calendar.reduce((sum, entry) => sum + calendarRunsPerDay(entry), 0));
  }
  const watched = [plist.WatchPaths, plist.QueueDirectories].flatMap((list) => Array.isArray(list) ? list : []);
  if (watched.length) triggers.push(`watch paths (${watched.length})`);
  if (plist.StartOnMount === true) triggers.push('on mount');
  if (plist.RunAtLoad === true) {
    triggers.push('run at load');
    if (runsPerDay === null) runsPerDay = 0;
  }
  return { triggers, runsPerDay };
}

const O8_LABEL = /^(?:ai|com|run)\.o8(?:\.|$)|^o8$/;

/** Who made a job: o8, the app it lives in, or the folder its program sits in. */
export function jobMaker(input: {
  label: string; program: string | null; scope: ComputerJobScope; home: string;
  bundle?: string | null; dataDir?: string;
}): ComputerJob['maker'] {
  const program = input.program ?? '';
  const dataDir = input.dataDir ?? join(input.home, '.o8');
  if (O8_LABEL.test(input.label) || /\/o8\.app\//.test(program) || program.startsWith(`${dataDir}/`)) {
    return { kind: 'o8', name: 'o8' };
  }
  const app = /([^/]+)\.app\//.exec(program)?.[1];
  if (app) return { kind: 'app', name: app };
  if (input.bundle) return { kind: 'app', name: input.bundle };
  const folder = program.startsWith('/') ? dirname(program) : null;
  const where = folder?.startsWith(`${input.home}/`) ? `~${folder.slice(input.home.length)}` : folder;
  const system = input.scope === 'system-agent' || input.scope === 'system-daemon';
  return { kind: system ? 'system' : 'user', name: where ?? (system ? 'installed for all users' : 'you') };
}

function cronRunsPerDay(expr: string): number | null {
  const fields = expr.split(' ');
  if (fields.length !== 5) return null;
  const count = (field: string, size: number) => {
    if (field === '*') return size;
    const step = /^\*\/(\d+)$/.exec(field);
    if (step) return Math.max(1, Math.floor(size / Number(step[1])));
    return field.split(',').length;
  };
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  return count(minute, 60) * count(hour, 24)
    * (day === '*' ? 1 : count(day, 31) / 30) * (month === '*' ? 1 : count(month, 12) / 12)
    * (weekday === '*' ? 1 : count(weekday, 7) / 7);
}

const SPECIAL_PER_DAY: Record<string, number | null> = {
  '@reboot': null, '@yearly': 1 / 365, '@annually': 1 / 365, '@monthly': 1 / 30, '@weekly': 1 / 7,
  '@daily': 1, '@midnight': 1, '@hourly': 24,
};

/** Crontab rows: the schedule and the program's path; never the rest of the command. */
export function crontabJobs(table: string): ComputerJob[] {
  const rows: ComputerJob[] = [];
  for (const raw of table.split('\n')) {
    const disabledByO8 = raw.startsWith(CRON_DISABLED_MARKER);
    const line = (disabledByO8 ? raw.slice(CRON_DISABLED_MARKER.length) : raw).trim();
    if (!line || line.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue;
    const special = /^(@\w+)\s+(.+)$/.exec(line);
    const fields = special ? null : /^((?:\S+\s+){4}\S+)\s+(.+)$/.exec(line);
    const when = special?.[1] ?? fields?.[1]?.replace(/\s+/g, ' ');
    const command = special?.[2] ?? fields?.[2];
    if (!when || !command) continue;
    // Leading NAME=value words are environment; the program is the first word after them.
    const program = command.split(/\s+/).find((word) => !word.includes('=')) ?? null;
    const label = program ? basename(program) : 'cron job';
    rows.push({
      id: crontabLineId(line), label, scope: 'cron', program, plist: null,
      triggers: [special ? when : `cron ${when}`],
      runsPerDay: special ? SPECIAL_PER_DAY[when] ?? null : cronRunsPerDay(when!),
      loaded: null, running: false, pid: null, runs: null, lastExit: null, disabled: disabledByO8,
      maker: { kind: 'user', name: 'crontab' }, actions: [], readOnlyReason: null, undoEntryId: null,
    });
  }
  return rows;
}

/**
 * What o8 may do to a job. System agents and daemons stay read-only, and
 * o8's own jobs are changed through o8's own controls. Stop needs the plist,
 * because its undo loads the job again from it.
 */
export function jobControls(job: ComputerJob): Pick<ComputerJob, 'actions' | 'readOnlyReason'> {
  if (job.scope === 'system-agent' || job.scope === 'system-daemon') {
    return { actions: [], readOnlyReason: 'System job: installed for every user, so o8 only shows it.' };
  }
  if (job.maker.kind === 'o8') return { actions: [], readOnlyReason: "o8's own job: change it in o8." };
  if (job.scope === 'cron') return { actions: job.disabled ? [] : ['disable'], readOnlyReason: null };
  const actions: ComputerJobAction[] = [];
  if (job.loaded && job.plist) actions.push('stop');
  if (!job.disabled) actions.push('disable');
  return { actions, readOnlyReason: null };
}

/** The latest change o8 made to each job that has not been undone. */
export function openUndos(log: ComputerJobLogEntry[]): Map<string, string> {
  const undone = new Set(log.flatMap((entry) => entry.undoes ? [entry.undoes] : []));
  const open = new Map<string, string>();
  for (const entry of log) {
    if (entry.action === 'undo' || undone.has(entry.entryId)) continue;
    open.set(`${entry.scope}:${entry.label}`, entry.entryId);
  }
  return open;
}

/** Running now first, then the jobs whose schedule runs them most often, then by runs so far. */
export function sortComputerJobs(jobs: ComputerJob[]): ComputerJob[] {
  return [...jobs].sort((a, b) => Number(b.running) - Number(a.running)
    || (b.runsPerDay ?? -1) - (a.runsPerDay ?? -1)
    || (b.runs ?? -1) - (a.runs ?? -1)
    || a.label.localeCompare(b.label));
}

async function pool<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

const FOLDERS: Array<{ scope: ComputerJobScope; path: (home: string) => string }> = [
  { scope: 'user', path: (home) => join(home, 'Library', 'LaunchAgents') },
  { scope: 'system-agent', path: () => '/Library/LaunchAgents' },
  { scope: 'system-daemon', path: () => '/Library/LaunchDaemons' },
];

export async function readComputerJobs(deps: ComputerJobsDeps = defaultComputerJobsDeps()): Promise<ComputerJobsReport> {
  const report: ComputerJobsReport = {
    jobs: [], hiddenMacosJobs: 0, hiddenOpenApps: 0, collectedAt: deps.now(),
    loginItems: { readable: false, note: 'macOS asks for a new permission before listing login items, so they are not read.' },
  };
  if (deps.platform !== 'darwin') {
    report.jobs = withControls(sortComputerJobs(crontabJobs(await deps.run('crontab', ['-l']) ?? '')), deps.logPath);
    return report;
  }
  const user = deps.uid === null ? null : `gui/${deps.uid}`;
  const [userText, systemText, crontab] = await Promise.all([
    user ? deps.run('launchctl', ['print', user]) : Promise.resolve(null),
    deps.run('launchctl', ['print', 'system']),
    deps.run('crontab', ['-l']),
  ]);
  const domains = {
    user: parseDomainPrint(userText ?? ''),
    system: parseDomainPrint(systemText ?? ''),
  };

  const files = (await Promise.all(FOLDERS.map(async (folder) => {
    const directory = folder.path(deps.home);
    const names = (await deps.listDir(directory).catch(() => [] as string[])).filter((name) => name.endsWith('.plist'));
    return names.slice(0, LIMIT).map((name) => ({ scope: folder.scope, path: join(directory, name) }));
  }))).flat();

  const seen = new Set<string>();
  const fromFiles = await pool(files, async (file): Promise<ComputerJob | null> => {
    const json = await deps.run('plutil', ['-convert', 'json', '-o', '-', file.path]);
    let plist: Plist;
    try { plist = json ? JSON.parse(json) as Plist : {}; } catch { plist = {}; }
    const label = typeof plist.Label === 'string' && plist.Label ? plist.Label : basename(file.path, '.plist');
    const domain = file.scope === 'system-daemon' ? domains.system : domains.user;
    const prefix = file.scope === 'system-daemon' ? 'system' : user;
    seen.add(`${file.scope === 'system-daemon' ? 'system' : 'user'}:${label}`);
    const listed = domain.services.get(label);
    const state = listed && prefix ? await deps.run('launchctl', ['print', `${prefix}/${label}`]) : null;
    const service = state ? parseServicePrint(state) : null;
    const program = plistProgram(plist) ?? service?.program ?? null;
    const bundles = Array.isArray(plist.AssociatedBundleIdentifiers) ? plist.AssociatedBundleIdentifiers : [];
    const { triggers, runsPerDay } = plistTriggers(plist);
    return {
      id: `${file.scope}:${label}`, label, scope: file.scope, program, plist: file.path,
      triggers: !json ? ['unreadable plist'] : triggers.length ? triggers : ['no trigger set'], runsPerDay,
      loaded: Boolean(listed), running: service?.running ?? Boolean(listed?.pid), pid: service?.pid ?? listed?.pid ?? null,
      runs: service?.runs ?? null, lastExit: service?.lastExit ?? listed?.lastExit ?? null,
      disabled: plist.Disabled === true || domain.disabled.get(label) === true,
      maker: jobMaker({
        label, program, scope: file.scope, home: deps.home,
        bundle: typeof bundles[0] === 'string' ? bundles[0] : service?.parentBundle ?? null,
      }),
      actions: [], readOnlyReason: null, undoEntryId: null,
    };
  });

  // Loaded user jobs with no plist in those folders: ones an app registered
  // itself. macOS's own jobs are counted, not listed.
  const loadedOnly = [...domains.user.services.keys()].filter((label) => !seen.has(`user:${label}`));
  const macos = (label: string) => label.startsWith('com.apple.');
  const openApp = (label: string) => label.startsWith('application.');
  report.hiddenMacosJobs = loadedOnly.filter(macos).length;
  report.hiddenOpenApps = loadedOnly.filter(openApp).length;
  const registered = await pool(loadedOnly.filter((label) => !macos(label) && !openApp(label)).slice(0, LIMIT),
    async (label): Promise<ComputerJob> => {
      const listed = domains.user.services.get(label)!;
      const text = user ? await deps.run('launchctl', ['print', `${user}/${label}`]) : null;
      const service = text ? parseServicePrint(text) : null;
      return {
        id: `user:${label}`, label, scope: 'user', program: service?.program ?? null, plist: null,
        triggers: ['registered by an app'], runsPerDay: null,
        loaded: true, running: service?.running ?? Boolean(listed.pid), pid: service?.pid ?? listed.pid,
        runs: service?.runs ?? null, lastExit: service?.lastExit ?? listed.lastExit,
        disabled: domains.user.disabled.get(label) === true,
        maker: jobMaker({ label, program: service?.program ?? null, scope: 'user', home: deps.home, bundle: service?.parentBundle }),
        actions: [], readOnlyReason: null, undoEntryId: null,
      };
    });

  report.jobs = withControls(sortComputerJobs([
    ...fromFiles.filter((job): job is ComputerJob => job !== null),
    ...registered,
    ...crontabJobs(crontab ?? ''),
  ]), deps.logPath);
  return report;
}

function withControls(jobs: ComputerJob[], logPath: string): ComputerJob[] {
  const undos = openUndos(readComputerJobsLog(logPath));
  return jobs.map((job) => ({ ...job, ...jobControls(job), undoEntryId: undos.get(`${job.scope}:${job.label}`) ?? null }));
}

export function defaultComputerJobsDeps(): ComputerJobsDeps {
  return {
    run: async (command, args) => {
      try {
        const { stdout } = await execFileAsync(command, args, { timeout: TIMEOUT_MS, maxBuffer: 4_000_000 });
        return String(stdout);
      } catch {
        return null;
      }
    },
    change: async (command, args) => {
      await execFileAsync(command, args, { timeout: TIMEOUT_MS, maxBuffer: 1_000_000 });
    },
    logPath: computerJobsLogPath(),
    listDir: (path) => readdir(path),
    home: homedir(),
    uid: process.getuid?.() ?? null,
    platform: process.platform,
    now: Date.now,
  };
}
