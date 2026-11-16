export function isLoopbackHost(host: string | null | undefined, port?: number): boolean;
export function isShellHost(host: string | null | undefined, port?: number): boolean;
export function isAllowedLocalHost(host: string | null | undefined, port?: number,
  env?: Readonly<Record<string, string | undefined>>): boolean;
export function requestTargetAllowed(target: string | null | undefined, port?: number): boolean;
export function browserWriteAllowed(method: string, get: (name: string) => string | null, protocol?: string): boolean;
