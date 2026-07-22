# Runbook

## Purpose
Provide reusable utilities for MCP servers and clients.

## Setup
1. Install deps: `npm install`
2. Build: `npm run build`

## Usage
- Registry publication is not part of the initial public-source release. Use a local checkout or a
  pinned Git dependency until a package release is announced.
- Exported modules live under `src/` and are re-exported from `src/index.ts`.
- Auth helpers include JWT validation and RFC7662 introspection. Introspection is the recommended default for centralized policy enforcement.
- Sender-constrained access tokens can be enforced via DPoP or mTLS helpers, and RFC8693 token exchange is supported for downstream access.

## Sender-constraint integration (TypeScript)

Pass request metadata into `authenticateToken` when you enable DPoP or mTLS:

```ts
import { authenticateToken, ReplayGuard } from '@sednalabs/mcp-toolkit-ts';

const ctx = await authenticateToken(token, {
  mode: 'introspection',
  issuer,
  audience,
  introspection: {
    url: introspectionUrl,
    clientId: introspectionClientId,
    clientSecret: introspectionClientSecret,
  },
  senderConstraints: {
    dpop: { required: true, replayGuard: new ReplayGuard({ ttlSeconds: 300, maxEntries: 1000 }) },
    mtls: { required: false },
  },
  request: {
    method: req.method,
    url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    dpopProof: req.header('DPoP') ?? undefined,
    tlsClientCertificate: req.socket.getPeerCertificate?.().raw,
  },
});
```

## Tests
- `npm run build`
- `npm test`
- `npm pack --dry-run`
