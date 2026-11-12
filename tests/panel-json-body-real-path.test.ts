import { NextRequest } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { expect, it } from 'vitest';

import * as route0 from '@/app/api/panel/branches/route';
import * as route1 from '@/app/api/panel/branches/checkout/route';
import * as route2 from '@/app/api/panel/dev-server/route';
import * as route3 from '@/app/api/panel/ide-surface/route';
import * as route4 from '@/app/api/panel/terminal-exec/route';
import * as route5 from '@/app/api/panel/assign-issue/route';
import * as route6 from '@/app/api/panel/issues/create/route';
import * as route7 from '@/app/api/panel/issues/enhance/route';
import * as route8 from '@/app/api/panel/terminal-state/route';
import * as route9 from '@/app/api/panel/workspaces/route';

const routes = [
  ['POST /api/panel/branches', route0.POST],
  ['DELETE /api/panel/branches', route0.DELETE],
  ['POST /api/panel/branches/checkout', route1.POST],
  ['POST /api/panel/dev-server', route2.POST],
  ['DELETE /api/panel/dev-server', route2.DELETE],
  ['POST /api/panel/ide-surface', route3.POST],
  ['POST /api/panel/terminal-exec', route4.POST],
  ['POST /api/panel/assign-issue', route5.POST],
  ['POST /api/panel/issues/create', route6.POST],
  ['POST /api/panel/issues/enhance', route7.POST],
  ['POST /api/panel/terminal-state', route8.POST],
  ['POST /api/panel/workspaces', route9.POST],
] as const;
it.each(routes)('%s rejects missing, malformed and non-object JSON', async (_name, handler) => {
  for (const body of ['', '{', 'null', '[]', '"text"', '42', 'true']) {
    const response = await handler(new NextRequest('http://localhost/api/panel/test', {
      method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}` }, body,
    }));
    expect(response.status, body).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object.' });
  }
});
