# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 18.x    | :white_check_mark: |
| < 18.0  | :x:                |

## Reporting Security Vulnerabilities

Please report security vulnerabilities via GitHub Security Advisories or by email to the maintainers.

## Known Upstream Vulnerabilities

As of November 2025, the following HIGH severity vulnerabilities exist in upstream dependencies that we cannot directly fix:

### Python 3.13.5-2

- **CVE-2025-8194**: Infinite loop when parsing malformed tarfiles
- **Impact**: DoS potential if processing untrusted tar archives
- **Status**: Awaiting upstream Debian fix

### libxml2 2.12.7

- **CVE-2025-12863**: Namespace use-after-free in xmlSetTreeDoc()
- **Impact**: Potential memory corruption
- **Status**: Awaiting upstream Debian fix

### libxslt 1.1.35

- **CVE-2025-7425**: Heap use-after-free
- **Impact**: Potential memory corruption
- **Status**: Awaiting upstream Debian fix

### gosu 1.17

- **CVE-2025-58183, CVE-2025-58186, CVE-2025-58187, CVE-2025-58188**: Go stdlib vulnerabilities
- **Impact**: Various Go standard library issues
- **Status**: Fixed in Go 1.24.8+ and 1.25.2+ (awaiting gosu rebuild)

## Security Measures

This image implements the following security best practices:

1. **Non-root execution**: Container runs as `postgres` user (not root)
2. **No default passwords**: `POSTGRES_PASSWORD` must be explicitly set
3. **Strong authentication**: SCRAM-SHA-256 only (no trust/md5)
4. **Network isolation**: Binds to localhost by default
5. **Signed images**: All releases are signed with Cosign
6. **SLSA attestations**: Supply chain security via GitHub Actions

## Security Scanning

All images undergo automated security scanning:

- **Dockle**: Best practices and CIS benchmark compliance
- **Trivy**: CVE vulnerability scanning
- **GitHub Security**: SARIF reports uploaded to Security tab

The CI pipeline blocks releases with CRITICAL vulnerabilities but allows HIGH severity issues from upstream packages that we cannot directly fix.
