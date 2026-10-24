import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { ChatGPTPlanService } from '@/lib/chatgpt-plan/service';
import { FixturePlanStore } from '../helpers/chatgpt-plan-fixture';

// Share the parent's owned credential-lock root without accessing an OS account.
os.homedir = () => process.argv[2];
syncBuiltinESMExports();

async function main() {
  const service = new ChatGPTPlanService(new FixturePlanStore(process.argv[2]), JSON.parse(process.argv[3]));
  const status = await service.status('user_fixture_owner');
  process.stdout.write(status.connected ? 'connected\n' : 'disconnected\n');
}
void main().catch(() => { process.stderr.write('Fixture renewal failed\n'); process.exitCode = 1; });
