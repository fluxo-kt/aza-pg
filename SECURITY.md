# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 18.x    | :white_check_mark: |
| < 18.0  | :x:                |

## Reporting Security Vulnerabilities

Please report security vulnerabilities via GitHub Security Advisories or by email to the maintainers.

## Scanner Policy

Security gates must distinguish fixable image risk from upstream no-fix noise:

- Blocking Trivy gates fail on fixable CRITICAL/HIGH vulnerabilities.
- SARIF scans still report findings with no fix so maintainers can track no-fix exposure.
- Do not silence findings with static CVE ignores unless the runtime path is impossible and a narrower path skip cannot express it.

## Privilege Drop

The upstream entrypoint drops root with `gosu`; the image ships no gosu: `/usr/local/bin/gosu` is [su-exec](https://github.com/ncopa/su-exec), a pure-C privilege-drop binary with the same CLI (`user[:group] command`).

## Security Measures

This image implements the following security best practices:

1. **Non-root execution**: Container runs as `postgres` user (not root)
2. **No default passwords**: `POSTGRES_PASSWORD` must be explicitly set
3. **Strong authentication**: connections from other hosts use SCRAM-SHA-256. The upstream entrypoint's initdb trusts the Unix socket and loopback (127.0.0.1, ::1) inside the container without a password, so anyone who can `docker exec` into it is a superuser
4. **Network isolation**: a lone container listens only on its own loopback until `POSTGRES_BIND_IP` is set, so a published port alone exposes nothing; the stacks listen on their Docker networks and publish on the host's `127.0.0.1` by default
5. **Signed images**: All releases are signed with Cosign
6. **SLSA attestations**: Supply chain security via GitHub Actions
7. **Minimal runtime tooling**: the image is a Nix closure holding only what a shipped feature uses at runtime: no package manager, compiler, Perl or Python. Every extension is compiled from the upstream commit the manifest pins; no vendor package or install script runs

## Security Scanning

All images undergo automated security scanning:

- **Dockle**: Best practices and CIS benchmark compliance
- **Trivy**: CVE vulnerability scanning
- **GitHub Security**: SARIF reports uploaded to Security tab

The CI pipeline blocks releases with fixable CRITICAL/HIGH vulnerabilities that Trivy finds. Trivy finds language packages only (Rust crates compiled into extensions, bundled JavaScript): a Nix image has no package database for it to read, so the C libraries and binaries go unscanned until the CVE judging on the ROADMAP lands.
