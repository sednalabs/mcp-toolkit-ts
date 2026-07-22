import type { ProbeStep } from '../../report.js';

const STDIO_ALLOW_ENV = 'MCP_PROBE_ALLOW_STDIO';

function isTruthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return true;
}

export function isStdioAllowed(): boolean {
  const raw = process.env[STDIO_ALLOW_ENV];
  if (!raw) {
    return false;
  }
  return isTruthy(raw);
}

export function enforceStdioAllowlist(
  transportType: string | undefined,
  steps: ProbeStep[],
): boolean {
  if (transportType !== 'stdio') {
    return true;
  }
  if (isStdioAllowed()) {
    steps.push({ name: 'stdio.allowlist', status: 'ok' });
    return true;
  }
  steps.push({
    name: 'stdio.allowlist',
    status: 'error',
    detail: `stdio transport disabled. Set ${STDIO_ALLOW_ENV}=1 to enable.`,
  });
  return false;
}

export function stdioAllowlistEnv(): string {
  return STDIO_ALLOW_ENV;
}
