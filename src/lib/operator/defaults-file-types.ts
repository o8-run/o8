import type { OperatorDefaults } from './defaults';
import { parseStoredJson } from './stored-json';

export type StoredOperatorDefaults = Partial<OperatorDefaults> & {
  defaultDispatchRuntimeExplicit?: boolean;
  autoApplyUpdates?: 'off' | 'when-idle';
};

export type FileOperatorDefaults = Partial<OperatorDefaults> & {
  defaultDispatchRuntimeExplicit?: boolean;
};

export const parseStoredDefaults = (raw: string): StoredOperatorDefaults => parseStoredJson<StoredOperatorDefaults>(raw);
