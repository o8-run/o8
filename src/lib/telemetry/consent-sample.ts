import { scrubSentryEvent, type SentryEventLike } from './scrub';

/**
 * Build the crash payload shown in first-run consent. This is executable proof,
 * not display-only copy: the representative event runs through the same
 * scrubSentryEvent transform used by the browser and Node beforeSend hooks.
 */
export function buildScrubbedCrashSample(): SentryEventLike {
  const representativeError: SentryEventLike = {
    message: 'TypeError: lane state was unavailable at /Users/operator/private-repo/src/app.tsx',
    exception: {
      values: [{
        value: 'Cannot resume lane from /Users/operator/private-repo/src/lib/lane/commands.ts',
        stacktrace: {
          frames: [{
            filename: '/Users/operator/private-repo/src/lib/lane/commands.ts',
            abs_path: '/Users/operator/private-repo/src/lib/lane/commands.ts',
            function: 'resumeLane',
            module: 'lane.commands',
          }],
        },
      }],
    },
    request: {
      url: 'http://127.0.0.1:47120/api/lane/resume?token=private',
      headers: { Authorization: 'Bearer private' },
      cookies: 'session=private',
      data: { prompt: 'private' },
    },
    breadcrumbs: [
      { message: 'opened /Users/operator/private-repo', data: { path: '/Users/operator/private-repo' } },
      { message: 'clicked resume', data: { count: 1, apiKey: 'private' } },
    ],
    extra: { surface: 'orchestrator', credential: 'private' },
    tags: { app_version: '0.1.x', plan: 'free', founder: false, surface: 'webview' },
    user: { id: 'operator', email: 'operator@example.test' },
    server_name: 'Operator-Mac.local',
  };

  return scrubSentryEvent(representativeError, { dropBreadcrumbsWithPaths: true }) ?? {};
}

export const SCRUBBED_CRASH_SAMPLE = buildScrubbedCrashSample();
