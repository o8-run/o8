// Real store lifecycle with a faux provider: no model service, Messages or app access.
(async () => {
  const { SymonBrain } = require('../../src/lib/symon/durable/brain.ts');
  const { createModels, fauxProvider } = await import('@earendil-works/pi-ai');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  try {
    const brain = await SymonBrain.open({ storagePath: process.argv[2], models, o8Servers: null });
    process.send({ opened: true });
    if (process.argv[3] === 'probe') { await brain.close(); process.exit(0); }
    setInterval(() => {}, 1000);
  } catch (error) {
    process.send({ opened: false, error: error.message });
    process.exit(0);
  }
})();
