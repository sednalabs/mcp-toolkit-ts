export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRIES = 0;
export const DEFAULT_RETRY_DELAY_MS = 250;

export type ProbeOptions = {
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
};

export function resolveProbeOptions(target: {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}): ProbeOptions {
  return {
    timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: target.retries ?? DEFAULT_RETRIES,
    retryDelayMs: target.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  };
}
