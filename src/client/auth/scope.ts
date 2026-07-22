import type {
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export function pickScope(
  explicitScope: string | undefined,
  resourceMetadata?: OAuthProtectedResourceMetadata | null,
  oauthMetadata?: OAuthMetadata | null,
): string | undefined {
  if (explicitScope && explicitScope.trim().length > 0) {
    return explicitScope.trim();
  }
  const resourceScopes = resourceMetadata?.scopes_supported;
  if (resourceScopes && resourceScopes.length > 0) {
    return resourceScopes.join(' ');
  }
  const oauthScopes = oauthMetadata?.scopes_supported;
  if (oauthScopes && oauthScopes.length > 0) {
    return oauthScopes.join(' ');
  }
  return undefined;
}

export function resolveResourceUrl(
  serverUrl: string,
  resourceMetadata?: OAuthProtectedResourceMetadata | null,
): URL {
  if (resourceMetadata?.resource) {
    return new URL(resourceMetadata.resource);
  }
  return new URL(serverUrl);
}
