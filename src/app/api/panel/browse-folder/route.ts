export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from '@/lib/providers/child-process';

/**
 * POST /api/panel/browse-folder
 * Opens a native folder picker dialog (macOS Finder via osascript).
 * Returns { path: "/selected/folder" } or { path: null } if cancelled.
 */
export async function POST() {
  try {
    const script = `
      tell application "System Events"
        activate
        set theFolder to choose folder with prompt "Select a project folder"
        return POSIX path of theFolder
      end tell
    `;

    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 60000, // 60s to give user time to browse
    }).trim();

    // Remove trailing slash if present
    const cleanPath = result.endsWith('/') ? result.slice(0, -1) : result;

    return NextResponse.json({ path: cleanPath });
  } catch (error) {
    const reason = error instanceof Error ? `${error.message} ${'stderr' in error ? error.stderr : ''}` : '';
    if (/\(-128\)|user cancel(?:ed|led)/i.test(reason)) return NextResponse.json({ path: null });
    return NextResponse.json({ error: 'Could not open the folder picker. Paste a folder path or Git URL.' }, { status: 503 });
  }
}
