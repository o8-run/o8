export const APP_BUNDLE: string;
export const SERVER_MODE_KEYS: { frontDoor: string; nextOff: string };
export const NEXT_PAYLOAD: string[];
export function serverMode(argv: string[]): { frontDoor: boolean; nextOff: boolean };
export function copyServerTree(
  source: string,
  destination: string,
  options?: { candidate?: boolean; nextOff?: boolean },
): void;
export function writeInfoPlist(
  root: string,
  file: string,
  version: string,
  mode?: { frontDoor: boolean; nextOff: boolean },
): void;
