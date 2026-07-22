import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { registerClient } from '@modelcontextprotocol/sdk/client/auth.js';

export function buildClientMetadata(
  redirectUrl: string,
  scope: string | undefined,
  clientSecret?: string,
): OAuthClientMetadata {
  return {
    redirect_uris: [redirectUrl],
    token_endpoint_auth_method: clientSecret ? 'client_secret_basic' : 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'mcp-probe',
    ...(scope !== undefined ? { scope } : {}),
  };
}

export async function resolveClientInformation(
  serverUrl: string,
  metadata: OAuthMetadata,
  clientId?: string,
  clientSecret?: string,
  allowDcr?: boolean,
  redirectUrl?: string,
  scope?: string,
): Promise<OAuthClientInformation> {
  if (clientId) {
    return {
      client_id: clientId,
      ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
    };
  }
  if (!allowDcr) {
    throw new Error('Client ID is required unless --allow-dcr is set.');
  }
  if (!redirectUrl) {
    throw new Error('Redirect URL is required for client registration.');
  }
  const clientMetadata = buildClientMetadata(redirectUrl, scope, clientSecret);
  return await registerClient(serverUrl, {
    metadata,
    clientMetadata,
  });
}
