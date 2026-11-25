/**
 * Workspace context injection for LLM Chat.
 *
 * Gathers repo info, file tree, git status, and recent activity
 * to build a system prompt that makes the model workspace-aware.
 */

import { execSync } from '@/lib/providers/child-process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
const WORKSPACE_CONTEXT_TTL_MS = 10_000;

// Project rules files — checked in priority order, first found wins
const RULES_FILES = [
  '.cortexrules',
  '.cortex/rules.md',
  '.cursorrules',
  '.clinerules',
  'AGENTS.md',
];

interface WorkspaceContext {
  repoRoot: string;
  repoName: string;
  branch: string;
  status: string;         // git status --short
  recentCommits: string;  // last 5 commits oneline
  fileTreeSummary: string; // top-level + key dirs
}

const workspaceContextCache = new Map<string, { context: WorkspaceContext; cachedAt: number }>();

function safeExec(cmd: string, cwd: string, timeoutMs = 3000): string {
  try {
    return execSync(cmd, { windowsHide: true, cwd, encoding: 'utf-8', timeout: timeoutMs }).trim();
  } catch {
    return '';
  }
}

function buildWorkspaceContext(repoRoot: string): WorkspaceContext {
  const repoName = safeExec('basename $(git rev-parse --show-toplevel 2>/dev/null)', repoRoot) || 'unknown';
  const branch = safeExec('git branch --show-current', repoRoot) || 'main';
  const status = safeExec('git status --short --untracked-files=no', repoRoot) || '(clean)';
  const recentCommits = safeExec('git log --oneline -5 --no-decorate', repoRoot) || '(no commits)';

  // File tree — top level + key subdirs, truncated
  const topLevel = safeExec('ls -1', repoRoot);
  const srcDirs = safeExec("find src -maxdepth 2 -type d 2>/dev/null | head -30", repoRoot);
  const fileTreeSummary = topLevel + (srcDirs ? '\n\nsrc/ structure:\n' + srcDirs : '');

  return { repoRoot, repoName, branch, status, recentCommits, fileTreeSummary };
}

export function getWorkspaceContext(repoRoot = DEFAULT_REPO_ROOT): WorkspaceContext {
  const cacheKey = repoRoot;
  const cached = workspaceContextCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < WORKSPACE_CONTEXT_TTL_MS) {
    return cached.context;
  }

  const context = buildWorkspaceContext(repoRoot);
  workspaceContextCache.set(cacheKey, { context, cachedAt: Date.now() });
  return context;
}

/**
 * Load project rules from .cortexrules, .cursorrules, etc.
 * First file found wins. Max 4KB to prevent context bloat.
 */
function loadProjectRules(repoRoot = DEFAULT_REPO_ROOT): { content: string; source: string } | null {
  for (const filename of RULES_FILES) {
    const filepath = join(repoRoot, filename);
    if (existsSync(filepath)) {
      try {
        let content = readFileSync(filepath, 'utf-8').trim();
        if (content.length > 4096) {
          content = content.slice(0, 4096) + '\n... (truncated — max 4KB)';
        }
        return { content, source: filename };
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function buildSystemPrompt(ctx: WorkspaceContext): string {
  const repoRoot = ctx.repoRoot;
  const rules = loadProjectRules(repoRoot);

  const structureSection = `## File Structure
\`\`\`
${ctx.fileTreeSummary}
\`\`\``;

  return `You are an AI assistant integrated into o8, a desktop coding environment.

## Current Workspace
- **Repository:** ${ctx.repoName}
- **Branch:** ${ctx.branch}

## Git Status
\`\`\`
${ctx.status}
\`\`\`

## Recent Commits
\`\`\`
${ctx.recentCommits}
\`\`\`

${structureSection}

## Guidelines
- You have context about this workspace. Reference files and structure when relevant.
- Be concise and actionable. Suggest specific file paths when discussing code.
- You can see the repo structure but cannot yet read or edit files directly.
- When the user asks about code, reference the file tree to guide them.
- Format code blocks with language tags for syntax highlighting.
- When generating Mermaid diagrams, use simple syntax: short node IDs (A, B, C), avoid special characters in labels, use \`graph TD\` or \`flowchart TD\` for flow charts. Keep labels short and wrap in square brackets like \`A[Label]\`. Avoid pipes in labels.
- When you use information from tool results (search_web, read_file, search_code), cite your sources inline using numbered references like [1], [2], etc. The source cards will be shown separately — just use the numbers in your text to reference them.${rules ? `

## Project Rules (from ${rules.source})
${rules.content}` : ''}`;
}

export function buildUnscopedSystemPrompt(): string {
  return `You are an AI assistant integrated into o8, a desktop coding environment.

No registered repository is currently scoped to this chat. Do not assume a project name, branch, git status, file tree, or repo history.

## Guidelines
- Stay truthful about missing workspace scope.
- If the user asks a repo-specific question, ask them to open or select the correct workspace repo first.
- Do not invent file paths, branch names, or project structure.
- Be concise and actionable.
- Format code blocks with language tags for syntax highlighting.
- When generating Mermaid diagrams, use simple syntax: short node IDs (A, B, C), avoid special characters in labels, use \`graph TD\` or \`flowchart TD\` for flow charts. Keep labels short and wrap in square brackets like \`A[Label]\`. Avoid pipes in labels.`;
}
