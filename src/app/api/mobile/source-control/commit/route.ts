import { sourceControlResponse } from '@/lib/mobile/source-control';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return sourceControlResponse(request, 'commit');
}
