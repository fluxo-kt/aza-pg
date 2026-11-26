# Changelog rules

**File**: `CHANGELOG.md` — Keep a Changelog format, user-facing, integrated with GitHub releases

Before writing or reviewing a release note, ask what the operator must update to see the change. Pull only the aza-pg image → use the image categories. Apply new Compose files → use the final `### Compose deployments` section and name the affected stack or example. If both ship a change, state each surface's impact and upgrade action in its own section.
Verify release-note claims against the artifact that owns them: manifest and image for bundled components, Compose diff for companion services, entrypoint for runtime defaults, publish workflow for attestations. Preview the rendered notes before publishing.
**Audience**: Image consumers (ops, developers deploying aza-pg). NOT developers of aza-pg tooling.

**Workflow**:

1. Track image and Compose changes in `[Unreleased]`, using the placement rule above
2. Focus on: extension updates, nixpkgs (server, glibc, library) changes, breaking changes, security fixes
3. The release commit dates itself: `/release` runs `bun scripts/release/date-changelog.ts`, which moves `[Unreleased]` under `## [v<pg>-<UTC timestamp>] - <date>`. publish.yml takes the tag name and the GitHub notes from that newest heading, so every branch shows the release dated the moment it ships and the anchor merge brings it to dev
4. Non-image changes: 1-2 brief bullets max in `### Development` — omit if trivial

**Entry rules** (`[Unreleased]` is read by someone upgrading from the last release):

- Start a changed bundled component's bullet with its bold manifest name, such as `**pgmq 1.13.1 → 1.13.2**`. For a display name, put the exact manifest name in parentheses before the version, such as `**Vault (supabase_vault) …**`. A mention elsewhere does not document the component's own change.

- One entry per component: `<name> <version in the last release> → <current>`. Read the old version from the tag (`git show <tag>:docker/postgres/extensions.manifest.json`), never from changelog text. A second bump before release edits that entry. A patch-only change (a lockfile bump for a CVE) moves no version and still needs its entry; `Changelog Coverage` in `validate` refuses any component whose pinned commit or patches changed since the last release and whose manifest name `[Unreleased]` lacks
- A dated `## [<tag>]` section is what shipped: never edit it
- Every claim comes from the component's own release notes for exactly that range; a feature from an earlier release is not news. Name the concrete fix, never "bug fixes". Completeness too: go through EVERY item of that range's notes (changes, deprecations, breaking, fixes) and decide per item whether it reaches what we ship (settings we pass, metrics and labels, defaults, behaviour under our config); name each one that does. Writing from the headline items alone omits exactly the changes an operator trips over
- A `Fixed` entry for our own defect lands in the same change as a check that reproduces the defect: it must fail on the image or code before the fix (run it against the last release when that one has the bug) and pass after. A fix whose proof is still pending is unproven, not Fixed; never park the proof on ROADMAP while the entry claims the fix
- A change that needs operator action is Breaking; state the action, and the setting that restores old behaviour when upstream offers one
- Every image change is stated with its cost as well as its gain: removed features, lost hardening (e.g. arm64 BTI), changed library versions, size. An operator must never discover a loss the changelog did not name

**The ONLY test that matters**: Would the change appear in `docker inspect`, `\dx`, extension behaviour, `psql --version`, or change a shipped Compose service's authentication, settings, metrics or operation? Yes → belongs. No → NEVER belongs.

**What NEVER belongs in the changelog**:

- Build fixes (`flake.nix`, `nix/*.nix`, generators) — even if they fixed a build bug, the fix itself is invisible; only the **resulting extension change** (if any) belongs
- Agent commands (`.claude/commands/`), skills, test scripts — invisible to image consumers
- Individual kaizen/audit passes, validate check improvements, internal refactors
- CI infra fixes (timeouts, retry logic, credentials) — operators can't see these
- Changes with no operator impact in either the image or the shipped Compose files

**Development section rules** (when it's worth including at all):

- Max 1-2 bullets total, no technical detail, user-impact framing only
- OK: "Test coverage hardened; CI updated to Node.js 24 runners"
- NOT OK: "testPgStatStatements now executes a tracked query after reset..."
- NOT OK: "Fixed ensureCleanDir to use node:fs instead of Bun shell rm..."

**Categories**: Breaking | Security | Fixed | Changed | Added | Deprecated | Removed | Development | Compose deployments
