interface CommandHelp {
  usage: string;
  required: string;
  defaults: string;
  details: string;
  example: string;
}

const help: Record<string, CommandHelp> = {
  'mission create': {
    usage: '--title <text> [--repo <path>] [--dispatch] [--runtime <id>] [--effort <tier>]',
    required: '--title <text>. Use --repo <path> to select the repository explicitly.',
    defaults: 'dispatch is false; the mission is prepared without launching. Runtime follows saved routing.',
    details: '--dispatch starts work immediately. --effort accepts adaptive, low, medium, high, max, xhigh, ultra. --existingBranchPolicy accepts auto, reset, continue, error (default auto).',
    example: 'o8 mission create --title "Inspect behavior" --repo /path/to/repo',
  },
  'mission dispatch': {
    usage: '[--mission <id>] [--wait | --watch] [--timeout <duration>] [--poll <ms>]',
    required: 'No flags; --mission <id> selects an exact prepared mission.',
    defaults: 'Current stored mission; returns after launch admission. --wait waits for launch; --watch waits for review or terminal state, with a 2h timeout and 5000ms polling.',
    details: '--timeout and --poll apply only to --watch. --timeout accepts milliseconds or ms, s, m, h suffixes; prefer --timeout 5m. --poll is milliseconds. --wait uses the fixed launch timeout. Do not redispatch after an ambiguous timeout without checking mission status.',
    example: 'o8 mission dispatch --mission mission-audit --wait',
  },
  'mission status': {
    usage: '[--mission <id>] [--cost]',
    required: 'No flags; --mission <id> selects an exact mission.',
    defaults: 'Current stored mission; cost details are omitted.',
    details: '--cost includes recorded runtime cost. This is a read-only call.',
    example: 'o8 mission status --mission mission-audit',
  },
  'packet merge-preview': {
    usage: '[<id> | --packet <id>]',
    required: 'A packet target, unless the current worktree identifies one.',
    defaults: 'Resolves the packet from the current worktree. This is read-only.',
    details: 'Returns governance checks and blockers. It does not approve or merge.',
    example: 'o8 packet merge-preview --packet pkt-audit',
  },
  'packet steer': {
    usage: '--message <text> [--packet <id>]',
    required: '--message <text> and a packet target outside a packet worktree.',
    defaults: 'Resolves the packet from the current worktree; reuses the existing session.',
    details: 'Use the exact packet id from mission status. A missing session requires a recovery decision.',
    example: 'o8 packet steer --packet pkt-audit --message "Also check empty input"',
  },
  'packet review': {
    usage: '--approve [--packet <id>] [--expected-sha <full-sha>] [--coverage <requirement>=<path>]',
    required: '--approve and a packet target. --coverage requires --expected-sha with the full 40-character reviewed commit.',
    defaults: 'Resolves the packet from the current worktree. Successful approval merges through the gate unless a hold applies.',
    details: 'Read the diff and run merge-preview first. --coverage is repeatable; --contract-version requires coverage. This command records approval and attempts a merge.',
    example: 'o8 packet review --packet pkt-audit --approve --expected-sha 0123456789012345678901234567890123456789 --coverage R1=src/example.ts',
  },
  'lease acquire': {
    usage: '<resource> [--ttl <duration>] [--wait]',
    required: '<resource>, the exact shared resource name.',
    defaults: '--ttl 2h; --wait is false, so a held resource returns immediately.',
    details: '--ttl accepts milliseconds or ms, s, m, h suffixes, from 1s through 24h. --wait queues in FIFO order. Release with o8 lease release <resource> from the same agent process.',
    example: 'o8 lease acquire audit --ttl 2m',
  },
  'lease status': {
    usage: '<resource>',
    required: '<resource>, using the same name as lease acquire.',
    defaults: 'No optional arguments; reads the holder and FIFO queue without acquiring.',
    details: 'Use o8 lease list to discover active names.',
    example: 'o8 lease status audit',
  },
  'task create': {
    usage: '--title <text> [--repo <path>] [--project <id>] [--summary <text>]',
    required: '--title <text> or a positional title. A project must be selected or active.',
    defaults: 'Uses the active project; creates a queued task without launching a worker.',
    details: '--repo selects the repository; --project selects a project id or slug. Use task claim and task dispatch when ready to launch.',
    example: 'o8 task create --title "Inspect behavior" --repo /path/to/repo --project project-audit',
  },
  'task block': {
    usage: '<id> --reason <text> [--code <value>]',
    required: '<id> and --reason <text>. The id can identify a packet, lane, or task.',
    defaults: 'No normalized blocker code; moves the task to the blocked group.',
    details: '--code accepts needs_clarification, missing_context, out_of_scope, dependency_blocked, context_full, nondeterministic_test, external_api_down, unknown.',
    example: 'o8 task block pkt-audit --reason "Waiting for dependency" --code dependency_blocked',
  },
};

export function commandUsage(primary: string, secondary: string | undefined): string | null {
  const command = `${primary} ${secondary ?? ''}`;
  const entry = help[command];
  if (!entry) return null;
  return `usage: o8 ${command} ${entry.usage}\n\nRequired: ${entry.required}\nDefaults: ${entry.defaults}\n${entry.details}\n\nExample: ${entry.example}\n\nRun \`o8 ${primary} --help\` for related commands.\n`;
}
