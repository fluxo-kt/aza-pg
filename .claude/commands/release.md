---
name: /release
description: Squash dev commits into a single release commit on the release branch
argument-hint: (optional notes or version override)
id: p-release
category: project
tags: [project, release]
---

# /release

You are executing a **deterministic release squash** for the aza-pg project.

The Anchor Merge pattern: granular dev commits → squashed single mega-commit on `release`.
Dev's anchor merge ensures `git merge --squash dev` applies ONLY the net delta.
After committing, both `release` and `main` are pushed simultaneously via refspec (see Phase 6).
**Always work from `release`, never from `main`** — `main` is kept in sync by push, not by running /release on it.

OPTIONAL NOTES / VERSION OVERRIDE: $ARGUMENTS

---

## ⚠️ GUARDRAILS — Read Before Every Execution

1. **⚠️ Net delta only**: CHANGELOG must show ONLY v_old→v_new (the released-to-released delta). Never show intermediate steps.
2. **⚠️ Consumer-first ordering**: Consumer outcomes first in commit message/CHANGELOG; internal/infra changes after.
3. **⚠️ No phantom entries**: Don't claim fixes for things not broken in the LAST RELEASED version.
4. **⚠️ `pgdg13` = Debian 13 (Trixie)**, NOT PostgreSQL 13: manifests of the Debian-built releases carry it.
5. **⚠️ `bun install` AFTER squash BEFORE validation** — stale node_modules cause false validation failures AND broken pre-commit hook regeneration.
6. **⚠️ NEVER compare tree hashes after CHANGELOG edits** — trees diverge by design (that's the point).
7. **⚠️ Use `git add -u` NOT `git add -A`** — never add untracked files (.DS_Store, .env, temp).
8. **⚠️ NEVER use `--no-verify` or `--no-gpg-sign`** — fix the root cause.
9. **⚠️ Prefer `startsWith()` over `===`** for version assertions — never encode stale absolute versions.
10. **⚠️ NEVER `git merge dev` (without `--squash`) on main/release** — this creates a merge commit and permanently pollutes the linear history. The ONLY allowed mechanism is `git merge --squash dev`.

---

## Phase 0: Pre-Flight (All Must Pass — Fail Fast)

```bash
bun scripts/release/preflight.ts
```

It refuses (exit 1, naming the fix) unless HEAD is `release` with a clean tree, local `dev` contains `origin/dev`, dev's newest Anchor Merge has the release HEAD as its second parent, and dev has commits after it. Its header gives the reasons. On success it prints `ANCHOR`, `DEV_SQUASH_TIP`, `RANGE`, the commit list and the deduplicated co-author trailers: Phases 1–4 use those values, so keep its output.

Not on `release`: the agent cannot switch branches, so ask Art to run `! git checkout release`, then re-run.

### 0.8 — Everything the image ships is current

Run every item of `/update`'s "Pre-Flight: Detect Available Updates" and "Pre-Flight: Additional Checks" now, on `dev`, and record one line per item: what it found, or "current". Results from an earlier session or day do not count: nixpkgs, Docker Hub, GitHub releases and npm change daily, and an update held back by the minimum release age becomes due when the age passes. The `check-updates` gate alone misses companion images, Bun packages and runtime, Actions pins and the nixpkgs revision in `flake.lock`. Anything due ⇒ ABORT the release and run `/update` on `dev` first.

---

## Phase 1: Analyse Net Delta

The commits being squashed are the preflight's commit list; `$ANCHOR` below is its `ANCHOR`.

### 1.2 — Categorise changes (consumer-visible)

Scan the diff for consumer-visible changes. Look at:

```bash
# Manifest changes (extension versions, PG version)
git diff $ANCHOR..refs/heads/dev -- scripts/extensions/manifest-data.ts

# CHANGELOG unreleased section (before squash — from dev's HEAD; no truncation)
git show refs/heads/dev:CHANGELOG.md

# Nix build changes (nixpkgs revision, build options, image contents)
git diff $ANCHOR..refs/heads/dev -- flake.nix flake.lock nix/

# Test additions/changes
git diff $ANCHOR..refs/heads/dev --stat -- scripts/test/
```

**Categorise into**:
- **Consumer-visible** (extensions added/updated/removed, PG version changes, API/behaviour changes, security fixes)
- **Build/reliability** (Nix build improvements, CI fixes, dependency updates — brief if user-impacting)
- **Infrastructure** (nixpkgs revision, build tools — 1 line if relevant)
- **Development/tooling** (tests, linting, scripts — 1-line summary)

---

## Phase 2: CHANGELOG Audit & Optimisation

Review dev's CHANGELOG (`[Unreleased]` section) against the net delta from Phase 1.

```bash
git show refs/heads/dev:CHANGELOG.md
```

**Audit rules**:

1. **Consumer-first ordering**: Accept the standard CHANGELOG categories: `Breaking`, `Security`, `Fixed`, `Changed`, `Added`, `Deprecated`, `Removed`, `Development`. Reorder by impact: Breaking first, then Security/Fixed, then Changed, Added, Deprecated, Removed, then Development last. Do NOT invent categories beyond this set.
2. **Net-delta only**: If X went v1→v2→v3 during dev, entry must say "v1→v3"
3. **Cancellation**: Entries added then reverted = omit entirely
4. **Development section**: MAX 3 brief lines, no per-file detail
5. **Cross-validation**: Every version change MUST match `git diff $ANCHOR..refs/heads/dev -- scripts/extensions/manifest-data.ts`
6. **No phantoms**: Don't claim fixes for things not broken in the last released version
7. **`[Unreleased]` holds only this release.** Each release commit carries its own dated section (Phase 4.4), so everything under `[Unreleased]` on dev is new since the newest `## [v…]` heading.
8. **Re-measure every number** in `[Unreleased]` (image size, store paths, MB added) on the image being released: each was measured when its entry was written, and any later closure change makes it false in a section that freezes at release.

Write down the specific CHANGELOG edits needed. You will apply them in Phase 4.4 AFTER the squash.

---

## Phase 3: Prepare Commit Message

### 3.1 — Derive title

Scan categorised changes from Phase 1:

- **Any extension version bumps or new features** → type: `feat`
- **All changes are bug fixes** → type: `fix`
- **Only tooling/CI/deps** → type: `chore`

Scope: `feat(postgres)` for features/upgrades, `fix(postgres)` for bugfix-dominated, `chore(release)` for maintenance-only.

Title should name the 1-2 most impactful consumer-visible changes (e.g., "upgrade PG 18.1→18.3, TimescaleDB 2.24→2.25"). **Max 72 chars total.**

Machine-verify before proceeding: `echo -n "TYPE(SCOPE): your title here" | wc -m` must output ≤ 72.

### 3.2 — Draft full commit message

Format (from reference commits `33c3c24`, `0d94637`):

```text
TYPE(SCOPE): concise consumer-first title (max 72 chars)

- Consumer-visible change 1 (extensions, features, security)
- Consumer-visible change 2
- Build/reliability fix (brief, only if user-impacting)
- Infrastructure: 1-line if relevant
- Development: 1-line summary of tooling/test changes

FIRST_SHORT..LAST_SHORT

Co-Authored-By: Name <email>
Co-Authored-By: Current Agent <agent@example.com>
```

Rules:
- Body bullets: consumer-visible first, then build, infra, dev
- Blank line before hash range
- Blank line before Co-Authored-By block
- Always include the current agent co-author identity from `AGENTS.md`
- Deduplicate co-authors case-insensitively; add the current agent if not already present

Write the complete message now with ALL actual values filled in (no UPPERCASE placeholders — replace them all). You will copy this exact text into the HEREDOC in Phase 4.7, replacing the template lines entirely.

---

## Phase 4: Execute Squash

> **CRITICAL SEQUENCE** — do not reorder steps.

### 4.1 — Squash dev onto current branch

```bash
# The preflight's DEV_SQUASH_TIP, not the moving dev ref: the Dev-Squash-Tip trailer then names exactly what was squashed.
git merge --squash DEV_SQUASH_TIP
```

This cannot conflict: the preflight proved release's HEAD is the anchor's second parent, so it is the merge base and the squash stages exactly dev's tree. A conflict means that proof broke: stop and report to Art (see [Stopping a release](#stopping-a-release)).

Verify changes were staged (should not be empty once the preflight passed):

```bash
STAGED_STAT=$(git diff --cached --stat)
if [[ -z "$STAGED_STAT" ]]; then
  echo "ABORT: git merge --squash dev produced no staged changes."
  echo "       Run: git rev-list $ANCHOR..refs/heads/dev --oneline (should be non-empty)"
  exit 1
fi
echo "$STAGED_STAT"
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

**Anything else** (type errors, failing tests, broken imports, shellcheck): the staged tree is dev's, so the defect is on dev. Stop the release (below), fix it on dev, then re-run /release.

### 4.4 — Apply CHANGELOG optimisations

Re-read `CHANGELOG.md` as it now is in the working tree (dev's version after squash), compare against what you planned in Phase 2, then apply the specific edits identified there. Then date the release in this commit:

```bash
bun scripts/release/date-changelog.ts   # prints the tag, e.g. v18.6-202611101530
git add -u   # Stage only tracked file modifications — NEVER git add -A
```

publish.yml names the tag and builds the GitHub notes from that newest `## [v…]` heading, and refuses a name already tagged on another commit. A redone squash takes dev's CHANGELOG afresh, so run the script again.

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

The `Dev-Squash-Tip` trailer records the commit Phase 4.1 squashed, so `anchor-merge.ts` can refuse to anchor over dev commits the release lacks.

**IMPORTANT**: The `'COMMIT_EOF'` single-quoted HEREDOC disables variable expansion. You MUST write all values literally. Replace every placeholder with actual values from the preflight and Phase 3:
- `TYPE` → actual type from Phase 3.1 (e.g., `feat`)
- `SCOPE` → actual scope (e.g., `postgres`)
- `title here` → actual title from Phase 3.2 (max 72 chars including `TYPE(SCOPE):` prefix)
- `change 1`, `change 2` → actual body bullets from Phase 3.2
- `FIRST_SHORT..LAST_SHORT` → the preflight's `RANGE` (e.g., `6a979fa..b111f5a`)
- `DEV_SQUASH_TIP` → the preflight's full `DEV_SQUASH_TIP`
- `Co-Authored-By: Name <email>` → the preflight's co-authors (one line per author)

Name every staged path literally after `--`: the commit guard refuses a commit without a pathspec, and reads paths only from the command line, so `--pathspec-from-file` is refused too. `git diff --cached --name-only --no-renames` lists them, both sides of a rename included.

```bash
# Message from the HEREDOC on stdin; never --no-verify; never --no-gpg-sign
git commit --only -F - -- PATH_1 PATH_2 … <<'COMMIT_EOF'
TYPE(SCOPE): title here

- change 1
- change 2

FIRST_SHORT..LAST_SHORT

Dev-Squash-Tip: DEV_SQUASH_TIP
Co-Authored-By: Name <email>
Co-Authored-By: Current Agent <agent@example.com>
COMMIT_EOF
```

Then `git diff --cached --quiet` must succeed: a path missing from the list stays staged and is not released.

**If commit fails due to signing** (SSH key not available):
- Ask user: `eval "$(ssh-agent -s)" && ssh-add`
- NEVER use `--no-gpg-sign` or touch git config

**Pre-commit hook interaction** (expected behaviour):
- Hook detects `manifest-data.ts` in staged files → runs `bun run generate`
- Auto-stages regenerated files
- Runs `oxlint --fix` and `prettier --write` on staged files
- Auto-stages fixes, then runs `bun run validate`; a failing check blocks the commit
- This is HELPFUL — provides additional safety. Requires `bun install` (Phase 4.2) to have run first.

---

## Phase 5: Verification

### 5.1 — Scope of changes vs dev

```bash
DIFF_FILES=$(git diff refs/heads/dev HEAD --name-only)
echo "Files differing from dev:"
echo "$DIFF_FILES"
```

**Expected to differ**: `CHANGELOG.md` (always, by design), `bun.lock` (if bun reformatted), any files edited in Phase 4.5.
**Flag as unexpected**: source files, scripts, Docker files, generated extension lists — these should be IDENTICAL to dev after squash.
**Note**: if dev has advanced since the squash (new commits landed after Phase 4.1), those files will also appear here. `anchor-merge.ts` refuses to anchor over them (Dev-Squash-Tip check).

Do NOT compare tree hashes — trees intentionally diverge after CHANGELOG edits.

### 5.2 — Linear history (machine-verified — no merge commit)

```bash
git log --oneline -3

# Machine check: HEAD must NOT be a merge commit (would have a second parent)
if git rev-parse HEAD^2 >/dev/null 2>&1; then
  echo "🚨 ERROR: HEAD is a merge commit! Release squash must produce a regular commit."
  echo "   This means git merge --squash was accidentally replaced with git merge."
  echo "   To undo: git reset --hard HEAD~1"
  echo "   See guardrail 10. After undoing, re-run /release."
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
git diff refs/heads/dev HEAD --name-only
echo "=============================="
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

A fix that cannot ride in the release (new tooling, anything needing its own tests) waits until the anchor is pushed and Art has checked out `dev`, then lands there as a normal commit. The agent cannot leave `release` itself, since the Bash hook refuses every `git checkout`; next step 4 asks Art for it.

Once kaizen is committed, output next steps for the user:

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo ""
echo "Next steps (all agent work complete):"
echo "  1. Review commit: git show HEAD"
echo "  2. Push both branches (main mirrors release; workflow_run runs dev's definitions — a publish.yml fix must be on dev):"
echo "       git push origin $CURRENT_BRANCH && git push origin $CURRENT_BRANCH:main"
echo "  3. After publish succeeds, the agent runs bun scripts/release/anchor-merge.ts (Appendix A)"
echo "  4. Then switch back for daily work: git checkout dev"
```

---

## Appendix A: Anchor Merge (After Push + CI Pass)

Creates a merge commit on dev whose **tree** is forced to match the release branch's (including CHANGELOG optimisations, release-time fixes). Use git plumbing — regular `git merge <branch> --no-ff` produces the WRONG tree when release-time edits diverge from dev.

Once publish has succeeded, run from any branch, with no question to the user:

```bash
bun scripts/release/anchor-merge.ts
```

It picks the v* tag on `origin/release`'s tip, refuses when `dev` holds commits the squash did not contain (the `Dev-Squash-Tip` trailer) or differs from `origin/dev`, builds the anchor with `git commit-tree`, moves `dev` without checking it out, and pushes it. Re-running after success does nothing. Every refusal names its fix; the script's header gives the reasons.

The anchor commit has:
- **Parent 1**: dev's tip (preserves dev history)
- **Parent 2**: the release tag (the squash commit and any kaizen commits)
- **Tree**: the released tree (anchored — hence "anchor merge")

The anchor merge's tree = release tree = dev's next starting point. Clean slate.

---

## Appendix B: main/release Branch Sync

GitHub's `workflow_run` triggered workflows always execute from the **default branch** (`dev`), regardless of which branch triggered the upstream CI. So the publish workflow runs `dev`'s `publish.yml`: a fix made only on `release` is silently bypassed until it is on `dev`. `main` mirrors `release`:

Push to both branches simultaneously — no branch switch needed:

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push origin "$CURRENT_BRANCH" "$CURRENT_BRANCH:main"
```

Only works if history is perfectly linear (fast-forward). If the push to `main` fails (rejected), investigate — do NOT force-push `main`.

---

## Stopping a release

Interrupted before the commit: resume where it stopped; the staged squash is still valid (`git merge --squash` leaves no merge in progress).

To stop instead, report the failure and ask Art to run `! git reset --hard HEAD && bun install`: discarding work is his call, not the agent's. Nothing else needs undoing: the preflight required a clean tree, so every change present came from the squash, and the squash staged its new files, which the reset removes too.

## Watching publish, and when it fails after the push

publish.yml is a `workflow_run` of CI, so GitHub files it under dev's branch and head SHA, never the release commit: `gh run list --commit <release SHA> --workflow publish.yml` stays empty forever. Find it with `gh run list --workflow publish.yml --limit 1 --json databaseId,createdAt,status,conclusion` and check `createdAt` follows CI's completion on release.

A failed publish tags nothing, so the pushed release commit is fixed in place, never re-squashed (a second `git merge --squash` re-applies the whole release and conflicts on CHANGELOG):

1. Art runs `! git checkout dev`. Fix and commit there, then push dev: publish runs dev's publish.yml, so a workflow fix must be on `origin/dev` before CI on release finishes.
2. Art runs `! git checkout release`. Apply exactly dev's fix commits: `git cherry-pick --no-commit <first>^..<last>`, then commit them as one, its body ending `Dev-Squash-Tip: <dev tip, full SHA>`. The release then holds everything up to dev's tip, which is what that trailer claims and what `anchor-merge.ts` checks.
3. Push release and `release:main`; CI and publish run again, then Appendix A as usual.

---

## Key Design Decisions (Reference)

**Why `git merge --squash dev` over alternatives**:
- Cherry-pick range: fragile (intermediate conflicts that cancel in net delta)
- `git diff | git apply`: loses metadata, no conflict detection
- `git merge --squash dev`: applies NET diff directly, proper 3-way merge semantics
- Since anchor merge makes dev's tree match main's, `main..dev` = exactly the new work

**Why `bun install` is mandatory after squash**:
The squash brings dev's code (including updated `bun.lock`) into the index/working tree, but `node_modules` still reflects release branch's packages. Dev may have updated oxlint, prettier, etc. Without `bun install`, validation uses stale binaries and the pre-commit hook's `bun run generate` uses wrong packages.

