import { childEnvironment } from '@/lib/providers/spawn-environment';
import 'server-only';

import { execFile } from '@/lib/providers/child-process';
import path from 'node:path';
import { promisify } from 'node:util';
// Old Cortex Go binary removed — cortexRecall no longer available
import { enrichRepoReadinessFromCache } from '@/lib/repos/readiness';
import { listRepos } from '@/lib/repos/registry';
import type { RepoReadinessState } from '@/lib/repos/types';

const execFileAsync = promisify(execFile);
const FTUX_CACHE_TTL_MS = 20_000;

type PromptIconKey = 'tree' | 'search' | 'file' | 'diff' | 'rocket';

interface BaseRepoContext {
  name: string;
  localPath: string;
  readinessState: RepoReadinessState;
}

interface BaseFtuxContext {
  fallbackName: string | null;
  username: string | null;
  repos: BaseRepoContext[];
  runtimeNames: string[];
  topics: string[];
}

export interface PersonalizedChatPrompt {
  iconKey: PromptIconKey;
  text: string;
  description: string;
}

export interface PersonalizedChatFtuxProfile {
  name: string | null;
  username: string | null;
  focusedRepoName: string | null;
  repoNames: string[];
  readyRepoCount: number;
  runtimeCount: number;
  runtimeNames: string[];
  topics: string[];
}

export interface PersonalizedChatFtuxPayload {
  greeting: {
    headline: string;
    statsLine: string;
    topicsLine: string | null;
  };
  prompts: PersonalizedChatPrompt[];
  profile: PersonalizedChatFtuxProfile;
  systemContext: string;
}

const RUNTIME_BINARIES = [
  { bin: 'codex', label: 'Codex' },
  { bin: 'claude', label: 'Claude Code' },
  { bin: 'agy', label: 'Antigravity CLI' },
];

let cachedBaseContext: { expiresAt: number; data: BaseFtuxContext } | null = null;
let baseContextInflight: Promise<BaseFtuxContext> | null = null;

function safeTrim(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function safeExec(command: string, args: string[], timeoutMs = 1_500) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      env: childEnvironment({ env: { GH_NO_UPDATE_NOTIFIER: '1' } }),
    });
    return `${stdout}\n${stderr}`.trim();
  } catch (error) {
    const execError = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = typeof execError.stdout === 'string'
      ? execError.stdout
      : execError.stdout instanceof Buffer
        ? execError.stdout.toString('utf-8')
        : '';
    const stderr = typeof execError.stderr === 'string'
      ? execError.stderr
      : execError.stderr instanceof Buffer
        ? execError.stderr.toString('utf-8')
        : '';
    return `${stdout}\n${stderr}`.trim();
  }
}

async function safeWhich(bin: string) {
  const output = await safeExec('which', [bin], 1_000);
  const firstLine = output.split('\n').map((line) => line.trim()).find(Boolean);
  return firstLine?.startsWith('/') ? firstLine : '';
}

async function readGitConfig(key: string) {
  const output = await safeExec('git', ['config', '--global', key], 1_000);
  const firstLine = output.split('\n').map((line) => line.trim()).find(Boolean);
  return firstLine ?? '';
}

async function readGitHubUsername() {
  const output = await safeExec('gh', ['auth', 'status', '--hostname', 'github.com'], 3_000);
  const activeMatch = output.match(/Logged in to github\.com account ([^\s]+)[\s\S]*?Active account:\s*true/i);
  if (activeMatch?.[1]) return activeMatch[1];
  const anyMatch = output.match(/Logged in to github\.com account ([^\s]+)/i)
    ?? output.match(/account ([^\s]+) \(/i);
  return anyMatch?.[1] ?? '';
}

function joinNaturalLanguage(items: string[]) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function salutationForDate(now: Date) {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function greetingName(name: string | null) {
  if (!name) return null;
  const firstToken = name.split(/\s+/).find(Boolean);
  return firstToken ?? name;
}

function resolveHeadline(name: string | null, now: Date) {
  const salutation = salutationForDate(now);
  const shortName = greetingName(name);
  return shortName ? `${salutation}, ${shortName}.` : `${salutation}.`;
}

async function inferTopicsFromCortex() {
  // Old Cortex Go binary removed — topic inference disabled until v2 migration
  return [];
}

async function detectRuntimeNames() {
  const detections = await Promise.all(
    RUNTIME_BINARIES.map(async ({ bin, label }) => ({
      label,
      detected: Boolean(await safeWhich(bin)),
    })),
  );

  return detections
    .filter((runtime) => runtime.detected)
    .map((runtime) => runtime.label);
}

async function loadBaseContext() {
  const [gitName, username, repos, runtimeNames, topics] = await Promise.all([
    readGitConfig('user.name'),
    readGitHubUsername(),
    listRepos()
      .then((items) => items.map(enrichRepoReadinessFromCache))
      .then((items) => items.map((repo) => ({
        name: repo.name,
        localPath: repo.localPath,
        readinessState: repo.readiness?.state ?? 'unknown',
      })))
      .catch(() => [] as BaseRepoContext[]),
    detectRuntimeNames(),
    inferTopicsFromCortex(),
  ]);

  return {
    fallbackName: safeTrim(gitName) ?? safeTrim(username),
    username: safeTrim(username),
    repos,
    runtimeNames,
    topics,
  } satisfies BaseFtuxContext;
}

async function getBaseContext() {
  if (cachedBaseContext && cachedBaseContext.expiresAt > Date.now()) {
    return cachedBaseContext.data;
  }
  if (baseContextInflight) return baseContextInflight;

  baseContextInflight = loadBaseContext()
    .then((data) => {
      cachedBaseContext = {
        data,
        expiresAt: Date.now() + FTUX_CACHE_TTL_MS,
      };
      return data;
    })
    .finally(() => {
      baseContextInflight = null;
    });

  return baseContextInflight;
}

function resolveFocusedRepoName(
  repos: BaseRepoContext[],
  options: { scopedRepoRoot?: string | null; preferredRepoName?: string | null },
) {
  const preferredRepoName = safeTrim(options.preferredRepoName);
  if (preferredRepoName) return preferredRepoName;

  const scopedRepoRoot = safeTrim(options.scopedRepoRoot);
  if (scopedRepoRoot) {
    const scoped = repos.find((repo) => path.resolve(repo.localPath) === path.resolve(scopedRepoRoot));
    if (scoped) return scoped.name;
  }

  return repos[0]?.name ?? null;
}

function resolveReadyRepoCount(repos: BaseRepoContext[]) {
  const readyCount = repos.filter((repo) => repo.readinessState === 'ready').length;
  const knownStates = repos.some((repo) => repo.readinessState !== 'unknown');
  if (!knownStates) return repos.length;
  return readyCount;
}

function buildStatsLine(profile: PersonalizedChatFtuxProfile) {
  const repoLabel = profile.readyRepoCount === 1 ? 'repo' : 'repos';
  const runtimeLabel = profile.runtimeCount === 1 ? 'runtime' : 'runtimes';
  return `${profile.readyRepoCount} ${repoLabel} ready. ${profile.runtimeCount} ${runtimeLabel} detected.`;
}

function topicSentenceLabel(topic: string) {
  if (topic === 'Auth systems') return 'auth systems';
  return topic;
}

function buildTopicsLine(topics: string[]) {
  if (topics.length === 0) return null;
  return `Looks like you're into ${joinNaturalLanguage(topics.map(topicSentenceLabel))}.`;
}

function dedupePrompts(prompts: PersonalizedChatPrompt[]) {
  const seen = new Set<string>();
  return prompts.filter((prompt) => {
    if (seen.has(prompt.text)) return false;
    seen.add(prompt.text);
    return true;
  });
}

function buildPromptSet(profile: PersonalizedChatFtuxProfile) {
  const repoName = profile.focusedRepoName ?? profile.repoNames[0] ?? '';
  const repoLabel = repoName || 'this codebase';
  const architectureText = repoName ? `Map the ${repoName} architecture` : 'Explain this codebase architecture';
  const reviewText = repoName ? `Review the latest changes in ${repoName}` : 'Review the latest changes in the codebase';
  const issueRepo = profile.repoNames.find((name) => name.toLowerCase() === 'o8' || name.toLowerCase() === 'cortex-ide')
    ?? repoName
    ?? profile.repoNames[0]
    ?? 'this repo';
  const hasTopics = profile.topics.length > 0;

  const prompts: PersonalizedChatPrompt[] = hasTopics
    ? [
        {
          iconKey: 'tree',
          text: repoName ? `Pick up your ${repoName} work` : 'Pick up your current project',
          description: repoName ? `Continue the active work in ${repoName}` : 'Resume a recent thread with context',
        },
        {
          iconKey: 'diff',
          text: `Triage open issues in ${issueRepo}`,
          description: 'Prioritize the GitHub work that needs attention next',
        },
        profile.topics.some((topic) => topic === 'Auth systems')
          ? {
              iconKey: 'file',
              text: 'Explain how the auth system works',
              description: 'Trace the login, session, and access flow end to end',
            }
          : profile.topics.some((topic) => topic === 'GitHub workflows')
            ? {
                iconKey: 'search',
                text: reviewText,
                description: 'Summarize what moved recently and what deserves a closer look',
              }
            : {
                iconKey: 'rocket',
                text: `What should we optimize in ${repoLabel}?`,
                description: 'Find the highest-leverage improvements first',
              },
        {
          iconKey: 'search',
          text: architectureText,
          description: 'Explain the main surfaces, flows, and seams in the codebase',
        },
      ]
    : [
        {
          iconKey: 'tree',
          text: repoName ? `Explain the ${repoName} architecture` : 'Explain this codebase architecture',
          description: 'Map the structure, boundaries, and main entry points',
        },
        {
          iconKey: 'search',
          text: repoName ? `Find TODOs in ${repoName}` : 'Find TODO comments in the code',
          description: 'Surface technical debt and unfinished edges quickly',
        },
        {
          iconKey: 'rocket',
          text: repoName ? `What should we optimize in ${repoName}?` : 'What could be optimized here?',
          description: 'Identify the biggest quality and performance wins',
        },
        {
          iconKey: 'diff',
          text: repoName ? `Review the latest changes in ${repoName}` : 'Review the most recent changes',
          description: 'Inspect recent edits for regressions, risk, and follow-up work',
        },
      ];

  return dedupePrompts(prompts).slice(0, 4);
}

function buildSystemContext(profile: PersonalizedChatFtuxProfile) {
  const lines = [
    'Fresh chat profile context:',
    profile.name ? `- User name: ${profile.name}` : null,
    profile.username ? `- GitHub username: ${profile.username}` : null,
    profile.focusedRepoName ? `- Focus repo: ${profile.focusedRepoName}` : null,
    profile.repoNames.length > 0 ? `- Registered repos: ${profile.repoNames.slice(0, 4).join(', ')}` : null,
    `- Ready repos: ${profile.readyRepoCount}`,
    profile.runtimeNames.length > 0 ? `- Detected runtimes: ${profile.runtimeNames.join(', ')}` : null,
    profile.topics.length > 0 ? `- Inferred interests: ${profile.topics.join(', ')}` : null,
    '- This is the first reply in a brand-new chat. Be warm, concise, and naturally aware of the profile when it helps.',
    '- Reference the repo or interests only when relevant. Do not overstate certainty or invent prior conversations.',
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
}

export async function getPersonalizedChatFtuxPayload(options: {
  userName?: string | null;
  scopedRepoRoot?: string | null;
  preferredRepoName?: string | null;
  now?: Date;
} = {}): Promise<PersonalizedChatFtuxPayload> {
  const base = await getBaseContext();
  const name = safeTrim(options.userName) ?? base.fallbackName;
  const focusedRepoName = resolveFocusedRepoName(base.repos, options);
  const repoNames = base.repos.slice(0, 4).map((repo) => repo.name);

  const profile: PersonalizedChatFtuxProfile = {
    name,
    username: base.username,
    focusedRepoName,
    repoNames,
    readyRepoCount: resolveReadyRepoCount(base.repos),
    runtimeCount: base.runtimeNames.length,
    runtimeNames: base.runtimeNames,
    topics: base.topics,
  };

  return {
    greeting: {
      headline: resolveHeadline(name, options.now ?? new Date()),
      statsLine: buildStatsLine(profile),
      topicsLine: buildTopicsLine(profile.topics),
    },
    prompts: buildPromptSet(profile),
    profile,
    systemContext: buildSystemContext(profile),
  };
}
