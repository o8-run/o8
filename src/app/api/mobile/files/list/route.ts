import { listMobileFiles, mobileFilesErrorResponse, resolveMobileFilesCheckout } from '@/lib/mobile/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const root = await resolveMobileFilesCheckout(params);
    return Response.json(await listMobileFiles(root, params.get('path') ?? ''), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return mobileFilesErrorResponse(error);
  }
}
