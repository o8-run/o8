export function until<T>(probe: () => T | Promise<T>, timeout: number): Promise<T>;
export function nativeEval(socketPath: string, code: string, timeout: number): Promise<unknown>;
export function chatTurn(options: { port: number; token: string; repoPath: string; backend: string; timeout: number }): Promise<void>;
export function workerDispatch(options: { runtime?: string; apiPort: number; token: string; repoPath: string; timeout: number }): Promise<void>;
