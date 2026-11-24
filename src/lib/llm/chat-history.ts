/** Repository context saved alongside a chat transcript. */
export interface SavedChatRepoContext {
  name?: string;
  localPath?: string;
  branch?: string | null;
  remoteUrl?: string | null;
}
