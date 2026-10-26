export interface ReleaseChannel {
  channel: 'beta' | 'preview';
  preview: boolean;
  tag: string;
  manifestName: 'beta.json' | 'preview.json';
  githubFlags: string[];
  publishStableEffects: boolean;
}

export function resolveReleaseChannel(
  version: string,
  env?: Record<string, string | undefined>,
): Readonly<ReleaseChannel>;
