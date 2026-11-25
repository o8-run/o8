import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// o8 sends no usage analytics and no crash or error reports. These checks keep
// analytics and error-reporting clients out of every dependency list and out of
// the source, so adding one back fails here before it can ship.

const root = process.cwd();

/** npm packages of analytics, session-recording and error-reporting services. */
const NPM_CLIENT = /^(@sentry\/|sentry-|posthog|@posthog\/|@segment\/|analytics-node$|@amplitude\/|amplitude-js$|mixpanel|@bugsnag\/|bugsnag|@datadog\/|dd-trace$|rollbar$|newrelic$|@newrelic\/|logrocket|@honeybadger-io\/|raygun|@vercel\/analytics$|@vercel\/speed-insights$|applicationinsights$|@microsoft\/applicationinsights|@opentelemetry\/exporter-|@firebase\/analytics$|firebase-analytics|@react-native-firebase\/(analytics|crashlytics)$|expo-insights$|@statsig\/|statsig-|heap-api|@fullstory\/|plausible-tracker$|@elastic\/apm-|elastic-apm-node$|@appsignal\/|@highlight-run\/|trackjs$)/;

/** Rust crates of the same services. */
const CRATE_CLIENT = /^(sentry|sentry-[a-z0-9-]+|opentelemetry-otlp|datadog[a-z0-9-]*|bugsnag[a-z0-9-]*|rollbar[a-z0-9-]*|posthog[a-z0-9-]*|segment|newrelic[a-z0-9-]*|honeybadger[a-z0-9-]*|minidumper[a-z0-9-]*|crash-handler)$/;

const SOURCE_ROOTS = ['src', 'cli/src', 'scripts', 'crates', 'native', 'src-tauri/src'];
const SKIP_DIRS = new Set(['node_modules', 'target', '.next', 'dist', 'evidence', 'fixtures']);
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|rs)$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) sourceFiles(path, out);
    else if (SOURCE_FILE.test(name) && !/\.test\.|_tests?\.rs$/.test(name)) out.push(path);
  }
  return out;
}

function cargoManifests(dir: string, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) cargoManifests(path, out);
    else if (name === 'Cargo.toml') out.push(path);
  }
  return out;
}

describe('no analytics or error-reporting clients', () => {
  it('keeps them out of the npm dependency lists', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const names = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .flatMap((field) => Object.keys(manifest[field] ?? {}));
    expect(names.filter((name) => NPM_CLIENT.test(name))).toEqual([]);
  });

  it('keeps them out of every Cargo manifest', () => {
    const found: string[] = [];
    for (const path of ['crates', 'native', 'src-tauri'].flatMap((dir) => cargoManifests(join(root, dir)))) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const name = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
        if (name && CRATE_CLIENT.test(name)) found.push(`${relative(root, path)}: ${name}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('keeps them out of the source', () => {
    const importer = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    const found: string[] = [];
    for (const path of SOURCE_ROOTS.flatMap((dir) => sourceFiles(join(root, dir)))) {
      const text = readFileSync(path, 'utf8');
      if (path.endsWith('.rs')) {
        if (/^\s*(?:use|extern crate)\s+(sentry|sentry_[a-z_]+|opentelemetry_otlp|datadog[a-z_]*|bugsnag[a-z_]*|posthog[a-z_]*|minidumper[a-z_]*|crash_handler)\b/m.test(text)
          || /\b(sentry|sentry_rust_minidump)::/.test(text)) {
          found.push(relative(root, path));
        }
        continue;
      }
      for (const match of text.matchAll(importer)) {
        if (NPM_CLIENT.test(match[1])) found.push(`${relative(root, path)}: ${match[1]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('recognizes the clients it guards against', () => {
    for (const name of ['@sentry/node', '@sentry/react-native', 'posthog-node', 'posthog-js', '@amplitude/analytics-node', 'mixpanel', '@vercel/analytics', '@react-native-firebase/crashlytics']) {
      expect(NPM_CLIENT.test(name), name).toBe(true);
    }
    for (const name of ['sentry', 'sentry-rust-minidump', 'opentelemetry-otlp']) {
      expect(CRATE_CLIENT.test(name), name).toBe(true);
    }
    for (const name of ['vitest', 'next', 'react', 'serde', 'reqwest', 'segmenter']) {
      expect(NPM_CLIENT.test(name) || CRATE_CLIENT.test(name), name).toBe(false);
    }
  });
});
