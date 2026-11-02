import { writeFileSync } from 'node:fs';
import { getSqlite, closeDb } from '@/lib/db';
import { projectNetworkThread } from '@/lib/bots/network-projection';

try {
  getSqlite();
  writeFileSync(process.argv[3], String(process.pid));
  projectNetworkThread(process.argv[2]);
} finally { closeDb(); }
