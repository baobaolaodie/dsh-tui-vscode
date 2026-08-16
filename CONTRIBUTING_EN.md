<div align="right">

English · [中文](CONTRIBUTING.md)

</div>

# Contributing to dsh-tui-vscode

Thank you for considering contributing to dsh-tui-vscode! The workflow and conventions below are **enforced server-side by CI** (contributors cannot weaken the checks by editing repo files).

## Development environment

- Node.js 24 (dev and CI agree); package management uses **npm** (`npm ci`).
- The e2e "real dsh-tui resume" test needs a global `dsh` CLI and `dsh-tui` (skipped automatically when absent).
- Install the local hook for development: `node scripts/install-commit-hook.mjs` (blocks fast-to-revert issues like commit-message format).

## Running tests

```bash
npm run typecheck        # tsc --noEmit
npm test                 # compile + data-layer unit tests (node:test)
npm run test:e2e         # real extension-host tests (@vscode/test-electron; Linux: xvfb-run -a)
npm run package          # compile + build the .vsix
```

## Change workflow

1. Branch from `main` with a **prefix** of `feat/` `fix/` `docs/` `chore/` `hotfix/` `ci/` `test/` (enforced by the CI pr-policy; `feature/` is rejected).
2. Commit messages follow **Conventional Commits**: `fix: ...` / `feat: ...` / `docs: ...` / `ci: ...` (CI audits every commit).
3. Open a Pull Request: the **title must also be Conventional Commits**; the body uses the five-section structure of `.github/PULL_REQUEST_TEMPLATE.md` (Summary / Scope of Changes / Verification / Self-check / Review Notes) — **deleting or omitting any section or checkbox fails the PR**.
4. Behavior changes **must be recorded in the Unreleased section of `CHANGELOG.md`** (both languages); ticking "Behavior changes recorded in CHANGELOG (Unreleased)" requires an actual CHANGELOG diff against the base (no fake self-checks).
5. Doc changes must be **mirrored in both languages** (CI enforces a line-count difference ≤ 10; CoC excluded).

## Code conventions

- Pure logic that does not need the VS Code API lives in `src/session.ts` / `src/sessions.ts` — **no `vscode` import** — so it is unit-testable.
- **Platform-independent assertions**: build expected paths with `join()`; CI runs on Linux and Windows, and hardcoded Windows-style separators fail on Linux (a lesson already learned).
- Stage explicit paths only — no `git add -A` grab-bags; run `git diff --check` before committing.
- Never commit credentials, keys, personal paths, or local artifacts (`.vsix`, `.e2e-workspace`, etc. are in `.gitignore`).

## Commit conventions

- One logical change per commit; no unrelated edits mixed in.
- Format: `<type>(<scope>): <subject>`, e.g. `fix(sessions): projectNameOf 双分隔符解析`.

## Submission flow

1. Fork this repository and branch from `main` (`git checkout -b fix/your-change`).
2. Commit your changes (`git commit -m 'fix: describe the change'`).
3. Push the branch (`git push origin fix/your-change`).
4. Open a Pull Request (title with a Conventional Commits prefix, same as commits).

Local pre-check: install the pre-commit hook (`node scripts/install-commit-hook.mjs`); CI covers the rest server-side.

## Publishing

- Current publishing flow: `npm run package` to build the vsix, then upload it at https://marketplace.visualstudio.com/manage (the official "manual publish" path — no PAT required).
- Version flow: bump `package.json` version → sync the README badges and CHANGELOG (the release-consistency CI enforces the five-point match) → create the `v*` tag → upload the new version via the web.
- Note: Azure DevOps global PATs are retired on 2026-12-01; for future CLI/CI automation, switch to Entra ID (`vsce publish --azure-credential`, vsce >= 2.26.1).
- Never use "Remove": an extension name is permanently reserved after removal and cannot be reused; use "Unpublish" to take it down.

### Publishing an update (new version)

1. **A new version number is mandatory**: Marketplace versions cannot be overwritten or reused after deletion — every release must use an incremented version number (uploading the same version is rejected).
2. **CHANGELOG**: move the `Unreleased` content into a version section `## [x.y.z] - date`, linking the PRs merged in this batch (the release-consistency CI requires a PR link or a direct-push marker in every version section).
3. **Five-point sync**: `package.json` version = README badges (zh/en) = first CHANGELOG version section (zh/en) — verified by CI.
4. `npm run package`, then upload the new vsix on the manage page (it becomes the extension's new version automatically, keeping install stats).
5. Create the `v*` tag and a GitHub Release (with the vsix attached), matching the store version.
6. After the release: reset `Unreleased` to empty; if the version sync touched README/CHANGELOG, push them together with the tag.
