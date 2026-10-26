'use client';

/**
 * Bridges the workspace-terminal controller's tab-spawn helpers down to
 * deeply nested children (ThoughtsChatPanel → ModePicker) so the mode
 * chooser can spawn a Single-runtime or Chat tab without prop-drilling
 * through OrchestratorTab.
 *
 * Mode persistence (mode/runtime/chatModel) for the active tab also
 * routes through this context — ThoughtsChatPanel updates the tab record
 * instead of writing to global per-workspace localStorage.
 */

import { createContext, useContext } from 'react';
import type { ChatModelId } from '@/components/desktop/orchestrator/chat-models';
import type { OrchestrationMode, OrchestratorRuntime } from '@/lib/orchestrator/types';

export interface WorkspaceSpawnHandlers {
  spawnSingleRuntimeTab: (runtime: OrchestratorRuntime) => string;
  spawnChatTab: () => string;
  spawnChatGPTPlanTab?: () => void;
  spawnOrchestratorTab: () => string;
  spawnFleetCanvasTab?: () => string;
  updateTabMode: (
    tabId: string,
    patch: {
      mode?: OrchestrationMode;
      singleRuntime?: OrchestratorRuntime;
      chatModelId?: ChatModelId;
      chatOpenrouterModel?: string | null;
      worktreeMode?: 'local' | 'new-worktree';
      worktreePath?: string;
    },
  ) => void;
}

const WorkspaceSpawnContext = createContext<WorkspaceSpawnHandlers | null>(null);

export const WorkspaceSpawnProvider = WorkspaceSpawnContext.Provider;

export function useWorkspaceSpawn(): WorkspaceSpawnHandlers | null {
  return useContext(WorkspaceSpawnContext);
}
