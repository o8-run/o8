/**
 * GET /api/cortex/directives
 *
 * Lists directive markdown files from the data dir's `directives/` folder.
 * Each file has YAML-like front matter: id, title, scope, repoName, priority,
 * created, updated, projects. The body below the second `---` is the
 * directive text.
 *
 * Query params:
 *   ?repoPath=<absolute-repo-path>  — optional. When supplied, the response is
 *     filtered to directives that apply to that repo using the same tier rules
 *     as the dispatch context builder (`lib/cortex/directives/filter.ts`):
 *       - global  → always included
 *       - project → included when the directive's `projects:` slug list
 *                   intersects the repo's Project memberships
 *       - repo    → included when `repoName` / `scope: <repoName>` matches
 *
 * Without the param the route returns every directive — preserves the original
 * read-only behavior for callers that want the full list.
 *
 * Response:
 *   { directives: Array<{ id, title, scope, repoName?, priority?, body, recentMerges, projects? }> }
 *
 * Surface — Recall Card (#742) and Packet Review Card (#729) consume this.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { readAllDirectiveTrailers } from '@/lib/cortex/directive-merges';
import { withTimingSync } from '@/lib/cortex/diagnostics';
import { parseDirectiveFile, type ParsedDirective } from '@/lib/cortex/directives/parse';
import { getSqlite } from '@/lib/db';
import { refreshDirectiveFts } from '@/lib/db/v14-fts5-migration';
import {
  type DirectiveProjectScope,
  directiveAppliesToRepo,
} from '@/lib/cortex/directives/filter';
import { resolveDirectiveListScope } from '@/lib/cortex/directives/scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DirectiveSummary {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
  /** #899 — project slug membership; empty when not project-scoped. */
  projects: string[];
  /** #769 — last 3 trailer lines newest-first; empty until a merge appends one. */
  recentMerges: string[];
  /** Absolute path of the backing markdown file — lets surfaces open it. */
  file: string | null;
}

function toSummary(parsed: ParsedDirective, file: string | null = null): DirectiveSummary {
  return {
    id: parsed.id,
    title: parsed.title,
    scope: parsed.scope,
    repoName: parsed.repoName,
    priority: parsed.priority,
    body: parsed.body,
    projects: parsed.projects,
    recentMerges: [],
    file,
  };
}

function directiveAppliesToActiveProject(parsed: ParsedDirective, projectScope: DirectiveProjectScope): boolean {
  const scope = parsed.scope.toLowerCase();
  if (scope === 'global' || scope === '') return true;
  if (scope !== 'project') return false;
  for (const id of parsed.projectIds) {
    if (projectScope.projectIds.has(id.toLowerCase())) return true;
  }
  for (const slug of parsed.projects) {
    if (projectScope.projectSlugs.has(slug.toLowerCase())) return true;
  }
  return false;
}

export async function GET(req: NextRequest) {
  try {
    const dataDir = getDataDir();
    const directivesDir = join(dataDir, 'directives');

    if (!existsSync(directivesDir)) {
      return NextResponse.json({ directives: [] }, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    const repoPath = req.nextUrl.searchParams.get('repoPath')?.trim() || null;

    const fileByDirective = new WeakMap<ParsedDirective, string>();
    const parsedAll: ParsedDirective[] = withTimingSync('recall.directives', () => {
      const entries = readdirSync(directivesDir).filter((name) => name.endsWith('.md'));
      const out: ParsedDirective[] = [];
      for (const name of entries) {
        try {
          const raw = readFileSync(join(directivesDir, name), 'utf-8');
          const fallbackId = name.replace(/\.md$/, '');
          const parsed = parseDirectiveFile(raw, fallbackId);
          if (parsed) {
            fileByDirective.set(parsed, join(directivesDir, name));
            out.push(parsed);
          }
        } catch (error) {
          console.warn(`[cortex-directives] Failed to read ${name}:`, error);
        }
      }
      return out;
    });

    // #899/#986 — apply active-project scope from ~/.o8/projects.json.
    // With a repoPath, use the same repo + active-project rules as dispatch.
    // Without a repoPath, expose only global + active-project directives.
    let parsed: ParsedDirective[] = parsedAll;
    const projectId = req.nextUrl.searchParams.get('projectId')?.trim();
    const projectScope = await resolveDirectiveListScope(projectId, repoPath);
    if (!projectScope) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    parsed = parsedAll.filter(directive => repoPath
      ? directiveAppliesToRepo(directive, repoPath, projectScope)
      : directiveAppliesToActiveProject(directive, projectScope));

    const directives = parsed.map((d) => toSummary(d, fileByDirective.get(d) ?? null));

    // #769 — Hydrate recent-merge trailers from the same markdown files.
    // The helper re-reads the dir, but the cost is trivial (≤dozens of small
    // files) and keeps the trailer logic colocated with the writer.
    const trailerMap = readAllDirectiveTrailers(3);
    for (const directive of directives) {
      directive.recentMerges = trailerMap[directive.id] ?? [];
    }

    // Sort by priority desc (higher = more important), then title.
    directives.sort((a, b) => {
      const ap = a.priority ?? 0;
      const bp = b.priority ?? 0;
      if (ap !== bp) return bp - ap;
      return a.title.localeCompare(b.title);
    });

    return NextResponse.json({ directives }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load directives.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/cortex/directives
 *
 * Writes a directive markdown file to the data dir. The auto-directive proposer
 * (#746) + the cross-repo proposer (#748) + the operator's Accept clicks all
 * funnel here so the proposal → directive loop closes IN-APP instead of
 * requiring the operator to hand-edit markdown files in a terminal.
 *
 * Body shape:
 *   {
 *     id?: string            // slug; defaults to d-<ts>-<random>
 *     title: string
 *     scope: 'global' | 'project' | string  // string = repoName for repo-scoped
 *     repoName?: string                     // when scope is the repo name
 *     projects?: string[]                   // project slugs (scope=project)
 *     priority?: number                     // higher = more important; default 5
 *     body: string                          // the directive text
 *   }
 *
 * Idempotent on id: writing the same id overwrites the file (intentional —
 * lets the operator re-Accept a tweaked proposal). Loopback-gated by middleware.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as null | {
      id?: unknown; title?: unknown; scope?: unknown; repoName?: unknown;
      projects?: unknown; priority?: unknown; body?: unknown;
    };
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ ok: false, error: 'body must be JSON' }, { status: 400 });
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const scope = typeof body.scope === 'string' ? body.scope.trim() : '';
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!title || !scope || !text) {
      return NextResponse.json({ ok: false, error: 'title, scope, and body are required' }, { status: 400 });
    }

    const idCandidate = typeof body.id === 'string' ? body.id.trim() : '';
    const id = idCandidate || `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      return NextResponse.json({ ok: false, error: 'id must match [A-Za-z0-9._-]+' }, { status: 400 });
    }

    const repoName = typeof body.repoName === 'string' ? body.repoName.trim() : '';
    const projects = Array.isArray(body.projects)
      ? body.projects.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
      : [];
    const priority = typeof body.priority === 'number' && Number.isFinite(body.priority)
      ? Math.max(0, Math.min(100, Math.round(body.priority)))
      : 5;
    const now = new Date().toISOString();

    const dataDir = getDataDir();
    const directivesDir = join(dataDir, 'directives');
    mkdirSync(directivesDir, { recursive: true });
    const filePath = join(directivesDir, `${id}.md`);

    // Preserve `created` on re-write so the file's history isn't reset on edit.
    let created = now;
    if (existsSync(filePath)) {
      try {
        const existing = readFileSync(filePath, 'utf-8');
        const parsed = parseDirectiveFile(existing, id);
        if (parsed?.id) {
          const createdMatch = existing.match(/^created:\s*(.+)$/m);
          if (createdMatch) created = createdMatch[1].trim();
        }
      } catch { /* ignore — treat as new */ }
    }

    // YAML-ish frontmatter the parser expects. Quote strings that could
    // ambiguate. Keep formatting consistent so re-reads round-trip cleanly.
    const escapedTitle = title.replace(/"/g, '\\"');
    const projectsLine = projects.length ? `projects: [${projects.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(', ')}]\n` : '';
    const repoLine = repoName ? `repoName: "${repoName.replace(/"/g, '\\"')}"\n` : '';
    const frontmatter = `---
id: ${id}
title: "${escapedTitle}"
scope: ${scope}
${repoLine}priority: ${priority}
${projectsLine}created: ${created}
updated: ${now}
---

${text}
`;

    writeFileSync(filePath, frontmatter, 'utf-8');
    try {
      refreshDirectiveFts(getSqlite(), `${id}.md`, frontmatter);
    } catch (error) {
      console.warn(
        '[cortex-directives] Failed to refresh directive FTS:',
        error instanceof Error ? error.message : error,
      );
    }

    return NextResponse.json({ ok: true, id, path: filePath }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to write directive.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const { deleteRetainedMemory } = await import('@/lib/cortex/forget');
  return deleteRetainedMemory(request, 'directive');
}
