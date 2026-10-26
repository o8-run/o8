import 'server-only';

/** A child read cannot join an aggregate authorized under another scope. */
export class GitHubReadScopeChangedError extends Error {
  constructor(message: string, readonly anonymous: boolean) {
    super(message);
  }
}
