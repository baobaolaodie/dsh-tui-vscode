<p align="center">
  <a href="gap-reports_ZH.md">简体中文</a>
</p>

---

# Gap Report 1 — dsh-ecosystem-spec Windows conformance test fails due to CRLF hash drift

## Symptom

After cloning `T-Auto/dsh-ecosystem-spec` on Windows and running `npm test`, it fails immediately:

```
AssertionError [ERR_ASSERTION]: storage.local schemaHash drifted
+ actual:   sha256:e9058da348d...
- expected: sha256:a43bd499060...
```

## Root Cause

- The `schemaHash` of `registry/contracts/storage.local-0.15.json` is computed over **LF bytes**.
- The repository has no `.gitattributes` enforcing LF.
- When Windows uses the default `core.autocrlf=true`, Git checkout converts files to **CRLF**.
- As a result, the SHA-256 of the local file does not match the registry record.

## Impact

- The spec claims that "`npm test` is enough to verify", but Windows developers cannot reproduce it.
- This directly breaks the reproducibility of the "executable spec", and is a concrete instance of what the author described as "instability will expose spec oversights".

## Suggested Fix

Add a `.gitattributes` at the repository root:

```
* text=auto eol=lf
*.json text eol=lf
*.md text eol=lf
```

and re-verify all registry schemaHash values (confirming they are computed over LF bytes).

## Files

- `.gitattributes` (new)
- `registry/contracts/*.json`
- `registry/registry-0.15.json`
- `conformance/tests/run.js` (if a newline-normalization fallback is still needed)

## Status Tracking

- **Submitted**: as [T-Auto/dsh-ecosystem-spec#1](https://github.com/T-Auto/dsh-ecosystem-spec/issues/1) (submitted by baobaolaodie).
- **Fixed and closed**: closed by T-Auto on 2026-08-18 (comment: "Fixed!"); the fix added `.gitattributes` to force `eol=lf` for `registry/contracts/*.json` and `schemas/*.json`.
- Note: `registry/registry-0.15.json` and `registry/permissions-0.1.json` are not covered by `.gitattributes`, but the conformance runner only hashes `registry/contracts/*.json` and `schemas/*.json`, so this does not affect reproducing `npm test`.

---

# Gap Report 2 — Official plugin template and docs not aligned with dsh-ecosystem-spec v0.15

## Symptom

- `dsh-tui-ecosystem/plugin-template` only has `package.json` + `cordis.patch.yml`, with **no `dsh-plugin.json`**.
- `dsh-TUI/docs/plugins.md` does not mention the v0.15 manifest / `facets.host` / contract coordinates / Host Descriptor at all.
- A GitHub-wide search for `filename:dsh-plugin.json` returns **0** results.

## Root Cause

- The actual runnable format of the current dsh plugin ecosystem is the **Cordis bundle** (`package.json`'s `dsh.bundle.patch` + `cordis.patch.yml`).
- The discovery entry point defined by dsh-ecosystem-spec v0.15 is **`dsh-plugin.json`**, and there is no adaptation layer between the two.
- The official template still teaches the Cordis bundle and has not caught up with the spec.

## Impact

- If the spec starts being enforced, **all existing community plugins will be incompatible**.
- Developers who want to "write plugins according to the spec" have no reliable template to follow.
- It blocks the spec from entering Candidate (candidate acceptance requires 3 example plugins).

## Suggested Fix

1. Add `dsh-plugin.json` to `plugin-template` as the official template;
2. Add an "ecosystem compatibility layer" section to `docs/plugins.md`, explaining the relationship between `dsh-plugin.json` and `cordis.patch.yml`;
3. Add at least one Adapter Note under `dsh-ecosystem-spec/adapters/`, mapping the Cordis bundle → v0.15 manifest;
4. Use the `dsh-tui-vscode` branch `feat/dsh-ecosystem-spec` as the first real-world pilot reference.

## Repos

- `dsh-tui-ecosystem/plugin-template`
- `ccch1mneyyy/dsh-TUI` (`docs/plugins.md`)
- `T-Auto/dsh-ecosystem-spec` (`adapters/`)
- `baobaolaodie/dsh-tui-vscode` (pilot reference)

## Status Tracking

- **Kept as a local record**: per the 2026-08 decision, it is recorded only in this file, and no upstream issue / PR is submitted for now;
- if the upstream later needs example plugins for Candidate acceptance, re-evaluate submitting one.
- **2026-08-23 timeliness audit update**: Sub-item 2 (`docs/plugins.md` not mentioning v0.15) is no longer valid — the document now contains a full "Community Interoperability Specification (Community Consensus v0.15)" section, and the host-side implementation (validation library / Host Descriptor construction / authorization storage / effect ledger / `/plugins`) has landed; sub-item 3 (a GitHub-wide search for `filename:dsh-plugin.json` returning 0) is no longer valid — it now returns about 200+ (including real plugin repositories such as dsh-data-agent / dsh-lark-bot / dsh-deepread and third-party marketplace directories). Sub-item 1 (plugin-template missing the manifest) was not re-checked in this round, so its status is unknown. The risk judgment that "once the spec is enforced all existing community plugins will be incompatible" has consequently been significantly downgraded.

---

# Gap Report 3 — The `commands.invoke` authorization semantics for multi-command plugins are unsatisfiable under the current rules

## Symptom

Running `/plugins check <manifest>` against a live dsh-tui 0.8.8, authorization with a single namespace-wide scope reports an error:

```
Semantic validation failed: commands.invoke scope is not a declared command: com.baobaolaodie.dsh-tui-vscode
```

After switching to per-command scopes (two `commands.invoke` entries with scopes `.start` / `.resume`), it is rejected at the parse stage on **the same std**:

```
component spec.facets[0].permissions contains duplicate permission
  "community.dsh/v1alpha1\u0000Permission\u0000commands.invoke"
```

## Root Cause

The three rules are mutually contradictory when combined (all confirmed by actual testing / reading the source):

1. **@dsh-std/manifest 0.1.0 parsing layer** (spec pin `614dfa1` behaves the same as the copy bundled in dsh-tui 0.8.8): community manifest permissions are deduplicated by `community.dsh/v1alpha1␀Permission␀<name>` — **only one entry with the same name is allowed; scope does not participate in the dedup key**;
2. **dsh-tui profile layer forward validation** (`plugin-spec/validate.js`): the scope of each `commands.invoke` must match a `contributes.commands[].id`;
3. **dsh-tui profile layer reverse validation** (same file): every declared command must have a `commands.invoke` authorization whose scope is exactly that command id.

⇒ When a plugin declares N≥2 commands, it needs N permissions with the same name (rule 3), but rule 1 allows only 1; and with only 1 declared, its scope can cover only 1 command (rule 2), so the remaining commands necessarily violate rule 3. **There is no manifest shape that can pass review.**

## Impact

- Any plugin declaring ≥2 commands cannot pass `/plugins check` or the upstream `validate:manifest`;
- It directly blocks the "multi-implementation evidence" required for the upstream to enter Candidate — multi-command plugins are the norm rather than the exception;
- This pilot is forced to converge on the single-command minimal compliant shape (only `.start`), and the `resume` declaration is put on hold.

## Reproduction

- dsh-tui 0.8.8 (global and profile copies consistent), @dsh-std/manifest 0.1.0;
- spec side: T-Auto/dsh-ecosystem-spec main `d406de4` + vendor pin `614dfa1`, `npm run validate:manifest`;
- host side: headless replication of the full `/plugins check` chain (parseManifest → projectManifest → createContractIndex(vendored) → validatePlugin → buildHostDescriptor → negotiate); both shapes reproduce the errors;
- single-command minimal shape: both sides PASS / `compatible` at the same time.

## Suggested Fix (choose one; upstream decision required)

1. **Change std**: change the parsing-layer dedup key to `name␀scope` (a key shape precedent already exists in the lib), allowing multiple authorizations with the same name but different scopes;
2. **Change the dsh-tui profile layer**: relax it to "action-level authorization covers all declared commands" (e.g., support a plugin-namespace-prefix scope), or drop the reverse-coverage requirement.

## Repos

- `Yan-Zero/dsh-std` (dedup key in the @dsh-std/manifest parsing layer; the upstream mount has pointed at `T-Auto/dsh-std` since 2026-10-02)
- `ccch1mneyyy/dsh-TUI` (`src/plugin-spec/validate.js` forward/reverse validation)
- `T-Auto/dsh-ecosystem-spec` (vendor pin and conformance fixtures lack multi-command coverage)

## Status Tracking

- **Kept as a local record**: per the 2026-08 decision, no upstream issue is submitted for now; this pilot stays all-green on both sides in the single-command minimal compliant shape, and the `resume` declaration will be restored after the upstream decision.
- **2026-10-03 upstream-state note**: the observations above were taken on dsh-tui **0.8.8** with spec pin `614dfa1` / `@dsh-std/manifest` 0.1.0. Since then the upstream spec repository was restructured (the old `conformance/` and the root `package.json` entry point are gone from main; the dsh-std mount now points at `T-Auto/dsh-std`, 2026-10-02) and dsh-TUI is at **0.12.0** (2026-09-30). No upstream ruling on the Gap 3 rule conflict has been observed as of this date, so this pilot still keeps the single-command shape; the recorded reproduction steps are a local record of the 0.8.8-era state.
