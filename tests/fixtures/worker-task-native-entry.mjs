import '../../scripts/register-server-only-stub.mjs';
import { register } from 'tsx/esm/api';
register();
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('tsx/cjs');
await require('./worker-task-native.fixture.ts').boot();
