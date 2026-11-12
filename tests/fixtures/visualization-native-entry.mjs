import '../../scripts/register-server-only-stub.mjs';
import { createRequire } from 'node:module';
import { register } from 'tsx/esm/api';
register();
const require = createRequire(import.meta.url);
require('tsx/cjs');
await require('./visualization-native.fixture.ts').boot();
