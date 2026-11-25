import { describe, expect, it } from 'vitest';

import { scrubPaths, stripQueryStrings } from './scrub';

describe('scrub — paths', () => {
  it('collapses the macOS home username but keeps the trailing path', () => {
    expect(scrubPaths('/Users/example/o8/src/x.ts')).toBe('/Users/…/o8/src/x.ts');
  });

  it('collapses linux /home usernames too', () => {
    expect(scrubPaths('at /home/deploy/app/server.js:12')).toBe('at /home/…/app/server.js:12');
  });

  it('scrubs multiple occurrences in one string', () => {
    const input = 'Error in /Users/quise/a.ts called from /Users/quise/b.ts';
    expect(scrubPaths(input)).toBe('Error in /Users/…/a.ts called from /Users/…/b.ts');
  });

  it('leaves non-home paths untouched', () => {
    expect(scrubPaths('/var/log/app.log')).toBe('/var/log/app.log');
  });
});

describe('scrub — query strings', () => {
  it('strips query strings from http(s) urls', () => {
    expect(stripQueryStrings('https://api.o8.run/v1/x?token=abc&id=9')).toBe('https://api.o8.run/v1/x');
  });

  it('leaves urls without a query untouched', () => {
    expect(stripQueryStrings('https://api.o8.run/v1/x')).toBe('https://api.o8.run/v1/x');
  });
});
