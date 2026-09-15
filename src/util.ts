import { createHash } from 'node:crypto';

export const hash = (value: unknown): string => createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export class ConfigurationError extends Error {}
export class UnsupportedSnapshot extends Error {}
export class Superseded extends Error {}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Also bounds dependencies that ignore AbortSignal. Late values have no consumers. */
export async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller may have created work that synchronously caused cancellation.
    // Consume its eventual rejection even though it can never supply a result.
    void work.catch(() => {});
    signal.throwIfAborted();
  }
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('Cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await bounded(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}

export const unique = <T>(values: T[]): T[] => [...new Set(values)];
