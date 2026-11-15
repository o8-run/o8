import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
export async function createSymonManagedProvider(model) {
  appendFileSync(join(process.env.CORTEX_IDE_DATA_DIR, 'provider-bound.log'), `${process.pid}\n`);
  const faux = fauxProvider({ provider: model.provider,
    api: 'faux-symon-owner-fixture', models: [{ id: model.id }] });
  faux.setResponses([() => {
    appendFileSync(join(process.env.CORTEX_IDE_DATA_DIR, 'resume-calls.log'), 'resume\n');
    return fauxAssistantMessage('Recovered once.');
  }]);
  return faux.provider;
}
