import path from 'node:path';

// Packet shells run in development mode and carry live control-plane tokens.
// Normalize before Vitest forks workers (and before application imports), not
// inside individual tests. Tests requiring authority must supply fixture tokens.
Object.assign(process.env, { NODE_ENV: 'test' });
for (const name of ['O8_WORKER_TOKEN', 'O8_API_TOKEN', 'O8_SPECTATOR_TOKEN']) {
  delete process.env[name];
}

export const sharedVitestConfig = {
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../src'),
      'server-only': path.resolve(__dirname, '../../tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    globalSetup: ['tests/global-test-data-dir.ts'],
    setupFiles: ['tests/setup-isolated-data-dir.ts'],
    include: [
      'src/**/*.test.ts',
      'tests/**/*.test.ts',
      'cli/**/*.test.ts',
    ],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
