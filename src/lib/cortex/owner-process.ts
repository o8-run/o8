/** Internal process role, shared across lazy handler bundles. No caller header sets it. */
const runtime = globalThis as typeof globalThis & { __o8NativeCortexReader?: boolean };

export function markNativeCortexReader(): void {
  runtime.__o8NativeCortexReader = true;
}

export function isNativeCortexReader(): boolean {
  return runtime.__o8NativeCortexReader === true;
}
