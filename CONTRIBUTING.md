# Contributing

Thank you for helping improve the TypeScript MCP Toolkit.

## Development workflow

1. Create a focused branch from the current default branch.
2. Install the exact dependency set with `npm ci`.
3. Keep changes within the existing module boundaries and expose new reusable behavior through an
   intentional public entrypoint.
4. Run `npm run build`, `npm test`, and `npm pack --dry-run`.
5. Open a pull request that explains the behavior change, security implications, and validation.

Behavior fixes should include a regression test at the closest public contract boundary. Avoid new
runtime dependencies unless the benefit and maintenance cost are clear.

## Security-sensitive changes

Changes to authentication, authorization, redaction, token handling, replay protection, or network
allowlists require both success-path and denial-path tests. Do not include real credentials,
customer data, local machine paths, or private service addresses in commits or test fixtures.

Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
