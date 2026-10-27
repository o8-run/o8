import { viewerJson } from '@/lib/viewers/response';
import { NextRequest } from 'next/server';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import os from 'os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface DiffEntry {
  id: string;
  file: string;           // relative file path
  shortFile: string;      // just filename
  tool: 'Edit' | 'Write' | 'Read' | 'MultiEdit';
  oldText?: string;
  newText?: string;
  content?: string;        // for Write operations
  timestamp: number;
}

/**
 * GET /api/claude-code/diffs?sessionKey=claude-code:live-PID&limit=20
 *
 * Extracts file edit/write operations from Claude Code JSONL,
 * returning structured diff entries for live rendering.
 */
export async function GET(req: NextRequest) {
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '20', 10);

  try {
    // Find all JSONL files across project dirs, sorted by mtime desc
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR).catch(() => []);
    const allFiles: { path: string; mtime: number }[] = [];

    for (const dir of projectDirs) {
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
      try {
        const files = await readdir(dirPath);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(dirPath, file);
          const fileStat = await stat(filePath);
          allFiles.push({ path: filePath, mtime: fileStat.mtimeMs });
        }
      } catch { /* skip */ }
    }

    if (allFiles.length === 0) {
      return viewerJson({ diffs: [] });
    }

    // Sort by most recent first, read all (but cap total lines)
    allFiles.sort((a, b) => b.mtime - a.mtime);

    const lines: string[] = [];
    for (const f of allFiles.slice(0, 5)) { // Read up to 5 most recent session files
      const raw = await readFile(f.path, 'utf-8');
      lines.push(...raw.trim().split('\n').filter(Boolean));
    }

    const diffs: DiffEntry[] = [];
    const homeDir = os.homedir();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message;
        if (!msg?.content || !Array.isArray(msg.content)) continue;

        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          const name = block.name;
          const input = block.input ?? {};

          if (name === 'Edit' && input.file_path) {
            const filePath = (input.file_path as string).replace(homeDir, '~');
            const shortFile = path.basename(input.file_path as string);
            diffs.push({
              id: `${entry.uuid ?? diffs.length}-edit-${shortFile}`,
              file: filePath,
              shortFile,
              tool: 'Edit',
              oldText: input.old_string as string | undefined,
              newText: input.new_string as string | undefined,
              timestamp,
            });
          }

          if (name === 'Write' && input.file_path) {
            const filePath = (input.file_path as string).replace(homeDir, '~');
            const shortFile = path.basename(input.file_path as string);
            diffs.push({
              id: `${entry.uuid ?? diffs.length}-write-${shortFile}`,
              file: filePath,
              shortFile,
              tool: 'Write',
              content: (input.content as string | undefined)?.slice(0, 2000),
              timestamp,
            });
          }

          if (name === 'MultiEdit' && input.file_path) {
            const filePath = (input.file_path as string).replace(homeDir, '~');
            const shortFile = path.basename(input.file_path as string);
            const edits = input.edits as { old_string?: string; new_string?: string }[] | undefined;
            if (edits) {
              for (const edit of edits) {
                diffs.push({
                  id: `${entry.uuid ?? diffs.length}-multi-${shortFile}-${diffs.length}`,
                  file: filePath,
                  shortFile,
                  tool: 'MultiEdit',
                  oldText: edit.old_string,
                  newText: edit.new_string,
                  timestamp,
                });
              }
            }
          }
        }
      } catch { /* skip malformed */ }
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
