# OpenClaw Local Operator SOP

This branch-local note consolidates the OpenClaw operating procedures captured in
`~/clawd/memory`. It is intended for local maintenance work on this host and is
not meant to replace upstream public docs.

## Scope

- `openclaw` source checkout: `$HOME/clawd/projects/openclaw`
- live build/install host: `$HOME/clawd/projects/openclaw-build`
- service label: `ai.openclaw.gateway`
- sentinel path: `~/.openclaw/restart-sentinel.json`

## Canonical Model

- Treat the source checkout and the live runtime as separate facts.
- Source edits land in `$HOME/clawd/projects/openclaw`.
- The live gateway is expected to run the installed build under
  `$HOME/clawd/projects/openclaw-build/node_modules/openclaw/dist/index.js`.
- A clean source worktree does not prove the live gateway has new code.
- A restarted gateway does not prove it is running the intended build artifact.

## Default Local Install SOP

When the goal is "install the local `main` version", use this exact shape:

1. Update or verify the source checkout in `$HOME/clawd/projects/openclaw`.
2. Build from the source checkout with `pnpm build`.
3. Build the Control UI assets with `pnpm ui:build`.
4. Produce a local package tarball with `npm pack`.
5. Install that tarball into `$HOME/clawd/projects/openclaw-build`.
6. Run the full restart SOP.
7. Verify the live runtime against the installed build, not just the source tree.

Operational notes:

- `openclaw-build` is a build/install host, not a source worktree.
- `pnpm ui:build` uses the repo `ui` build path and auto-installs UI deps when
  needed.
- If the install comes up with `Control UI assets not found. Build them with
pnpm ui:build (auto-installs UI deps), or run pnpm ui:dev during
development.`, treat that as a missed UI build step and rerun `pnpm ui:build`
  before packaging or reinstalling.
- If a rebuilt tarball reuses the same package version and
  `pnpm install --force --frozen-lockfile` fails on integrity, refresh the
  build host lockfile first with:

```bash
cd "$HOME/clawd/projects/openclaw-build"
pnpm install --lockfile-only --no-frozen-lockfile
```

- After refreshing the lockfile checksum, rerun the intended install command.

## Code Change to Live Effect SOP

Use this rule for any source change under `src/`:

1. Edit source in `$HOME/clawd/projects/openclaw`.
2. Run `pnpm build`.
3. If the change affects the Control UI or the install complains about missing
   Control UI assets, run `pnpm ui:build`.
4. Install or otherwise refresh the live build artifact if the runtime uses
   `$HOME/clawd/projects/openclaw-build`.
5. Restart only when explicitly approved.
6. Verify the live runtime path and behavior after restart.

Rules:

- The gateway runs built `dist/` output, not `src/`.
- Do not describe a source-only change as live until `pnpm build` has completed
  and the running gateway has been reloaded or restarted onto the new artifact.
- For runtime proof, inspect the live build path, launchd state, and gateway
  logs together.

## Upstream Release Sync While Preserving Local Semantics

Use this SOP when the goal is to move the local `main` branch onto the latest
upstream stable release without discarding local behavior.

### Non-negotiables

- Sync from an isolated worktree, not from the primary checkout.
- Start from a clean local `main`.
- Create a safety branch before touching the release sync path.
- Preserve local semantics by intent. Do not resolve conflicts with blind
  `ours` / `theirs` picks.
- Do not use `git reset --hard` as a sync shortcut.
- Do not merge back to local `main` until build and regression gates are green.

### Target selection

- Fetch tags and upstream refs first.
- Prefer the latest stable upstream tag shaped like `vYYYY.M.D`.
- Do not silently substitute a beta tag for a stable release unless explicitly
  requested.
- Record the chosen target tag and target SHA in the run notes before merging.

### Branch and worktree layout

Use durable names that capture the target version and timestamp:

- safety snapshot: `local-main-safety-<timestamp>`
- sync branch: `sync-main-<version>-<timestamp>`
- isolated worktree: a dedicated sync worktree for that branch

This preserves an audit trail and keeps the primary checkout clean.

### Path selection gate

Choose the sync path before touching code:

- If the local semantic delta is already compact, or can first be compacted,
  into `20` or fewer feature commits, treat it as `small local / large
upstream` and use the patch-stack fast path below.
- If the local semantic delta still exceeds `20` commits after cleanup, or the
  local changes form a wide refactor across many subsystems, use the full merge
  sync procedure.

This gate is about semantic work size, not raw timestamp history. If the local
branch contains noisy checkpoint commits, rewrite them into compact feature
commits first and then re-evaluate the `20`-commit threshold.

### Patch-stack fast path for small local delta

Use this path when upstream changed a lot but the local behavior you need to
preserve is comparatively small.

Core idea:

- Stand on the new upstream release first.
- Re-apply only the compact local semantic patch stack.
- Drop any local patch that upstream already absorbed semantically.

Fast-path procedure:

1. Fetch upstream refs and tags.
2. Identify the new upstream target release tag.
3. Identify the old base that the current local semantic stack was built on.
4. Compact local-only work into feature commits if needed.
5. Create a sync branch and isolated worktree from the new upstream release
   tag, not from the old local `main`.
6. Re-apply the local feature commits with `git cherry-pick -n` or direct
   `git cherry-pick` in semantic order.
7. For each patch:
   if it applies cleanly, keep it;
   if it becomes empty, treat that as likely upstream absorption and verify
   before dropping it;
   if it conflicts, rewrite only the minimum code needed to preserve the local
   behavior on top of the new upstream shape.
8. Use `git range-diff <old-base>..<old-local> <new-upstream>..<new-sync>` to
   compare the old semantic stack against the new one.
9. Run `pnpm build` and the targeted regression set for the local patches that
   remain.
10. Only after green gates, absorb the sync branch back into local `main`.

Fast-path rules:

- Prefer dropping a patch over resolving it if upstream already contains the
  same behavior.
- Resolve conflicts by preserving intent, not by preserving line-for-line
  history.
- Keep the local patch stack small after the sync. Do not reintroduce noisy
  checkpoints onto `main`.
- When a local patch survives the sync, keep its feature boundary intact so the
  next release sync stays cheap.

### Sync procedure

Use this procedure when the path-selection gate chooses the full merge sync
path.

1. Fetch upstream refs and tags.
2. Verify local `main` is clean.
3. Create a safety snapshot branch from local `main`.
4. Create a sync branch from local `main`.
5. Create an isolated worktree for the sync branch.
6. In the sync worktree, merge the target upstream release tag.
7. Resolve conflicts semantically:
   local behavior stays unless there is a deliberate reason to adopt the
   upstream behavior instead.
8. Commit the merge and any follow-up fixes as explicit checkpoints.
9. Run build and regression gates in the sync worktree.
10. Only after green gates, fast-forward or otherwise cleanly absorb the sync
    branch back into local `main`.

### Semantic conflict resolution rules

- Compare behavior, not just line shape.
- Preserve local fixes, local safety checks, and local operator workflows unless
  the upstream release intentionally supersedes them.
- When upstream and local code solve the same problem differently, rewrite into
  one canonical implementation instead of keeping duplicate paths.
- If the sync changes tests, update tests to reflect the intended final
  behavior, then rerun the affected regression coverage.

### Gate loop

Minimum expectations before the sync is considered ready:

- `pnpm build`
- targeted regression tests for the touched subsystem
- any broader test or review gate required by the specific change

If a gate fails:

1. debug the concrete failure
2. fix the root cause in the sync worktree
3. rerun the failed gate
4. keep iterating until the gate set is green

### Merge-back rule

After the sync branch is absorbed into local `main`, remember that worktree
build artifacts do not automatically become the live runtime.

Follow-up steps after merge-back:

1. rebuild the primary checkout if needed
2. refresh the installed build artifact in `openclaw-build`
3. run the full restart SOP only when explicitly approved
4. verify the live runtime on the installed build path

### Known failure mode from prior runs

- A successful worktree sync does not update the live build by itself.
- If the primary checkout is fast-forwarded after a worktree sync, it may still
  require an explicit `pnpm build`.
- If the deploy helper path has drifted or no longer exists, fall back to the
  manual local install SOP instead of assuming the old script still works.

## Rewrite Local Main History Into Compact Feature Commits

Use this SOP when the goal is to keep the exact current `main` tree but rewrite
your own recent `main` commits into a smaller, feature-grouped history.

### Non-negotiables

- Rewrite from an isolated worktree, never from the primary checkout.
- Do not use interactive rebase UI for this workflow.
- Do not change the final tree. The rewritten branch must match the old
  `main` tree exactly before `main` is replaced.
- Verify build plus targeted regressions before the force-push.
- Force-push with lease, not a blind `--force`.

### Preparation

1. Start from a clean primary checkout.
2. Capture the current `main` tree hash:

```bash
git rev-parse main^{tree}
```

3. Find the base commit immediately before the first commit you want to
   preserve semantically but rewrite structurally.
4. Create an isolated rewrite worktree and branch:

```bash
git worktree add .worktrees/rewrite-main-compact-<date> \
  -b rewrite/main-compact-<date> main
```

5. In the rewrite worktree, install deps if needed and run a baseline build:

```bash
pnpm install
pnpm build
```

### Commit grouping procedure

1. Reset the rewrite branch to the chosen base commit:

```bash
git switch -C rewrite/main-compact-<date> <base-sha>
```

2. Group the original commits by real feature boundary, not by timestamp.
3. For each feature group, accumulate the original commits with
   `git cherry-pick -n <sha>...`.
4. Commit the staged result as one compact feature commit.
5. Prefer `scripts/committer "<message>" <file...>` for grouped commits.

Semantic grouping rules:

- Keep one canonical commit per subsystem or behavior slice.
- Drop merge noise and duplicate commits only if their content is already fully
  represented by the grouped commits.
- Fold related docs/tests into the owning feature commit when they belong to
  that same behavior.

### Ignore and hook footgun

If a grouped commit includes a tracked file under an ignored path, such as a
tracked `reports/...` file, `scripts/committer` or the repo pre-commit hook may
fail because the hook finishes with a plain `git add -- <files>`.

Use this recovery path:

1. confirm the file is intentionally tracked on the old `main`
2. restage it with `git add --force <path>`
3. commit with hooks disabled for that one grouped commit:

```bash
git -c core.hooksPath=/dev/null commit -m "<message>"
```

Do not skip the later verification gates just because a hook was bypassed.

### Tree-equivalence gate

Before touching local `main`, prove that the rewritten branch has the exact same
tree as the old `main`:

```bash
git rev-parse HEAD^{tree}
git diff --stat main..HEAD
```

Required outcome:

- the new tree hash matches the original `main^{tree}` hash
- `git diff --stat main..HEAD` is empty

If the tree differs, keep fixing the rewrite until it is identical. Do not
replace `main` with a semantically "close enough" tree.

### Verification gate

Minimum verification before rewriting `main` for real:

- `pnpm build`
- targeted regression tests for every touched feature area

If one of the targeted tests already fails or hangs on a branch whose tree is
identical to the old `main`, record it as a pre-existing test problem, not a
rewrite regression. Still report it explicitly; do not silently treat it as
green.

### Replace local and remote main

After the tree-equivalence and verification gates are satisfied:

1. move local `main` to the rewritten branch tip:

```bash
git branch -f main rewrite/main-compact-<date>
```

2. push the rewritten `main` with lease protection:

```bash
git push --force-with-lease origin main
```

### Post-push checks

- confirm the push updated `origin/main` to the rewritten tip
- keep the rewrite worktree until the operator confirms no rollback is needed
- record the grouped commit list and verification commands in the run notes

## Restart Policy

In this local workflow, "restart" defaults to a full restart, not a hot reload.

Rules:

- Treat any gateway restart, reload, or draining action as high risk.
- Do not trigger restart/reload/draining while other active tasks are still in
  flight.
- Get explicit user confirmation before any action that can restart, reload, or
  drain the gateway.
- Do not use `openclaw gateway restart` as the default safe operation on this
  host.
- Do not write the sentinel to the wrong path. The correct file is
  `~/.openclaw/restart-sentinel.json`.

Mechanically, a config-only change may be compatible with a hot reload, but the
operational policy on this host is still to treat any reload-capable action as
high risk and explicitly confirm it first.

## Full Restart SOP

### Step 1: write the sentinel first

Write the sentinel before the restart so the relaunched process can emit the
completion message automatically.

```bash
cat > ~/.openclaw/restart-sentinel.json <<'EOF'
{
  "version": 1,
  "payload": {
    "kind": "full-restart",
    "status": "ok",
    "ts": "REPLACE_WITH_UTC_TIMESTAMP",
    "sessionKey": "agent:main:main",
    "deliveryContext": {
      "channel": "telegram",
      "to": "telegram:REPLACE_ME"
    },
    "message": "Full restart complete."
  }
}
EOF
```

Example timestamp replacement:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
```

### Step 2: run the cold restart

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

Notes:

- `-k` kills the existing service instance and restarts it atomically.
- Prefer `launchctl kickstart -k` over ad hoc stop/start sequences.
- Do not substitute `kill -9` or `launchctl stop` as the routine path.

### Step 3: verify the restart

```bash
launchctl list | rg ai.openclaw.gateway
curl -s http://127.0.0.1:18789/health | head -1
tail -n 120 ~/.openclaw/logs/gateway.log
```

Expected checks:

- `launchctl list` shows `ai.openclaw.gateway` with a fresh PID.
- the health endpoint responds successfully.
- the gateway log shows a fresh startup and listening record.

## Live Runtime Verification SOP

After installing or restarting, verify the live runtime with at least these
checks:

1. Inspect `$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist` and confirm
   the program arguments point at the intended installed build path.
2. Confirm `launchctl list | rg ai.openclaw.gateway` shows a fresh PID.
3. Confirm `~/.openclaw/logs/gateway.log` contains the new startup window.
4. If the task depends on a specific codepath, inspect the live installed
   `dist/` files under `openclaw-build/node_modules/openclaw/dist/` for the
   expected string or implementation.

This avoids the common false positive where the source tree changed but the live
gateway still runs an older installed artifact.

## Config and Runtime Guardrails

- Editing `~/.openclaw/openclaw.json` is operationally risky because active
  config changes can trigger live reload or restart behavior.
- Report restart/reload risk explicitly before touching active config.
- Separate "source repo is clean" from "live gateway is on the new build".
- If a report file needs to be sent through OpenClaw delivery, copy it into
  `~/.openclaw/media/` first instead of sending directly from `reports/`.

## Sources in Memory

The current SOP was distilled from these memory records:

- `~/clawd/memory/KNOWLEDGE_BASE/FULL_RESTART_PROCEDURE.md`
- `~/clawd/memory/KNOWLEDGE_BASE/WORK_RULES.md`
- `~/clawd/memory/KNOWLEDGE_BASE/INTERACTION_PREFS.md`
- `~/clawd/memory/2026-02-28-cold-restart.md`
- `~/clawd/memory/2026-03-03-0349.md`
- `~/clawd/memory/2026-03-08.md`
- `~/clawd/memory/2026-03-09.md`
- `~/clawd/memory/2026-03-11.md`
- `~/clawd/memory/2026-03-15.md`
- `~/clawd/memory/2026-03-16.md`
