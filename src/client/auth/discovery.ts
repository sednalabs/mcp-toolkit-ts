import type {
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { ensureHostAllowed } from './allowlist.js';

export type OAuthDiscoveryResult = {
  authServerUrl: string;
  oauthMetadata: OAuthMetadata;
  resourceMetadata: OAuthProtectedResourceMetadata | null;
};

export async function discoverOAuthContext(
  serverUrl: string,
  allowedHosts?: string[],
): Promise<OAuthDiscoveryResult> {
  ensureHostAllowed(serverUrl, allowedHosts, 'Server');

  let resourceMetadata: OAuthProtectedResourceMetadata | null = null;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl);
  } catch {
    resourceMetadata = null;
  }

  let authServerUrl = new URL('/', serverUrl).toString();
  if (resourceMetadata?.authorization_servers?.length) {
    const candidate = resourceMetadata.authorization_servers[0];
    if (candidate) {
      authServerUrl = candidate;
    }
  }
  ensureHostAllowed(authServerUrl, allowedHosts, 'Authorization server');

  const oauthMetadata = await discoverAuthorizationServerMetadata(new URL(authServerUrl));
  if (!oauthMetadata) {
    throw new Error('Failed to discover OAuth metadata.');
  }
  if (typeof oauthMetadata.authorization_endpoint === 'string') {
    ensureHostAllowed(oauthMetadata.authorization_endpoint, allowedHosts, 'Authorization endpoint');
  }
  if (typeof oauthMetadata.token_endpoint === 'string') {
    ensureHostAllowed(oauthMetadata.token_endpoint, allowedHosts, 'Token endpoint');
  }

  return {
    authServerUrl,
    oauthMetadata,
    resourceMetadata,
  };
}
