/** Native ESM keeps uncommon syntax assets out of webpack and standalone traces.
 * The caller supplies only same-origin paths for pinned, allowlisted assets.
 * A failed module graph needs fresh URLs, including its relative imports.
 */
const moduleUrls = new Map<string, string>();

export function importSyntaxModule(url: string): Promise<{ default: unknown }> {
  const attemptUrl = moduleUrls.get(url) ?? url;
  return import(/* webpackIgnore: true */ /* @vite-ignore */ attemptUrl).catch((error: unknown) => {
    // A late rejection from an older attempt must not replace a newer attempt.
    if ((moduleUrls.get(url) ?? url) === attemptUrl) {
      moduleUrls.set(url, url.replace('/syntax/', `/syntax/attempt/${crypto.randomUUID()}/`));
    }
    throw error;
  });
}
