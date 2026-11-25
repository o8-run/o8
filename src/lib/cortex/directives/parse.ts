/**
 * Shared directive front-matter parser.
 *
 * Two call sites read directive markdown files and need the same shape:
 *   - `src/lib/cortex/context-block.ts` (dispatch context — filters
 *     project-scoped directives by repo membership)
 *   - `src/app/api/cortex/directives/route.ts` (Recall Card UI)
 *
 * Before this helper was extracted, the parsers diverged: the dispatch path
 * read the `projects:` front-matter field; the UI route did not. The result
 * was project-scoped directives leaking into the Recall Card for repos that
 * weren't members of the project. Surfaced by the #899 dogfood agent.
 *
 * Format:
 *   ---
 *   id: example
 *   title: Example
 *   scope: project        # or `global` / `repo` / `<repoName>`
 *   repoName: o8  # optional
 *   priority: 10          # optional
 *   projects: [o8, atlas] # optional — only meaningful when scope: project
 *   projectIds: [default] # optional — active project ids from ~/.o8/projects.json
 *   ---
 *   <body>
 *
 *   ## Recent Merges        # appended by #769; stripped from `body`
 *   - 2026-04-29 [merged] feat(...)
 */

const FRONT_MATTER_BOUNDARY = /^---\s*$/m;

export interface ParsedDirective {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  /**
   * #899 — `scope: project` directives carry a list of project slugs in the
   * front matter (`projects: [atlas, beacon]`). Empty list when the directive
   * isn't project-scoped or front matter omitted the field. Slugs are
   * lowercased and de-duplicated to keep membership checks predictable.
   */
  projects: string[];
  /** Active project ids from ~/.o8/projects.json. */
  projectIds: string[];
  priority: number | null;
  /** Body with the `## Recent Merges` trailer (#769) stripped. */
  body: string;
}

/**
 * Parse a single directive markdown file. Returns null when the input is
 * missing front matter or the closing `---` boundary — callers treat null
 * as "skip this file" rather than throwing.
 */
export function parseDirectiveFile(raw: string, fallbackId: string): ParsedDirective | null {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('---')) return null;

  const afterFirst = text.slice(3).trimStart();
  const closingIndex = afterFirst.search(FRONT_MATTER_BOUNDARY);
  if (closingIndex < 0) return null;

  const front = afterFirst.slice(0, closingIndex);
  const rawBody = afterFirst.slice(closingIndex).replace(FRONT_MATTER_BOUNDARY, '').trim();
  // #769 — strip the `## Recent Merges` trailer so the operator-authored
  // content is what callers render / mine. Trailer lines surface separately
  // via `readAllDirectiveTrailers()` in the API route.
  const body = rawBody.replace(/\n*##\s+Recent Merges\b[\s\S]*$/, '').trim();

  const meta: Record<string, string> = {};
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    // #1119 — spec-ingest writes quoted YAML values for `title:` / `repoName:`
    // (so titles can contain `:` and other punctuation). Strip a single
    // surrounding pair of `"` or `'` so downstream equality checks
    // (`directiveAppliesToRepo` doing `declaredRepo === repoName`) match the
    // unquoted on-disk repo name. Mirrors the front-matter parser in
    // `extractDirectiveFields` (v14-fts5-migration.ts).
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) meta[key] = value;
  }

  const priorityRaw = meta.priority;
  const priorityNum = priorityRaw ? Number.parseInt(priorityRaw, 10) : NaN;

  return {
    id: meta.id?.trim() || fallbackId,
    title: meta.title?.trim() || fallbackId,
    scope: meta.scope?.trim() || 'global',
    repoName: meta.repoName?.trim() || null,
    projects: parseProjectsList(meta.projects),
    projectIds: parseProjectsList(meta.projectIds ?? meta.projectId),
    priority: Number.isFinite(priorityNum) ? priorityNum : null,
    body,
  };
}

/**
 * Parse the `projects:` front-matter field into a normalized slug list.
 * Accepts both YAML-ish shapes the directive parser already supports:
 *   projects: [atlas, beacon]
 *   projects: atlas, beacon
 * Returns an empty array when the field is missing/empty/malformed.
 */
export function parseProjectsList(raw: string | undefined): string[] {
  if (!raw) return [];
  const stripped = raw.trim().replace(/^\[|\]$/g, '').trim();
  if (!stripped) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of stripped.split(',')) {
    const slug = part.trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (!slug) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}
