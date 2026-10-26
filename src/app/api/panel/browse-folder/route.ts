export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { pickNativePath } from '@/lib/desktop/native-picker';

/**
 * POST /api/panel/browse-folder
 * Opens a native folder picker (osascript on macOS, zenity or kdialog on Linux).
 * Returns { path: "/selected/folder" }, { path: null } if cancelled, or
 * { path: null, unavailable: true } when this host has no picker program.
 */
export async function POST() {
  return NextResponse.json(await pickNativePath('folder', 'Select a project folder', { timeoutMs: 60_000 }));
}
