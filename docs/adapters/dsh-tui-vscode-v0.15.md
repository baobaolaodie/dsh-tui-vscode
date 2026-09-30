<div align="right">

English · [简体中文](dsh-tui-vscode-v0.15_ZH.md)

</div>

# Adapter Note — dsh-tui-vscode (VS Code companion) v0.15

**Status:** Draft / Experimental
**Spec version:** community-v0.15
**Host:** dsh-TUI 0.7.0+ / Cordis 4.x profile; VS Code Extension API ^1.90.0
**Plugin:** `com.baobaolaodie.dsh-tui-vscode` (pilot declaration)

## Positioning

dsh-tui-vscode is the VS Code companion extension for dsh-TUI. Its role in the dsh ecosystem is that of a "provider of entry points that start/resume dsh-TUI sessions", rather than a standalone Cordis runtime plugin.

This Note records how the manifest concepts of dsh-ecosystem-spec v0.15 map onto this repository's existing implementation, and the known deviations between the current pilot declaration and the specification.

## Contract Mapping

| Community v0.15 concept | Current state in dsh-tui-vscode |
| --- | --- |
| `facets.host.entry` | `out/extension.js` (VS Code extension entry point; **not an executable entry that the dsh host can load** — see deviation D-1) |
| `facets.host.apiVersion` | `v1alpha1` (pilot value; the facet version has already passed validation in the real-host `/plugins check` chain on 2026-08-23 — consistent with D-2/D-5 and the Evidence section) |
| `requires.contracts` | `commands.dsh/v1alpha1` + `Command` (declaration of the start/resume commands) |
| `permissions` | `commands.invoke` (single entry; the scope must be a declared command id — the host positively validates scope ∈ commandIds and inversely requires every command to have a corresponding grant, while the std parsing layer dedupes by name and forbids more than one entry with the same name. Only `.start` is declared for now; `.resume` will be restored after the upstream ruling, see Gap 3) |
| `contributes.commands` | Only `com.baobaolaodie.dsh-tui-vscode.start` is declared for now (`.resume` is on hold because of the Gap 3 rule conflict; the extension itself still provides that command) |
| `subscriptions` | None (no event subscriptions such as messages.observe at present) |
| Host Descriptor | The upstream example has been published: `registry/host-descriptor.tui.example.json` (`facetApiVersions=["v1alpha1"]`, storage/commands/messages); dsh-tui already builds a real descriptor at runtime but has no published artifact (see D-2) |
| effect ledger | Not implemented; the pilot currently reads and writes the VS Code terminal and the session file system, with no standard ledger |

## Known Deviations

- **D-1 entry cannot be loaded directly by dsh**: `out/extension.js` is a VS Code Extension Host entry point and cannot be loaded directly by dsh/Cordis. The current `dsh-plugin.json` is a "declarative pilot", not an executable plugin.
- **D-2 the real Host Descriptor has been negotiated in practice (closed loop on 2026-08-23)**: the spec registry has no offline-verifiable descriptor publication artifact, but dsh-TUI already builds a real Host Descriptor at runtime; on 2026-08-23 this pilot completed negotiation against a running dsh-tui 0.8.8 via `/plugins check` → **`compatible`** (see the Evidence section). The reason for keeping the evidence level at `Declared` has narrowed to "entry cannot be loaded directly by dsh (D-1) + no activation/lifecycle integration (D-3)"; the negotiation dimension has been verified in practice.
- **D-3 no effect ledger / lifecycle integration on this plugin side (revised 2026-08-23)**: the host-side lifecycle entities have been implemented — dsh-TUI's effect ledger (C-060, `~/.dsh-tui/effect-ledger.jsonl`, the pluginId / activationInstance / runtimeGenerationId triple) and its unified authorization store are both live; the deviation has narrowed to the fact that this extension, as a VS Code companion, declares no activation instance and does not integrate with the host ledger, while its behavior still goes through the VS Code terminal and the session file system.
- **D-4 dual-track coexistence with the Cordis bundle**: the actually runnable layer is still `package.json`'s `dsh.bundle` + `cordis.patch.yml`; `dsh-plugin.json` is an additional pilot declaration, and the two have not been unified yet.
- **D-5 evidence level is Declared**: the pilot manifest has passed the upstream dsh-std v0.15 schema + semantic validation (`parseManifest` → `projectManifest` → `manifestDefinitions.validate`) and negotiated **`compatible`** against the upstream repository's example Host Descriptor (`registry/host-descriptor.tui.example.json`) (no missing required items, no denied permissions). Since 2026-08-21 this re-check can be reproduced with one command through the official entry point `npm run validate:manifest` (upstream PR #5). Real-host negotiation has since been closed out as well: on 2026-08-23 a `/plugins check` against a running dsh-tui 0.8.8 negotiated **`compatible`** (the same record as D-2; see the Evidence section). Because entry cannot be loaded directly by dsh (D-1) and there is still no activation/lifecycle integration (D-3), the evidence level remains `Declared` — the outstanding end-to-end gap is the loadable-entry / lifecycle dimension, not the negotiation dimension — and it cannot claim `Tested` / `Verified`.

## Evidence

- Repository: https://github.com/baobaolaodie/dsh-tui-vscode
- Branch: `feat/dsh-ecosystem-spec`
- `dsh-plugin.json`: repository root (pilot declaration)
- Upstream conformance re-check (updated 2026-08-22): T-Auto/dsh-ecosystem-spec main HEAD `d406de4` (including PR #5, the official validation entry point) + pinned `vendor/dsh-std` @ `614dfa1`:
  - `npm run test:standalone` full suite exit code 0 (manifest / Host Descriptor / envelope / ledger / claim positive and negative fixtures and the five-state negotiation matrix all behave as expected);
  - official entry point `npm run validate:manifest -- --manifest ./dsh-plugin.json --host registry/host-descriptor.tui.example.json` → `{"valid":true,"decision":"compatible","missingOptional":[]}`, exit 0;
  - the conclusion remains **`compatible`** (structure + semantics + negotiation all pass; after PR #5 extracted the admission algorithm into the shared core `admission-core.js`, the re-check conclusion is unchanged).
- Host-side re-check (2026-08-23; headless replication of the full `/plugins check` chain: parseManifest → projectManifest → createContractIndex(vendored registry/permissions) → validatePlugin → buildHostDescriptor → negotiate, on an installed copy of dsh-tui 0.8.8): **TUI semantic validation PASS**, negotiate → **`compatible`** (host.dropped=[] / warnings=[]); minimal compliant shape (single command `.start`).
- Real-host negotiation on record (2026-08-23; running dsh-tui 0.8.8; real terminal `/plugins check D:\...\dsh-plugin.json`): after the C-070 trust banner it printed **「协商结果：compatible」**. The headless prediction matched the real host, closing the loop on the negotiated dimension.
- Note: upstream [PR #2](https://github.com/T-Auto/dsh-ecosystem-spec/pull/2) (conformance loading alignment) has been merged, fixing the earlier "standalone checkout cannot run" problem; a standalone checkout now uses `npm run test:standalone` (equivalent to `node scripts/conformance.mjs --standalone`).
- Merged upstream: this Note was merged as `adapters/dsh-tui-vscode-v0.15.md` with [T-Auto/dsh-ecosystem-spec PR #3](https://github.com/T-Auto/dsh-ecosystem-spec/pull/3) (the first Adapter Note in the ecosystem; it was once listed in the first row of the README "ecosystem extensions" table, which was later removed by upstream commit `69052fd`, see "Upstream Evolution Tracking").
- Existing CI: `npm test` / `npm run test:e2e` cover VS Code extension behavior, but not v0.15 conformance.

## Upstream Evolution Tracking

- **2026-08-18 namespace migration (PR #4)**: upstream migrated the TUI-private namespace `x-ccch1mneyyy.tui/*` to the neutral `tui.dsh/*` (DecisionEvents / Channel / SettingsSection / Scene, coordinate `tui.dsh/v1alpha1`), with no implicit alias for the old coordinates (negotiation stays deterministic). **This pilot's `requires.contracts` only uses std's `commands.dsh/v1alpha1#Command` and consumes no `tui.dsh` private coordinate, so the migration does not affect this pilot**; if TUI-private capabilities are used in the future, the `tui.dsh/v1alpha1` coordinate must be used instead.
- **2026-08-18 conformance can run standalone**: after PR #2 was merged, `npm run test:standalone` can verify independently (31 fixtures + five-state negotiation all green); the re-check of this pilot on top of it still concludes `compatible`.
- **2026-08-21 official single-plugin validation entry point (PR #5)**: the admission algorithm was extracted from `conformance/tests/run.js` into the shared core `conformance/tests/admission-core.js`, adding `npm run validate:manifest -- --manifest ./dsh-plugin.json [--host ...] [--grant ...]` (exit 0 = compatible / compatible_degraded / waiting_authorization). The pilot's earlier evidence method of "manually replicating the same logic" can now be reproduced with one command through the official CLI.
- **2026-08-21 RFC 0009 promoted to [PR #8](https://github.com/T-Auto/dsh-ecosystem-spec/pull/8) (open, branch `dev-supply-chain-vision`)**: the maintainer personally submitted the supply-chain incident response as a formal PR — the retraction registry `registry/retractions-0.15.json` (yanked/deleted dual semantics, append-only) plus additions to PLUGIN-ADMISSION-CHECKLIST / SECURITY / governance; the description states zero compatibility impact on existing coordinates/schema/registry (purely additive layer; old parsers ignore unknown fields), and it also backfills the previously missing TUI-OBS-002 / TUI-DEP-001 / TUI-CLAIM-001 / TUI-RUN-001/002 into the requirements matrix. The merge probability is high; if it is merged, the impact of consumer-side requirements (TUI-SC-003 yanked/deleted handling) on this pilot must be evaluated.
- **2026-08-18~22 README front-page rewrite**: commit `69052fd` removed the "ecosystem extensions" table's direct links to this repository and its Adapter Note; ecosystem visibility is now carried by the [tui plugin marketplace](https://dshtui.com/plugins/) (the README badge reports 23 plugins); the Note file itself is still in `adapters/` and is included in the upstream `package.json`'s `files`. In the same period the spec itself had zero drift (spec / registry / schemas / `vendor/dsh-std` @ `614dfa1` all unchanged).
- **2026-08-23 freshness audit: the dsh-TUI main repository has landed the host side**: [docs/plugins.md](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/plugins.md) added a "Community Interop Spec (Community Consensus v0.15)" section — the `src/plugin-spec/` validation/negotiation pure library, the vendored profile + `npm run verify:plugin-spec` drift check, Host Descriptor construction, the unified authorization store (8 registered permissions, `commands.invoke` allowed by default), the effect ledger and the `/plugins` diagnostic surface are all marked as landed; boundary-declaration load enforcement still belongs to the dsh CLI Loader. Also: network-wide `filename:dsh-plugin.json` hits have reached 200+ (including several real community plugin repositories), and the manifest format is spreading. Accordingly, D-2/D-3 of this Note were rewritten.
- **2026-08-23 upstream rule defect found in practice (Gap 3)**: through a running dsh-tui (0.8.8, `/plugins check`), this pilot manifest exposed the fact that — the @dsh-std/manifest 0.1.0 parsing layer dedupes by `community.dsh/v1alpha1␀Permission␀<name>` (only one entry per name; scope does not participate), while the dsh-tui profile layer requires that "each `commands.invoke` scope must be a declared command id" and inversely that "every declared command has a corresponding invoke grant". Under the three rules combined, **a plugin declaring ≥2 commands has no form that can pass the review**. This pilot currently keeps the minimal compliant single-command (`.start`) shape, staying green on both sides; see `docs/gap-reports.md` Gap 3.

## Convergence Plan

1. ✅ Completed 2026-08-23: real-host `/plugins check` negotiation `compatible` (the headless replication chain predicted it first; both are on record);
2. After the upstream ruling on Gap 3 (multi-command permission semantics conflict), restore the `resume` command and the second invoke grant declaration;
3. Wait until Cordis or the dsh loader supports reading `dsh-plugin.json` as a package identity layer;
4. Then decide whether entry needs to become a standalone Node/Cordis entry point;
5. At that point add the effect ledger and lifecycle mappings, and upgrade from `Declared` to a higher evidence level;
6. This Note has already been merged upstream as the first Adapter Note into `adapters/` via T-Auto/dsh-ecosystem-spec PR #3 (the ecosystem's first VS Code companion adaptation reference); subsequent increments (evidence upgrades, upstream evolution tracking) will be synced upstream via small PRs.
