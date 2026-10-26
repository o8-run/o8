import { NextWindowStartupError } from '@/lib/next/app-window';
import { SettingsTomlConflictError } from '@/lib/settings/operator-defaults-store';

export function operatorDefaultsUpdateFailure(error: unknown, native: boolean) {
  if (error instanceof NextWindowStartupError) {
    return { body: { error: error.message, code: error.code }, status: 503 };
  }
  const conflict = error instanceof SettingsTomlConflictError;
  const message = native
    ? (conflict ? 'Settings changed. Reload before saving.' : 'Settings update refused. Check the declared settings and try again.')
    : error instanceof Error ? error.message : 'Failed to update operator defaults.';
  return { body: { error: message }, status: conflict ? 409 : 400 };
}
