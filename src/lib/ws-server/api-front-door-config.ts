/** Launcher sets this for development app builds; NODE_ENV never captures next dev. */
export function apiFrontDoorEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.O8_API_FRONT_DOOR === '1';
}

/** Existing canonical WS owner guards also apply when the launcher enables takeover. */
export function nativeHttpTransportEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return apiFrontDoorEnabled(env) || env.O8_NEXT_O8D === '1';
}
