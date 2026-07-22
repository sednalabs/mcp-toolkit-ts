import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';
import { verifyDpopProof } from '../server/auth/dpop.js';
import { ReplayGuard } from '../server/auth/replay_guard.js';

describe('DPoP verification', () => {
  it('accepts valid DPoP proof and enforces replay guard', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    const jkt = await calculateJwkThumbprint(jwk);
    const accessToken = 'access-token';
    const ath = createHash('sha256').update(accessToken).digest('base64url');
    const now = Math.floor(Date.now() / 1000);
    const proof = await new SignJWT({
      htm: 'POST',
      htu: 'https://example.test/mcp',
      iat: now,
      jti: 'jti-1',
      ath,
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
      .sign(privateKey);

    const guard = new ReplayGuard({ ttlSeconds: 10, maxEntries: 100 });
    await verifyDpopProof(
      { cnf: { jkt } },
      accessToken,
      { method: 'POST', url: 'https://example.test/mcp', proof },
      { required: true, replayGuard: guard, allowedAlgorithms: ['ES256'], requireAth: true },
    );

    await expect(
      verifyDpopProof(
        { cnf: { jkt } },
        accessToken,
        { method: 'POST', url: 'https://example.test/mcp', proof },
        { required: true, replayGuard: guard, allowedAlgorithms: ['ES256'], requireAth: true },
      ),
    ).rejects.toMatchObject({ reason: 'dpop_replay' });
  });
});
