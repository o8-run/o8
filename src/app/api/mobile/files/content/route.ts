import { mobileFilesErrorResponse, parseMobileFileLineRange, readMobileFile, resolveMobileFilesCheckout } from '@/lib/mobile/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const root = await resolveMobileFilesCheckout(params);
    const range = parseMobileFileLineRange(params);
    return Response.json(await readMobileFile(root, params.get('path') ?? '', range), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return mobileFilesErrorResponse(error);
  }
}
