# Optional GitHub Environment Approval Gate

`publish.yml` currently publishes automatically after all blocking release gates pass. A GitHub Environment approval gate is an intentional release-contract change, not required setup. Add it only after explicit approval.

## When To Enable

Enable a `production` GitHub Environment only when releases must wait for a human approval after build, test, scan, manifest, signature, SBOM, attestation, and public-artifact gates are defined.

Do not use this document to “fix” a failed release. Fix the failing release gate instead.

## Required Secrets

None. Workflows use the built-in `GITHUB_TOKEN`.

## Repository Environment Setup

1. Open repository **Settings** -> **Environments**.
2. Create an environment named exactly `production`.
3. Set deployment branches to allow only `release`.
4. Add required reviewers only if manual approval is the approved release contract.

## Workflow Change

Add the environment to the `release` job in `.github/workflows/publish.yml`:

```yaml
release:
  environment: production
```

Place the gate before production tag promotion. Keep all build, test, scan, and manifest gates blocking.

Because `workflow_run` uses workflow definitions from the default branch, push the workflow change to both `release` and `main` before depending on it for production.

## Reviewer Criteria

Approve only when the run shows:

- build and merge digest are present and stable
- all test jobs passed
- Trivy blocking scan passed
- production tags resolve to the tested digest
- Cosign signatures verify
- SBOM download succeeds
- provenance attestation verifies
- GitHub Release exists and references the published digest

Reject on any failed, skipped, stale, or unverifiable gate.

## Permissions

The workflow already needs:

```yaml
permissions:
  contents: read
  packages: write
  id-token: write
  attestations: write
  security-events: write
```

## Troubleshooting

**No approval requested:** the workflow does not include `environment: production`, or the environment has no required reviewers.

**Cannot approve own run:** add another maintainer as reviewer, or remove required reviewers if approval is no longer the release contract.

**GHCR push denied:** ensure repository Actions workflow permissions allow read/write and the package is public after first publish.

**Cosign or attestation verification fails:** keep `id-token: write`, run on the repository release branch, and verify the OIDC identity regex matches the repository.

## References

- [GitHub Environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
- [Environment Protection Rules](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment#environment-protection-rules)
