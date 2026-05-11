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
- SARIF scans still report upstream Debian findings so maintainers can track no-fix exposure.
- Do not silence findings with static CVE ignores unless the runtime path is impossible and a narrower path skip cannot express it.
- Do not mix Debian stable images with sid/testing packages to satisfy scanners; that trades scanner silence for ABI and support risk.

## Resolved Vulnerabilities

Vulnerabilities that have been actively mitigated in this image:

### gosu -> su-exec replacement

- **Issue**: The upstream postgres base image includes `gosu`, a Go binary that can appear in layer-based scanners even after replacement.
- **Resolution**: `/usr/local/bin/gosu` is replaced with [su-exec v0.2](https://github.com/ncopa/su-exec), a pure-C privilege-drop binary with the same CLI (`user[:group] command`).
- **Verification**: The Docker build fails if `/usr/local/bin/gosu` is larger than 500 KB, which catches accidental restoration of the multi-MB Go binary.
- **Scanner handling**: Trivy gates skip only `usr/local/bin/gosu`; static CVE ignores are not used for this class because path-level suppression is narrower and less likely to hide future fixable CVEs.

## Security Measures

This image implements the following security best practices:

1. **Non-root execution**: Container runs as `postgres` user (not root)
2. **No default passwords**: `POSTGRES_PASSWORD` must be explicitly set
3. **Strong authentication**: SCRAM-SHA-256 only (no trust/md5)
4. **Network isolation**: Binds to localhost by default
5. **Signed images**: All releases are signed with Cosign
6. **SLSA attestations**: Supply chain security via GitHub Actions
7. **Minimal runtime tooling**: Install-only helpers (`curl`, `unzip`, GnuPG CLI stack, `lsb-release`, `percona-release`) are purged after all repositories and release assets are installed

## Security Scanning

All images undergo automated security scanning:

- **Dockle**: Best practices and CIS benchmark compliance
- **Trivy**: CVE vulnerability scanning
- **GitHub Security**: SARIF reports uploaded to Security tab

The CI pipeline blocks releases with fixable CRITICAL/HIGH vulnerabilities. Upstream Debian findings with no stable fix remain visible in SARIF and diagnostics instead of being hidden by stale ignore lists.
