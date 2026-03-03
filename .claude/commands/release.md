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
13. **⚠️ NEVER `git merge dev` (without `--squash`) on main/release** — this creates a merge commit and permanently pollutes the linear history. The ONLY allowed mechanism is `git merge --squash dev`.

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

### 0.3 — Fetch and compare dev (distinguish direction — behind is dangerous)

```bash
git fetch origin
LOCAL_DEV=$(git rev-parse dev)
REMOTE_DEV=$(git rev-parse origin/dev 2>/dev/null || echo "")
if [[ -n "$REMOTE_DEV" && "$LOCAL_DEV" != "$REMOTE_DEV" ]]; then
  if git merge-base --is-ancestor origin/dev dev 2>/dev/null; then
    # local dev has commits not yet pushed (local AHEAD of remote) — normal
    echo "⚠️  INFO: Local dev is AHEAD of origin/dev (unpushed commits). Proceeding."
  else
    # remote dev has commits local doesn't have (local BEHIND or diverged) — DANGEROUS
    echo "🚨 ABORT: Local dev is BEHIND or diverged from origin/dev — you may be missing commits!"
    echo "   If BEHIND (no local-only commits): git checkout dev && git pull --ff-only && git checkout $BRANCH"
    echo "   If DIVERGED (both sides have unique commits): investigate before proceeding — do NOT rebase blindly"
    echo "   Verify: git log --oneline dev...origin/dev"
    exit 1
  fi
fi
```

### 0.4 — Find latest anchor merge

```bash
ANCHOR=$(git log dev --merges --format="%H" --regexp-ignore-case --grep="Anchor Merge" -1)
[[ -n "$ANCHOR" ]] || { echo "ABORT: No anchor merge found on dev."; exit 1; }
echo "Anchor merge: $ANCHOR"
echo "Anchor short: $(git rev-parse --short $ANCHOR)"
echo "Anchor message: $(git log -1 --format='%s' $ANCHOR)"
```

### 0.5 — Verify anchor merge parentage (parent2 on main lineage)

```bash
# $ANCHOR^2 fails if ANCHOR is not a real merge commit (grep may match non-merges)
ANCHOR_P2=$(git rev-parse "$ANCHOR^2" 2>/dev/null) || \
  { echo "ABORT: $ANCHOR has no second parent — not a merge commit. Anchor malformed."; exit 1; }

git merge-base --is-ancestor "$ANCHOR_P2" HEAD || \
  { echo "ABORT: Anchor parent2 ($ANCHOR_P2) is NOT on main/release lineage."; \
    echo "       The anchor merge may be malformed. Investigate."; exit 1; }
echo "Anchor parent2 $ANCHOR_P2 confirmed on main lineage. ✓"
```

### 0.6 — No drift since last release (anchor parent2 = current HEAD)

```bash
CURRENT_HEAD=$(git rev-parse HEAD)
[[ "$ANCHOR_P2" == "$CURRENT_HEAD" ]] || {
  echo "ABORT: Anchor parent2 ($ANCHOR_P2) ≠ HEAD ($CURRENT_HEAD)."
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
echo "Branch:            $BRANCH"
echo "HEAD:              $(git rev-parse --short HEAD)"
echo "Anchor:            $(git rev-parse --short $ANCHOR)"
echo "Dev tip:           $(git rev-parse --short dev)"
echo "Commits to squash: $COMMIT_COUNT"
echo "=========================="
```

---

## Phase 1: Analyse Net Delta

### 1.1 — Enumerate commits (anchor..dev, ALL including merges)

```bash
# Verify count independently to guard against RTK truncation
git rev-list $ANCHOR..dev --count  # Should match $COMMIT_COUNT from Phase 0

# List ALL commits including intermediate merges — full picture of what's being squashed
git log $ANCHOR..dev --oneline
```

### 1.2 — Categorise changes (consumer-visible)

Scan the diff for consumer-visible changes. Look at:

```bash
# Manifest changes (extension versions, PG version, base image)
git diff $ANCHOR..dev -- scripts/extensions/manifest-data.ts

# CHANGELOG unreleased section (before squash — from dev's HEAD; no truncation)
git show dev:CHANGELOG.md

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
# Anchored grep avoids false positives from prose mentioning co-authors.
# sort -f | awk deduplicates case-insensitively, keeping input order of first occurrence.
COAUTHORS=$(git log $ANCHOR..dev --format="%b" \
  | grep -iE "^co-authored-by:" \
  | awk '!seen[tolower($0)]++')
echo "$COAUTHORS"
```

### 1.4 — Determine hash range (for commit body)

```bash
# --no-merges for range display: shows the actual work commits, not merge plumbing
WORK_COMMITS=$(git rev-list $ANCHOR..dev --no-merges)
if [[ -z "$WORK_COMMITS" ]]; then
  # All commits are merges (rare but possible) — fall back to full range
  echo "⚠️ All commits in range are merges — using full range for hash display"
  WORK_COMMITS=$(git rev-list $ANCHOR..dev)
fi
FIRST_SHORT=$(git rev-parse --short "$(echo "$WORK_COMMITS" | tail -1)")
LAST_SHORT=$(git rev-parse --short "$(echo "$WORK_COMMITS" | head -1)")
echo "Range: ${FIRST_SHORT}..${LAST_SHORT}"
```

---

## Phase 2: CHANGELOG Audit & Optimisation

Review dev's CHANGELOG (`[Unreleased]` section) against the net delta from Phase 1.

```bash
git show dev:CHANGELOG.md
```

**Audit rules**:

1. **Consumer-first ordering within existing categories**: Use whichever categories dev's CHANGELOG already has (`Breaking`, `Changed`, `Added`, `Development` — from `update.md`). Reorder for impact: Breaking first, then Changed (security fixes go here too), then Added, then Development. Do NOT invent new categories like "Fixed" or "Security" — put bug fixes in "Changed", security fixes in "Changed" with a ⚠️ marker.
2. **Net-delta only**: If X went v1→v2→v3 during dev, entry must say "v1→v3"
3. **Cancellation**: Entries added then reverted = omit entirely
4. **Development section**: MAX 3 brief lines, no per-file detail
5. **Cross-validation**: Every version change MUST match `git diff $ANCHOR..dev -- scripts/extensions/manifest-data.ts`
6. **No phantoms**: Don't claim fixes for things not broken in the last released version
7. **Upgrade verification SQL**: For significant extension upgrades, include a SQL snippet consumers can run to verify (e.g., `SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';`)
8. **No `[Unreleased]` rename**: CI/release tagging does that; leave it as-is

Write down the specific CHANGELOG edits needed (which lines to change, add, or remove). You will apply them in Phase 4.4 AFTER the squash, at which point the CHANGELOG in the working tree will be dev's version.

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

Write the complete message now with ALL actual values filled in (no UPPERCASE placeholders — replace them all). You will copy this exact text into the HEREDOC in Phase 4.7, replacing the template lines entirely.

---

## Phase 4: Execute Squash

> **CRITICAL SEQUENCE** — do not reorder steps.

### 4.1 — Squash dev onto current branch

```bash
git merge --squash dev
```

Expected output: a list of staged files. Verify changes were staged:

```bash
# Verify squash produced staged changes (should not be empty after passing Phase 0.7)
STAGED_STAT=$(git diff --cached --stat)
if [[ -z "$STAGED_STAT" ]]; then
  echo "ABORT: git merge --squash dev produced no staged changes."
  echo "       Run: git rev-list $ANCHOR..dev --oneline (should be non-empty)"
  exit 1
fi
echo "$STAGED_STAT"
```

If **merge conflicts** (should not happen with a valid anchor merge, but defensively):

```bash
# NOTE: git merge --squash does NOT set MERGE_HEAD, so git merge --abort fails here.
# Capture conflict info FIRST (while markers are in the working tree), THEN reset.
echo "ABORT: Merge conflicts detected. Conflicting files:"
git status --short | grep -E "^(UU|AA|DD|AU|UA|DU|UD)"
echo ""
echo "Recovering to clean state:"
git reset HEAD
git checkout -- .
bun install
echo "Investigate: ensure anchor merge parent2 == HEAD, then fix on dev and re-run /release."
exit 1
```

### 4.2 — Sync node_modules to dev's packages

```bash
bun install
```

This syncs `node_modules` to dev's `bun.lock` (dev may have updated oxlint, prettier, etc.).
The `postinstall` script also installs bun-git-hooks.

Re-stage `bun.lock` in case `bun install` reformatted it (bun may canonicalise JSONC format):

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

Re-read `CHANGELOG.md` as it now is in the working tree (dev's version after squash), compare against what you planned in Phase 2, then apply the specific edits identified there.

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
```

**Expected to see**: manifest changes, CHANGELOG, generated files, bun.lock (if reformatted), any Phase 4.5 edits.
**Flag as unexpected**: any source files (`scripts/`, `docker/`) that shouldn't have changed, unrecognised config files.
Note: `bun.lock` diff is normal if bun's format changed across versions.

### 4.7 — Commit

**IMPORTANT**: The `'COMMIT_EOF'` single-quoted HEREDOC disables variable expansion. You MUST write all values literally. Replace every placeholder with actual values from Phase 1 and 3:
- `TYPE` → actual type from Phase 3.1 (e.g., `feat`)
- `SCOPE` → actual scope (e.g., `postgres`)
- `title here` → actual title from Phase 3.2 (max 72 chars including `TYPE(SCOPE): `)
- `change 1`, `change 2` → actual body bullets from Phase 3.2
- `FIRST_SHORT..LAST_SHORT` → actual hashes from Phase 1.4 (e.g., `6a979fa..b111f5a`)
- `Co-Authored-By: Name <email>` → actual co-authors from Phase 1.3 (one line per author)

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

**Expected to differ**: `CHANGELOG.md` (always, by design), `bun.lock` (if bun reformatted), any files edited in Phase 4.5.
**Flag as unexpected**: source files, scripts, Docker files, generated extension lists — these should be IDENTICAL to dev after squash.

Do NOT compare tree hashes — trees intentionally diverge after CHANGELOG edits.

### 5.2 — Linear history (machine-verified — no merge commit)

```bash
git log --oneline -3

# Machine check: HEAD must NOT be a merge commit (would have a second parent)
if git rev-parse HEAD^2 >/dev/null 2>&1; then
  echo "🚨 ERROR: HEAD is a merge commit! Release squash must produce a regular commit."
  echo "   This means git merge --squash was accidentally replaced with git merge."
  echo "   See guardrail 13. You must revert this and re-run /release."
  exit 1
fi
echo "Linear history confirmed — HEAD is a regular commit. ✓"
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
echo "Diff from dev (CHANGELOG.md + any release-time edits):"
git diff dev HEAD --name-only
echo "=============================="
echo ""
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Next steps:"
echo "  1. Review commit: git show HEAD"
echo "  2. Push: git push origin $CURRENT_BRANCH"
echo "  3. After CI passes: create Anchor Merge on dev (see Appendix A)"
echo "  4. Sync main/release if needed (see Appendix B)"
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

**⚠️ Kaizen commits MUST happen BEFORE creating the Anchor Merge** (Appendix A). The anchor merge captures the release branch tree at that moment — if kaizen edits to this command file happen after the anchor merge, dev and release will drift by exactly those edits. Sequence: Phase 6 kaizen commit → push → CI → Anchor Merge.

---

## Appendix A: Anchor Merge (After Push + CI Pass)

Creates a merge commit on dev whose **tree** is forced to match the release branch's (including CHANGELOG optimisations, release-time fixes). Use git plumbing — regular `git merge <branch> --no-ff` produces the WRONG tree when release-time edits diverge from dev.

```bash
# Determine which branch /release was run on. Auto-detect: the release branch is
# whichever of main/release has the squash commit as its HEAD. If unsure, verify with:
#   git log --oneline main -1
#   git log --oneline release -1
# Then set RELEASE_BRANCH accordingly:
RELEASE_BRANCH="main"   # Change to "release" if /release ran on release branch

git checkout dev

# ⚠️ dev working tree MUST be clean — git reset --hard destroys uncommitted changes!
[[ -z "$(git status --porcelain)" ]] || { echo "ABORT: dev is dirty."; exit 1; }

RELEASE_SHORT=$(git rev-parse --short $RELEASE_BRANCH)
TREE=$(git rev-parse $RELEASE_BRANCH^{tree})
DEV_HEAD=$(git rev-parse --short HEAD)

COMMIT=$(echo "Anchor Merge: dev $DEV_HEAD → $RELEASE_BRANCH $RELEASE_SHORT" \
  | git commit-tree $TREE -p HEAD -p $RELEASE_BRANCH)

# Guard against commit-tree failure (empty commit hash = catastrophic reset)
[[ -n "$COMMIT" ]] || { echo "ABORT: git commit-tree failed — COMMIT is empty. Do NOT reset."; exit 1; }

git reset --hard $COMMIT
git push origin dev
```

This creates a merge commit on dev with:
- **Parent 1**: dev HEAD (preserves dev history)
- **Parent 2**: release branch HEAD (the squash commit)
- **Tree**: release branch's tree (anchored — hence "anchor merge")

The anchor merge's tree = release tree = dev's next starting point. Clean slate.

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

**Why Appendix A uses `git commit-tree` instead of `git merge`**:
`git merge $RELEASE_BRANCH --no-ff` on dev would create a merge commit with dev's parent-1 + release's parent-2, BUT the tree would be the 3-way merge result, not release's tree — so release-time edits (e.g., CHANGELOG changes) would be REVERTED. `commit-tree` forces the tree to be exactly release's tree.
