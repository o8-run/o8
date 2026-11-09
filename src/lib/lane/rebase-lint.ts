import { resolveGitBinary } from '@/lib/git/binary';
import { execFile } from '@/lib/providers/child-process';
import * as nodeModule from 'node:module';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { LaneGitMetadataError, laneGit } from '@/lib/lane/lane-git';
import { ranUnconfined, runConfinedProcess } from '@/lib/sandbox/run-confined';

const execFileAsync = promisify(execFile);

const LINT_TIMEOUT_MS = 90_000;
const LINT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const LINT_OUTPUT_PREVIEW_CHARS = 4_000;
const LINTABLE_EXTENSIONS = new Set([
  '.astro',
  '.cjs',
  '.cts',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.svelte',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);
const ESLINT_CONFIG_FILES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
];

interface ChangedLintFile {
  headPath: string;
  basePath: string | null;
}

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
  column?: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

interface LintSnapshot {
  results: EslintFileResult[];
  stderr: string;
}

/**
 * `unconfined` is set when ESLint ran without the sandbox because confinement
 * is unavailable on this host.
 */
export type LaneRebaseLintResult =
  | { ok: true; skipped?: string; detail?: string; unconfined?: true }
  | { ok: false; output: string; unconfined?: true };

/** One line for the merge card when lane lint ran without the sandbox (#3414). */
export const UNCONFINED_LINT_NOTE = 'Lint ran without the sandbox: command confinement is unavailable on this host.';

// Lints file texts with the ESLint entry in argv[1], from the base checkout in
// cwd. The texts never reach disk, so a lane file cannot become ESLint config
// or a module that config loads.
const LINT_TEXT_RUNNER = `
const { readFileSync } = require('node:fs');
const path = require('node:path');
(async () => {
  const [eslintEntry, inputPath] = process.argv.slice(1);
  const files = JSON.parse(readFileSync(inputPath, 'utf8'));
  const api = require(eslintEntry);
  const ESLint = typeof api.loadESLint === 'function' ? await api.loadESLint({ cwd: process.cwd() }) : api.ESLint;
  const eslint = new ESLint({ cwd: process.cwd() });
  const results = [];
  for (const file of files) {
    for (const result of await eslint.lintText(file.text, { filePath: path.join(process.cwd(), file.path) })) {
      results.push({ filePath: result.filePath, messages: result.messages.map(({ ruleId, severity, message, line, column }) => ({ ruleId, severity, message, line, column })) });
    }
  }
  process.stdout.write(JSON.stringify(results));
})().catch((error) => { process.stderr.write(String((error && error.stack) || error)); process.exitCode = 2; });
`;

class LintTimeoutError extends Error {}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new LintTimeoutError('ESLint exceeded the 90 s timeout.');
  return remaining;
}

function errorOutput(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stdout = 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '').trim() : '';
  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '').trim() : '';
  return stdout || stderr || error.message;
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof LintTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  const candidate = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  return candidate.killed === true || candidate.code === 'ETIMEDOUT' || candidate.signal === 'SIGTERM';
}

function parsePackageJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A file at a revision, read from git so a link in a checkout is never followed. */
async function revisionFile(cwd: string, rev: string, file: string, deadline: number, gitRepoPath?: string): Promise<string | null> {
  try {
    return await gitOutput(cwd, ['show', `${rev}:${file}`], deadline, gitRepoPath);
  } catch (error) {
    if (isTimeoutError(error)) throw error;
    return null;
  }
}

/**
 * Lint runs only when the base revision configures it, and only with the
 * ESLint installed in `installRoot`, never one from the lane's checkout.
 */
async function lintAvailability(input: {
  cwd: string;
  gitRepoPath?: string;
  mergeBase: string;
  installRoot: string;
  deadline: number;
}): Promise<{ skip: false; eslintEntry: string } | { skip: true; reason: string }> {
  const packageText = await revisionFile(input.cwd, input.mergeBase, 'package.json', input.deadline, input.gitRepoPath);
  const packageJson = packageText === null ? null : parsePackageJson(packageText);
  const scripts = packageJson?.scripts;
  const lintScript = scripts && typeof scripts === 'object'
    ? (scripts as Record<string, unknown>).lint
    : null;
  if (typeof lintScript !== 'string' || lintScript.trim().length === 0) {
    return { skip: true, reason: 'package.json has no lint script' };
  }

  const rootFiles = new Set((await gitOutput(
    input.cwd, ['ls-tree', '--name-only', input.mergeBase], input.deadline, input.gitRepoPath,
  )).split('\n'));
  const hasConfigFile = ESLINT_CONFIG_FILES.some((file) => rootFiles.has(file));
  if (!hasConfigFile && !packageJson?.eslintConfig) {
    return { skip: true, reason: 'no ESLint config was found' };
  }

  try {
    // This anchor belongs to the runtime repository, not the app being bundled.
    // A direct createRequire call is statically rewritten by webpack to an
    // undefined resolver when its argument cannot be evaluated at build time.
    const runtimeCreateRequire = Reflect.get(nodeModule, 'createRequire') as typeof nodeModule.createRequire;
    const requireFromInstall = runtimeCreateRequire(path.join(input.installRoot, 'package.json'));
    return { skip: false, eslintEntry: requireFromInstall.resolve('eslint') };
  } catch {
    return { skip: true, reason: 'no local ESLint installation was found' };
  }
}

async function gitOutput(cwd: string, args: string[], deadline: number, gitRepoPath?: string): Promise<string> {
  const execute = gitRepoPath
    ? (args: string[], options: { timeout: number; maxBuffer: number }) => laneGit(cwd, gitRepoPath, args, options)
    : (args: string[], options: { timeout: number; maxBuffer: number }) => execFileAsync(resolveGitBinary(), args, { cwd, windowsHide: true, encoding: 'utf8', ...options });
  const { stdout } = await execute(args, {
    timeout: remainingTimeout(deadline),
    maxBuffer: LINT_MAX_BUFFER_BYTES,
  });
  return stdout;
}

function isLintableFile(file: string): boolean {
  return LINTABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function parseChangedFiles(output: string, cwd: string): ChangedLintFile[] {
  const tokens = output.split('\0');
  const changed: ChangedLintFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    const kind = status[0];
    const firstPath = tokens[index++] ?? '';
    const secondPath = kind === 'R' || kind === 'C' ? tokens[index++] ?? '' : '';
    const headPath = secondPath || firstPath;
    const basePath = kind === 'A' ? null : firstPath;
    if (kind === 'D' || !headPath || !isLintableFile(headPath)) continue;
    if (!existsSync(path.join(cwd, headPath))) continue;
    changed.push({ headPath, basePath });
  }
  return changed;
}

// A merge verifies in a clone of the repository, where the base branch may
// exist only as the fetched origin ref. Same order as lane diff facts.
async function resolveBaseRef(cwd: string, baseRef: string, deadline: number, gitRepoPath?: string): Promise<string> {
  if (baseRef.startsWith('refs/')) return baseRef;
  for (const ref of [`refs/heads/${baseRef}`, `refs/remotes/origin/${baseRef}`]) {
    try {
      await gitOutput(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], deadline, gitRepoPath);
      return ref;
    } catch (error) {
      if (error instanceof LaneGitMetadataError) throw error;
    }
  }
  return baseRef;
}

async function changedLintFiles(
  cwd: string,
  baseRef: string,
  deadline: number,
  gitRepoPath?: string,
): Promise<{ mergeBase: string; files: ChangedLintFile[] }> {
  const base = await resolveBaseRef(cwd, baseRef, deadline, gitRepoPath);
  const mergeBase = (await gitOutput(cwd, ['merge-base', base, 'HEAD'], deadline, gitRepoPath)).trim();
  if (!mergeBase) throw new Error(`Unable to resolve the lint merge base from ${baseRef}.`);
  const output = await gitOutput(
    cwd,
    ['diff', '--name-status', '-z', '--find-renames', `${mergeBase}..HEAD`],
    deadline,
    gitRepoPath,
  );
  return { mergeBase, files: parseChangedFiles(output, cwd) };
}

function parseEslintResults(stdout: string, stderr: string): LintSnapshot {
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error('ESLint JSON output was not an array.');
    return { results: parsed as EslintFileResult[], stderr };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`ESLint did not return valid JSON: ${reason}\n${stderr || stdout}`.trim());
  }
}

// ESLint loads the base checkout's config, which is code, so it still runs
// confined to that checkout (#3414).
async function lintSnapshot(input: {
  cwd: string;
  eslintEntry: string;
  files: Array<{ path: string; text: string }>;
  deadline: number;
  onUnconfined: () => void;
}): Promise<LintSnapshot> {
  // Inside the checkout's .git, so the confined process can read it and nothing lints it.
  const inputPath = path.join(input.cwd, '.git', 'o8-lint-input.json');
  writeFileSync(inputPath, JSON.stringify(input.files));
  const args = ['-e', LINT_TEXT_RUNNER, input.eslintEntry, inputPath];
  try {
    const run = await runConfinedProcess(input.cwd, process.execPath, args, {
      cwd: input.cwd,
      timeout: remainingTimeout(input.deadline),
      maxBuffer: LINT_MAX_BUFFER_BYTES,
    });
    if (run.unconfined) input.onUnconfined();
    return parseEslintResults(run.stdout, run.stderr);
  } catch (error) {
    if (ranUnconfined(error)) input.onUnconfined();
    if (isTimeoutError(error)) throw new LintTimeoutError('ESLint exceeded the 90 s timeout.');
    const stdout = error instanceof Error && 'stdout' in error
      ? String((error as { stdout?: unknown }).stdout ?? '')
      : '';
    const stderr = error instanceof Error && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : errorOutput(error);
    if (stdout.trim()) return parseEslintResults(stdout, stderr);
    throw new Error(stderr || errorOutput(error));
  }
}

function relativeResultPath(cwd: string, filePath: string): string {
  const canonicalCwd = realpathSync(cwd);
  const canonicalFile = existsSync(filePath) ? realpathSync(filePath) : filePath;
  const relativePath = path.relative(canonicalCwd, canonicalFile);
  return relativePath.split(path.sep).join('/');
}

function isIgnoredFileWarning(message: EslintMessage): boolean {
  return message.severity === 1
    && message.ruleId === null
    && /file ignored|no matching configuration/i.test(message.message);
}

function relevantMessages(result: EslintFileResult): EslintMessage[] {
  return result.messages.filter((message) => !isIgnoredFileWarning(message));
}

function diagnosticRule(message: EslintMessage): string {
  if (message.ruleId) return message.ruleId;
  if (/unused eslint-disable directive/i.test(message.message)) return 'unused-disable';
  return 'eslint';
}

function formatDiagnostic(file: string, message: EslintMessage): string {
  const line = message.line ?? 1;
  return `${file}:${line}:${diagnosticRule(message)} ${message.message}`;
}

function formatFailure(lines: string[]): string {
  const output = lines.join('\n');
  return output.slice(0, LINT_OUTPUT_PREVIEW_CHARS) || 'Unknown lint error';
}

async function makeBaseCheckout(
  cwd: string,
  mergeBase: string,
  deadline: number,
  installRoot: string,
): Promise<string> {
  const baseDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-lint-base-')));
  try {
    await gitOutput(baseDir, ['clone', '--quiet', '--shared', '--no-checkout', cwd, '.'], deadline);
    await gitOutput(baseDir, ['checkout', '--quiet', '--detach', mergeBase], deadline);
    const sourceModules = path.join(installRoot, 'node_modules');
    const baseModules = path.join(baseDir, 'node_modules');
    if (existsSync(sourceModules) && !existsSync(baseModules)) {
      symlinkSync(sourceModules, baseModules, 'junction');
    }
    return baseDir;
  } catch (error) {
    rmSync(baseDir, { recursive: true, force: true });
    throw error;
  }
}

function warningsByPath(cwd: string, snapshot: LintSnapshot): Map<string, EslintMessage[]> {
  const warnings = new Map<string, EslintMessage[]>();
  for (const result of snapshot.results) {
    warnings.set(
      relativeResultPath(cwd, result.filePath),
      relevantMessages(result).filter((message) => message.severity === 1),
    );
  }
  return warnings;
}

function warningSignature(message: EslintMessage): string {
  return `${message.ruleId ?? 'eslint'}\0${message.message}`;
}

function warningsAbsentFromBase(
  baseWarnings: EslintMessage[],
  headWarnings: EslintMessage[],
): EslintMessage[] {
  const remainingBaseSignatures = new Map<string, number>();
  for (const message of baseWarnings) {
    const signature = warningSignature(message);
    remainingBaseSignatures.set(signature, (remainingBaseSignatures.get(signature) ?? 0) + 1);
  }

  const added: EslintMessage[] = [];
  for (const message of headWarnings) {
    const signature = warningSignature(message);
    const remaining = remainingBaseSignatures.get(signature) ?? 0;
    if (remaining === 0) {
      added.push(message);
    } else {
      remainingBaseSignatures.set(signature, remaining - 1);
    }
  }
  return added;
}

/**
 * Lint only packet-attributed files, then compare warning identities with the
 * merge-base revision. Severity-2 findings always block; warnings block only
 * when their rule-and-message signature is absent from the base multiset.
 *
 * ESLint config is code, so it always comes from the merge base: the packet's
 * files are linted as text inside a base checkout, with the ESLint installed
 * in `installRoot` (default: the repository, then `cwd`).
 */
export async function runLaneRebaseLint(input: {
  cwd: string;
  gitRepoPath?: string;
  installRoot?: string;
  baseRef: string;
  actualBranch: string;
  logPrefix: string;
  timeoutMs?: number;
}): Promise<LaneRebaseLintResult> {
  const timeoutMs = input.timeoutMs ?? LINT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const installRoot = input.installRoot ?? input.gitRepoPath ?? input.cwd;

  let unconfined = false;
  const onUnconfined = () => { unconfined = true; };
  const marked = <T extends LaneRebaseLintResult>(result: T): T => (unconfined ? { ...result, unconfined: true } : result);
  try {
    const { mergeBase, files } = await changedLintFiles(input.cwd, input.baseRef, deadline, input.gitRepoPath);
    const availability = await lintAvailability({
      cwd: input.cwd, gitRepoPath: input.gitRepoPath, mergeBase, installRoot, deadline,
    });
    if (availability.skip) {
      console.warn(`[${input.logPrefix}] Skipping lint for ${input.actualBranch}: ${availability.reason}.`);
      return { ok: true, skipped: availability.reason };
    }
    if (files.length === 0) {
      return { ok: true, detail: 'No changed lintable files.' };
    }

    const texts = async (rev: string, paths: string[]) => {
      const read: Array<{ path: string; text: string }> = [];
      for (const file of paths) {
        const text = await revisionFile(input.cwd, rev, file, deadline, input.gitRepoPath);
        if (text !== null) read.push({ path: file, text });
      }
      return read;
    };
    const baseDir = await makeBaseCheckout(input.cwd, mergeBase, deadline, installRoot);
    try {
      const head = await lintSnapshot({
        cwd: baseDir,
        eslintEntry: availability.eslintEntry,
        files: await texts('HEAD', files.map((file) => file.headPath)),
        deadline,
        onUnconfined,
      });
      const errors: string[] = [];
      let warningCount = 0;
      for (const result of head.results) {
        const file = relativeResultPath(baseDir, result.filePath);
        const messages = relevantMessages(result);
        warningCount += messages.filter((message) => message.severity === 1).length;
        errors.push(...messages
          .filter((message) => message.severity === 2)
          .map((message) => formatDiagnostic(file, message)));
      }
      if (errors.length > 0) {
        const output = formatFailure(errors);
        console.error(`[${input.logPrefix}] Lint failed for ${input.actualBranch}:\n${output}`);
        return marked({ ok: false, output });
      }
      if (warningCount === 0) {
        console.log(`[${input.logPrefix}] Lint passed for ${input.actualBranch}`);
        return marked({ ok: true });
      }

      const basePaths = files.flatMap((file) => (file.basePath === null ? [] : [file.basePath]));
      const baseWarnings = basePaths.length === 0
        ? new Map<string, EslintMessage[]>()
        : warningsByPath(baseDir, await lintSnapshot({
          cwd: baseDir,
          eslintEntry: availability.eslintEntry,
          files: await texts(mergeBase, basePaths),
          deadline,
          onUnconfined,
        }));

      const headWarnings = warningsByPath(baseDir, head);
      const newWarnings: string[] = [];
      for (const file of files) {
        const current = headWarnings.get(file.headPath) ?? [];
        const baseline = file.basePath ? baseWarnings.get(file.basePath) ?? [] : [];
        newWarnings.push(...warningsAbsentFromBase(baseline, current)
          .map((message) => formatDiagnostic(file.headPath, message)));
      }
      if (newWarnings.length > 0) {
        const output = formatFailure(newWarnings);
        console.error(`[${input.logPrefix}] Lint introduced warnings for ${input.actualBranch}:\n${output}`);
        return marked({ ok: false, output });
      }

      console.log(`[${input.logPrefix}] Lint passed for ${input.actualBranch}; existing base warnings did not increase.`);
      return marked({ ok: true });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (isTimeoutError(error)) {
      const reason = `ESLint exceeded the ${Math.ceil(timeoutMs / 1000)} s timeout`;
      console.warn(`[${input.logPrefix}] Skipping lint for ${input.actualBranch}: ${reason}.`);
      return marked({ ok: true, skipped: reason });
    }
    const output = formatFailure([errorOutput(error)]);
    console.error(`[${input.logPrefix}] Lint verification failed for ${input.actualBranch}:\n${output}`);
    return marked({ ok: false, output });
  }
}
