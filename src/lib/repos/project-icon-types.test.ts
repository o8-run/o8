/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * packages/contracts/src/project.ts, apps/server/src/orchestration-v2/ProjectCommands.ts,
 * commit f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
 * MIT; see licenses/t3code-MIT.txt. Adaptation: hermetic o8 identity contract tests.
 */
import { expect, it } from 'vitest';
import { normalizeProjectIcon, ProjectIconInputError } from './project-icon-types';

it('normalizes a monogram while preserving a valid color', () => {
  expect(normalizeProjectIcon({ kind: 'monogram', text: ' ａｂ ', color: 'blue' }))
    .toEqual({ kind: 'monogram', text: 'AB', color: 'blue' });
});

it('accepts one or two Unicode graphemes and rejects longer monograms', () => {
  expect(normalizeProjectIcon({ kind: 'monogram', text: 'é中', color: 'teal' }))
    .toEqual({ kind: 'monogram', text: 'É中', color: 'teal' });
  expect(() => normalizeProjectIcon({ kind: 'monogram', text: 'ABC', color: 'teal' })).toThrow(ProjectIconInputError);
  expect(() => normalizeProjectIcon({ kind: 'monogram', text: '', color: 'teal' })).toThrow(ProjectIconInputError);
});

it('trims an emoji and rejects empty or oversized identities', () => {
  expect(normalizeProjectIcon({ kind: 'emoji', emoji: ' 🌱 ' })).toEqual({ kind: 'emoji', emoji: '🌱' });
  for (const emoji of ['', 'a'.repeat(33)]) expect(() => normalizeProjectIcon({ kind: 'emoji', emoji })).toThrow(ProjectIconInputError);
});

it('accepts a stored Lucide glyph name and rejects invalid names and colors', () => {
  expect(normalizeProjectIcon({ kind: 'lucide', name: ' folder-code ', color: 'violet' }))
    .toEqual({ kind: 'lucide', name: 'folder-code', color: 'violet' });
  for (const icon of [{ kind: 'lucide', name: '../bad', color: 'violet' }, { kind: 'monogram', text: 'AB', color: 'unknown' }]) {
    expect(() => normalizeProjectIcon(icon)).toThrow(ProjectIconInputError);
  }
});

it('clears an identity explicitly and rejects non-identity input', () => {
  expect(normalizeProjectIcon(null)).toBeNull();
  for (const icon of [undefined, 'emoji', {}, { kind: 'image', path: 'favicon.svg' }]) {
    expect(() => normalizeProjectIcon(icon)).toThrow(ProjectIconInputError);
  }
});
