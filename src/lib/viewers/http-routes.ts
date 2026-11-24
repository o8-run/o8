/** Native read-only producers. Mutations retain their existing server owner. */
export const viewerHttpRoutes = [
  { path: '/api/panel/file-content', load: () => import('@/app/api/panel/file-content/route') },
  { path: '/api/v2/files', load: () => import('@/app/api/v2/files/route') },
  { path: '/api/panel/file-io', load: () => import('@/app/api/panel/file-io/route') },
  { path: '/api/panel/file-diff', load: () => import('@/app/api/panel/file-diff/route') },
  { path: '/api/panel/commits/[hash]', load: () => import('@/app/api/panel/commits/[hash]/route') },
  { path: '/api/panel/commits/[hash]/file', load: () => import('@/app/api/panel/commits/[hash]/file/route') },
  { path: '/api/panel/git-log', load: () => import('@/app/api/panel/git-log/route') },
  { path: '/api/panel/git/log', load: () => import('@/app/api/panel/git/log/route') },
  { path: '/api/panel/file-asset', load: () => import('@/app/api/panel/file-asset/route') },
  { path: '/api/panel/serve-image', load: () => import('@/app/api/panel/serve-image/route') },
  { path: '/api/mobile/media', load: () => import('@/app/api/mobile/media/route') },
  { path: '/api/panel/threads/artifact', load: () => import('@/app/api/panel/threads/artifact/route') },
  { path: '/api/v2/context/files', load: () => import('@/app/api/v2/context/files/route') },
  { path: '/api/repo-spec', load: () => import('@/app/api/repo-spec/route') },
].map(entry => ({ ...entry, methods: entry.path === '/api/v2/context/files' ? ['GET', 'POST'] : ['GET'] }));
