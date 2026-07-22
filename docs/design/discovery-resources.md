# Discovery Resources

## Purpose
Provide a deterministic, low-latency discovery surface so a cold-starting agent can
understand a server with a single resource read, without listing dozens of tools
or relying on ad-hoc docs.

By default, the toolkit exposes:
- `mcp-toolkit://discovery/tools` (tool index)
- `mcp-toolkit://discovery/examples/{tool}` (lookup helper)
- `mcp-toolkit://discovery/attest` (attestation snapshot)

Servers should override the base URI to match their scheme (for example,
`keycloak-admin-mcp://discovery`).

## Tool Index Schema (v1)
The index is a compact JSON payload with a strict size budget.

```json
{
  "schema_version": "v1",
  "generated_at": "2025-01-01T00:00:00Z",
  "tool_count": 2,
  "tools": [
    {
      "name": "widgets.list",
      "example_uri": "example-server://examples/widgets.list",
      "title": "List widgets",
      "description": "List widgets with optional filters."
    },
    {
      "name": "widgets_create",
      "example_uri": "example-server://examples/widgets.create",
      "logical_name": "widgets.create"
    }
  ]
}
```

Notes:
- `example_uri` should point to a resource that provides payload examples or a
  stable pointer to documentation.
- `logical_name` is optional; it is useful when servers expose a normalized
  tool name (for example `safe` name mode).

## Attestation Snapshot
The attestation resource is a lightweight manifest for orchestration checks:

```json
{
  "schema_version": "v1",
  "generated_at": "2025-01-01T00:00:00Z",
  "source_fingerprint": {
    "algorithm": "sha256",
    "digest": "...",
    "fileCount": 42,
    "totalBytes": 123456,
    "value": "sha256:..."
  },
  "capabilities": { "tools": {}, "resources": {} }
}
```

Keep this payload intentionally small and avoid sensitive configuration values.

## Budgets
- Payload cap: 64KB for the tool index (hard fail if exceeded).
- Prefer short titles/descriptions; large docs belong in example resources.
- Build once and serve from memory (O(1) reads).

## Integration Pattern
1. Create a `DiscoveryRegistry`.
2. Register tools as they are added to the server.
3. Register discovery resources once tool registration is complete.

```ts
const registry = new DiscoveryRegistry();
registry.registerTool({
  name: 'users.list',
  exampleUri: 'keycloak-admin-mcp://examples/users.list',
});

registerDiscoveryResources(server, registry, {
  baseUri: 'keycloak-admin-mcp://discovery',
});
```

## Security Guidance
- Only include tool names, example URIs, and short summaries.
- Do not include secrets, tokens, or environment values.
- Apply resource access checks in the host server if discovery should be scoped.
