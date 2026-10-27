/** Invalid user folder selections are recoverable input errors. */
export class RepoFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoFolderError';
  }
}
