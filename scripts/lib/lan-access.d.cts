type Environment = Readonly<Record<string, string | undefined>>;
export function dataDir(env?: Environment): string;
export function savedLanAccess(env?: Environment): boolean;
export function lanAccessEnabled(env?: Environment): boolean;
