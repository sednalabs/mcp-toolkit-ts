import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export function missingScopes(requiredScopes: string[], grantedScopes: string[]): string[] {
  if (requiredScopes.length === 0) {
    return [];
  }
  const granted = new Set(grantedScopes);
  return requiredScopes.filter((scope) => !granted.has(scope));
}

export function hasRequiredScopes(
  authInfo: AuthInfo | undefined,
  requiredScopes: string[],
): boolean {
  if (requiredScopes.length === 0) {
    return true;
  }
  if (!authInfo) {
    return false;
  }
  return missingScopes(requiredScopes, authInfo.scopes).length === 0;
}
