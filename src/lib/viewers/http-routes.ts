/** Native read-only producers. Mutations retain their existing server owner. */
export const viewerHttpRoutes = [
  { path: '/api/panel/file-content', load: () => import('@/app/api/panel/file-content/route') },
  { path: '/api/v2/files', load: () => import('@/app/api/v2/files/route') },
  { path: '/api/panel/file-io', load: () => import('@/app/api/panel/file-io/route') },
  { path: '/api/panel/file-diff', load: () => import('@/app/api/panel/file-diff/route') },
  { path: '/api/panel/worktree-diff', load: () => import('@/app/api/panel/worktree-diff/route') },
  { path: '/api/panel/commit-diff', load: () => import('@/app/api/panel/commit-diff/route') },
  { path: '/api/panel/commits/[hash]', load: () => import('@/app/api/panel/commits/[hash]/route') },
  { path: '/api/panel/commits/[hash]/file', load: () => import('@/app/api/panel/commits/[hash]/file/route') },
  { path: '/api/panel/git-log', load: () => import('@/app/api/panel/git-log/route') },
  { path: '/api/panel/git/log', load: () => import('@/app/api/panel/git/log/route') },
  { path: '/api/review/file', load: () => import('@/app/api/review/file/route') },
  { path: '/api/mobile/review-file', load: () => import('@/app/api/mobile/review-file/route') },
  { path: '/api/review/diff', load: () => import('@/app/api/review/diff/route') },
  { path: '/api/panel/file-preview', load: () => import('@/app/api/panel/file-preview/route') },
].map(entry => ({ ...entry, methods: ['GET'] }));
