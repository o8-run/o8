/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * packages/contracts/src/project.ts, apps/server/src/orchestration-v2/ProjectCommands.ts,
 * apps/web/src/components/settings/ProjectIconPickerDialog.tsx, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
 * MIT; see licenses/t3code-MIT.txt. Adaptation: o8 server validation and projection.
 */
export const PROJECT_ICON_COLORS = [
  'gray', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
] as const;
export type ProjectIconColor = typeof PROJECT_ICON_COLORS[number];
export type ProjectIconOverride =
  | { kind: 'monogram'; text: string; color: ProjectIconColor }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'lucide'; name: string; color: ProjectIconColor };
export interface ProjectIconSettings {
  faviconPath: string | null;
  projectIcon: ProjectIconOverride | null;
}
/** Identity overrides take display precedence; clearing one retains the file choice. */
export interface ProjectIconProjection extends ProjectIconSettings {
  resourceUrl: string | null;
}
export class ProjectIconInputError extends Error {}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function normalizeProjectIcon(value: unknown): ProjectIconOverride | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new ProjectIconInputError('Invalid project icon.');
  const icon = value as Record<string, unknown>;
  if (icon.kind === 'emoji' && typeof icon.emoji === 'string') {
    const emoji = icon.emoji.trim();
    if (emoji.length > 0 && emoji.length <= 32) return { kind: 'emoji', emoji };
  }
  const color = icon.color as ProjectIconColor;
  if (PROJECT_ICON_COLORS.includes(color)) {
    if (icon.kind === 'lucide' && typeof icon.name === 'string') {
      const name = icon.name.trim();
      if (name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return { kind: 'lucide', name, color };
    }
    if (icon.kind === 'monogram' && typeof icon.text === 'string') {
      const text = icon.text.normalize('NFKC').trim().toUpperCase();
      if (text.length <= 32 && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u.test(text)
        && Array.from(segmenter.segment(text)).length <= 2) return { kind: 'monogram', text, color };
    }
  }
  throw new ProjectIconInputError('Choose an emoji, a glyph and color, or a monogram of one or two letters or numbers.');
}
