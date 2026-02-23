# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Massu, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@massu.ai** with:

1. A description of the vulnerability
2. Steps to reproduce
3. The potential impact
4. Any suggested fixes (optional)

## Response Timeline

- **Acknowledgment**: Within 48 hours of your report
- **Initial assessment**: Within 5 business days
- **Resolution target**: Within 30 days for critical issues

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Scope

The following are in scope for security reports:

- `@massu/core` npm package
- MCP server (packages/core)
- Lifecycle hooks (packages/core/src/hooks)
- CLI tool (`npx massu`)

The following are **out of scope**:

- The massu.ai website (report separately to security@massu.ai)
- Third-party dependencies (report to the upstream project)

## Recognition

We appreciate responsible disclosure. With your permission, we will credit you in the security advisory and changelog.
