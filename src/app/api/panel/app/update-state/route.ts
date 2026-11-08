import * as handlers from '@/lib/app-update/routes/update-state';
import { ownedUpdateRoute } from '@/lib/app-update/routes/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = ownedUpdateRoute(handlers.GET);
export const POST = ownedUpdateRoute(handlers.POST);
