const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

export function parseAllowedHostsEnv(): string[] | undefined {
  const raw = process.env.MCP_PROBE_ALLOWED_HOSTS;
  if (!raw) {
    return DEFAULT_ALLOWED_HOSTS;
  }
  const hosts = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

export function isHostAllowed(url: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.host;
  const hostname = parsed.hostname;
  const origin = parsed.origin;
  return allowedHosts.some((entry) => entry === host || entry === hostname || entry === origin);
}

export function ensureHostAllowed(
  url: string,
  allowedHosts: string[] | undefined,
  label: string,
): void {
  if (!isHostAllowed(url, allowedHosts)) {
    throw new Error(`${label} host is not in the allowlist`);
  }
}
