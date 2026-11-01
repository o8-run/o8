import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
export default async function register(context: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--side-chat')) return {};
  return (await import('../../../native/o8-next/src/shell_features/right_panel/side_chat_fixture')).install(context);
}
