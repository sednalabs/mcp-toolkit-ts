import { randomUUID } from 'node:crypto';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  startAuthorization,
  exchangeAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { parseAllowedHostsEnv } from './allowlist.js';
import { openBrowser } from './browser.js';
import { startCallbackServer } from './callback_server.js';
import { resolveClientInformation } from './client_registration.js';
import { discoverOAuthContext } from './discovery.js';
import { pickScope, resolveResourceUrl } from './scope.js';
import { storeNormalizedTokens } from './token_store.js';

export type OAuthFlowOptions = {
  serverUrl: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  allowDcr: boolean;
  redirectHost: string;
  redirectPort: number;
  openBrowser: boolean;
};


export async function runOAuthFlow(options: OAuthFlowOptions): Promise<OAuthTokens> {
  const allowedHosts = parseAllowedHostsEnv();
  const { oauthMetadata, resourceMetadata } = await discoverOAuthContext(
    options.serverUrl,
    allowedHosts,
  );

  const scope = pickScope(options.scope, resourceMetadata, oauthMetadata);
  const redirectUrl = `http://${options.redirectHost}:${options.redirectPort}/oauth/callback`;
  const resource = resolveResourceUrl(options.serverUrl, resourceMetadata);

  const clientInformation = await resolveClientInformation(
    options.serverUrl,
    oauthMetadata,
    options.clientId,
    options.clientSecret,
    options.allowDcr,
    redirectUrl,
    scope,
  );

  const state = randomUUID();
  const { authorizationUrl, codeVerifier } = await startAuthorization(options.serverUrl, {
    metadata: oauthMetadata,
    clientInformation,
    redirectUrl,
    state,
    resource,
    ...(scope !== undefined ? { scope } : {}),
  });

  const callbackServer = await startCallbackServer(
    options.redirectHost,
    options.redirectPort,
    state,
  );

  if (options.openBrowser) {
    openBrowser(authorizationUrl);
  } else {
    process.stdout.write(`Open this URL to authorize:\n${authorizationUrl.toString()}\n`);
  }

  const callback = await callbackServer.result;
  if (callback.error) {
    callbackServer.server.close();
    throw new Error(`OAuth error: ${callback.errorDescription ?? callback.error}`);
  }
  if (!callback.code) {
    callbackServer.server.close();
    throw new Error('No authorization code received.');
  }

  const tokens = await exchangeAuthorization(options.serverUrl, {
    metadata: oauthMetadata,
    clientInformation,
    authorizationCode: callback.code,
    codeVerifier,
    redirectUri: redirectUrl,
    resource,
  });

  callbackServer.server.close();

  const storedClientId = options.clientId ?? clientInformation.client_id;
  const storedClientSecret =
    options.clientSecret ??
    ('client_secret' in clientInformation ? clientInformation.client_secret : undefined);
  await storeNormalizedTokens(options.serverUrl, tokens, storedClientId, storedClientSecret);

  return tokens;
}
