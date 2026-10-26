import { createHash } from 'node:crypto';
import { viewerCredentialCorpus, knownViewerOperatorFixture, knownViewerDeviceFixture, knownViewerEnvironmentFixture } from './fixtures/viewer-credential-corpus';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const assignmentCases = [
  ['python triple', 'PASSWORD = """\nfixture-triple-head\nfixture-triple-tail\n"""\npublic = True\n', 'fixture-triple-tail'],
  ['python expression', 'PASSWORD = (\n    "fixture-expression-head"\n    "fixture-expression-tail"\n)\npublic = True\n', 'fixture-expression-tail'],
  ['python annotated call', 'password: str = make(\n    "fixture-call-tail"\n)\n', 'fixture-call-tail'],
  ['python comment', 'PASSWORD = (\n  # closing ) in a comment\n  "fixture-comment-tail"\n)\n', 'fixture-comment-tail'],
  ['block comment', 'PASSWORD = (\n  /* closing ) in a comment */\n  "fixture-block-comment-tail"\n)\n', 'fixture-block-comment-tail'],
  ['computed grouped', "process.env['PASS' + 'WORD'] = (\n  'fixture-computed-group-tail'\n);\n", 'fixture-computed-group-tail'],
  ['indexed grouped', 'config["password"] = (\n  "fixture-indexed-group-tail"\n)\n', 'fixture-indexed-group-tail'],
  ['short command', 'curl -u "fixture:fixture-short-option-tail"\n', 'fixture-short-option-tail'],
  ['yaml literal', 'password: |- # value\n  fixture-literal-head\n  fixture-literal-tail\npublic: true\n', 'fixture-literal-tail'],
  ['yaml folded', '"password": >-\n  fixture-folded-head\n  fixture-folded-tail\npublic: true\n', 'fixture-folded-tail'],
  ['yaml plain continuation', 'password: fixture-plain-head\n  fixture-plain-tail\npublic: true\n', 'fixture-plain-tail'],
] as const;
let root: string;
let server: Server;
let origin: string;
let authority: string;
const operator = 'fixture-review-operator-' + 'x'.repeat(32);
const rotated = 'fixture-review-rotated-' + 'y'.repeat(32);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const directReads = [
  ['/api/v2/files', () => import('@/app/api/v2/files/route')],
  ['/api/review/file', () => import('@/app/api/review/file/route')],
  ['/api/mobile/review-file', () => import('@/app/api/mobile/review-file/route')],
  ['/api/panel/file-content', () => import('@/app/api/panel/file-content/route')],
  ['/api/panel/file-diff', () => import('@/app/api/panel/file-diff/route')],
  ['/api/panel/commit-diff', () => import('@/app/api/panel/commit-diff/route')],
  ['/api/panel/commits/[hash]', () => import('@/app/api/panel/commits/[hash]/route')],
  ['/api/panel/worktree-diff', () => import('@/app/api/panel/worktree-diff/route')],
  ['/api/worktrees/diff', () => import('@/app/api/worktrees/diff/route')],
] as const;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'o8-viewer-review-'));
  vi.stubEnv('CORTEX_IDE_REVIEW_REPO_ROOT', root);
  vi.stubEnv('CORTEX_IDE_MEDIA_ROOT', root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  for (let i = 0; i < assignmentCases.length; i++) writeFileSync(join(root, `review-${i}.txt`), 'public\n');
  for (const kind of ['pem', 'python', 'yaml']) writeFileSync(join(root, `${kind}-hunks.txt`), 'public\n');
  writeFileSync(join(root, 'base.txt'), 'public\n'); git('add', '.'); git('commit', '-q', '-m', 'base'); git('checkout', '-q', '-b', 'viewer-review');
  for (let i = 0; i < assignmentCases.length; i++) writeFileSync(join(root, `review-${i}.txt`), 'pending\n');
  for (const kind of ['pem', 'python', 'yaml']) writeFileSync(join(root, `${kind}-hunks.txt`), 'pending\n');
  const { getDataDir } = await import('@/lib/data-dir-migration');
  writeFileSync(join(getDataDir(), 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'review', name: 'fixture', localPath: root }] }));
  vi.stubEnv('O8_VIEWER_FIXTURE_TOKEN', knownViewerOperatorFixture);
  vi.stubEnv('O8_VIEWER_FIXTURE_PASSWORD', knownViewerEnvironmentFixture);
  const { writeActiveTokenHashes } = await import('@/lib/mobile/device-token-file');
  writeActiveTokenHashes([createHash('sha256').update(knownViewerDeviceFixture).digest('hex')]);
  const { WS_TOKEN_PATH } = await import('@/lib/ws-auth'); writeFileSync(WS_TOKEN_PATH, operator); authority = operator;
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  server = createServer(async (req, res) => { if (!await handleNativeHttp(req, res)) res.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Listener did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
function request(route: string, params: Record<string, string> = {}, init: ConstructorParameters<typeof NextRequest>[1] = {}) {
  const url = new URL(route, origin); url.search = new URLSearchParams({ workspace: root, worktreePath: root, repoPath: root, ...params }).toString();
  const headers = new Headers(init?.headers); headers.set('authorization', `Bearer ${authority}`);
  return new NextRequest(url, { ...init, headers });
}
async function inspect(response: Response, clear: string) {
  expect([200, 206, 415]).toContain(response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  let recovered = bytes.toString('utf8');
  if (response.headers.get('content-type')?.includes('json')) {
    const visit = (value: unknown) => {
      if (typeof value === 'string') {
        recovered += value;
        if (/^data:[^,]+;base64,/.test(value)) recovered += Buffer.from(value.slice(value.indexOf(',') + 1), 'base64').toString('utf8');
      } else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(JSON.parse(bytes.toString()));
  }
  for (const match of recovered.matchAll(/data:[^,\s]+;base64,([A-Za-z0-9+/=\r\n]+)/g)) recovered += Buffer.from(match[1], 'base64').toString('utf8');
  expect(recovered.includes(clear), 'credential recoverable from response').toBe(false);
}
async function exerciseText(file: string, clear: string, sha: string, baseBranch: string) {
  for (const [route, load] of directReads) {
    const req = request(route.replace('[hash]', sha), { path: file, sha, baseBranch });
    const handler = (await load()).GET as (req: NextRequest, ctx: { params: Promise<{ hash: string }> }) => Promise<Response>;
    await inspect(await handler(req, { params: Promise.resolve({ hash: sha }) }), clear);
    await inspect(await fetch(req), clear);
  }
}

describe('security review regressions through persisted viewer routes', () => {
  it.each(assignmentCases)('%s masks complete assignment values', async (name, source, clear) => {
    const baseBranch = `review-${assignmentCases.findIndex(item => item[0] === name)}`; git('branch', baseBranch);
    const file = `${baseBranch}.txt`; writeFileSync(join(root, file), source); git('add', '--', file); git('commit', '-q', '-m', 'assignment fixture');
    const sha = git('rev-parse', 'HEAD'); writeFileSync(join(root, file), source + '\npublic edit\n');
    await exerciseText(file, clear, sha, baseBranch);
  });

  it.each(['pem', 'python', 'yaml'])('%s masks block bodies whose opening boundary is absent from diff hunks', async kind => {
    const file = `${kind}-hunks.txt`;
    const header = kind === 'pem' ? '-----BEGIN PRIVATE KEY-----' : kind === 'python' ? 'PASSWORD = """' : 'password: |';
    const footer = kind === 'pem' ? '-----END PRIVATE KEY-----' : kind === 'python' ? '"""' : 'public: true';
    const lines = Array.from({ length: 90 }, (_, index) => `${kind === 'yaml' ? '  ' : ''}fixture-block-line-${index}`);
    writeFileSync(join(root, file), [header, ...lines, footer].join('\n') + '\n');
    git('add', '--', file); git('commit', '-q', '-m', 'block baseline');
    const baseBranch = `review-${kind}-base`; git('branch', baseBranch);
    lines[30] = `${kind === 'yaml' ? '  ' : ''}fixture-${kind}-first-tail`;
    lines[70] = `${kind === 'yaml' ? '  ' : ''}fixture-${kind}-second-tail`;
    const changed = [header, ...lines, footer].join('\n') + '\n';
    writeFileSync(join(root, file), changed); git('add', '--', file); git('commit', '-q', '-m', 'block changes');
    const sha = git('rev-parse', 'HEAD');
    lines[50] = `${kind === 'yaml' ? '  ' : ''}fixture-${kind}-workspace-tail`;
    writeFileSync(join(root, file), [header, ...lines, footer].join('\n') + '\n');
    await exerciseText(file, `fixture-${kind}-second-tail`, sha, baseBranch);
    for (const [route, load] of directReads.filter(([route]) => !route.includes('commit'))) {
      const req = request(route, { path: file, sha, baseBranch });
      const handler = (await load()).GET as (req: NextRequest) => Promise<Response>;
      await inspect(await handler(req), `fixture-${kind}-workspace-tail`);
      await inspect(await fetch(req), `fixture-${kind}-workspace-tail`);
    }
  });

  it('refuses recoverable credentials in valid binary previews, including byte ranges', async () => {
    const png = makePng(operator); writeFileSync(join(root, 'metadata.png'), png);
    const { GET: preview } = await import('@/app/api/panel/file-preview/route');
    const { GET: asset } = await import('@/app/api/panel/file-asset/route');
    for (const [route, handler] of [['/api/panel/file-preview', preview], ['/api/panel/file-asset', asset]] as const) {
      const req = request(route, { path: 'metadata.png' });
      await inspect(await handler(req), operator); await inspect(await fetch(req), operator);
    }
    const start = png.indexOf(operator);
    const req = request('/api/panel/file-asset', { path: 'metadata.png' }, { headers: { range: `bytes=${start}-${start + operator.length - 1}` } });
    await inspect(await asset(req), operator); await inspect(await fetch(req), operator);
  });

  it('redacts readme and refuses credential-bearing raw SVG bytes and value-only ranges', async () => {
    writeFileSync(join(root, 'README.md'), `# Public\nPASSWORD=${operator}\n`);
    const { GET: readme } = await import('@/app/api/panel/readme/route');
    const req = request('/api/panel/readme'); await inspect(await readme(req), operator); await inspect(await fetch(req), operator);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><!-- PASSWORD=${operator} --></svg>`;
    writeFileSync(join(root, 'control.svg'), svg);
    const { GET: asset } = await import('@/app/api/panel/file-asset/route');
    const start = svg.indexOf(operator);
    for (const headers of [new Headers(), new Headers({ range: `bytes=${start}-${start + operator.length - 1}` })]) {
      const req = request('/api/panel/file-asset', { path: 'control.svg' }, { headers });
      await inspect(await asset(req), operator); await inspect(await fetch(req), operator);
    }
  });

  it.each(['data:', 'da\tta:', 'da&#9;ta:'])('masks opaque image payloads with scheme %s embedded in textual SVG', async scheme => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${scheme}image/png;base64,${makePng(operator).toString('base64')}"/></svg>`;
    writeFileSync(join(root, 'embedded.svg'), svg);
    for (const [route, handler] of [
      ['/api/panel/file-preview', (await import('@/app/api/panel/file-preview/route')).GET],
      ['/api/panel/file-asset', (await import('@/app/api/panel/file-asset/route')).GET],
      ['/api/v2/files', (await import('@/app/api/v2/files/route')).GET],
    ] as const) {
      const req = request(route, { path: 'embedded.svg' });
      for (const response of [await handler(req), await fetch(req)]) {
        expect(await response.clone().text()).not.toContain(makePng(operator).toString('base64'));
        await inspect(response, operator);
      }
    }
  });

  it('protects additional raw workspace and artifact aliases', async () => {
    const png = makePng(operator); writeFileSync(join(root, 'alias.png'), png);
    const html = `<html><body>${operator}</body></html>`;
    writeFileSync(join(root, 'o8.md'), html); writeFileSync(join(root, 'alias.txt'), html);
    const { ensureArtifactBucket, artifactRelPath, artifactAbsPath, recordArtifact } = await import('@/lib/artifacts/store');
    ensureArtifactBucket(null);
    for (const [id, kind, extension, mimeType, bytes] of [
      ['art-viewer-report', 'report', 'html', 'text/html', Buffer.from(html)],
      ['art-viewer-image', 'screenshot', 'png', 'image/png', png],
    ] as const) {
      const relPath = artifactRelPath(null, id, extension); writeFileSync(artifactAbsPath(relPath), bytes);
      recordArtifact({ id, kind, source: 'manual', relPath, mimeType });
    }
    const cases = [
      ['/api/panel/serve-image', { path: join(root, 'alias.png') }, (await import('@/app/api/panel/serve-image/route')).GET],
      ['/api/mobile/media', { path: join(root, 'alias.png') }, (await import('@/app/api/mobile/media/route')).GET],
      ['/api/panel/report-artifact', { id: 'art-viewer-report' }, (await import('@/app/api/panel/report-artifact/route')).GET],
      ['/api/panel/threads/artifact', { id: 'art-viewer-report' }, (await import('@/app/api/panel/threads/artifact/route')).GET],
      ['/api/panel/threads/artifact', { id: 'art-viewer-image' }, (await import('@/app/api/panel/threads/artifact/route')).GET],
      ['/api/repo-spec', { repoPath: root }, (await import('@/app/api/repo-spec/route')).GET],
    ] as const;
    for (const [route, params, handler] of cases) {
      const req = request(route, params); await inspect(await handler(req), operator); await inspect(await fetch(req), operator);
    }
    const { POST } = await import('@/app/api/v2/context/files/route');
    const req = request('/api/v2/context/files', {}, { method: 'POST', headers: { 'x-cortex-repo-path': root }, body: JSON.stringify({ paths: ['alias.txt'] }) });
    await inspect(await POST(new NextRequest(req.clone())), operator);
    await inspect(await fetch(req.clone()), operator);
  });

  it.each(viewerCredentialCorpus)('additional file aliases inspect corpus shape $name', async item => {
    writeFileSync(join(root, 'README.md'), item.text); writeFileSync(join(root, 'o8.md'), item.text);
    writeFileSync(join(root, 'alias.svg'), `<svg><!-- ${item.text} --></svg>`);
    const { ensureArtifactBucket, artifactRelPath, artifactAbsPath, recordArtifact } = await import('@/lib/artifacts/store');
    ensureArtifactBucket(null); const id = 'art-viewer-corpus'; const relPath = artifactRelPath(null, id, 'txt');
    writeFileSync(artifactAbsPath(relPath), item.text); recordArtifact({ id, kind: 'report', source: 'manual', relPath, mimeType: 'text/plain' });
    const cases = [
      ['/api/panel/readme', {}, (await import('@/app/api/panel/readme/route')).GET],
      ['/api/repo-spec', { repoPath: root }, (await import('@/app/api/repo-spec/route')).GET],
      ['/api/panel/file-asset', { path: 'alias.svg' }, (await import('@/app/api/panel/file-asset/route')).GET],
      ['/api/panel/serve-image', { path: join(root, 'alias.svg') }, (await import('@/app/api/panel/serve-image/route')).GET],
      ['/api/mobile/media', { path: join(root, 'alias.svg') }, (await import('@/app/api/mobile/media/route')).GET],
      ['/api/panel/report-artifact', { id }, (await import('@/app/api/panel/report-artifact/route')).GET],
      ['/api/panel/threads/artifact', { id }, (await import('@/app/api/panel/threads/artifact/route')).GET],
    ] as const;
    for (const [route, params, handler] of cases) {
      const req = request(route, params);
      for (const response of [await handler(req), await fetch(req)]) {
        expect(response.status).toBe(200);
        const header = response.headers.get('x-o8-viewer-redaction');
        const marks = header ? JSON.parse(header) : (await response.clone().json()).redaction;
        expect(marks.spans.length).toBeGreaterThan(0); await inspect(response, item.clear);
      }
    }
    const { POST } = await import('@/app/api/v2/context/files/route');
    const req = request('/api/v2/context/files', {}, { method: 'POST', headers: { 'x-cortex-repo-path': root }, body: JSON.stringify({ paths: ['README.md'] }) });
    await inspect(await POST(new NextRequest(req.clone())), item.clear); await inspect(await fetch(req), item.clear);
    const { insertTaskArtifact } = await import('@/lib/task-artifacts/store');
    const artifactId = `tart-00000000-0000-4000-8000-${String(1000 + viewerCredentialCorpus.indexOf(item)).padStart(12, '0')}`;
    const at = new Date().toISOString();
    insertTaskArtifact({ id: artifactId, schemaVersion: 1, title: 'fixture', html: `<pre>${item.text}</pre>`,
      target: { kind: 'packet', repoPath: root, packetId: 'fixture-packet', laneId: null, sessionKey: 'fixture:session', threadId: null },
      originHead: git('rev-parse', 'HEAD'), headPolicy: 'any', actions: [], state: 'live', stateReason: null, createdBy: 'operator', createdAt: at, updatedAt: at });
    const { GET } = await import('@/app/api/task-artifacts/[id]/route'); const artifactRequest = request(`/api/task-artifacts/${artifactId}`);
    await inspect(await GET(artifactRequest, { params: Promise.resolve({ id: artifactId }) }), item.clear);
    await inspect(await fetch(artifactRequest), item.clear);

  });

  it('redacts persisted interactive HTML at its direct read alias', async () => {
    const { insertTaskArtifact, getTaskArtifactById } = await import('@/lib/task-artifacts/store');
    const id = 'tart-00000000-0000-4000-8000-000000004759';
    const html = `<pre>${operator}</pre>`; const at = new Date().toISOString();
    insertTaskArtifact({ id, schemaVersion: 1, title: 'fixture', html,
      target: { kind: 'packet', repoPath: root, packetId: 'fixture-packet', laneId: null, sessionKey: 'fixture:session', threadId: null },
      originHead: git('rev-parse', 'HEAD'), headPolicy: 'any', actions: [], state: 'live', stateReason: null, createdBy: 'operator', createdAt: at, updatedAt: at });
    const route = `/api/task-artifacts/${id}`; const req = request(route);
    const { GET } = await import('@/app/api/task-artifacts/[id]/route');
    await inspect(await GET(req, { params: Promise.resolve({ id }) }), operator);
    await inspect(await fetch(req), operator); expect(getTaskArtifactById(id)?.html).toBe(html);
  });

  it.each([false, true])('keeps old masked reads read-only after token rotation, force=%s', async force => {
    const { WS_TOKEN_PATH } = await import('@/lib/ws-auth');
    const { GET, POST } = await import('@/app/api/v2/files/route');
    const { GET: readAbsolute, PUT } = await import('@/app/api/panel/file-io/route');
    for (const surface of ['relative', 'absolute']) {
      writeFileSync(WS_TOKEN_PATH, operator); authority = operator;
      const source = `public heading\n${operator}\n`; writeFileSync(join(root, 'rotation.txt'), source);
      const read = surface === 'relative' ? await GET(request('/api/v2/files', { path: 'rotation.txt' })) : await readAbsolute(request('/api/panel/file-io', { path: join(root, 'rotation.txt') }));
      const body = await read.json(); expect(body.content.includes('[redacted]')).toBe(true);
      writeFileSync(WS_TOKEN_PATH, rotated); authority = rotated;
      const data = surface === 'relative' ? { workspace: root, path: 'rotation.txt', content: `${body.content}edit\n`, expectedHash: body.contentHash, force } : { path: join(root, 'rotation.txt'), content: `${body.content}edit\n`, expectedMtimeMs: body.mtimeMs, force };
      const req = request(surface === 'relative' ? '/api/v2/files' : '/api/panel/file-io', {}, { method: surface === 'relative' ? 'POST' : 'PUT', body: JSON.stringify(data) });
      const response = surface === 'relative' ? await POST(req) : await PUT(req);
      expect(response.status).toBe(409); expect(readFileSync(join(root, 'rotation.txt'), 'utf8')).toBe(source);
    }
    writeFileSync(WS_TOKEN_PATH, operator); authority = operator;
  });

  it('preserves ordinary unmasked editor saves after rotation', async () => {
    const { GET, POST } = await import('@/app/api/v2/files/route');
    const { GET: readAbsolute, PUT } = await import('@/app/api/panel/file-io/route');
    for (const surface of ['relative', 'absolute']) {
      writeFileSync(join(root, 'ordinary.txt'), 'public source\n');
      const req = request(surface === 'relative' ? '/api/v2/files' : '/api/panel/file-io', { path: surface === 'relative' ? 'ordinary.txt' : join(root, 'ordinary.txt') });
      const opened = await (await (surface === 'relative' ? GET(req) : readAbsolute(req))).json();
      const content = opened.content + 'public edit\n';
      const body = surface === 'relative' ? { workspace: root, path: 'ordinary.txt', content, expectedHash: opened.contentHash } : { path: join(root, 'ordinary.txt'), content, expectedMtimeMs: opened.mtimeMs };
      const save = request(surface === 'relative' ? '/api/v2/files' : '/api/panel/file-io', {}, { method: surface === 'relative' ? 'POST' : 'PUT', body: JSON.stringify(body) });
      expect((await (surface === 'relative' ? POST(save) : PUT(save))).status).toBe(200);
      expect(readFileSync(join(root, 'ordinary.txt'), 'utf8')).toBe(content);
    }
  });

  it('measures the warm 1.20 MB read through the file route', async () => {
    const { GET } = await import('@/app/api/v2/files/route');
    const source = 'export const publicValue = 123;\n'.repeat(40_000).slice(0, 1_200_000);
    writeFileSync(join(root, 'large.txt'), source);
    for (let i = 0; i < 2; i++) await (await GET(request('/api/v2/files', { path: 'large.txt' }))).text();
    const timings: number[] = [];
    for (let i = 0; i < 7; i++) { const start = performance.now(); const response = await GET(request('/api/v2/files', { path: 'large.txt' })); expect((await response.json()).content).toBe(source); timings.push(performance.now() - start); }
    timings.sort((a, b) => a - b);
    console.log(JSON.stringify({ sizeBytes: Buffer.byteLength(source), warmReadMedianMs: timings[3] }));
    // Covers the whole file route (read + redaction + JSON), not just redaction.
    // The redactor itself is ~16ms for this 1.2 MB benign body (it short-circuits
    // via the TRIGGER gate); the rest is route/IO/JSON overhead that swings on a
    // shared CI runner (~27ms observed). 60ms keeps a real regression ceiling
    // while giving that variance headroom.
    expect(timings[3]).toBeLessThan(60);
  });
});

function makePng(metadata: string): Buffer {
  const crc = (bytes: Buffer) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, bytes: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); const data = Buffer.concat([Buffer.from(type), bytes]); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(data)); return Buffer.concat([size, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('tEXt', Buffer.from(`Comment\0${metadata}`)), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
