export interface SandboxDenial {
  operation: 'file-read' | 'file-write' | 'process-exec' | 'sandbox-apply' | 'unknown';
  resource: string;
  line: string;
}

const OPERATION_NOT_PERMITTED = /operation not permitted/i;

function trimResource(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/[.,;]$/, '').slice(0, 512);
}

function operationForCommand(command: string): SandboxDenial['operation'] {
  const name = command.trim().split(/[ /]/).at(-1)?.toLowerCase() ?? '';
  if (['cat', 'head', 'tail', 'stat', 'ls', 'find', 'rg', 'grep'].includes(name)) return 'file-read';
  if (['chmod', 'chown', 'cp', 'ln', 'mkdir', 'mv', 'rm', 'touch'].includes(name)) return 'file-write';
  if (['env', 'sh', 'bash', 'zsh', 'sandbox-exec'].includes(name)) return 'process-exec';
  return 'unknown';
}

/** Parse the stderr forms emitted by macOS sandbox-exec and denied children. */
export function detectSandboxDenial(raw: string): SandboxDenial | null {
  for (const originalLine of raw.split(/\r?\n/)) {
    const diagnostic = originalLine.trim();
    if (!diagnostic || diagnostic.startsWith('{') || diagnostic.startsWith('[')) continue;
    const line = diagnostic.slice(0, 1024);

    // A policy expression or quoted source line is not a kernel diagnostic.
    const sandboxLog = diagnostic.match(/^(?:Sandbox:\s+\S+\(\d+\)\s+)?deny(?:\(\d+\))?\s+(file-read(?:-[a-z-]+)?|file-write(?:-[a-z-]+)?|process-exec)\s+(\/.+)$/i);
    if (sandboxLog) {
      const operation = sandboxLog[1]?.toLowerCase().startsWith('file-read')
        ? 'file-read'
        : sandboxLog[1]?.toLowerCase().startsWith('file-write')
          ? 'file-write'
          : 'process-exec';
      return { operation, resource: trimResource(sandboxLog[2] ?? 'unknown resource'), line };
    }

    const execFailure = diagnostic.match(/^(?:sandbox-exec:\s*)?execvp\(\) of ['"](.+?)['"] failed:\s*Operation not permitted\s*$/i);
    if (execFailure) {
      return { operation: 'process-exec', resource: trimResource(execFailure[1] ?? ''), line };
    }

    const modeFailure = diagnostic.match(/^(?:chmod:\s*)?Unable to change file mode on (.+?):\s*Operation not permitted\s*$/i);
    if (modeFailure) {
      return { operation: 'file-write', resource: trimResource(modeFailure[1] ?? ''), line };
    }

    if (/^sandbox-exec:\s*sandbox_apply:/i.test(diagnostic) && OPERATION_NOT_PERMITTED.test(diagnostic)) {
      return { operation: 'sandbox-apply', resource: 'generated worker sandbox profile', line };
    }

    const childFailure = diagnostic.match(/^([\w./-]+):\s+(.+?):\s*Operation not permitted\s*$/i);
    if (childFailure) {
      return {
        operation: operationForCommand(childFailure[1] ?? ''),
        resource: trimResource(childFailure[2] ?? 'unknown resource'),
        line,
      };
    }
  }
  return null;
}

/** Stdout is provider data, not stderr. Inspect only explicit failed tool envelopes. */
export function detectRunSandboxDenial(runtime: string, stdout: string, stderr: string): SandboxDenial | null {
  const stderrDenial = detectSandboxDenial(stderr);
  if (stderrDenial) return stderrDenial;
  for (const line of stdout.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    const diagnostics: string[] = [];
    if (runtime === 'claude-code' && event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const result of event.message.content) {
        if (result?.type !== 'tool_result' || result.is_error !== true) continue;
        if (typeof result.content === 'string') diagnostics.push(result.content);
        else if (Array.isArray(result.content)) {
          for (const part of result.content) {
            if (part?.type === 'text' && typeof part.text === 'string') diagnostics.push(part.text);
          }
        }
      }
    }
    const item = event.item;
    if (runtime === 'codex' && event.type === 'item.completed' && item?.type === 'command_execution'
      && (item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0))
      && typeof item.aggregated_output === 'string') diagnostics.push(item.aggregated_output);
    for (const diagnostic of diagnostics) {
      const denial = detectSandboxDenial(diagnostic);
      if (denial) return denial;
    }
  }
  return null;
}

export function sandboxDenialOperatorMessage(runtime: string, denial: SandboxDenial): string {
  return `${runtime} worker sandbox blocked ${denial.operation} access to ${denial.resource}. `
    + 'Review the worker sandbox profile before retrying the blocked operation.';
}
