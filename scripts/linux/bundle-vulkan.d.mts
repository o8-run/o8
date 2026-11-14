export interface BundledVulkanFile {
  name: string;
  bytes: number;
  package?: string;
  license?: string;
  version?: string;
  notice?: string;
}

export function resolveVulkanLicenseFiles(copyright: string, commonRoot?: string): {
  source: string;
  common: Array<{ name: string; source: string }>;
};

export function bundleVulkan(appdir: string): BundledVulkanFile[];

export function setOriginRunpath(file: string, path?: string): void;
export function assertVulkanInventory(notice: string, manifest: BundledVulkanFile[]): void;
