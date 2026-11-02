import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import type { MobileTranscriptMedia } from './types';
import { validateComposerImageAttachments, type ComposerImageAttachment } from './composer-image-validation';

export type { ComposerImageAttachment } from './composer-image-validation';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function imageMediaRoot(): string {
  return join(process.env.CORTEX_IDE_MEDIA_ROOT || join(getDataDir(), 'media'), 'orchestrator-images');
}

export function persistComposerImages(attachments: readonly ComposerImageAttachment[]): MobileTranscriptMedia[] {
  const checked = validateComposerImageAttachments(attachments);
  if (checked.length === 0) return [];
  const root = imageMediaRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });

  return checked.map((attachment) => {
    const match = /^data:(image\/[a-z+.-]+);base64,([a-z\d+/]+={0,2})$/i.exec(attachment.dataUri);
    const mimeType = match?.[1].toLowerCase() ?? '';
    const extension = IMAGE_EXTENSIONS[mimeType];
    if (!match || !extension) throw new Error('Image attachment format is unsupported.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0 || bytes.toString('base64') !== match[2]) {
      throw new Error('Image attachment has invalid base64 data.');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const path = join(root, `${digest}${extension}`);
    if (!existsSync(path)) {
      const temporary = join(root, `.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
        try {
          // The content address is stable across retry; the rename keeps the
          // served image complete if a transcript reads immediately.
          renameSync(temporary, path);
        } catch (error) {
          if (!existsSync(path)) throw error;
        }
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    if (!lstatSync(path).isFile() || !readFileSync(path).equals(bytes)) {
      throw new Error('Saved image attachment failed integrity validation.');
    }
    return {
      kind: 'image',
      path,
      name: attachment.name?.trim().slice(0, 500) || `Image ${digest.slice(0, 8)}`,
      mimeType,
    };
  });
}

/** The model sees an image's pixels but not its bytes. The path lets an agent use the file itself, such as adding it to a PR. */
export function withAttachmentFilePaths(
  message: string,
  attachments: readonly ComposerImageAttachment[] | undefined,
): string {
  const media = persistComposerImages(attachments ?? []);
  if (media.length === 0) return message;
  return `${message}\n\nAttached image files on this machine:\n${media.map((item) => `- ${item.path}`).join('\n')}`;
}

/** Codex reads initial-prompt images from disk; Solo can read only its runtime home. */
export function codexComposerImagePaths(attachments: readonly ComposerImageAttachment[], codexHome: string): string[] {
  const media = persistComposerImages(attachments);
  if (media.length === 0) return [];
  const root = join(codexHome, 'composer-images');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return media.map((item) => {
    const path = join(root, basename(item.path));
    if (!existsSync(path)) {
      try {
        linkSync(item.path, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
          writeFileSync(path, readFileSync(item.path), { flag: 'wx', mode: 0o600 });
        } else if (!existsSync(path)) {
          throw error;
        }
      }
    }
    if (!lstatSync(path).isFile() || statSync(path).size !== statSync(item.path).size) {
      throw new Error('Codex image attachment failed integrity validation.');
    }
    return path;
  });
}
