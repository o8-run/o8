#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRustHelper } from './lib/build-rust-helper.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
buildRustHelper({ root, crate: join(root, 'src-tauri', 'sidecars', 'pi-write'), name: 'o8-pi-write', label: 'pi-write', linux: true });
