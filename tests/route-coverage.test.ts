/**
 * Filesystem-driven middleware policy coverage (RF-2 class-killer).
 *
 * WHY THIS EXISTS — the "green tests encode the premise" gap. A hand-written
 * gate suite (tests/middleware-gate.test.ts) only exercises the routes the
 * author remembered to list. A route added later with no gate ships silently.
 * This suite discovers routes the way Next.js does — by walking
 * `src/app/api/**\/route.ts` on disk — and asserts EVERY real route resolves to
 * an explicit middleware policy. A new route (or a new public allowlist entry
 * nobody mirrored here) FAILS the build instead of shipping unclassified.
 *
 * The policy manifest below mirrors src/middleware.ts. Each discovered route is
 * classified into exactly one of {self-auth, public-any, public-read,
 * loopback-read, spectator-read, gated} and
 * the middleware's ACTUAL behavior (from LAN, from loopback) is asserted to
 * match. Default is `gated` — an unclassified route that the middleware lets
 * through from LAN trips the `else → expect deny` branch and reddens the suite.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
}));

const TEST_TOKEN = 'vitest-route-coverage-token-0123456789';
const SPECTATOR_TOKEN = 'vitest-route-coverage-spectator-0123456789';
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-route-cov-'));
writeFileSync(path.join(dataDir, 'ws-token'), `${TEST_TOKEN}\n`, 'utf-8');
writeFileSync(
  path.join(dataDir, 'broadcast-spectator-tokens'),
  `${createHash('sha256').update(SPECTATOR_TOKEN).digest('hex')}\n`,
  'utf-8',
);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { panelGateMiddleware } = await import('@/middleware');

// ── Route discovery — walk the ACTUAL filesystem, same source of truth as Next.

const API_ROOT = path.join(process.cwd(), 'src', 'app', 'api');

function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkRouteFiles(full));
    } else if (entry === 'route.ts' || entry === 'route.tsx') {
      out.push(full);
    }
  }
  return out;
}

/**
 * File path → concrete request pathname, exactly how Next.js maps the App
 * Router: strip the `src/app` prefix + `/route.ts`, drop `(route-group)`
 * segments, and substitute dynamic segments with a concrete value so the path
 * is a real URL the middleware can classify.
 */
function fileToPathname(file: string): string {
  const rel = path.relative(path.join(process.cwd(), 'src', 'app'), file);
  const segments = rel
    .split(path.sep)
    .slice(0, -1) // drop the route.ts filename
    .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')'))) // route groups are path-invisible
    .map((seg) => {
      if (seg.startsWith('[[...') && seg.endsWith(']]')) return 'seg/sub'; // optional catch-all
      if (seg.startsWith('[...') && seg.endsWith(']')) return 'seg/sub'; // catch-all
      if (seg.startsWith('[') && seg.endsWith(']')) return 'seg'; // dynamic
      return seg;
    });
  return `/${segments.join('/')}`;
}

const routeFiles = walkRouteFiles(API_ROOT);
const routes = routeFiles.map((file) => ({ file, pathname: fileToPathname(file) }));

const ALLOWED_ROUTE_EXPORTS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'runtime',
  'dynamic',
  'revalidate',
  'fetchCache',
  'preferredRegion',
  'maxDuration',
  'generateStaticParams',
]);
const ROUTE_HANDLER_EXPORTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.getModifiers(node as ts.HasModifiers)?.some((modifier) => modifier.kind === kind));
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  ));
}

function routeShapeErrors(file: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const relativeFile = path.relative(process.cwd(), file);
  const errors: string[] = [];
  const localDeclarations = new Map<string, ts.FunctionDeclaration | ts.VariableDeclaration>();
  const exportedBindings = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      localDeclarations.set(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) localDeclarations.set(name, declaration);
      }
    }
  }

  function recordExport(exportedName: string, localName = exportedName): void {
    if (!ALLOWED_ROUTE_EXPORTS.has(exportedName)) {
      errors.push(`${relativeFile} exports unsupported route field "${exportedName}"`);
    }
    if (ROUTE_HANDLER_EXPORTS.has(exportedName)) exportedBindings.set(exportedName, localName);
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      recordExport('default');
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
        recordExport('*');
        continue;
      }
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) recordExport(element.name.text, element.propertyName?.text ?? element.name.text);
      }
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      recordExport('default');
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      recordExport(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) recordExport(name);
      }
    } else if (
      (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement))
      && statement.name
      && ts.isIdentifier(statement.name)
    ) {
      recordExport(statement.name.text);
    }
  }

  function handlerArity(localName: string, seen = new Set<string>()): number | null {
    if (seen.has(localName)) return null;
    seen.add(localName);
    const declaration = localDeclarations.get(localName);
    if (!declaration) return null;
    if (ts.isFunctionDeclaration(declaration)) return declaration.parameters.length;
    const initializer = declaration.initializer;
    if (!initializer) return null;
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      return initializer.parameters.length;
    }
    if (ts.isIdentifier(initializer)) return handlerArity(initializer.text, seen);
    return null;
  }

  for (const [exportedName, localName] of exportedBindings) {
    const arity = handlerArity(localName);
    if (arity !== null && arity > 2) {
      errors.push(`${relativeFile} exports ${exportedName} with ${arity} arguments; route handlers accept at most 2`);
    }
  }

  return errors;
}

function routeFixture(name: string, source: string): string {
  const fixtureDir = path.join(dataDir, 'route-shape-fixtures', name);
  mkdirSync(fixtureDir, { recursive: true });
  const file = path.join(fixtureDir, 'route.ts');
  writeFileSync(file, source, 'utf8');
  return file;
}

describe('route module shape', () => {
  // Parses every route file with the TypeScript compiler. On a machine under
  // load that is comfortably past the 5s default, and a timeout here fails
  // `npm run typecheck` for reasons that have nothing to do with the code.
  it('passes every route in the real API tree', () => {
    expect(routeFiles.flatMap(routeShapeErrors)).toEqual([]);
  }, 120_000);

  it('rejects a fixture route with a stray value export', () => {
    const file = routeFixture('stray-export', 'export const POST = async () => new Response();\nexport const testSeam = true;\n');
    expect(routeShapeErrors(file)).toEqual([
      expect.stringContaining('exports unsupported route field "testSeam"'),
    ]);
  });

  it('rejects a default export even when its local name is an allowed handler', () => {
    const file = routeFixture('default-export', 'export default function POST() { return new Response(); }\n');
    expect(routeShapeErrors(file)).toEqual([
      expect.stringContaining('exports unsupported route field "default"'),
    ]);
  });

  it('rejects a fixture route with a three-argument handler', () => {
    const file = routeFixture('three-argument-handler', 'export async function POST(request: Request, context: unknown, extra: unknown) { return Response.json({ request, context, extra }); }\n');
    expect(routeShapeErrors(file)).toEqual([
      expect.stringContaining('exports POST with 3 arguments; route handlers accept at most 2'),
    ]);
  });
});

// ── Policy manifest (mirrors src/middleware.ts). Adding a route to any bucket
//    here is the deliberate act of classifying a route as public — the whole
//    point is that it CANNOT happen by omission.

const SELF_AUTH = [/^\/api\/worker(\/|$)/, /^\/api\/cloud(\/|$)/, /^\/api\/github\/webhook(\/|$)/];
const PUBLIC_ANY = [
  /^\/api\/v2\/auth\/logout\/?$/,
  /^\/api\/mobile\/enroll(\/|$)/,
];
const PUBLIC_READ = [
  /^\/api\/panel\/status(\/|$)/,
  /^\/api\/v2\/auth\/session\/?$/,
  /^\/api\/mobile\/orchestrator\/backend-availability(\/|$)/,
  /^\/api\/mobile\/push\/public-key(\/|$)/,
  // #1529 — a paired phone whose saved API port moved probes this to find the
  // new one. Credential-free by design: it returns port metadata plus a
  // signature over a domain-separated transcript
  // (`o8-e2ee-v1|pairing-discovery|…`), binding the caller's nonce to the
  // server identity the device already pinned, so a rogue listener cannot
  // solicit the device credential. Exposes no bearer or enrollment material,
  // and 404s entirely unless mobile E2EE is enabled.
  /^\/api\/mobile\/pairing-discovery\/?$/,
];
const LOOPBACK_READ = [
  /^\/api\/browser\/proxy\/?$/,
  /^\/api\/browser\/engine\/view\/?$/,
  /^\/api\/panel\/proxy\/?$/,
  // o8.md inline images load as <img> tags — no bearer possible (2026-07-31).
  /^\/api\/panel\/file-asset\/?$/,
  // Boot-gate identity probe — the packaged boot page is static HTML that
  // cannot attach a bearer (v0.1.600 stuck-boot incident).
  /^\/api\/setup\/identity\/?$/,
];
const EXPLICIT_GATED = [
  /^\/api\/prompt-library(\/|$)/,
  /^\/api\/mcp\/?$/,
  /^\/api\/leases\/?$/,
  /^\/api\/orchestrator\/receipts\/?$/,
  /^\/api\/orchestrator\/ui-loop(?:\/steer)?\/?$/,
  /^\/api\/broadcast\/tokens\/?$/,
  /^\/api\/broadcast\/post\/?$/,
  /^\/api\/broadcast\/say\/?$/,
  // #1619: local Codex app-server lifecycle + streamed audio/transcript events.
  // Operator-only because it can start a local Codex thread and reads OAuth state.
  /^\/api\/voice\/realtime\/codex\/?$/,
];
const SPECTATOR_READ = [
  /^\/api\/broadcast\/events\/?$/,
  /^\/api\/broadcast\/commentary\/?$/,
  /^\/api\/broadcast\/snapshot\/?$/,
  /^\/api\/orchestrator\/truth\/?$/,
];

type Policy = 'self-auth' | 'public-any' | 'public-read' | 'loopback-read' | 'spectator-read' | 'gated';

function expectedPolicy(pathname: string): Policy {
  if (SELF_AUTH.some((p) => p.test(pathname))) return 'self-auth';
  if (PUBLIC_ANY.some((p) => p.test(pathname))) return 'public-any';
  if (PUBLIC_READ.some((p) => p.test(pathname))) return 'public-read';
  if (LOOPBACK_READ.some((p) => p.test(pathname))) return 'loopback-read';
  if (SPECTATOR_READ.some((p) => p.test(pathname))) return 'spectator-read';
  if (EXPLICIT_GATED.some((p) => p.test(pathname))) return 'gated';
  return 'gated';
}

const LAN = '192.168.1.50:3001';
const LOOPBACK = 'localhost:3001';

function status(pathname: string, method: string, host: string, bearer?: string): number {
  // Keep route-capability checks behind the new authority boundary while
  // retaining the caller's remote or loopback transport identity.
  const req = new NextRequest(`http://${LOOPBACK}${pathname}`, {
    method,
    headers: {
      host: LOOPBACK,
      'x-o8-client-addr': host === LAN ? 'o8-relay-forward' : '127.0.0.1',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
  });
  return panelGateMiddleware(req).status;
}

describe('route-coverage — every /api route resolves to an explicit middleware policy', () => {
  it('discovers a substantial number of route files (sanity: the walker works)', () => {
    // If this drops to near-zero the walker broke and every assertion below is
    // vacuously green — the exact failure mode this whole suite guards against.
    expect(routes.length).toBeGreaterThan(100);
  });

  it.each(routes.map((r) => [r.pathname, r.file] as const))(
    'classifies %s and the middleware agrees',
    (pathname) => {
      for (const method of ['GET', 'POST']) {
        const foreignHost = new NextRequest(`http://${LAN}${pathname}`, { method,
          headers: { host: LAN, authorization: `Bearer ${TEST_TOKEN}` } });
        expect(panelGateMiddleware(foreignHost).status).toBe(421);
      }
      const policy = expectedPolicy(pathname);
      const getLan = status(pathname, 'GET', LAN);
      const postLan = status(pathname, 'POST', LAN);

      // An authenticated operator can reach every route. Loopback is transport
      // context, not an identity, so it never replaces the operator bearer.
      expect(status(pathname, 'GET', LOOPBACK, TEST_TOKEN)).toBe(200);

      if (policy === 'self-auth' || policy === 'public-any') {
        // Reachable off-host by design (self-authing handler or OAuth handshake).
        expect(getLan).toBe(200);
        expect(postLan).toBe(200);
      } else if (policy === 'public-read') {
        // GET is public; writes still hit the gate.
        expect(getLan).toBe(200);
        expect(postLan).toBe(401);
      } else if (policy === 'loopback-read') {
        // Iframe navigation cannot attach a bearer, so these three read-only
        // resources use socket-truth loopback while writes remain gated.
        expect(getLan).toBe(401);
        expect(postLan).toBe(401);
        expect(status(pathname, 'GET', LOOPBACK)).toBe(200);
        expect(status(pathname, 'POST', LOOPBACK)).toBe(401);
      } else if (policy === 'spectator-read') {
        expect(getLan).toBe(401);
        expect(postLan).toBe(401);
        expect(status(pathname, 'GET', LAN, SPECTATOR_TOKEN)).toBe(200);
        expect(status(pathname, 'HEAD', LAN, SPECTATOR_TOKEN)).toBe(200);
        expect(status(pathname, 'POST', LAN, SPECTATOR_TOKEN)).toBe(403);
      } else {
        // GATED — the default. A route that reaches this branch but is silently
        // public from LAN means someone added a public route without listing it
        // in the manifest above: this assertion reddens.
        expect(getLan).toBe(401);
        expect(postLan).toBe(401);
        expect(status(pathname, 'GET', LOOPBACK)).toBe(401);
      }
    },
  );

  it('every explicit policy entry maps to a real route on disk (no stale manifest)', () => {
    // A manifest pattern that matches NO real route is dead config that hides
    // intent — force it to be pruned.
    const allClassified = [...SELF_AUTH, ...PUBLIC_ANY, ...PUBLIC_READ, ...LOOPBACK_READ, ...SPECTATOR_READ, ...EXPLICIT_GATED];
    for (const pattern of allClassified) {
      const matched = routes.some((r) => pattern.test(r.pathname));
      expect(matched, `manifest pattern ${pattern} matches no route file`).toBe(true);
    }
  });

  it('the vast majority of real routes are GATED (default-deny holds across the tree)', () => {
    const gated = routes.filter((r) => expectedPolicy(r.pathname) === 'gated');
    // Sanity floor: if this collapses, the classifier started treating routes as
    // public en masse.
    expect(gated.length).toBeGreaterThan(routes.length * 0.8);
  });
});

// ── Path-boundary / trailing-slash cases (the original fail-open class). These
//    are explicit because they probe the seam BETWEEN a public prefix and its
//    neighbors — a filesystem walk can't synthesize a `/api/workerfoo` sibling.

describe('route-coverage — path-boundary safety (trailing-slash / prefix confusion)', () => {
  it('does not leave the deleted GitHub exchange under a public v2 auth prefix', () => {
    expect(status('/api/v2/auth/github', 'GET', LAN)).toBe(401);
    expect(status('/api/v2/auth/github', 'POST', LAN)).toBe(401);
  });

  it('a gated base and its trailing-slash + child are all denied from LAN', () => {
    expect(status('/api/board', 'GET', LAN)).toBe(401);
    expect(status('/api/board/', 'GET', LAN)).toBe(401);
    expect(status('/api/board/anything', 'GET', LAN)).toBe(401);
  });

  it('a self-auth prefix does NOT leak to a look-alike sibling path', () => {
    // `/api/worker` is self-auth; `/api/workerfoo` must NOT inherit the bypass.
    expect(status('/api/worker/poll', 'POST', LAN)).toBe(200);
    expect(status('/api/workerfoo', 'POST', LAN)).toBe(401);
    expect(status('/api/worker-secrets', 'GET', LAN)).toBe(401);
  });

  it('a public-read prefix does NOT leak writes on a look-alike sibling', () => {
    expect(status('/api/panel/status', 'GET', LAN)).toBe(200); // real public read
    expect(status('/api/panel/statusfoo', 'GET', LAN)).toBe(401); // sibling is gated
  });
});
