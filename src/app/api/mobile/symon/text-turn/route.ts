import { symonOwnerRoute } from '@/lib/symon/http/owner-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = symonOwnerRoute();
export const DELETE = symonOwnerRoute();
