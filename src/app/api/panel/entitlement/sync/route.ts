import { auth } from '@clerk/nextjs/server';
import { syncEntitlement } from '@/lib/entitlement/account-sync';

export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  return syncEntitlement(request, async () => {
    const { userId, getToken } = await auth();
    return userId ? getToken() : null;
  });
}
