# GitHub Environment Setup for aza-pg

## Required Secrets

**None.** All workflows use the built-in `GITHUB_TOKEN` which is automatically provided by GitHub Actions.

## Production Environment Setup

The `publish.yml` workflow requires a GitHub Environment named `production` with manual approval.

**Steps to configure:**

1. Navigate to your repository on GitHub
2. Go to **Settings** → **Environments**
3. Click **New environment**
4. Name it exactly: `production`
5. Configure protection rules:
   - ☑️ **Required reviewers**: Add yourself or team members
   - **Deployment branches**: Only `release` branch

**No additional secrets needed** — uses `GITHUB_TOKEN` automatically.

**Why this is required:**

- Prevents accidental releases from unintended branch pushes
- Provides manual approval gate before publishing public images
- Allows review of build/scan results before promotion to production tags

### Approval Workflow

When a push to `release` branch triggers `publish.yml`:

1. Workflow starts and waits at "Build and Publish Single-Node Image" job
2. GitHub sends notification to designated reviewers
3. Reviewers can:
   - View build logs and scan results
   - Check generated summary with versions/extensions
   - **Approve** → workflow continues with image publication
   - **Reject** → workflow stops, no images published

4. After approval:
   - Image builds to testing tag
   - Security scans run (Dockle + Trivy)
   - If all pass → production tags created
   - If any fail → workflow fails, no production tags

### Security Permissions Required

The workflow needs these permissions (already configured in publish.yml):

```yaml
permissions:
  contents: read # Read repository code
  packages: write # Push to GHCR
  id-token: write # Cosign keyless OIDC
  attestations: write # SBOM/Provenance
  security-events: write # Upload SARIF to Security tab
```

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

## Troubleshooting

**Issue:** Workflow fails with "Environment not found"
**Solution:** Create the `production` environment in repository settings

**Issue:** No approval requested
**Solution:** Verify required reviewers are configured in environment protection rules

**Issue:** Cannot approve own workflow run
**Solution:** Add another maintainer as reviewer, or temporarily remove protection rules for testing

**Issue:** Approval times out
**Solution:** No timeout by default, but check if wait timer was configured

**Issue:** "Permission denied" when pushing to GHCR
**Solution:**

- Verify repo settings: **Settings** → **Actions** → **General** → **Workflow permissions** → "Read and write permissions"
- Check package visibility: **Packages** → **aza-pg** → **Package settings** → "Public"

**Issue:** Cosign signing fails
**Solution:**

- Ensure `id-token: write` permission in workflow
- Verify GitHub Actions OIDC provider is enabled (auto-enabled for public repos)
- Check workflow runs on `release` branch (not fork)

**Issue:** Image not visible in GHCR
**Solution:**

- First push creates package as private by default
- Manually change to public: **Packages** → **aza-pg** → **Package settings** → "Change visibility" → "Public"

### Testing the Approval Flow

**DO NOT test on production release branch.** Instead:

1. Create a test branch: `git checkout -b test-approval-flow`
2. Make a trivial change to trigger workflow
3. Temporarily modify `publish.yml` line 5-6 to:
   ```yaml
   branches:
     - test-approval-flow
   ```
4. Push and test the approval process
5. Revert the branch trigger change before merging

### Additional Security Recommendations

1. **Branch Protection for `release`:**
   - Settings → Branches → Add rule for `release`
   - Require pull request reviews before merging
   - Require status checks to pass (ci.yml)
   - Include administrators (no bypass)

2. **GHCR Permissions:**
   - Verify GITHUB_TOKEN has packages:write
   - For organization repos, check org-level package permissions

3. **Secrets Management:**
   - No additional secrets needed (uses GITHUB_TOKEN)
   - Cosign uses keyless OIDC (no private key storage)

## Production Deployment Checklist

Before first production release:

- [ ] Production environment created with required reviewers
- [ ] At least 1 designated reviewer has accepted role
- [ ] Branch protection enabled on `release` branch
- [ ] Test approval flow completed successfully
- [ ] Review team understands approval criteria:
  - [ ] Manifest and configs are up to date
  - [ ] All tests pass
  - [ ] Security scans show acceptable results
  - [ ] Version tags are correct
  - [ ] Extension catalog matches expectations

## References

- [GitHub Environments Documentation](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
- [Environment Protection Rules](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment#environment-protection-rules)
