import type { SurfaceRoutes } from '../surface-routes';
export default async function register(): Promise<SurfaceRoutes> {
  return process.argv.includes('--resources')
    ? (await import('../../../native/o8-next/src/shell_features/right_panel/resources_fixture')).install()
    : {};
}
