import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { normalizeTokens, storeTokens } from './cache.js';

export async function storeNormalizedTokens(
  serverUrl: string,
  tokens: OAuthTokens,
  clientId: string,
  clientSecret?: string,
): Promise<void> {
  await storeTokens(serverUrl, normalizeTokens(tokens), clientId, clientSecret);
}
