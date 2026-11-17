#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRustHelper } from './lib/build-rust-helper.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
buildRustHelper({ root, crate: join(root, 'crates', 'o8d'), name: 'o8d', label: 'o8d', features: ['experimental-session-reads'] });
