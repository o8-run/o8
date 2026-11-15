import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import type { McpTool } from './shared';

export const DISPATCH_MISSION_TOOL: McpTool = {
  name: 'dispatch_mission',
  description:
    'Dispatch the existing packets of a prepared mission created with dispatch:false. Pass the exact missionId returned by create_mission: dispatch_mission({missionId: "mission-abc123"}). This starts that mission without creating a new mission or generic delegate packet. Also use after reset_packet or retry_packet when a relaunch is needed, or for explicit redispatch. Omit runtime to preserve the prepared routing and contract. create_mission dispatches by default; do not dispatch it again unless it was prepared or needs relaunch. Omitted missionId selects the current stored mission.',
  inputSchema: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: 'Bypass machine load admission for this dispatch only.' },
      missionId: { type: 'string', description: 'Optional mission ID. If omitted, dispatches the current stored mission.' },
      runtime: { type: 'string', enum: [...listDispatchableRuntimes(), 'claude'], description: 'Optional per-dispatch worker runtime. When set, it overrides the runtime stamped on every not-yet-launched packet admitted by this dispatch.' },
    },
  },
};
