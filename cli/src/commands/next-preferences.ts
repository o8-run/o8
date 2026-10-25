import { O8WebviewClient } from '../../../src/lib/mcp/o8-webview-client';

const keys = ['cortex-theme-palette', 'cortex-theme', 'cortex-reduce-transparency',
  'cortex-workspace-glass', 'o8:sidebar:visible', 'o8:sidebar:width'] as const;

/** Read only the selected profile's running webview, using existing read commands. */
export async function readNextPreferences(): Promise<string | undefined> {
  let client: O8WebviewClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    client = new O8WebviewClient();
    const source = client;
    const collect = async () => {
      const info = await source.getAppInfo();
      if (!['macos', 'linux', 'windows'].includes(info.os?.os ?? '')) return undefined;
      const read = async () => {
        const values: Array<string | null> = [];
        // Some supported peers omit response ids. One in-flight read is unambiguous.
        for (const key of keys) values.push(await source.readNativePreference(key));
        return values;
      };
      const first = await read();
      const second = await read();
      if (JSON.stringify(first) !== JSON.stringify(second)) return undefined;
      const [storedPalette, legacy, transparency, storedGlass, visible, width] = second;
      const hasPreference = storedPalette !== null || legacy !== null || transparency !== null;
      const remap: Record<string, string> = { light: 'light', dark: 'dark', midnight: 'dark', chocolate: 'dark' };
      let palette = ['light', 'dark'].includes(storedPalette ?? '') ? storedPalette! : remap[legacy ?? ''] ?? (hasPreference ? 'dark' : 'light');
      const nativeGlass = info.os?.os === 'macos';
      const allGlass = nativeGlass && (storedGlass === 'true' || storedGlass === null && !hasPreference);
      const reduce = ['on', 'off', 'system'].includes(transparency ?? '') ? transparency : hasPreference ? 'system' : 'on';
      const glass = nativeGlass && (allGlass || reduce !== 'on');
      if (allGlass) palette = 'dark';
      const numericWidth = Number(width);
      const sidebarWidth = Number.isFinite(numericWidth) && numericWidth >= 160 && numericWidth <= 500 ? numericWidth : 300;
      const main = (await source.listWindows()).windows.find(window => window.label === 'main');
      const scale = main?.scaleFactor ?? 1;
      const w = (main?.innerSize?.width ?? 0) / scale;
      const h = (main?.innerSize?.height ?? 0) / scale;
      const windowSize = Number.isFinite(w) && Number.isFinite(h) && scale > 0 && w >= 600 && w <= 7680 && h >= 400 && h <= 4320 ? [w, h] : undefined;
      return JSON.stringify({ version: 1, palette, glass, allGlass, sidebarWidth, sidebarVisible: visible !== 'false', ...(windowSize ? { windowSize } : {}) });
    };
    return await Promise.race([collect(), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1500); })]);
  } catch { return undefined; }
  finally { if (timer) clearTimeout(timer); client?.cancel(); }
}
