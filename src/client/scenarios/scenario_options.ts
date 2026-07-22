export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRIES = 0;
export const DEFAULT_RETRY_DELAY_MS = 250;

export function resolveScenarioTiming(target: {
  timeout_ms?: number;
  retries?: number;
  retry_delay_ms?: number;
}): { timeoutMs: number; retries: number; retryDelayMs: number } {
  return {
    timeoutMs: target.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    retries: target.retries ?? DEFAULT_RETRIES,
    retryDelayMs: target.retry_delay_ms ?? DEFAULT_RETRY_DELAY_MS,
  };
}
