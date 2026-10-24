/** Native ESM keeps uncommon syntax assets out of webpack and standalone traces.
 * The caller supplies only same-origin paths for pinned, allowlisted assets.
 * Rejected imports are left uncached here so the view's retry can try again.
 */
export function importSyntaxModule(url: string): Promise<{ default: unknown }> {
  return import(/* webpackIgnore: true */ /* @vite-ignore */ url);
}
