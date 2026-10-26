import { viewerJson } from '@/lib/viewers/response';
import { NextRequest } from 'next/server';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import os from 'os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

interface DiffEntry {
  id: string;
  file: string;
  shortFile: string;
  tool: 'Edit' | 'Write' | 'Read' | 'MultiEdit';
  oldText?: string;
  newText?: string;
  content?: string;
  timestamp: number;
}

/**
 * Parse Codex apply_patch format into file edits.
 * Format: "*** Begin Patch\n*** Update File: /path/to/file.ts\n@@ ... @@\n-old\n+new"
 */
function parsePatch(patchText: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const homeDir = os.homedir();

  // Split by "*** Update File:" or "*** Add File:" markers
  const fileBlocks = patchText.split(/\*\*\*\s+(Update|Add)\s+File:\s+/);

  for (let i = 1; i < fileBlocks.length; i += 2) {
    const operation = fileBlocks[i]; // "Update" or "Add"
    const block = fileBlocks[i + 1];
    if (!block) continue;

    const lines = block.split('\n');
    const filePath = lines[0].trim().replace(homeDir, '~');
    const shortFile = path.basename(filePath);

    if (operation === 'Add') {
      const content = lines.slice(1).filter(l => l.startsWith('+')).map(l => l.slice(1)).join('\n');
      entries.push({
        id: `codex-add-${shortFile}-${entries.length}`,
        file: filePath,
        shortFile,
        tool: 'Write',
        content: content.slice(0, 2000),
        timestamp: Date.now(),
      });
    } else {
      // Parse @@ hunks for old/new
      const oldLines: string[] = [];
      const newLines: string[] = [];

      for (const line of lines.slice(1)) {
        if (line.startsWith('@@')) continue;
        if (line.startsWith('-')) oldLines.push(line.slice(1));
        else if (line.startsWith('+')) newLines.push(line.slice(1));
        else if (line.startsWith(' ')) {
          oldLines.push(line.slice(1));
          newLines.push(line.slice(1));
        }
      }

      if (oldLines.length > 0 || newLines.length > 0) {
        entries.push({
          id: `codex-edit-${shortFile}-${entries.length}`,
          file: filePath,
          shortFile,
          tool: 'Edit',
          oldText: oldLines.join('\n'),
          newText: newLines.join('\n'),
          timestamp: Date.now(),
        });
      }
    }
  }

  return entries;
}

/**
 * GET /api/codex/diffs?limit=20
 *
 * Reads recent Codex session JSONLs and extracts apply_patch + exec_command tool calls.
 */
export async function GET(req: NextRequest) {
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '20', 10);

  try {
    // Find recent session files (walk year/month/day dirs)
    const allFiles: { path: string; mtime: number }[] = [];

    const years = await readdir(CODEX_SESSIONS_DIR).catch(() => []);
    for (const year of years.slice(-1)) { // Latest year
      const months = await readdir(path.join(CODEX_SESSIONS_DIR, year)).catch(() => []);
      for (const month of months.slice(-1)) { // Latest month
        const days = await readdir(path.join(CODEX_SESSIONS_DIR, year, month)).catch(() => []);
        for (const day of days.slice(-2)) { // Last 2 days
          const dayDir = path.join(CODEX_SESSIONS_DIR, year, month, day);
          try {
            const files = await readdir(dayDir);
            for (const file of files) {
              if (!file.endsWith('.jsonl')) continue;
              const filePath = path.join(dayDir, file);
              const fileStat = await stat(filePath);
              allFiles.push({ path: filePath, mtime: fileStat.mtimeMs });
            }
          } catch { /* skip */ }
        }
      }
    }

    if (allFiles.length === 0) {
      return viewerJson({ diffs: [] });
    }

    // Sort by most recent, read top 5
    allFiles.sort((a, b) => b.mtime - a.mtime);

    const diffs: DiffEntry[] = [];

    for (const f of allFiles.slice(0, 5)) {
      const raw = await readFile(f.path, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const payload = entry.payload ?? {};
          const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

          // apply_patch tool calls
          if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch' && payload.input) {
            const patchEntries = parsePatch(payload.input);
            for (const pe of patchEntries) {
              pe.timestamp = timestamp;
              pe.id = `${f.path}-${diffs.length}-${pe.shortFile}`;
              diffs.push(pe);
            }
          }

          // exec_command (show as terminal events)
          if (payload.type === 'function_call' && payload.name === 'exec_command') {
            try {
              const args = JSON.parse(payload.arguments ?? '{}');
              if (args.cmd) {
                diffs.push({
                  id: `${f.path}-exec-${diffs.length}`,
                  file: args.cmd.slice(0, 80),
                  shortFile: '$ ' + args.cmd.split(' ')[0],
                  tool: 'Read', // Using Read as "terminal" indicator
                  content: args.cmd,
                  timestamp,
                });
              }
            } catch { /* skip */ }
          }
        } catch { /* skip malformed */ }
      }
    }

    return viewerJson({ diffs: diffs.slice(-limit) }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    return viewerJson(
      { diffs: [], error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }
}
