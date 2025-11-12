# GitHub Secrets and Environment Setup

## Required Secrets

**None.** All workflows use the built-in `GITHUB_TOKEN` which is automatically provided by GitHub Actions.

## GitHub Environments

### Production Environment

The `publish.yml` workflow uses a `production` environment for releases:

1. Go to **Settings** → **Environments** → **New environment**
2. Name: `production`
3. **Protection rules** (recommended):
   - Required reviewers: Add yourself or team members
   - Deployment branches: Only `release` branch
4. **No secrets needed** - uses `GITHUB_TOKEN` automatically

## Image Signing (Cosign)

The release workflow signs images using **Cosign with keyless OIDC**:

- **Mode**: `COSIGN_EXPERIMENTAL=1` (keyless signing)
- **Provider**: GitHub Actions OIDC (auto-configured)
- **Attestations**: SBOM + Provenance (SLSA v0.2)
- **Transparency log**: Rekor (public, immutable)

**No additional secrets or keys required.**

### Verifying Signed Images

```bash
# Verify signature
cosign verify \
  --certificate-identity-regexp="https://github.com/fluxo-kt/aza-pg" \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  ghcr.io/fluxo-kt/aza-pg:18

# Verify attestations
cosign verify-attestation \
  --certificate-identity-regexp="https://github.com/fluxo-kt/aza-pg" \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  --type slsaprovenance \
  ghcr.io/fluxo-kt/aza-pg:18
```

## GitHub Container Registry (GHCR)

Images are pushed to `ghcr.io/fluxo-kt/aza-pg`:

- **Authentication**: `GITHUB_TOKEN` with `packages: write` permission
- **Visibility**: Public (configured in repo settings)
- **No PAT needed**: Built-in token has sufficient permissions

## Workflow Permissions

All workflows require these GitHub Actions permissions (auto-configured):

```yaml
permissions:
  contents: read # Read repository
  packages: write # Push to GHCR
  id-token: write # Cosign OIDC signing
  attestations: write # SBOM/Provenance
```

These are declared in each workflow file - no manual configuration needed.

## Troubleshooting

### "Permission denied" when pushing to GHCR

- Verify repo settings: **Settings** → **Actions** → **General** → **Workflow permissions** → "Read and write permissions"
- Check package visibility: **Packages** → **aza-pg** → **Package settings** → "Public"

### Cosign signing fails

- Ensure `id-token: write` permission in workflow
- Verify GitHub Actions OIDC provider is enabled (auto-enabled for public repos)
- Check workflow runs on `release` branch (not fork)

### Image not visible in GHCR

- First push creates package as private by default
- Manually change to public: **Packages** → **aza-pg** → **Package settings** → "Change visibility" → "Public"
