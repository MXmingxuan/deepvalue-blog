# Obsidian Publisher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` and complete each task with tests and an independent review before continuing.

**Goal:** Add a safe, manual one-click pipeline that turns explicitly publishable notes from a separate Obsidian Vault into previewed, validated Astro entries, then confirms them through a scoped Git commit and optional push.

**Architecture:** A dependency-light Node ESM publisher lives in `publisher/`. Its pure libraries parse, validate, index, and transform Vault notes; a transaction layer stages generated Markdown and copied assets outside the repository before applying an exact manifest. A localhost preview/confirmation server wraps the transaction, while two CLI commands provide Obsidian-compatible entry points. Personal paths and publish state remain Git-ignored.

**Tech stack:** Node.js 22 ESM, `gray-matter`, `yaml`, built-in `node:test`, built-in HTTP server, existing Astro build and Git CLI.

## Non-negotiable safety rules

- Never scan anything outside the configured Vault root.
- Only notes whose YAML has the boolean `publish: true` are eligible.
- Never move, rename, edit, or delete Vault attachments.
- Preview and cancel must leave tracked repository content unchanged.
- Apply only the files listed in the staging manifest and refuse overlapping working-tree changes.
- Stage only generated entry/assets/configured state-independent targets; never use `git add .`.
- Do not push unless the user confirms in the browser or passes an explicit confirmation flag.
- Never commit `publish.config.local.json`, `.publish-state.json`, absolute Vault paths, or temporary staging data.

## Task 1: Configuration, frontmatter, identity, and validation core

**Files:**
- Modify: `package.json`, `package-lock.json`, `.gitignore`
- Create: `publish.config.example.json`
- Create: `publisher/lib/config.mjs`
- Create: `publisher/lib/frontmatter.mjs`
- Create: `publisher/lib/identity.mjs`
- Create: `publisher/lib/validate.mjs`
- Create: `publisher/lib/state-store.mjs`
- Create: `tests/publisher-core.test.mjs`

**Requirements:**

- Add pinned `gray-matter` and `yaml` dependencies.
- Ignore `publish.config.local.json`, `.publish-state.json`, `.publish-staging/`, and `.publish-preview/`.
- Validate that configured Vault root is absolute and exists, repo output paths stay inside the repository, and attachment roots stay inside the Vault.
- Parse YAML without losing Markdown body. Normalize arrays and optional fields into the public schema.
- Generate a deterministic readable `publish_id` when absent, but do not mutate the Vault in V1; print the suggested field for the user to add. A supplied `publish_id` is the permanent identity.
- Enforce domain, format, source type, confidence, article requirements, and investment section rules. Produce filename + field diagnostics.
- State writes are atomic, backed up on corruption, contain repository-relative emitted paths, and never contain note bodies.

**Tests:** malformed config, YAML parsing, `publish: true` eligibility, identity stability, article/log requirements, invalid enums, atomic/corrupt state recovery.

**Commit:** `feat: add publisher configuration and validation core`

## Task 2: Vault scanner, link/callout transformation, and asset copying

**Files:**
- Create: `publisher/lib/vault-index.mjs`
- Create: `publisher/lib/transform.mjs`
- Create: `publisher/lib/assets.mjs`
- Create: `tests/publisher-transform.test.mjs`
- Create: `tests/publisher-scanner.test.mjs`

**Requirements:**

- Current-note scanning must reject a source outside the Vault. Pending scanning recursively reads Markdown only, ignores configured folders, and returns only eligible new/changed notes.
- Detect duplicate `publish_id` values across eligible notes before generating output.
- Resolve note links by exact Vault-relative path first and unique basename second. Published targets become `/blog/<publish_id>/`; unpublished targets become visible plain text without leaking paths. Ambiguous links abort.
- Convert image embeds to `/media/<publish_id>/<deterministic-name>` and copy only supported image types. Missing, case-mismatched, ambiguous, PDF/audio/canvas embeds abort with actionable diagnostics.
- Convert Obsidian callouts to standards-compatible blockquotes with a stable label. Merge configured inline hashtags into frontmatter tags while ignoring code fences and URLs.
- Preserve tables, code fences, footnotes, lists, blockquotes, and ordinary Markdown.
- Copy assets into caller-provided staging directories; source files must remain byte-for-byte unchanged.

**Tests:** eligibility/hash selection, duplicate IDs, exact/ambiguous links, unpublished links, callouts, hashtags, deterministic images, missing/unsupported assets, source immutability.

**Commit:** `feat: transform publishable Obsidian notes`

## Task 3: Transactional staging and repository application

**Files:**
- Create: `publisher/lib/render-entry.mjs`
- Create: `publisher/lib/transaction.mjs`
- Create: `publisher/lib/git.mjs`
- Create: `tests/publisher-transaction.test.mjs`

**Requirements:**

- Render Astro-compatible frontmatter into `src/content/entries/<publish_id>.md`, preserving `published_at` from state and updating `updated_at` only on confirmed republish.
- Stage generated entries and assets in a unique temporary directory outside tracked output paths. Produce a JSON manifest with hashes and exact target paths.
- Build preview against an isolated temporary repository copy/worktree so the live repository is unchanged before confirmation.
- Cancel removes the transaction directory.
- Before apply, detect tracked or untracked conflicts at every target. Allow an existing generated target only when its current hash matches the last published state; otherwise abort.
- After apply, run `npm run build`; on failure restore pre-apply target snapshots.
- Git helper stages exact manifest targets only, verifies the staged set, creates `publish: <title or N entries>`, and pushes only when explicitly requested. Preserve unrelated modifications.
- Update state only after successful application/commit, retaining retry information if push fails.

**Tests:** first publish, republish timestamps, cancel immutability, conflicting target, build rollback, exact Git staging in a temporary repo, unrelated dirty file exclusion, push-disabled default.

**Commit:** `feat: add transactional publication workflow`

## Task 4: Local preview/confirm UI and Obsidian commands

**Files:**
- Create: `publisher/cli.mjs`
- Create: `publisher/server.mjs`
- Create: `publisher/public/index.html`
- Create: `publisher/public/styles.css`
- Create: `publisher/public/app.js`
- Create: `tests/publisher-cli.test.mjs`
- Modify: `package.json`

**Requirements:**

- Add `publish:current`, `publish:pending`, and `publish:test` scripts.
- `publish:current -- --source <absolute-path>` stages exactly the active eligible note. `publish:pending` stages all eligible new/changed notes.
- CLI validates and builds an isolated preview, starts a loopback-only server on an available port, opens the real target route, and displays the exact note/assets/diff manifest.
- UI exposes Confirm & Push, Confirm without Push, and Cancel. Mutating endpoints require a random per-transaction token, accept POST only, and can be used once.
- Terminal output includes the preview URL and clear recovery instructions. `--no-open`, `--yes`, and `--no-push` support automation without changing safe defaults; `--yes` is required for non-interactive apply.
- Exit codes distinguish validation, build, conflict, Git, and push failures.

**Tests:** argument handling, safe defaults, source requirement, loopback binding, one-shot token, cancel, and non-interactive confirmation guard.

**Commit:** `feat: add one-click Obsidian publishing commands`

## Task 5: Documentation, migration, and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify or replace: `scripts/prepare-publish.mjs`
- Create: `publisher/README.md`
- Create: `tests/publisher-e2e.test.mjs`

**Requirements:**

- Document the separate Vault model, required frontmatter, articles versus logs, domain taxonomy, configuration, current/pending commands, browser confirmation, failure recovery, and a shell-command bridge for Obsidian.
- Deprecate the old in-repo attachment mover; it must no longer move source assets. Either turn it into a clear compatibility wrapper around the safe publisher or fail with migration instructions.
- End-to-end fixtures use a temporary Vault and temporary Git repo and verify: publishable-only selection, transformed links/callouts/images, long logs, first publish + update, cancel, no Vault mutation, no private path leakage, exact commit scope, and successful Astro build.
- Run `npm test`, `npm run publish:test`, and `npm run build` from a clean tree.
- Manually exercise a preview transaction with a temporary fixture, inspect desktop/mobile UI, cancel it, and verify the repository remains unchanged.

**Commit:** `docs: complete Obsidian publishing workflow`

## Final review and delivery

- Run an independent whole-branch code review for privacy, filesystem containment, transaction integrity, Git scope, and public routing.
- Fix every Critical or Important finding and re-review.
- Run fresh complete tests/build, verify the local site and publisher preview in the browser, then merge the implementation branch into `main` and push `main` as explicitly requested.
