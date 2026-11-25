// Deterministic scale fixtures for the interaction-performance harness.
// The fixture set is a function of (scale, seed) only: the same inputs always
// produce the same registry, the same workspace tabs, and the same digest, so
// two runs on different machines measure the same workload.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_FIXTURE_SEED = 16970;
export const FIXTURE_SCALES = Object.freeze([50, 250, 1000]);
export const QUICK_FIXTURE_SCALES = Object.freeze([50]);
export const FIXTURE_REPO_PREFIX = 'o8-fixture-repo';
export const DEFAULT_FIXTURE_PROJECT = Object.freeze({ id: 'default', name: 'Workspace' });
const BRANCHES = Object.freeze(['main', 'develop', 'release', 'hotfix', 'next']);

// Deterministic 32-bit PRNG. Seeded per fixture so the generated shape never
// depends on wall-clock time, machine, or run order.
export function createRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export function fixtureRepoName(index) {
  return `${FIXTURE_REPO_PREFIX}-${String(index).padStart(4, '0')}`;
}

// The plan is path-free on purpose: absolute paths depend on the temp dir, and
// a digest that changes every run cannot prove two runs used the same workload.
export function buildFixturePlan(scale, seed = DEFAULT_FIXTURE_SEED) {
  if (!Number.isInteger(scale) || scale < 1) throw new Error(`fixture scale must be a positive integer, received ${scale}`);
  const random = createRandom(seed + scale);
  const repos = Array.from({ length: scale }, (_, index) => ({
    name: fixtureRepoName(index + 1),
    defaultBranch: BRANCHES[Math.floor(random() * BRANCHES.length)],
    // The registry orders repos by last-opened; a deterministic spread keeps
    // the list order stable without depending on filesystem mtimes.
    lastOpenedOffsetMinutes: Math.floor(random() * 10_000),
  }));
  const tabs = [
    {
      id: 'fixture-agent',
      label: 'Agent',
      kind: 'orchestrator',
      orchestratorThreadId: 'thoughts-interaction-fixture',
      mode: 'fleet',
    },
    { id: 'fixture-chat', label: 'Assistant', kind: 'llm-chat' },
    { id: 'fixture-terminal', label: 'Terminal', kind: 'terminal', cliAgent: 'shell' },
    {
      id: 'fixture-canvas',
      label: 'Canvas',
      kind: 'canvas',
      canvasTab: {
        id: 'interaction-fixture-welcome',
        kind: 'welcome',
        label: 'Welcome',
        resourceId: 'interaction-fixture',
      },
    },
  ];
  return { scale, seed, repos, tabs };
}

export function fixtureDigest(plan) {
  return createHash('sha256').update(JSON.stringify({
    schema: 'o8/interaction-fixture/v1',
    scale: plan.scale,
    seed: plan.seed,
    repos: plan.repos,
    tabs: plan.tabs,
    project: DEFAULT_FIXTURE_PROJECT,
    designPage: designFixturePage(plan.seed).digest,
  })).digest('hex').slice(0, 16);
}

function repoEntry(plan, repo, index, repoPath, epochMs) {
  return {
    id: repo.name,
    name: repo.name,
    localPath: repoPath,
    remoteUrl: null,
    defaultBranch: repo.defaultBranch,
    isGitRepo: true,
    addedAt: new Date(epochMs).toISOString(),
    lastOpenedAt: new Date(epochMs + index * 1000 + repo.lastOpenedOffsetMinutes * 60_000).toISOString(),
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'copy',
      envFiles: ['.env', '.env.local'],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'auto',
    },
  };
}

function initTemplateRepo(templateDir) {
  fs.mkdirSync(templateDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: templateDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(templateDir, 'fixture.txt'), 'interaction fixture\n');
  execFileSync('git', ['add', 'fixture.txt'], { cwd: templateDir, stdio: 'ignore' });
  execFileSync('git', [
    '-c', 'user.name=o8 fixture',
    '-c', 'user.email=fixture@invalid',
    'commit', '-qm', 'fixture',
  ], { cwd: templateDir, stdio: 'ignore' });
}

// Materializes the plan into an isolated data dir. Nothing here touches
// ~/.o8 or any live operator state: the caller passes the dir to the stack as
// CORTEX_IDE_DATA_DIR and deletes it during cleanup.
export function materializeFixture(plan, { root = os.tmpdir() } = {}) {
  // Realpath matters: on macOS os.tmpdir() is a symlink (/var → /private/var),
  // and the repo registry filters saved workspace state against realpathed repo
  // roots. A symlinked fixture path silently loses every seeded tab.
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(root, `o8-interactions-${plan.scale}-`)));
  const reposRoot = path.join(dataDir, 'fixture-repos');
  const templateDir = path.join(reposRoot, plan.repos[0].name);
  initTemplateRepo(templateDir);
  const epochMs = Date.UTC(2026, 0, 1);
  const registry = [];
  for (const [index, repo] of plan.repos.entries()) {
    const repoPath = path.join(reposRoot, repo.name);
    if (index > 0) fs.cpSync(templateDir, repoPath, { recursive: true });
    registry.push(repoEntry(plan, repo, index, repoPath, epochMs));
  }
  fs.mkdirSync(path.join(dataDir, 'terminal-states'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'chat-history'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'setup.json'), JSON.stringify({ setupComplete: true, skippedSteps: [] }));
  fs.writeFileSync(path.join(dataDir, 'settings.toml'), [
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: registry }));
  // The left panel lists repositories inside a project, so without a project
  // ledger the generated fleet never reaches a rendered surface. This uses the
  // app's own default project shape rather than inventing one.
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
    projects: [{
      id: DEFAULT_FIXTURE_PROJECT.id,
      name: DEFAULT_FIXTURE_PROJECT.name,
      repoPaths: registry.map((repo) => repo.localPath),
      createdAt: new Date(epochMs).toISOString(),
      color: '#5b8db8',
    }],
    activeProjectId: DEFAULT_FIXTURE_PROJECT.id,
  }));
  fs.writeFileSync(path.join(dataDir, 'terminal-states', 'tile-root.json'), JSON.stringify({
    version: 1,
    // The shipped default hides the experimental casual-chat tab. Make the
    // normal Orchestrator composer active so first-interaction timing measures
    // a real operator path instead of waiting for a hidden tab to fall back.
    activeTabId: 'fixture-agent',
    tabs: plan.tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      kind: tab.kind,
      cliAgent: tab.cliAgent ?? 'shell',
      repoName: registry[0].name,
      repoPath: registry[0].localPath,
      orchestratorThreadId: tab.orchestratorThreadId,
      mode: tab.mode,
      canvasTab: tab.canvasTab,
    })),
    savedAt: new Date(epochMs).toISOString(),
  }));
  fs.writeFileSync(path.join(dataDir, 'chat-history', 'thoughts-interaction-fixture.json'), JSON.stringify({
    title: 'Interaction fixture',
    repoName: registry[0].name,
    repoPath: registry[0].localPath,
    savedAt: new Date(epochMs).toISOString(),
    messages: [],
  }));
  // No project ledger is seeded on purpose. A seeded projects.json left the
  // workspace empty (no orchestrator surface, no composer), which removes the
  // input path this harness exists to measure. The fleet therefore reaches the
  // app through the repository registry only; see the reachability note in
  // docs/operations/interaction-performance-budgets.md.
  return {
    dataDir,
    repoDir: templateDir,
    reposRoot,
    project: DEFAULT_FIXTURE_PROJECT,
    tabs: plan.tabs,
    repoNames: registry.map((repo) => repo.name),
    repoCount: registry.length,
    digest: fixtureDigest(plan),
  };
}

// The Design Mode fixture page. Design Mode arms over the embedded browser
// pane, so the scenario needs a page to draw on; a generated, seeded one keeps
// the target geometry identical between runs and between machines.
export function designFixturePage(seed = DEFAULT_FIXTURE_SEED) {
  const random = createRandom(seed + 7717);
  const blocks = Array.from({ length: 12 }, (_, index) => ({
    id: `design-block-${String(index + 1).padStart(2, '0')}`,
    hue: Math.floor(random() * 360),
    height: 48 + Math.floor(random() * 24),
  }));
  const html = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>o8 interaction fixture</title>',
    '<style>',
    'body{margin:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#111}',
    '#design-fixture-root{padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px}',
    '.design-block{border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600}',
    '</style></head><body>',
    '<h1 id="design-fixture-title">o8 interaction fixture</h1>',
    '<div id="design-fixture-root">',
    ...blocks.map((block) => (
      `<div class="design-block" id="${block.id}" data-fixture-block="${block.id}" `
      + `style="height:${block.height}px;background:hsl(${block.hue} 62% 46%)">${block.id}</div>`
    )),
    '</div></body></html>',
  ].join('\n');
  return {
    html,
    blocks,
    digest: createHash('sha256').update(html).digest('hex').slice(0, 16),
    targetBlockId: blocks[0].id,
  };
}
