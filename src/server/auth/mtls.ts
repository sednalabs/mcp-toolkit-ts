import crypto from 'node:crypto';
import { AuthError } from './errors.js';

export type MtlsConfig = {
  required?: boolean;
};

export type MtlsRequest = {
  clientCertificate?: Buffer | string;
};

function parseCertificate(value: Buffer | string): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.includes('BEGIN CERTIFICATE')) {
    const match = trimmed.match(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/s);
    if (!match) {
      throw new AuthError('Invalid client certificate.', {
        status: 401,
        code: 'auth.invalid_token',
        reason: 'mtls_cert_invalid',
        hint: 'To fix this, provide a valid client certificate.',
      });
    }
    const base64 = match[1]?.replace(/\s+/g, '') ?? '';
    return Buffer.from(base64, 'base64');
  }
  return Buffer.from(trimmed, 'base64');
}

function certThumbprint(cert: Buffer | string): string {
  const der = parseCertificate(cert);
  return crypto.createHash('sha256').update(der).digest('base64url');
}

export function verifyMtlsBinding(
  claims: Record<string, unknown>,
  request: MtlsRequest,
  config: MtlsConfig,
): void {
  const cnf = (claims.cnf ?? {}) as Record<string, unknown>;
  const expected = typeof cnf['x5t#S256'] === 'string' ? cnf['x5t#S256'] : undefined;
  if (!expected) {
    if (config.required) {
      throw new AuthError('Token missing certificate binding.', {
        status: 401,
        code: 'auth.invalid_token',
        reason: 'mtls_missing_cnf',
        hint: 'To fix this, request a token bound to a client certificate.',
      });
    }
    return;
  }
  if (!request.clientCertificate) {
    throw new AuthError('Missing client certificate.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'mtls_missing_cert',
      hint: 'To fix this, present a client certificate for mutual TLS.',
    });
  }
  const actual = certThumbprint(request.clientCertificate);
  if (actual !== expected) {
    throw new AuthError('Client certificate does not match token binding.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'mtls_binding_mismatch',
      hint: 'To fix this, use the certificate bound to the access token.',
    });
  }
}
