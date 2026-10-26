/** Native drops carry paths; browsers may only expose a directory's name. */
export function droppedRepoPath(data: DataTransfer): string | null {
  const file = data.files?.[0] as (File & { path?: string }) | undefined;
  if (file?.path) return file.path;
  const uri = data.getData('text/uri-list').split(/\r?\n/).find(row => row && !row.startsWith('#'));
  if (uri?.startsWith('file://')) {
    try {
      const url = new URL(uri);
      if (url.hostname && url.hostname !== 'localhost') return null;
      return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
    } catch { return null; }
  }
  const text = data.getData('text/plain').trim();
  return /^(?:\/|~\/|[A-Za-z]:[\\/]|https?:\/\/|ssh:\/\/|git:\/\/|[^\s/@]+@[^\s:]+:)/i.test(text) ? text : null;
}
