import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
// The query bypasses the fixture resolver for constants only, never model calls.
import { SYMON_MANAGED_MODEL } from '../../src/lib/symon/durable/managed-provider.ts?fixture-constants';
export { SYMON_MANAGED_MODEL };
export async function createSymonManagedProvider() {
  appendFileSync(join(process.env.CORTEX_IDE_DATA_DIR, 'provider-bound.log'), `${process.pid}\n`);
  const faux = fauxProvider({ provider: SYMON_MANAGED_MODEL.provider,
    api: 'faux-symon-owner-fixture', models: [{ id: SYMON_MANAGED_MODEL.id }] });
  faux.setResponses([() => {
    appendFileSync(join(process.env.CORTEX_IDE_DATA_DIR, 'resume-calls.log'), 'resume\n');
    return fauxAssistantMessage('Recovered once.');
  }]);
  return faux.provider;
}
