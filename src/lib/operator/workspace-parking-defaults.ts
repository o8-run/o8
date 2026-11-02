import 'server-only';

export type WorkspaceParkingMode = 'manual' | 'pressure' | 'settled';

export interface WorkspaceParkingDefaults {
  workspaceParkingMode: WorkspaceParkingMode;
}

export const WORKSPACE_PARKING_FALLBACK: WorkspaceParkingDefaults = {
  workspaceParkingMode: 'settled',
};

export function isWorkspaceParkingMode(value: unknown): value is WorkspaceParkingMode {
  return value === 'manual' || value === 'pressure' || value === 'settled';
}

function envWorkspaceParkingMode(): WorkspaceParkingMode | null {
  const raw = process.env.O8_WORKSPACE_PARKING_MODE?.trim();
  return isWorkspaceParkingMode(raw) ? raw : null;
}

export function resolveStoredWorkspaceParking(
  stored: Partial<WorkspaceParkingDefaults>,
): Partial<WorkspaceParkingDefaults> {
  return isWorkspaceParkingMode(stored.workspaceParkingMode)
    ? { workspaceParkingMode: stored.workspaceParkingMode }
    : {};
}

export function resolveWorkspaceParkingSettings(file: Partial<WorkspaceParkingDefaults>) {
  const envMode = envWorkspaceParkingMode();
  return {
    values: {
      workspaceParkingMode: envMode ?? file.workspaceParkingMode ?? WORKSPACE_PARKING_FALLBACK.workspaceParkingMode,
    },
    sources: {
      workspaceParkingMode: envMode !== null
        ? 'env' as const
        : file.workspaceParkingMode !== undefined
          ? 'file' as const
          : 'default' as const,
    },
  };
}

export function applyWorkspaceParkingUpdate(
  stored: Partial<WorkspaceParkingDefaults>,
  update: Partial<WorkspaceParkingDefaults>,
): void {
  if (update.workspaceParkingMode === undefined) return;
  if (!isWorkspaceParkingMode(update.workspaceParkingMode)) {
    throw new Error('workspaceParkingMode must be "manual", "pressure" or "settled".');
  }
  stored.workspaceParkingMode = update.workspaceParkingMode;
}
