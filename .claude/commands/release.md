---
name: /release
description: Squash dev commits into a single release commit on main/release
argument-hint: (optional notes or version override)
id: p-release
category: project
tags: [project, release]
---

# /release

You are executing a **deterministic release squash** for the aza-pg project.

The Anchor Merge pattern: granular dev commits → squashed single mega-commit on main/release.
Dev's anchor merge ensures `git merge --squash dev` applies ONLY the net delta.

OPTIONAL NOTES / VERSION OVERRIDE: $ARGUMENTS

---

## ⚠️ GUARDRAILS — Read Before Every Execution

1. **⚠️ RTK truncation**: `git log` output may be filtered by RTK proxy. Always verify commit counts with `git rev-list ... --count` or `| wc -l`.
2. **⚠️ Net delta only**: CHANGELOG must show ONLY v_old→v_new (the released-to-released delta). Never show intermediate steps.
3. **⚠️ Consumer-first ordering**: Consumer outcomes first in commit message/CHANGELOG; internal/infra changes after.
4. **⚠️ No phantom entries**: Don't claim fixes for things not broken in the LAST RELEASED version.
5. **⚠️ `pgdg13` = Debian 13 (Trixie)**, NOT PostgreSQL 13.
6. **⚠️ `bun install` AFTER squash BEFORE validation** — stale node_modules cause false validation failures AND broken pre-commit hook regeneration.
7. **⚠️ NEVER compare tree hashes after CHANGELOG edits** — trees diverge by design (that's the point).
8. **⚠️ VERIFY anchor merge**: check parent2 is on main lineage, don't just grep the message.
9. **⚠️ Use `git add -u` NOT `git add -A`** — never add untracked files (.DS_Store, .env, temp).
10. **⚠️ NEVER use `--no-verify` or `--no-gpg-sign`** — fix the root cause.
11. **⚠️ `git fetch origin` before anchor discovery** — local dev might be stale.
12. **⚠️ Prefer `startsWith()` over `===`** for version assertions — never encode stale absolute versions.

---

## Phase 0: Pre-Flight (All Must Pass — Fail Fast)

Run each check in sequence; abort on first failure.

### 0.1 — Branch check

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" == "main" || "$BRANCH" == "release" ]] || \
  { echo "ABORT: Switch to main or release first (currently: $BRANCH)"; exit 1; }
```

### 0.2 — Clean working tree

```bash
[[ -z "$(git status --porcelain)" ]] || \
  { echo "ABORT: Working tree is dirty. Commit or stash changes first."; git status --short; exit 1; }
```

### 0.3 — Fetch and compare dev

```bash
git fetch origin
LOCAL_DEV=$(git rev-parse dev)
REMOTE_DEV=$(git rev-parse origin/dev 2>/dev/null || echo "")
if [[ -n "$REMOTE_DEV" && "$LOCAL_DEV" != "$REMOTE_DEV" ]]; then
  echo "⚠️  WARNING: Local dev differs from origin/dev."
  echo "   Local:  $LOCAL_DEV"
  echo "   Remote: $REMOTE_DEV"
  echo "   Consider: git checkout dev && git pull && git checkout $BRANCH"
  echo "   Proceed only if you intentionally have unpushed dev commits."
fi
```

### 0.4 — Find latest anchor merge

```bash
ANCHOR=$(git log dev --merges --format="%H" --grep="Anchor Merge" -1)
[[ -n "$ANCHOR" ]] || { echo "ABORT: No anchor merge found on dev."; exit 1; }
echo "Anchor merge: $ANCHOR"
echo "Anchor short: $(git rev-parse --short $ANCHOR)"
echo "Anchor message: $(git log -1 --format='%s' $ANCHOR)"
```

### 0.5 — Verify anchor merge parentage (parent2 on main lineage)

```bash
ANCHOR_P2=$(git rev-parse $ANCHOR^2)
git merge-base --is-ancestor $ANCHOR_P2 HEAD || \
  { echo "ABORT: Anchor merge parent2 ($ANCHOR_P2) is NOT on main lineage."; \
    echo "       The anchor merge may be malformed. Investigate."; exit 1; }
echo "Anchor parent2 $ANCHOR_P2 confirmed on main lineage. ✓"
```

### 0.6 — No drift since last release (anchor parent2 = current HEAD)

```bash
CURRENT_HEAD=$(git rev-parse HEAD)
[[ "$ANCHOR_P2" == "$CURRENT_HEAD" ]] || {
  echo "ABORT: Anchor merge parent2 ($ANCHOR_P2) ≠ HEAD ($CURRENT_HEAD)."
  echo "       Main/release has moved since the anchor merge was created."
  echo "       Create a new anchor merge on dev pointing to the current HEAD."
  exit 1
}
```

### 0.7 — Dev has new commits after anchor merge

```bash
COMMIT_COUNT=$(git rev-list $ANCHOR..dev --count)
echo "Commits after anchor: $COMMIT_COUNT"
[[ "$COMMIT_COUNT" -gt 0 ]] || \
  { echo "ABORT: No commits on dev after anchor merge. Nothing to release."; exit 1; }
```

**Pre-flight PASSED** — display summary:

```bash
echo "=== Pre-Flight Summary ==="
echo "Branch:         $BRANCH"
echo "HEAD:           $(git rev-parse --short HEAD)"
echo "Anchor:         $(git rev-parse --short $ANCHOR)"
echo "Dev tip:        $(git rev-parse --short dev)"
echo "Commits to squash: $COMMIT_COUNT"
echo "=========================="
```

---

## Phase 1: Analyse Net Delta

### 1.1 — Enumerate commits (anchor..dev)

```bash
# Verify count independently to guard against RTK truncation
git rev-list $ANCHOR..dev --count  # Should match $COMMIT_COUNT from Phase 0

# List commits for review
git log $ANCHOR..dev --oneline --no-merges
```

### 1.2 — Categorise changes (consumer-visible)

Scan the diff for consumer-visible changes. Look at:

```bash
# Manifest changes (extension versions, PG version, base image)
git diff $ANCHOR..dev -- scripts/extensions/manifest-data.ts

# CHANGELOG unreleased section
git show dev:CHANGELOG.md | head -80

# Dockerfile changes (if any)
git diff $ANCHOR..dev -- docker/postgres/Dockerfile.template

# Test additions/changes
git diff $ANCHOR..dev --stat -- scripts/test/
```

**Categorise into**:
- **Consumer-visible** (extensions added/updated/removed, PG version changes, API/behaviour changes, security fixes)
- **Build/reliability** (Dockerfile improvements, CI fixes, dependency updates — brief if user-impacting)
- **Infrastructure** (base image, build tools — 1 line if relevant)
- **Development/tooling** (tests, linting, scripts — 1-line summary)

### 1.3 — Collect unique co-authors

```bash
# grep anchored to line-start; sort -uf = case-insensitive dedup, first-occurrence casing wins
COAUTHORS=$(git log $ANCHOR..dev --format="%b" | grep -iE "^co-authored-by:" | sort -uf)
echo "$COAUTHORS"
```

### 1.4 — Determine hash range (for commit body)

```bash
FIRST_SHORT=$(git rev-parse --short $(git rev-list $ANCHOR..dev --no-merges | tail -1))
LAST_SHORT=$(git rev-parse --short $(git rev-list $ANCHOR..dev --no-merges | head -1))
echo "Range: ${FIRST_SHORT}..${LAST_SHORT}"
```

---

## Phase 2: CHANGELOG Audit & Optimisation

Review dev's CHANGELOG (`[Unreleased]` section) against the net delta from Phase 1.

**Audit rules**:

1. **Consumer-first ordering**: Security → Breaking → Fixed → Changed → Added → Development
2. **Net-delta only**: If X went v1→v2→v3 during dev, entry must say "v1→v3"
3. **Cancellation**: Entries added then reverted = omit entirely
4. **Development section**: MAX 3 brief lines, no per-file detail
5. **Cross-validation**: Every version change MUST match `git diff $ANCHOR..dev -- scripts/extensions/manifest-data.ts`
6. **No phantoms**: Don't claim fixes for things not broken in the last released version
7. **Upgrade verification SQL**: For significant extension upgrades, include a SQL snippet consumers can run to verify (e.g., `SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';`)
8. **No `[Unreleased]` rename**: CI/release tagging does that; leave it as-is

Prepare the optimised CHANGELOG content. You will apply it as an edit in Phase 4 after the squash.

---

## Phase 3: Prepare Commit Message

### 3.1 — Derive title

Scan categorised changes from Phase 1:

- **Any extension version bumps or new features** → type: `feat`
- **All changes are bug fixes** → type: `fix`
- **Only tooling/CI/deps** → type: `chore`

Scope: `feat(postgres)` for features/upgrades, `fix(postgres)` for bugfix-dominated, `chore(release)` for maintenance-only.

Title should name the 1-2 most impactful consumer-visible changes (e.g., "upgrade PG 18.1→18.3, TimescaleDB 2.24→2.25"). **Max 72 chars total.**

### 3.2 — Draft full commit message

Format (from reference commits `33c3c24`, `0d94637`):

```
TYPE(SCOPE): concise consumer-first title (max 72 chars)

- Consumer-visible change 1 (extensions, features, security)
- Consumer-visible change 2
- Build/reliability fix (brief, only if user-impacting)
- Infrastructure: 1-line if relevant
- Development: 1-line summary of tooling/test changes

FIRST_SHORT..LAST_SHORT

Co-Authored-By: Name <email>
Co-Authored-By: Claude <noreply@anthropic.com>
```

Rules:
- Body bullets: consumer-visible first, then build, infra, dev
- Blank line before hash range
- Blank line before Co-Authored-By block
- Always include `Co-Authored-By: Claude <noreply@anthropic.com>`
- Deduplicate co-authors (case-insensitive); add Claude if not already present

Save the message draft. You will use it in `git commit -m` in Phase 4.

---

## Phase 4: Execute Squash

> **CRITICAL SEQUENCE** — do not reorder steps.

### 4.1 — Squash dev onto current branch

```bash
git merge --squash dev
```

Expected output: a list of staged files (no "Already up to date." — that's caught by Phase 0.7).

If "Already up to date." with empty staged index:

```bash
git diff --cached --stat
# If empty: ABORT — pre-flight should have caught this
echo "ABORT: git merge --squash dev produced no changes. Investigate."
```

If **merge conflicts** (should not happen with a proper anchor merge, but defensively):

```bash
# NOTE: git merge --squash does NOT set MERGE_HEAD, so git merge --abort won't work here.
# Recover with reset + checkout instead:
git reset HEAD
git checkout -- .
bun install              # Restore release branch's node_modules
echo "ABORT: Conflicts during squash. Investigate:"
git diff $ANCHOR..dev -- <conflicted-file>
echo "Likely cause: anchor merge is malformed, or main has diverged."
exit 1
```

### 4.2 — Sync node_modules to dev's packages

```bash
bun install
```

This syncs `node_modules` to dev's `bun.lock` (dev may have updated oxlint, prettier, etc.).
The `postinstall` script also installs bun-git-hooks.

Re-stage `bun.lock` in case `bun install` reformatted it:

```bash
git add bun.lock
```

### 4.3 — Run validation

```bash
bun run validate
bun run validate:all
```

**If validation fails** — categorise and handle:

**Auto-fixable** (fix, proceed):
- Prettier/formatting:
  ```bash
  bun run validate:fix
  git add -u
  ```
- Generated files stale:
  ```bash
  bun run generate
  git add -u
  ```
- CHANGELOG issues → edit directly, then `git add CHANGELOG.md`

**Non-trivial** (ABORT — user fixes on dev, re-runs /release):
- TypeScript type errors
- Failed unit tests
- Missing files or broken imports
- shellcheck errors in new shell scripts

Abort sequence:

```bash
git reset HEAD           # Unstage everything (index → HEAD)
git checkout -- .        # Restore working tree to HEAD
bun install              # Restore release branch's node_modules
echo "ABORTED: [describe failure]. Fix on dev, re-run /release."
```

### 4.4 — Apply CHANGELOG optimisations

Edit `CHANGELOG.md` to apply the optimised content prepared in Phase 2.

After editing:

```bash
git add -u   # Stage only tracked file modifications — NEVER git add -A
```

### 4.5 — Apply any other release-time fixes

If doc cleanup, formatting, or other minor fixes are needed:
- Make the edits now
- Stage with `git add -u`

These changes are squashed into the same mega-commit. The anchor merge will propagate them back to dev.

### 4.6 — Verify staged files look correct

```bash
git diff --cached --stat
# Review: expected to see manifest changes, CHANGELOG, generated files, bun.lock, etc.
# Flag anything unexpected.
```

### 4.7 — Commit

```bash
# Use HEREDOC for correct formatting; never --no-verify; never --no-gpg-sign
git commit -m "$(cat <<'COMMIT_EOF'
TYPE(SCOPE): title here

- change 1
- change 2

FIRST_SHORT..LAST_SHORT

Co-Authored-By: Name <email>
Co-Authored-By: Claude <noreply@anthropic.com>
COMMIT_EOF
)"
```

**If commit fails due to signing** (SSH key not available):
- Ask user: `eval "$(ssh-agent -s)" && ssh-add`
- NEVER use `--no-gpg-sign` or touch git config

**Pre-commit hook interaction** (expected behaviour):
- Hook detects `manifest-data.ts` in staged files → runs `bun run generate`
- Auto-stages regenerated files
- Runs `oxlint --fix` and `prettier --write` on staged files
- Auto-stages fixes
- This is HELPFUL — provides additional safety. Requires `bun install` (Phase 4.2) to have run first.

---

## Phase 5: Verification

### 5.1 — Scope of changes vs dev

```bash
DIFF_FILES=$(git diff dev HEAD --name-only)
echo "Files differing from dev:"
echo "$DIFF_FILES"
```

**Expected**: Only `CHANGELOG.md` (and any other explicitly edited files from Phase 4.5).
**Flag**: Any unexpected differences (may indicate unintended changes).

Do NOT compare tree hashes — trees intentionally diverge after CHANGELOG edits.

### 5.2 — Linear history

```bash
git log --oneline -3
# Should show: single new commit on top, no merge commit
```

### 5.3 — Final validation

```bash
bun run validate
```

### 5.4 — Summary output

```bash
echo "=== Release Commit Summary ==="
git log -1 --format="Hash:    %H%nShort:   %h%nAuthor:  %an%nDate:    %ai%nSubject: %s"
echo ""
echo "Diff from dev (should be CHANGELOG only):"
git diff dev HEAD --name-only
echo "=============================="
echo ""
echo "Next steps:"
echo "  1. Review commit: git show HEAD"
echo "  2. Push: git push origin $BRANCH"
echo "  3. After CI passes: create Anchor Merge on dev (see Appendix)"
echo "  4. Sync main/release if needed (see Appendix)"
```

---

## Phase 6: Kaizen

After every execution, reflect and update this command:

1. What was surprising or non-obvious?
2. What should pre-flight have caught that it didn't?
3. What CHANGELOG entries didn't match reality?
4. What needed manual intervention that could be automated?
5. Any new edge case or gotcha to encode as a guardrail?

→ Edit this command file, commit as:
`docs(skill): improve /release — [lesson learned]`

---

## Appendix A: Anchor Merge (After Push + CI Pass)

Creates a merge commit on dev whose **tree** is forced to match main's (including CHANGELOG optimisations, release-time fixes). Use git plumbing — regular `git merge main --no-ff` produces the WRONG tree when release-time edits diverge from dev.

```bash
git checkout dev

# ⚠️ dev working tree MUST be clean — git reset --hard destroys uncommitted changes!
[[ -z "$(git status --porcelain)" ]] || { echo "ABORT: dev is dirty."; exit 1; }

RELEASE_TAG=$(git rev-parse --short main)  # or release branch HEAD
TREE=$(git rev-parse main^{tree})
DEV_HEAD=$(git rev-parse --short HEAD)

COMMIT=$(echo "Anchor Merge: merging $DEV_HEAD and $RELEASE_TAG ($(git rev-parse --short main))" \
  | git commit-tree $TREE -p HEAD -p main)

git reset --hard $COMMIT
git push origin dev
```

This creates a merge commit on dev with:
- **Parent 1**: dev HEAD (preserves dev history)
- **Parent 2**: main HEAD (the squash commit)
- **Tree**: main's tree (anchored — hence "anchor merge")

The anchor merge's tree = main's tree = dev's next starting point. Clean slate.

---

## Appendix B: main/release Branch Sync

If /release ran on `release` but `main` needs updating (or vice versa):

```bash
git checkout main && git merge release --ff-only && git checkout release
```

Only works if history is perfectly linear (fast-forward). If not, investigate before forcing.

---

## Appendix C: Interruption Recovery

If the process is interrupted mid-execution:

```bash
# Assess state
git status

# If changes staged but not committed: can resume (edit → stage → commit) or abort
# git merge --squash does NOT set MERGE_HEAD — no "merge in progress" state

# To abort from any point and return to clean state:
git reset HEAD           # Unstage everything
git checkout -- .        # Restore working tree to HEAD
bun install              # Restore release branch's node_modules
```

---

## Key Design Decisions (Reference)

**Why `git merge --squash dev` over alternatives**:
- Cherry-pick range: fragile (intermediate conflicts that cancel in net delta)
- `git diff | git apply`: loses metadata, no conflict detection
- `git merge --squash dev`: applies NET diff directly, proper 3-way merge semantics
- Since anchor merge makes dev's tree match main's, `main..dev` = exactly the new work

**Why this command file persists through squash**:
The file is committed to the release branch before squash. Since dev doesn't touch it and the merge base is HEAD, `git merge --squash dev` does not delete it. It persists in the index.

**Why `bun install` is mandatory after squash**:
The squash brings dev's code (including updated `bun.lock`) into the index/working tree, but `node_modules` still reflects release branch's packages. Dev may have updated oxlint, prettier, etc. Without `bun install`, validation uses stale binaries and the pre-commit hook's `bun run generate` uses wrong packages.
