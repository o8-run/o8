export declare function splitIntegrationFiles(
  files: string[],
  weights: Record<string, number>,
  count: number,
): Array<{ files: string[]; totalSeconds: number }>;
