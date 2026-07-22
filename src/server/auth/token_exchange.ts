import { AuthError } from './errors.js';

export type TokenExchangeAuthMethod = 'client_secret_basic' | 'client_secret_post';

export type TokenExchangeConfig = {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  authMethod?: TokenExchangeAuthMethod;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type TokenExchangeRequest = {
  subjectToken: string;
  subjectTokenType?: string;
  actorToken?: string;
  actorTokenType?: string;
  audience?: string;
  resource?: string;
  scope?: string;
  requestedTokenType?: string;
  clientId?: string;
  extraParams?: Record<string, string>;
};

export type TokenExchangeResponse = {
  access_token: string;
  issued_token_type?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
};

const DEFAULT_SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const DEFAULT_REQUESTED_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

function resolveFetch(custom?: typeof fetch): typeof fetch {
  if (custom) return custom;
  if (typeof fetch === 'function') return fetch;
  throw new AuthError('Fetch is not available.', {
    status: 500,
    code: 'auth.exchange_unavailable',
    reason: 'fetch_missing',
    hint: 'To fix this, provide a fetch implementation.',
  });
}

export async function exchangeToken(
  config: TokenExchangeConfig,
  request: TokenExchangeRequest,
): Promise<TokenExchangeResponse> {
  const fetchImpl = resolveFetch(config.fetch);
  const params = new URLSearchParams();
  params.set('grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange');
  params.set('subject_token', request.subjectToken);
  params.set('subject_token_type', request.subjectTokenType ?? DEFAULT_SUBJECT_TOKEN_TYPE);
  if (request.actorToken) {
    params.set('actor_token', request.actorToken);
    if (request.actorTokenType) {
      params.set('actor_token_type', request.actorTokenType);
    }
  }
  if (request.requestedTokenType ?? DEFAULT_REQUESTED_TOKEN_TYPE) {
    params.set('requested_token_type', request.requestedTokenType ?? DEFAULT_REQUESTED_TOKEN_TYPE);
  }
  if (request.audience) {
    params.set('audience', request.audience);
  }
  if (request.resource) {
    params.set('resource', request.resource);
  }
  if (request.scope) {
    params.set('scope', request.scope);
  }
  if (request.clientId) {
    params.set('client_id', request.clientId);
  }
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };
  const authMethod = config.authMethod ?? 'client_secret_basic';
  if (authMethod === 'client_secret_post') {
    params.set('client_id', config.clientId);
    params.set('client_secret', config.clientSecret);
  } else {
    const encoded = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString(
      'base64',
    );
    headers.authorization = `Basic ${encoded}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 5_000);
  try {
    const response = await fetchImpl(config.tokenEndpoint, {
      method: 'POST',
      headers,
      body: params,
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new AuthError('Token exchange failed.', {
        status: response.status,
        code: 'auth.exchange_failed',
        reason: 'exchange_failed',
        hint: text || 'Verify the token exchange client credentials and request parameters.',
      });
    }
    const payload = text ? (JSON.parse(text) as TokenExchangeResponse) : ({} as TokenExchangeResponse);
    if (!payload.access_token) {
      throw new AuthError('Token exchange did not return an access token.', {
        status: 502,
        code: 'auth.exchange_failed',
        reason: 'missing_access_token',
        hint: 'Verify the authorization server supports RFC8693 token exchange.',
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AuthError('Token exchange timed out.', {
        status: 504,
        code: 'auth.exchange_timeout',
        reason: 'exchange_timeout',
        hint: 'Increase the token exchange timeout or verify network connectivity.',
      });
    }
    throw new AuthError('Token exchange failed.', {
      status: 502,
      code: 'auth.exchange_failed',
      reason: 'exchange_failed',
      hint: 'Verify the authorization server is reachable.',
    });
  } finally {
    clearTimeout(timeout);
  }
}

export type ExchangeAccessTokenRequest = TokenExchangeRequest & {
  requireAudienceOrResource?: boolean;
  allowRefreshToken?: boolean;
};

/**
 * Policy-enforced RFC8693 helper: require subject token, optionally require audience/resource,
 * and forbid refresh tokens by default.
 */
export async function exchangeAccessToken(
  config: TokenExchangeConfig,
  request: ExchangeAccessTokenRequest,
): Promise<TokenExchangeResponse> {
  if (!request.subjectToken || request.subjectToken.trim().length === 0) {
    throw new AuthError('Token exchange requires a subject token.', {
      status: 400,
      code: 'auth.exchange_invalid_request',
      reason: 'missing_subject_token',
      hint: 'Provide a non-empty subject_token when requesting exchange.',
    });
  }
  const requireAudienceOrResource = request.requireAudienceOrResource ?? true;
  if (requireAudienceOrResource && !request.audience && !request.resource) {
    throw new AuthError('Token exchange requires an audience or resource.', {
      status: 400,
      code: 'auth.exchange_invalid_request',
      reason: 'missing_audience_or_resource',
      hint: 'Provide audience or resource to bind exchanged tokens to their target.',
    });
  }

  const response = await exchangeToken(config, {
    ...request,
    requestedTokenType: request.requestedTokenType ?? DEFAULT_REQUESTED_TOKEN_TYPE,
  });
  if (!request.allowRefreshToken && response.refresh_token) {
    throw new AuthError('Token exchange returned a refresh token unexpectedly.', {
      status: 400,
      code: 'auth.exchange_invalid_response',
      reason: 'refresh_token_forbidden',
      hint: 'Disable refresh tokens for exchange or set allowRefreshToken=true.',
    });
  }
  return response;
}
