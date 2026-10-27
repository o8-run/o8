import { NextResponse } from 'next/server';
import { isSelfUpdatableInstall } from '@/lib/app-update/install-target';
import { getRunningInstallInfo } from '@/lib/app-update/install-info';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The server can inspect its native parent and the Linux package database. */
export async function GET() {
  const info = await getRunningInstallInfo();
  return NextResponse.json(
    { ...info, selfUpdatable: isSelfUpdatableInstall(info) },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
