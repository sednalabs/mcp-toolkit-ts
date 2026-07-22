import { AuthError } from './errors.js';
import type { ReplayGuard } from './replay_guard.js';
import { verifyDpopProof, type DpopConfig, type DpopRequest } from './dpop.js';
import { verifyMtlsBinding, type MtlsConfig, type MtlsRequest } from './mtls.js';

export type SenderConstraintRequest = {
  method: string;
  url: string;
  dpopProof?: string;
  dpopNonce?: string;
  tlsClientCertificate?: Buffer | string;
};

export type SenderConstraintConfig = {
  dpop?: Omit<DpopConfig, 'replayGuard'> & { replayGuard: ReplayGuard };
  mtls?: MtlsConfig;
};

export async function verifySenderConstraints(
  claims: Record<string, unknown>,
  accessToken: string,
  config: SenderConstraintConfig | undefined,
  request: SenderConstraintRequest | undefined,
): Promise<void> {
  if (!config) return;
  if (!request) {
    const needsDpop = Boolean(config.dpop?.required);
    const needsMtls = Boolean(config.mtls?.required);
    if (needsDpop || needsMtls) {
      throw new AuthError('Sender-constrained token required.', {
        status: 401,
        code: 'auth.invalid_token',
        reason: 'sender_constraints_missing',
        hint: 'To fix this, include DPoP proof or mutual TLS credentials.',
      });
    }
    return;
  }

  if (config.dpop) {
    const dpopRequest: DpopRequest = {
      method: request.method,
      url: request.url,
      ...(request.dpopProof !== undefined ? { proof: request.dpopProof } : {}),
      ...(request.dpopNonce !== undefined ? { nonce: request.dpopNonce } : {}),
    };
    await verifyDpopProof(claims, accessToken, dpopRequest, config.dpop);
  }
  if (config.mtls) {
    const mtlsRequest: MtlsRequest =
      request.tlsClientCertificate !== undefined
        ? { clientCertificate: request.tlsClientCertificate }
        : {};
    verifyMtlsBinding(claims, mtlsRequest, config.mtls);
  }
}
