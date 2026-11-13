// Real store lifecycle with a faux provider: no model service, Messages or app access.
const keepAlive = setInterval(() => {}, 1000);
(async () => {
  const { SymonBrain } = require('../../src/lib/symon/durable/brain.ts');
  const { createModels, fauxProvider } = await import('@earendil-works/pi-ai');
  const { SYMON_MANAGED_MODEL } = require('../../src/lib/symon/durable/managed-provider.ts');
  const faux = process.argv[3] === 'pending' ? fauxProvider({ provider: SYMON_MANAGED_MODEL.provider, api: 'faux-symon-owner-fixture', models: [{ id: SYMON_MANAGED_MODEL.id }] }) : fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  try {
    const model = faux.getModel();
    if (process.argv[3] === 'pending') faux.setResponses([async () => new Promise(() => {})]);
    const brain = await SymonBrain.open({ storagePath: process.argv[2], models, model: { provider: model.provider, modelId: model.id }, o8Servers: null });
    if (process.argv[3] === 'pending') {
      const outcome = await brain.send({ key: 'app:recovery', source: 'app', title: 'Fixture', requestId: 'app:recovery-1', text: 'Recover this turn' }, 300);
      process.send({ pending: outcome.state === 'pending' });
    } else process.send({ opened: true });
    if (process.argv[3] === 'probe') { await brain.close(); process.exit(0); }
    void keepAlive;
  } catch (error) {
    process.send({ opened: false, error: error.message });
    process.exit(0);
  }
})();
