export interface ReleaseChannel {
  channel: 'stable' | 'beta' | 'preview';
  preview: boolean;
  tag: string;
  manifestName: 'latest.json' | 'beta.json' | 'preview.json';
  githubFlags: string[];
  publishStableEffects: boolean;
}

export function resolveReleaseChannel(
  version: string,
  env?: Record<string, string | undefined>,
): Readonly<ReleaseChannel>;
