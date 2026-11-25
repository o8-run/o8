export interface ReleaseConfig {
  githubOAuthClientId: string;
  clerkPublishableKey: string;
}

export function resolveReleaseConfig(
  root: string,
  env?: Readonly<Record<string, string | undefined>>,
): ReleaseConfig;

export function resolveReleaseBuildEnvironment(
  root: string,
  env?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined>;
