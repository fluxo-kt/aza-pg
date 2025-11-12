# GitHub Environment Setup for aza-pg

## Required GitHub Repository Configuration

### Production Environment Setup

The `publish.yml` workflow requires a GitHub Environment named `production` with manual approval.

**Steps to configure:**

1. Navigate to your repository on GitHub
2. Go to **Settings** → **Environments**
3. Click **New environment**
4. Name it exactly: `production`
5. Configure protection rules:
   - ☑️ **Required reviewers**
   - Add at least 1 reviewer (repository maintainers recommended)
   - Optional: Set deployment branch rule to `release` only

**Why this is required:**

- Prevents accidental releases from unintended branch pushes
- Provides manual approval gate before publishing public images
- Allows review of build/scan results before promotion to production tags

### Environment Configuration Details

```yaml
Name: production
Protection Rules:
  - Required reviewers: 1+ (maintainers)
  - Deployment branches: release (recommended)
  - Wait timer: 0 minutes (optional: add delay)
```

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
  security-events: write # Upload SARIF to Security tab
```

### Troubleshooting

**Issue:** Workflow fails with "Environment not found"
**Solution:** Create the `production` environment in repository settings

**Issue:** No approval requested
**Solution:** Verify required reviewers are configured in environment protection rules

**Issue:** Cannot approve own workflow run
**Solution:** Add another maintainer as reviewer, or temporarily remove protection rules for testing

**Issue:** Approval times out
**Solution:** No timeout by default, but check if wait timer was configured

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
