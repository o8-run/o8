#!/usr/bin/env node
/** Production build reserves generated-output ownership before cache invalidation. */
import { buildCompletionGate } from './build-completion-gate.mjs';
buildCompletionGate();

import { runGeneratedOutputLaunch } from './lib/generated-output-launch.mjs';

process.exitCode = await runGeneratedOutputLaunch('build');
