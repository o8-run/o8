export function isLoopbackHost(host: string | null | undefined, port?: number): boolean;
export function isShellHost(host: string | null | undefined, port?: number): boolean;
export function isAllowedLocalHost(host: string | null | undefined, port?: number,
  env?: Readonly<Record<string, string | undefined>>): boolean;
export function requestTargetAllowed(target: string | null | undefined, port?: number): boolean;
export function browserWriteAllowed(method: string, get: (name: string) => string | null, protocol?: string): boolean;
/** Server entry points register the rule that also reads the saved phone-access setting. */
export function setLanAccessRule(rule: (env?: Readonly<Record<string, string | undefined>>) => boolean): void;
