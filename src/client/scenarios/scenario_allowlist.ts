import type { TransportType } from '../../transport.js';
import type { ProbeStep } from '../../report.js';
import { isHostAllowed } from '../auth/allowlist.js';

export function enforceHostAllowlist(
  scenario: { transport: TransportType; url?: string },
  steps: ProbeStep[],
  allowedHosts?: string[],
): boolean {
  const allowlistConfigured = process.env.MCP_PROBE_ALLOWED_HOSTS !== undefined;
  if (scenario.transport === 'stdio') {
    steps.push({ name: 'host.allowlist', status: 'ok', detail: 'not applicable' });
    return true;
  }
  if (!allowedHosts || allowedHosts.length === 0) {
    steps.push({ name: 'host.allowlist', status: 'ok', detail: 'not configured' });
    return true;
  }
  if (!scenario.url) {
    steps.push({ name: 'host.allowlist', status: 'error', detail: 'Missing target URL' });
    return false;
  }
  if (!isHostAllowed(scenario.url, allowedHosts)) {
    steps.push({
      name: 'host.allowlist',
      status: 'error',
      detail: `Host not allowed: ${new URL(scenario.url).host}`,
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
