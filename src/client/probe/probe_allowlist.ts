import { isHostAllowed } from '../auth/allowlist.js';
import { isStdioAllowed } from '../scenarios/allowlist.js';
import type { ProbeStep } from '../../report.js';

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
    detail: 'stdio transport disabled. Set MCP_PROBE_ALLOW_STDIO=1 to enable.',
  });
  return false;
}

export function enforceHostAllowlist(
  target: { transportType: string; url?: string },
  steps: ProbeStep[],
  allowedHosts?: string[],
): boolean {
  const allowlistConfigured = process.env.MCP_PROBE_ALLOWED_HOSTS !== undefined;
  if (target.transportType === 'stdio') {
    steps.push({ name: 'host.allowlist', status: 'ok', detail: 'not applicable' });
    return true;
  }
  if (!allowedHosts || allowedHosts.length === 0) {
    steps.push({ name: 'host.allowlist', status: 'ok', detail: 'not configured' });
    return true;
  }
  if (!target.url) {
    steps.push({ name: 'host.allowlist', status: 'error', detail: 'Missing target URL' });
    return false;
  }
  if (!isHostAllowed(target.url, allowedHosts)) {
    steps.push({
      name: 'host.allowlist',
      status: 'error',
      detail: `Host not allowed: ${new URL(target.url).host}`,
    });
    return false;
  }
  steps.push({
    name: 'host.allowlist',
    status: 'ok',
    ...(!allowlistConfigured ? { detail: 'default (localhost only)' } : {}),
  });
  return true;
}

export function applyExpectAuthRequired(
  steps: ProbeStep[],
  expectAuthRequired?: boolean,
): void {
  if (!expectAuthRequired) {
    return;
  }
  const prmStep = steps.find((step) => step.name === 'auth.prm');
  const ok =
    prmStep?.status === 'ok' &&
    prmStep.detail !== 'no auth required' &&
    prmStep.detail !== 'not applicable';
  const detail = ok ? undefined : 'Expected an auth challenge but none was detected';
  steps.push({
    name: 'expect.auth_required',
    status: ok ? 'ok' : 'error',
    ...(detail !== undefined ? { detail } : {}),
  });
}
