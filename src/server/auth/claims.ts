export function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim());
  const compact = filtered.filter((entry) => entry.length > 0);
  return compact.length > 0 ? compact : undefined;
}

export function normalizeAudience(value: unknown): string[] {
  const asString = readString(value);
  if (asString) return [asString];
  const asArray = readStringArray(value);
  if (asArray) return asArray;
  return [];
}

export function readTokenType(payload: Record<string, unknown>, headerTyp?: string): string | undefined {
  if (headerTyp) return headerTyp;
  const typ = readString(payload.typ);
  if (typ) return typ;
  return readString(payload.token_type);
}

export function readSubject(payload: Record<string, unknown>): string | undefined {
  return readString(payload.sub) ?? readString(payload.username);
}

export function readClientId(payload: Record<string, unknown>): string {
  return (
    readString(payload.azp) ||
    readString(payload.client_id) ||
    normalizeAudience(payload.aud)[0] ||
    'unknown'
  );
}

export function extractScopes(payload: Record<string, unknown>): string[] {
  const raw = (payload.scope ?? payload.scp ?? payload.scopes) as string | string[] | undefined;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s)).filter((s) => s.length > 0);
  }
  return String(raw)
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function extractRoles(payload: Record<string, unknown>): string[] {
  const roles: string[] = [];
  const realmAccess = payload.realm_access as { roles?: string[] } | undefined;
  if (realmAccess?.roles) {
    roles.push(...realmAccess.roles.map((r) => String(r)).filter((r) => r.length > 0));
  }
  const resourceAccess = payload.resource_access as
    | Record<string, { roles?: string[] }>
    | undefined;
  if (resourceAccess) {
    for (const entry of Object.values(resourceAccess)) {
      if (!entry?.roles) continue;
      roles.push(...entry.roles.map((r) => String(r)).filter((r) => r.length > 0));
    }
  }
  return Array.from(new Set(roles));
}
