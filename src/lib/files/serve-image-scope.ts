import { homedir } from 'node:os';

// The TS route and authenticated admission share the same process-start allowlist.
export const SERVE_IMAGE_ROOTS = [process.env.HOME || homedir(), '/tmp'];
