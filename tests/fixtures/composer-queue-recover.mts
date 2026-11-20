// tsx loads the .ts fixture as CommonJS, so its named exports are not
// statically importable from this ES module; read them from the namespace.
const child = await import('./composer-queue-child');
const attach = child.attachFixtureComposerExecutor
  ?? (child as unknown as { default: typeof child }).default.attachFixtureComposerExecutor;
const detach = await attach();
detach();
