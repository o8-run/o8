import { execFile } from '@/lib/providers/child-process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FallbackScreenshot {
  imageBase64: string;
  mimeType: 'image/png';
}

type SendCommand = (command: string, payload: Record<string, unknown>) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function screenshotCommandErrorMessage(value: unknown): string | null {
  const root = record(value);
  if (!root) {
    return null;
  }

  if (root.success === false) {
    return stringValue(root.error) ?? 'o8 screenshot command failed';
  }

  const nested = record(root.data);
  if (nested?.success === false) {
    return stringValue(nested.error) ?? 'o8 screenshot command failed';
  }

  return null;
}

export function isNullObjectScreenshotPanic(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes('Attempted to create a NULL object')
    || (message.includes('Task join error') && message.includes('panicked'));
}

function codedError(message: string, code: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

export async function sendScreenshotWithFallback(
  sendCommand: SendCommand,
  resetConnection: () => void,
  windowLabel: string,
  captureRegion = captureMacOsWindowRegion,
): Promise<unknown> {
  const fallback = async (error: unknown) => {
    resetConnection();
    try {
      const capture = await captureRegion(
        () => sendCommand('get_app_info', {}),
        windowLabel,
      );
      return {
        success: true,
        data: `data:${capture.mimeType};base64,${capture.imageBase64}`,
      };
    } catch (fallbackError) {
      throw codedError(
        `Screenshot subsystem panicked (${errorMessage(error)}); macOS region fallback failed (${errorMessage(fallbackError)})`,
        'ESCREENSHOT_PANIC',
      );
    }
  };

  try {
    const result = await sendCommand('take_screenshot', {
      window_label: windowLabel,
      save_to_disk: false,
      thumbnail: false,
    });
    const commandError = screenshotCommandErrorMessage(result);
    if (!commandError) {
      return result;
    }

    const error = codedError(commandError, 'ESCREENSHOT');
    if (isNullObjectScreenshotPanic(error)) {
      return await fallback(error);
    }
    throw error;
  } catch (error) {
    if (isNullObjectScreenshotPanic(error)) {
      return await fallback(error);
    }
    throw error;
  }
}

export function pickWindowCaptureRect(appInfo: unknown, windowLabel: string): WindowRect | null {
  const root = record(appInfo);
  const windows = Array.isArray(root?.windows) ? root.windows : [];
  const window = windows
    .map(record)
    .find((candidate) => candidate?.label === windowLabel && candidate.visible !== false);
  const position = record(window?.position);
  const size = record(window?.size);
  const x = numberValue(position?.x);
  const y = numberValue(position?.y);
  const width = numberValue(size?.width);
  const height = numberValue(size?.height);

  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export async function captureMacOsWindowRegion(
  getAppInfo: () => Promise<unknown>,
  windowLabel: string,
): Promise<FallbackScreenshot> {
  if (process.platform !== 'darwin') {
    throw new Error('macOS region screenshot fallback is only available on darwin');
  }

  const rect = pickWindowCaptureRect(await getAppInfo(), windowLabel);
  if (!rect) {
    throw new Error(`Could not resolve ${windowLabel} window bounds for screenshot fallback`);
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'o8-screenshot-fallback-'));
  const filePath = path.join(tempDir, 'capture.png');

  try {
    await execFileAsync('/usr/sbin/screencapture', [
      '-x',
      '-t',
      'png',
      '-R',
      `${rect.x},${rect.y},${rect.width},${rect.height}`,
      filePath,
    ], { windowsHide: true, timeout: 10_000 });

    const image = await readFile(filePath);
    if (image.length === 0) {
      throw new Error('macOS screencapture produced an empty image');
    }

    return { imageBase64: image.toString('base64'), mimeType: 'image/png' };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
