# Repository workspace manifest

`o8.workspace.json` is a versioned repository workspace declaration. Keep it at the repository root, next to `o8.md`, and check it into the repository so clones receive the same contract. `~/.o8/repos.json` can cache the manifest version, path, service names, or a validation error, but the checked-in file is the source of truth.

## Execution policy

The operator setting `workspaceManifestPolicy` controls whether a packet launch may execute a checked-in manifest. The default is `disabled`, so a fresh installation does not run repository-declared commands.

- `disabled` skips the manifest before allocating ports or running setup.
- `one-approval` creates one operator approval for the repository path and the SHA-256 hash of the manifest bytes. Approval covers that exact manifest hash for later packet launches. Rejection keeps that hash blocked. Editing any manifest byte requires a new decision.
- `auto` applies the manifest without a per-hash approval.

The approval card lists the manifest commands verbatim and uses the existing operator inbox flow. An approval records the decision only. It does not apply the manifest to the packet that raised the card. A later packet launch reads the decision and applies the manifest through the normal launch path.

Skipped launches record `workspace_manifest_skipped` with the policy and manifest hash. A pending or rejected one-approval decision also carries the approval ID. Policy evaluation completes before port leases, setup commands, service receipts, health probes, or preview resolution.

## Remote task previews

A cloud task can request its manifest-declared preview from the task menu in the macOS coordinator desktop app. The URL must resolve to one healthy, declared HTTP service on the worker's loopback interface. The current job, claim, active worker key, reviewed manifest hash, service command, and Linux process-group socket ownership are checked before serving project bytes. The task cannot supply an arbitrary destination.

Project content opens in a separate native webview on a dedicated loopback origin. It receives neither coordinator credentials nor the regular Browser pane's agent controls. Closing the view destroys its native page and access listener; Reconnect requests fresh access for the current attempt. Revocation, worker loss, expired or replaced claims, and stopped services invalidate access.

This first transport supports bounded HTTP GET/HEAD responses only. It does not support WebSockets, streamed responses, write requests, remote editing, or services retained after execution. Linux owns the service; the coordinator must run the supported macOS native shell. Other desktop platforms and access from another coordinator device remain separate acceptance work.

## Version 1 schema

```ts
interface WorkspaceManifestV1 {
  version: 1;
  setup?: string[];
  teardown?: string[];
  services?: Array<{
    name: string;
    command: string;
    cwd?: string;
    dependsOn?: string[];
    restart?: { maxRestarts: number; delayMs?: number };
    timeoutMs?: number;
    outputLimitBytes?: number;
    shutdownGraceMs?: number;
    env?: Record<string, string>;
    port?: {
      preferred: number;
      env?: string;
    };
    health?: {
      http?: string;
      tcp?: true;
      timeoutMs?: number;
    };
  }>;
  preview?: {
    url: string;
    autoOpen?: boolean;
  };
  limits?: { timeoutMs?: number; outputLimitBytes?: number; shutdownGraceMs?: number };
}
```

`setup` and `teardown` list commands that run from the repository root. A service `cwd`, when present, is relative to that root. `preview.url` can contain `{{port}}` or `{{service:<name>}}` placeholders.

## Complete example

```json
{
  "version": 1,
  "setup": [
    "npm install",
    "npm run build"
  ],
  "teardown": [
    "npm run cleanup"
  ],
  "services": [
    {
      "name": "api",
      "command": "npm run dev:api",
      "cwd": "apps/api",
      "env": {
        "LOG_LEVEL": "debug"
      },
      "port": {
        "preferred": 4100,
        "env": "API_PORT"
      },
      "health": {
        "http": "http://127.0.0.1:{{port}}/health",
        "timeoutMs": 30000
      }
    },
    {
      "name": "web",
      "command": "npm run dev:web",
      "cwd": "apps/web",
      "dependsOn": ["api"],
      "env": { "API_ORIGIN": "http://127.0.0.1:{{service:api}}" },
      "port": {
        "preferred": 4173,
        "env": "WEB_PORT"
      },
      "health": {
        "tcp": true,
        "timeoutMs": 30000
      }
    }
  ],
  "preview": {
    "url": "http://127.0.0.1:{{service:web}}"
  }
}
```

## Validation and discovery rules

- Parsing is strict at every schema object. An unknown key fails validation and the error names its JSON path, such as `$.services[0].restartPolicy`.
- `version` is required. Version 1 passes through `migrateManifest()` unchanged. Unsupported versions fail with an error at `$.version`.
- Service names must be unique within one manifest.
- A preferred port must be an integer from 1 through 65535. It cannot use o8's current production, reserved, or development blocks: `47100` through `47111` and `47120` through `47129`. `src/lib/panel/port-constants.ts` is authoritative.
- `loadWorkspaceManifest(repoPath)` reads only `<repoPath>/o8.workspace.json`. A missing file returns `null`.
- Repository connection never fails because of an invalid manifest. The registry caches `{ manifest: { error } }` and leaves the checked-in file unchanged.
- Discovery does not run setup, teardown, services, health checks, placeholder resolution, or port allocation.

## Owned local service lifecycle

Approved packet provisioning allocates all ports, validates real service directories, and starts a private supervisor in a registered o8 terminal. Repository commands remain held until setup completes and durable terminal registration succeeds. Services start in dependency order; each dependency must pass its declared readiness check before the next starts. `PORT` is the current service's allocated port. Named port environment variables and `{{service:<name>}}` values let peers find one another without sharing credentials. A failed health check never publishes a ready preview.

`restart.maxRestarts` defaults to zero and is capped at five. Every attempt retains command identity, timing, exit, output byte count and health evidence. `timeoutMs` on a service bounds its lifetime; root `limits.timeoutMs` bounds each setup/teardown command. Service output and shutdown limits override the root defaults. Output is counted and bounded rather than copied into receipts or persistent logs. Setup retains its existing bounded execution path. Health deadlines are capped at five minutes each and aggregate readiness at 45 minutes.

Completion, cancellation, reset, provisioning failure, unexpected service exit and server-owner death stop the owned process groups before teardown. The supervisor keeps an exact process-group leader until settlement and verifies process birth identity before signalling. Teardown is claimed durably before it runs and is never replayed after interruption. Failed or unconfirmed cleanup retains its evidence and refuses a new generation. The normal terminal Stop action also waits for the coordinator, so a slow approved teardown is not interrupted by ordinary process escalation.

The immutable approved command snapshot and generation state live in the operator data directory. Restarted modules read that state; they do not load replacement teardown commands from the worktree. Symlinked/escaping service directories and authenticated or non-loopback preview/health URLs are refused before setup. Manifest environment declarations cannot contain credential fields; repository services receive only declared non-secret values, allocated ports and executable lookup paths. Existing provider credential policy remains authoritative, and provider material is rejected rather than copied into manifests or receipts.

`preview.autoOpen` opts into the existing Browser-open request after readiness. Its receipt distinguishes a confirmed opened view from pending or unavailable native transport. Unavailable Browser transport does not turn a healthy service into a failed provision. UI-loop readiness consumes the same declared preview, and a later service failure invalidates it.

Local service ownership currently requires tmux and a POSIX host. An unavailable terminal or unsupported host fails visibly; no detached raw-process fallback runs repository commands. Repositories without a manifest retain their existing setup path. Remote task previews use their existing worker lifecycle described above.
