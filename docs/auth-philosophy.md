# Auth philosophy

- Access tokens are treated as capabilities; JWT is an implementation detail.
- Authorization semantics are opaque; JWT is a wire format.
- Token validation uses off-the-shelf JOSE libraries and/or RFC 7662 introspection; no custom token cryptography or authorization server logic.
- Authorization decisions are centralized (introspection when available); MCP components and downstream services avoid interpreting policy-bearing claims.
- Authorization must remain revocation-aware; any caching of validation results is bounded and explicit.
- Expose only non-authoritative claims for routing/diagnostics (aud, iss, exp, azp/client_id).
- Never log or forward raw tokens; prefer request IDs for correlation.
- Sender-constrained tokens (DPoP or mTLS) should be enforced when configured.
