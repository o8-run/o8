/**
 * #2446 — advisory rule citations on the merge preview.
 *
 * Real-path doctrine: every case drives the real `previewPacketMerge` on a
 * real git repo whose packet branch changes files against main. The repo's
 * CLAUDE.md is ingested through the real `ingestRepoSpecs`, so the rules are
 * read from the directive index with their ingested ids. The provider setting
 * comes from the real operator-defaults store, the key from the data-dir key
 * file, and every call goes over HTTP to the local judgment endpoint fixture.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { dirname, join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';

const h = vi.hoisted(() => ({
  /** Baseline switch: behave as if preview-merge had no citation hook. */
  withoutHook: false,
}));

vi.mock('@/lib/judgment/directive-citations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/judgment/directive-citations')>();
  return {
    ...actual,
    directiveCitationsForPreview: (...args: Parameters<typeof actual.directiveCitationsForPreview>) => (
      h.withoutHook ? Promise.resolve(undefined) : actual.directiveCitationsForPreview(...args)
    ),
  };
});

const originalEnv = { CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR, O8_DATA_DIR: process.env.O8_DATA_DIR };
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-directive-citations-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const OPERATOR_TOKEN = 'operator-ws-token-directive-citations-2446-abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf-8');

const { getSqlite } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { previewPacketMerge } = await import('@/lib/lane/preview-merge');
const { ingestRepoSpecs } = await import('@/lib/cortex/spec-ingest');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const {
  LOCKED_RULES, MAX_DIRECTIVES_PER_FILE, readDirectiveRules, selectRulesForPath,
  setDirectiveCitationsTransportForTests, waitForDirectiveCitations,
} = await import('@/lib/judgment/directive-citations');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const reviewStateRoute = await import('@/app/api/orchestrator/review-state/route');

const KEY = 'ts-fixture-key-directive-citations-2446';
const PACKET_TITLE = 'Polish the settings card';

const CLAUDE_MD = `# Repo rules

Intro text for the overview section of this repo spec file.

## Critical Rules

### NEVER
- **Never spread \`...statusResult\` AFTER session data** — the status response clobbers sessions.
- **Never use CSS classes** — inline styles only (\`style={{ }}\` props). iOS Safari reliability issue. This is permanent.
- **Never hardcode rgba colors for surfaces** — use \`var(--t-bg-card)\`, \`var(--t-panel)\`, \`var(--t-input-bg)\`.
- **Never hardcode API/WS ports** — use \`getApiBase()\` from \`@/lib/panel/api-port\`.
- **Never hardcode \`/Users/example/*\` paths** — use \`process.cwd()\`, \`os.homedir()\`, or an explicit env var.
- **Never use CSS shorthand** — use \`paddingTop\`/\`paddingLeft\`, not \`padding: "8px 16px"\`.
- **Never throw in API routes** — return structured error responses.
`;

let fixture: JudgmentEndpointFixture;
const gitDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeRepoFile(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A real repo with the rules in CLAUDE.md on main, ingested, and a packet branch changing `files`. */
async function setupPacket(packetId: string, files: Record<string, string>) {
  const root = mkdtempSync(join(os.tmpdir(), `dircite-${packetId}-`));
  gitDirs.push(root);
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'o8-test']);
  git(root, ['config', 'user.email', 'o8@example.test']);
  writeRepoFile(root, 'CLAUDE.md', CLAUDE_MD);
  writeRepoFile(root, 'README.md', 'directive citations\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['checkout', '-b', `inline/${packetId}`]);
  for (const [path, content] of Object.entries(files)) writeRepoFile(root, path, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'packet change']);
  const repoPath = realpathSync(root);
  await ingestRepoSpecs(repoPath);
  const lane = createLane({
    repoPath, worktreePath: repoPath, branch: `inline/${packetId}`, baseBranch: 'main',
    runtime: 'codex', label: PACKET_TITLE, packetId,
  });
  return { lane, repoPath };
}

/** The ingested directive row holding the rules, read straight from the index spec-ingest writes. */
function ingestedRulesRow(repoPath: string): { id: string; body: string } {
  const slug = repoPath.split('/').pop()!.toLowerCase();
  const rows = getSqlite().prepare(`SELECT directive_id AS id, body FROM directives_fts WHERE directive_id LIKE ?`)
    .all(`spec-ingest:${slug}:claude:critical-rules%`) as Array<{ id: string; body: string }>;
  expect(rows).toHaveLength(1);
  return rows[0];
}

const ruleId = (directiveId: string, key: string) => `${directiveId}#${key}`;

function reply(scores: Record<string, number>) {
  return {
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: Object.fromEntries(Object.entries(scores).map(([id, noul]) => [id, { type: 'noul', noul }])),
      usage: { input_tokens: 1800, output_tokens: 12 },
    },
  };
}

function laneEvents(laneId: string, verb: string) {
  return (getSqlite().prepare('SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = ? ORDER BY rowid')
    .all(laneId, verb) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
}

/** First preview starts the detached calls; the second, after they settle, reads the recorded result. */
async function previewSettled(packetId: string, laneId: string) {
  const first = await previewPacketMerge(packetId);
  expect(first.directiveCitations?.status).toBe('pending');
  await waitForDirectiveCitations(laneId);
  return previewPacketMerge(packetId);
}

beforeAll(async () => {
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  fixture = await startJudgmentEndpointFixture();
  setDirectiveCitationsTransportForTests({ endpoint: fixture.endpoint, timeoutMs: 2_000, maxAttempts: 1 });
  writeFileSync(judgmentKeyPath(), `${KEY}\n`);
  chmodSync(judgmentKeyPath(), 0o600);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

beforeEach(async () => {
  fixture.reset();
  h.withoutHook = false;
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
});

afterAll(async () => {
  setDirectiveCitationsTransportForTests(undefined);
  vi.restoreAllMocks();
  await fixture.close();
  for (const dir of gitDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('advisory rule citations on the merge preview', () => {
  it('cites the CSS-classes rule, quoted as stored, for a component that adds a className', async () => {
    const { lane, repoPath } = await setupPacket('pkt-cite-css', {
      'src/components/Foo.tsx': 'export function Foo() {\n  return <div className="x">foo</div>;\n}\n',
    });
    const row = ingestedRulesRow(repoPath);
    const ids = ['css-classes', 'rgba-surfaces', 'css-shorthand', 'hardcoded-ports', 'users-paths'].map((key) => ruleId(row.id, key));
    fixture.replies.push(reply(Object.fromEntries(ids.map((id) => [id, id.endsWith('#css-classes') ? 0.93 : 0.04]))));

    const preview = await previewSettled('pkt-cite-css', lane.id);

    expect(preview.directiveCitations?.status).toBe('ready');
    expect(preview.directiveCitations?.citations).toHaveLength(1);
    const [citation] = preview.directiveCitations!.citations;
    expect(citation.directiveId).toBe(row.id);
    expect(row.body.split('\n')).toContain(citation.ruleText);
    expect(citation.ruleText).toBe('- **Never use CSS classes** — inline styles only (`style={{ }}` props). iOS Safari reliability issue. This is permanent.');
    expect(citation).toMatchObject({ path: 'src/components/Foo.tsx', probability: 0.93 });

    expect(fixture.seen).toHaveLength(1);
    const body = fixture.seen[0].body as { state: Record<string, unknown>; questions: Record<string, unknown> };
    expect(Object.keys(body.questions).sort()).toEqual([...ids].sort());
    expect(Object.keys(body.state).sort()).toEqual(['file', 'hunk', 'rules']);
    expect(body.state.file).toEqual({ path: 'src/components/Foo.tsx', added: 3, removed: 0 });
    expect((body.state.rules as Record<string, { text: string }>)[ruleId(row.id, 'css-classes')].text).toBe(citation.ruleText);
    expect(JSON.stringify(body)).not.toContain(PACKET_TITLE);

    const receipts = laneEvents(lane.id, 'judgment');
    expect(receipts).toHaveLength(1);
    expect(citation.receiptId).toBe(receipts[0].receiptId);
    expect(preview.directiveCitations?.receiptIds).toEqual([receipts[0].receiptId]);
    expect(receipts[0]).toMatchObject({
      ok: true,
      surface: 'directive-citations',
      packetId: 'pkt-cite-css',
      selection: { recipe: 'critical-rules-never-v1', path: 'src/components/Foo.tsx', directiveIds: ids, exemptions: [] },
    });
    // Nothing in the gate reads the citation.
    expect(preview.blockers).not.toContain('directive-citations');
  }, 60_000);

  it('sends nothing and cites nothing for a docs-only diff', async () => {
    const { lane } = await setupPacket('pkt-cite-docs', { 'README.md': 'directive citations\n\nMore docs.\n' });

    const preview = await previewSettled('pkt-cite-docs', lane.id);

    expect(fixture.seen).toHaveLength(0);
    expect(preview.directiveCitations).toEqual({ status: 'ready', citations: [], receiptIds: [] });
    expect(laneEvents(lane.id, 'judgment')).toHaveLength(0);
  }, 60_000);

  it('asks an API route only about the throw, ports, and /Users/ rules', async () => {
    const { lane, repoPath } = await setupPacket('pkt-cite-route', {
      'src/app/api/thing/route.ts': "export async function GET() {\n  throw new Error('boom');\n}\n",
    });
    const row = ingestedRulesRow(repoPath);
    const ids = ['throw-in-api-routes', 'hardcoded-ports', 'users-paths'].map((key) => ruleId(row.id, key));
    fixture.replies.push(reply(Object.fromEntries(ids.map((id) => [id, id.endsWith('#throw-in-api-routes') ? 0.88 : 0.02]))));

    const preview = await previewSettled('pkt-cite-route', lane.id);

    expect(fixture.seen).toHaveLength(1);
    expect(Object.keys((fixture.seen[0].body as { questions: object }).questions).sort()).toEqual([...ids].sort());
    expect(preview.directiveCitations?.citations.map((citation) => citation.ruleId)).toEqual([ruleId(row.id, 'throw-in-api-routes')]);
  }, 60_000);

  it('exempts test files from the ports and /Users/ rules and cites nothing', async () => {
    const { lane, repoPath } = await setupPacket('pkt-cite-tests', {
      'src/lib/paths.test.ts': "export const fixturePath = '/Users/x/repo';\n",
      'src/components/Widget.test.tsx': "export const home = '/Users/x';\n",
    });
    const row = ingestedRulesRow(repoPath);
    const ids = ['css-classes', 'rgba-surfaces', 'css-shorthand'].map((key) => ruleId(row.id, key));
    fixture.replies.push(reply(Object.fromEntries(ids.map((id) => [id, 0.03]))));

    const preview = await previewSettled('pkt-cite-tests', lane.id);

    // Only the component test is asked, and never about ports or /Users/.
    expect(fixture.seen).toHaveLength(1);
    expect(Object.keys((fixture.seen[0].body as { questions: object }).questions).sort()).toEqual([...ids].sort());
    expect(preview.directiveCitations?.citations).toEqual([]);
    const [record] = laneEvents(lane.id, 'directive_citations') as Array<{ files: Array<{ path: string; asked: string[]; exemptions: string[] }> }>;
    expect(record.files).toEqual([
      expect.objectContaining({ path: 'src/components/Widget.test.tsx', asked: ids, exemptions: ['hardcoded-ports', 'users-paths'] }),
      expect.objectContaining({ path: 'src/lib/paths.test.ts', asked: [], exemptions: ['hardcoded-ports', 'users-paths'] }),
    ]);
  }, 60_000);

  it('records the CSS-shorthand answer as held back and never cites it', async () => {
    const { lane, repoPath } = await setupPacket('pkt-cite-shorthand', {
      'src/components/Bar.tsx': "export function Bar() {\n  return <div style={{ padding: '8px 16px' }}>bar</div>;\n}\n",
    });
    const row = ingestedRulesRow(repoPath);
    const ids = ['css-classes', 'rgba-surfaces', 'css-shorthand', 'hardcoded-ports', 'users-paths'].map((key) => ruleId(row.id, key));
    fixture.replies.push(reply(Object.fromEntries(ids.map((id) => [id, id.endsWith('#css-shorthand') ? 0.9 : 0.05]))));

    const preview = await previewSettled('pkt-cite-shorthand', lane.id);

    expect(preview.directiveCitations?.citations).toEqual([]);
    const [record] = laneEvents(lane.id, 'directive_citations') as Array<{ scores: Array<{ ruleId: string; probability: number; heldBack?: boolean }> }>;
    expect(record.scores.find((score) => score.ruleId === ruleId(row.id, 'css-shorthand'))).toMatchObject({ probability: 0.9, heldBack: true });
    expect(record.scores.filter((score) => score.heldBack)).toHaveLength(1);
  }, 60_000);

  it('leaves the preview JSON byte-identical and sends nothing when judgment.provider is off', async () => {
    const { lane } = await setupPacket('pkt-cite-off', {
      'src/components/Foo.tsx': 'export function Foo() {\n  return <div className="x">foo</div>;\n}\n',
    });
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    h.withoutHook = true;
    const baseline = JSON.stringify(await previewPacketMerge('pkt-cite-off'));
    h.withoutHook = false;
    const off = JSON.stringify(await previewPacketMerge('pkt-cite-off'));

    expect(off).toBe(baseline);
    expect(off).not.toContain('directiveCitations');
    expect(fixture.seen).toHaveLength(0);
    expect(laneEvents(lane.id, 'judgment')).toHaveLength(0);
    expect(laneEvents(lane.id, 'directive_citations')).toHaveLength(0);
  }, 60_000);

  it('spends nothing on the review-state banner, which never shows citations; the merge preview still asks', async () => {
    const { lane, repoPath } = await setupPacket('pkt-cite-banner', {
      'src/components/Foo.tsx': 'export function Foo() {\n  return <div className="x">foo</div>;\n}\n',
    });
    const response = await reviewStateRoute.GET(new NextRequest(
      'http://localhost:3001/api/orchestrator/review-state?packetId=pkt-cite-banner',
      { headers: { host: 'localhost:3001', authorization: `Bearer ${OPERATOR_TOKEN}` } },
    ));
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    await waitForDirectiveCitations(lane.id);

    expect(text).toContain('pkt-cite-banner');
    expect(fixture.seen).toHaveLength(0);
    expect(laneEvents(lane.id, 'directive_citations')).toHaveLength(0);
    expect(text).not.toContain('directiveCitations');

    const row = ingestedRulesRow(repoPath);
    const ids = ['css-classes', 'rgba-surfaces', 'css-shorthand', 'hardcoded-ports', 'users-paths'].map((key) => ruleId(row.id, key));
    fixture.replies.push(reply(Object.fromEntries(ids.map((id) => [id, 0.05]))));
    await previewSettled('pkt-cite-banner', lane.id);
    expect(fixture.seen).toHaveLength(1);
  }, 60_000);

  it('asks at most five rules per file under the path recipe', () => {
    const rules = LOCKED_RULES.map((locked) => ({ ruleId: `d#${locked.key}`, directiveId: 'd', key: locked.key, text: locked.sentence, heldBack: locked.heldBack }));
    const paths = ['src/components/a/B.tsx', 'src/components/B.test.tsx', 'src/app/api/route.ts', 'src/app/api/x/y/route.ts', 'src/lib/x.ts', 'src/x.tsx', 'tests/x.ts', 'src/lib/panel/port-constants.ts', 'README.md'];
    const counts = paths.map((path) => selectRulesForPath(path, rules).asked.length);
    expect(Math.max(...counts)).toBe(MAX_DIRECTIVES_PER_FILE);
    expect(counts).toEqual([5, 3, 3, 3, 2, 4, 0, 1, 0]);
    // A repo without the rules asks nothing and records which were missing.
    expect(readDirectiveRules('/nowhere/unknown-repo')).toEqual({ rules: [], missing: LOCKED_RULES.map((locked) => locked.key) });
  });
});
