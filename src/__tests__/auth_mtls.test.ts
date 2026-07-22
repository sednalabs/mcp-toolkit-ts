import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMtlsBinding } from '../server/auth/mtls.js';

describe('mTLS binding', () => {
  it('accepts matching certificate thumbprint', () => {
    const cert = Buffer.from('cert-bytes');
    const thumbprint = createHash('sha256').update(cert).digest('base64url');
    expect(() =>
      verifyMtlsBinding({ cnf: { 'x5t#S256': thumbprint } }, { clientCertificate: cert }, { required: true }),
    ).not.toThrow();
  });

  it('rejects missing certificate when required', () => {
    expect(() =>
      verifyMtlsBinding({ cnf: { 'x5t#S256': 'missing' } }, {}, { required: true }),
    ).toThrow();
  });
});
