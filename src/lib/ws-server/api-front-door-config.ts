/** Launcher sets this for development app builds; NODE_ENV never captures next dev. */
export function apiFrontDoorEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.O8_API_FRONT_DOOR === '1';
}
