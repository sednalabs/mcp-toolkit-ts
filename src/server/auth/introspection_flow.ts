import crypto from 'node:crypto';
import { AuthError } from './errors.js';
import { IntrospectionClient, type IntrospectionConfig } from './introspection.js';

const introspectionClients = new Map<string, IntrospectionClient>();

export function getIntrospectionClient(config: IntrospectionConfig): IntrospectionClient {
  if (config.fetch || config.now) {
    return new IntrospectionClient(config);
  }
  const secretHash = crypto.createHash('sha256').update(config.clientSecret).digest('hex');
  const key = [
    config.url,
    config.clientId,
    config.authMethod ?? 'client_secret_basic',
    config.timeoutMs ?? 5000,
    config.cacheTtlSeconds ?? 0,
    config.cacheMaxEntries ?? 1000,
    secretHash,
  ].join('|');
  const cached = introspectionClients.get(key);
  if (cached) return cached;
  const client = new IntrospectionClient(config);
  introspectionClients.set(key, client);
  return client;
}

export async function introspectToken(
  token: string,
  config: IntrospectionConfig,
): Promise<Record<string, unknown>> {
  const client = getIntrospectionClient(config);
  try {
    const result = await client.introspect(token);
    if (!result.active) {
      throw new AuthError('Token is inactive.', {
        status: 401,
        code: 'auth.invalid_token',
        reason: 'inactive_token',
        hint: 'To fix this, refresh the access token and retry.',
      });
    }
    return result.response;
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    throw new AuthError('Token introspection failed.', {
      status: 401,
      code: 'auth.introspection_failed',
      reason: 'introspection_failed',
      hint: 'To fix this, verify the authorization server is reachable.',
    });
  }
}
