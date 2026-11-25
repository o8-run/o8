import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE_KEYS = Object.freeze([
  'githubOAuthClientId',
  'clerkPublishableKey',
]);

/**
 * Resolve deployment-specific values used while producing the signed desktop
 * build. Values remain outside Git; this helper only gives every build phase
 * the same view of o8.release.json and its environment overrides.
 */
export function resolveReleaseConfig(root, env = process.env) {
  const config = Object.fromEntries(FILE_KEYS.map((key) => [key, '']));
  const configPath = join(root, 'o8.release.json');
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      for (const key of FILE_KEYS) {
        if (typeof parsed[key] === 'string') config[key] = parsed[key].trim();
      }
    } catch (error) {
      console.warn(`⚠️  o8.release.json parse failed — ignoring: ${error.message}`);
    }
  }

  const overrides = {
    githubOAuthClientId: env.GITHUB_OAUTH_CLIENT_ID,
    clerkPublishableKey: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string' && value.trim()) config[key] = value.trim();
  }
  return config;
}

/** Match the web producer's public-client environment without mutating the caller. */
export function resolveReleaseBuildEnvironment(root, env = process.env) {
  const buildEnv = { ...env };
  const config = resolveReleaseConfig(root, env);
  // Preserve explicit environment bytes: recipe compatibility hashes the value
  // actually passed to the compiler, not the trimmed release-config projection.
  if (!buildEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && config.clerkPublishableKey) {
    buildEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = config.clerkPublishableKey;
  }
  return buildEnv;
}
