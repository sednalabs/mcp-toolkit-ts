# Sedna Labs TypeScript MCP Toolkit

Reusable TypeScript primitives for building Model Context Protocol servers, clients, probes, and
operator-facing automation. The toolkit keeps transport, authentication, observability, discovery,
and scenario execution behind focused modules with a small public facade.

This repository is the canonical public source for `@sednalabs/mcp-toolkit-ts`. Registry
publication is not part of the initial source release, and `package.json` remains marked private to
prevent accidental publication. The unscoped `mcp-toolkit` package on npm is an unrelated project.

## Included utilities

- Transport helpers for stdio, SSE, and Streamable HTTP clients.
- Probe reports, replay checks, raw-request checks, and scripted scenarios.
- Request IDs and trace context for request and actor correlation.
- Structured logging with secret redaction.
- Scope guards, tool errors, and registry helpers.
- JWT validation and RFC 7662 introspection with non-authoritative claims filtering.
- Optional DPoP, mTLS, RFC 8693 token exchange, and replay protection.
- Discovery resources and server fingerprinting.
- An optional SQLite event store for Streamable HTTP replay.

## Install from a checkout

Until a package release is announced, use a pinned checkout or a local path from the consuming
project:

```json
{
  "dependencies": {
    "@sednalabs/mcp-toolkit-ts": "file:../mcp-toolkit-ts"
  }
}
```

Import the public facade:

```ts
import {
  createTransport,
  registerTool,
  requireScopes,
} from '@sednalabs/mcp-toolkit-ts';
```

## Optional SQLite event store

Install `sqlite3` in the consuming project when the SQLite-backed event store is needed:

```bash
npm install sqlite3
```

```ts
import { SqliteEventStore } from '@sednalabs/mcp-toolkit-ts/server/events/sqlite';

const store = new SqliteEventStore({
  path: './data/mcp-events.sqlite',
  maxStreams: 1000,
  maxEventsPerStream: 1000,
  ttlSeconds: 300,
});
```

## Development

The hosted workflows use Node.js 22 and the committed lockfile:

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

The package exports the root facade and the optional SQLite entrypoint. Other files under `src/`
are implementation details and may change without notice.

## Security

Auth contexts deliberately avoid exposing raw access tokens or complete JWT claims. Use
`NonAuthoritativeClaims` and the derived `scopes`, `clientId`, and `subject` fields. See
[SECURITY.md](SECURITY.md) for vulnerability reporting.

## Documentation

- [Authentication philosophy](docs/auth-philosophy.md)
- [Discovery resources](docs/design/discovery-resources.md)
- [Runbook](docs/runbook.md)
- [Docstring policy](docs/docstring-policy.md)

## License

Licensed under the [Apache License 2.0](LICENSE).
