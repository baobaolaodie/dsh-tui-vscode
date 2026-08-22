# Adapter Note — dsh-tui-vscode (VS Code companion) v0.15

**Status:** Draft / Experimental
**Spec version:** community-v0.15
**Host:** dsh-TUI 0.7.0+ / Cordis 4.x profile; VS Code Extension API ^1.90.0
**Plugin:** `com.baobaolaodie.dsh-tui-vscode` (pilot declaration)

## 定位

dsh-tui-vscode 是 dsh-TUI 的 VS Code companion 扩展。它在 dsh 生态里的角色是“启动/恢复 dsh-TUI 会话的入口提供者”，而不是一个独立的 Cordis 运行时插件。

本 Note 记录 dsh-ecosystem-spec v0.15 的 manifest 概念如何映射到该仓库现有实现，以及当前试点声明与规范之间的已知偏差。

## Contract 映射

| Community v0.15 概念 | dsh-tui-vscode 现状 |
| --- | --- |
| `facets.host.entry` | `out/extension.js`（VS Code 扩展入口；**非 dsh 宿主可执行入口**，见偏差 D-1） |
| `facets.host.apiVersion` | `v1alpha1`（试点值；尚未被 dsh-tui 运行时协商） |
| `requires.contracts` | `commands.dsh/v1alpha1` + `Command`（启动/恢复命令的声明） |
| `permissions` | `commands.invoke`（单条；scope = 插件命名空间，覆盖 start/resume；dsh-std 投影按 action 去重，同一 action 不允许重复声明） |
| `contributes.commands` | `dsh-tui-vscode.start` / `dsh-tui-vscode.resume` |
| `subscriptions` | 无（当前不订阅 messages.observe 等事件） |
| Host Descriptor | 上游示例已发布：`registry/host-descriptor.tui.example.json`（`facetApiVersions=["v1alpha1"]`，storage/commands/messages）；dsh-tui 已在运行时构建真实 descriptor 但无发布工件（见 D-2） |
| effect ledger | 未实现；当前通过 VS Code 终端/会话文件系统读写，无标准 ledger |

## 已知偏差

- **D-1 entry 不可被 dsh 直接加载**：`out/extension.js` 是 VS Code Extension Host 入口，不能由 dsh/Cordis 直接加载。当前 `dsh-plugin.json` 是“声明性试点”，不是可执行插件。
- **D-2 真实 Host Descriptor 已在运行时构建，但无可复验工件、未实测协商（2026-08-23 修订）**：dsh-TUI 主仓已落地 Host Descriptor 构建（`ctx.tuiPluginHost` 提供 runtime generationId，按运行代码真实挂载的契约动态声明，未挂载的 Command 契约剔除并告警）；但 spec 仓库 `registry/` 仍只有示例工件 `host-descriptor.tui.example.json`（`facetApiVersions=["v1alpha1"]`），没有可供离线 `validate:manifest --host` 复验的「真实」descriptor 发布物，本扩展也尚未对运行中 dsh-tui 导出的 descriptor 实测协商。证据等级维持 `Declared` 的理由由「宿主侧不存在」修正为「尚未实测 + 工件未发布」。
- **D-3 本插件侧未接入 effect ledger / lifecycle（2026-08-23 修订）**：宿主侧生命周期实体已实现——dsh-TUI 的效果台账（C-060，`~/.dsh-tui/effect-ledger.jsonl`，pluginId / activationInstance / runtimeGenerationId 三元组）与统一授权存储均已上线；偏差收窄为本扩展作为 VS Code companion 未声明 activation instance、未接入宿主台账，行为仍走 VS Code 终端与会话文件系统。
- **D-4 与 Cordis bundle 双轨并存**：实际可运行层仍是 `package.json` 的 `dsh.bundle` + `cordis.patch.yml`；`dsh-plugin.json` 是额外试点声明，两者尚未统一。
- **D-5 证据等级为 Declared**：试点 manifest 已通过上游 dsh-std v0.15 的 schema + 语义校验（`parseManifest` → `projectManifest` → `manifestDefinitions.validate`），并对上游仓库的示例(example)Host Descriptor（`registry/host-descriptor.tui.example.json`）协商出 **`compatible`**（无 required 缺失、无 denied permission）。2026-08-21 起该复核可经官方入口 `npm run validate:manifest` 一键复现（上游 PR #5）。但因 entry 不可被 dsh 直接加载（D-1）且真实 host 协商未发生，证据等级仍为 `Declared`，不能声称 `Tested` / `Verified`。

## 证据

- 仓库：https://github.com/baobaolaodie/dsh-tui-vscode
- 分支：`feat/dsh-ecosystem-spec`
- `dsh-plugin.json`：本仓库根目录（试点声明）
- 上游 conformance 复核（2026-08-22 更新）：T-Auto/dsh-ecosystem-spec main HEAD `d406de4`（含 PR #5 官方校验入口）+ 固定 `vendor/dsh-std` @ `614dfa1`：
  - `npm run test:standalone` 全量 suite 退出码 0（manifest/Host Descriptor/envelope/ledger/claim 正反 fixture 与五态协商矩阵全部符合预期）；
  - 官方入口 `npm run validate:manifest -- --manifest ./dsh-plugin.json --host registry/host-descriptor.tui.example.json` → `{"valid":true,"decision":"compatible","missingOptional":[]}`，exit 0；
  - 结论维持 **`compatible`**（结构 + 语义 + 协商全过；PR #5 将 admission 算法抽为共用核心 `admission-core.js` 后复核结论不变）。
- 注：上游 [PR #2](https://github.com/T-Auto/dsh-ecosystem-spec/pull/2)（conformance 加载对齐）已合并，修复早期「独立检出无法运行」问题；独立检出现在用 `npm run test:standalone`（等价 `node scripts/conformance.mjs --standalone`）。
- 已合入上游：本 Note 已随 [T-Auto/dsh-ecosystem-spec PR #3](https://github.com/T-Auto/dsh-ecosystem-spec/pull/3) 合入 `adapters/dsh-tui-vscode-v0.15.md`（生态首篇 Adapter Note；曾列于 README「生态扩展一览表」首行，该表后被上游提交 `69052fd` 移除，见「上游演变跟踪」）。
- 现有 CI：`npm test` / `npm run test:e2e` 覆盖 VS Code 扩展行为，不覆盖 v0.15 conformance。

## 上游演变跟踪

- **2026-08-18 命名空间迁移（PR #4）**：上游把 TUI 私有命名空间 `x-ccch1mneyyy.tui/*` 统一迁移为中性 `tui.dsh/*`（DecisionEvents / Channel / SettingsSection / Scene，坐标 `tui.dsh/v1alpha1`），旧坐标不作隐式别名（协商保持确定性）。**本试点 `requires.contracts` 仅使用 std 的 `commands.dsh/v1alpha1#Command`，不消费任何 `tui.dsh` 私有坐标，故迁移不影响本试点**；若未来使用 TUI 私有能力，须改用 `tui.dsh/v1alpha1` 坐标。
- **2026-08-18 conformance 可独立跑**：PR #2 合并后 `npm run test:standalone` 可独立验证（31 fixture + 五态协商全绿）；本试点在其上复核结论仍为 `compatible`。
- **2026-08-21 官方单插件校验入口（PR #5）**：admission 算法自 `conformance/tests/run.js` 抽出为共用核心 `conformance/tests/admission-core.js`，新增 `npm run validate:manifest -- --manifest ./dsh-plugin.json [--host ...] [--grant ...]`（exit 0 = compatible / compatible_degraded / waiting_authorization）。本试点早期的「同款逻辑手工复刻」取证方式自此可由官方 CLI 一键复现。
- **2026-08-21 RFC 0009 转正为 [PR #8](https://github.com/T-Auto/dsh-ecosystem-spec/pull/8)（open，分支 `dev-supply-chain-vision`）**：维护者本人以正式 PR 提交供应链事件响应——撤销注册表 `registry/retractions-0.15.json`（yanked/deleted 双语义、append-only）与 PLUGIN-ADMISSION-CHECKLIST / SECURITY / governance 增补；自述对现有坐标/schema/registry **零兼容性影响**（纯新增层、旧 parser 忽略未知字段），并顺带把此前缺失的 TUI-OBS-002 / TUI-DEP-001 / TUI-CLAIM-001 / TUI-RUN-001/002 补录进 requirements 矩阵。合并概率高；若合入需评估消费端要求（TUI-SC-003 yanked/deleted 处理）对本试点的影响。
- **2026-08-18~22 README 门面重写**：提交 `69052fd` 移除「生态扩展一览表」对本仓库与 Adapter Note 的直达链接，生态可见性转由 [tui 插件市场](https://dshtui.com/plugins/)承担（README 徽章口径收录 23 个）；Note 文件本身仍在 `adapters/` 且被上游 `package.json` 的 `files` 收录。同期规范本体零漂移（spec / registry / schemas / `vendor/dsh-std` @ `614dfa1` 均未动）。
- **2026-08-23 时效审计：dsh-TUI 主仓已落地宿主侧**：[docs/plugins.md](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/plugins.md) 新增「社区互操作规范（Community Consensus v0.15）」章节——`src/plugin-spec/` 校验/协商纯库、vendored profile + `npm run verify:plugin-spec` 漂移检查、Host Descriptor 构建、统一授权存储（8 个注册权限，`commands.invoke` 默认允许）、效果台账与 `/plugins` 诊断面均标记为已落地；边界声明加载强制仍归 dsh CLI Loader。另：全网 `filename:dsh-plugin.json` 命中已达 200+（含多个真实社区插件仓），manifest 格式正在扩散。据此改写本 Note D-2/D-3。

## 收敛计划

1. 对运行中 dsh-tui 构建的真实 Host Descriptor 实测协商（spec registry 尚无可直接消费的发布工件，需经 `/plugins` 诊断面或宿主导出）；
2. 等 Cordis 或 dsh loader 支持读取 `dsh-plugin.json` 作为包身份层；
3. 再决定 entry 是否需要改为独立的 Node/Cordis 入口；
4. 届时补 effect ledger 与 lifecycle 映射，并从 `Declared` 升级到更高证据等级；
5. 本 Note 已作为第一篇 Adapter Note 随 T-Auto/dsh-ecosystem-spec PR #3 合入上游 `adapters/`（生态首个 VS Code companion 适配参考）；后续增量（证据升级、上游演变跟踪）再以小 PR 向上游同步。
