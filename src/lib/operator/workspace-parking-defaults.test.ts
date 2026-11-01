import { afterEach, describe, expect, it } from 'vitest';

import {
  applyWorkspaceParkingUpdate,
  resolveStoredWorkspaceParking,
  resolveWorkspaceParkingSettings,
} from './workspace-parking-defaults';

const originalMode = process.env.O8_WORKSPACE_PARKING_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.O8_WORKSPACE_PARKING_MODE;
  else process.env.O8_WORKSPACE_PARKING_MODE = originalMode;
});

describe('workspace parking operator defaults', () => {
  it('defaults to on-settle parking and preserves env over file source truth', () => {
    delete process.env.O8_WORKSPACE_PARKING_MODE;
    expect(resolveWorkspaceParkingSettings({})).toEqual({
      values: { workspaceParkingMode: 'settled' },
      sources: { workspaceParkingMode: 'default' },
    });
    expect(resolveWorkspaceParkingSettings({ workspaceParkingMode: 'pressure' })).toEqual({
      values: { workspaceParkingMode: 'pressure' },
      sources: { workspaceParkingMode: 'file' },
    });
    process.env.O8_WORKSPACE_PARKING_MODE = 'manual';
    expect(resolveWorkspaceParkingSettings({ workspaceParkingMode: 'pressure' })).toEqual({
      values: { workspaceParkingMode: 'manual' },
      sources: { workspaceParkingMode: 'env' },
    });
  });

  it('rejects unknown stored, environment, and update values', () => {
    expect(resolveStoredWorkspaceParking({ workspaceParkingMode: 'other' as 'manual' })).toEqual({});
    process.env.O8_WORKSPACE_PARKING_MODE = 'other';
    expect(resolveWorkspaceParkingSettings({}).values.workspaceParkingMode).toBe('settled');
    expect(() => applyWorkspaceParkingUpdate({}, { workspaceParkingMode: 'other' as 'manual' }))
      .toThrow(/manual.*pressure/);
  });
});
