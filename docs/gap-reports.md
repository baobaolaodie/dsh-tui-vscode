# Gap Report 1 — dsh-ecosystem-spec Windows conformance test fails due to CRLF hash drift

## 现象 / Symptom

在 Windows 上克隆 `T-Auto/dsh-ecosystem-spec` 后运行 `npm test`，立即失败：

```
AssertionError [ERR_ASSERTION]: storage.local schemaHash drifted
+ actual:   sha256:e9058da348d...
- expected: sha256:a43bd499060...
```

## 根因 / Root cause

- `registry/contracts/storage.local-0.15.json` 的 `schemaHash` 是按 **LF 字节**计算的。
- 该仓库没有 `.gitattributes` 强制 LF。
- Windows 默认 `core.autocrlf=true` 时，Git checkout 会把文件转成 **CRLF**。
- 因此本机文件的 SHA-256 与 registry 记录不一致。

## 影响 / Impact

- 规范宣称“npm test 即可验证”，但 Windows 开发者无法复现。
- 这直接破坏了“可执行规范”的可复现性，是作者所说的“不稳定会爆规范疏漏”的具体实例。

## 建议修复 / Suggested fix

在仓库根目录添加 `.gitattributes`：

```
* text=auto eol=lf
*.json text eol=lf
*.md text eol=lf
```

并重新校对所有 registry schemaHash（确认是按 LF 字节计算）。

## 涉及文件 / Files

- `.gitattributes`（新增）
- `registry/contracts/*.json`
- `registry/registry-0.15.json`
- `conformance/tests/run.js`（如果还需要做换行归一化兜底）

## 状态跟踪 / Status

- **已提交**：作为 [T-Auto/dsh-ecosystem-spec#1](https://github.com/T-Auto/dsh-ecosystem-spec/issues/1)（由 baobaolaodie 提交）。
- **已修复并关闭**：T-Auto 于 2026-08-18 关闭（评论“已修复！”）；修复方式为新增 `.gitattributes`，对 `registry/contracts/*.json` 与 `schemas/*.json` 强制 `eol=lf`。
- 注：`registry/registry-0.15.json`、`registry/permissions-0.1.json` 不在 `.gitattributes` 覆盖范围内，但 conformance runner 只对 `registry/contracts/*.json` 与 `schemas/*.json` 做 hash 校验，故不影响 `npm test` 复现。

---
# Gap Report 2 — Official plugin template and docs not aligned with dsh-ecosystem-spec v0.15

## 现象 / Symptom

- `dsh-tui-ecosystem/plugin-template` 只有 `package.json` + `cordis.patch.yml`，**没有 `dsh-plugin.json`**。
- `dsh-TUI/docs/plugins.md` 完全没有提及 v0.15 manifest / `facets.host` / contract coordinates / Host Descriptor。
- 整个 GitHub 搜索 `filename:dsh-plugin.json` 结果为 **0**。

## 根因 / Root cause

- 当前 dsh 插件生态的实际可运行格式是 **Cordis bundle**（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`）。
- dsh-ecosystem-spec v0.15 定义的发现入口是 **`dsh-plugin.json`**，两者没有适配层。
- 官方模板还在教 Cordis bundle，没跟上 spec。

## 影响 / Impact

- 如果规范开始强制，**现存所有社区插件都会不兼容**。
- 开发者想“按规范写插件”也没有可靠样板可参照。
- 会阻碍规范进入 Candidate（候选验收要求 3 个示例插件）。

## 建议修复 / Suggested fix

1. 在 `plugin-template` 增加 `dsh-plugin.json`，作为官方样板；
2. 在 `docs/plugins.md` 增加“生态兼容层”章节，说明 `dsh-plugin.json` 与 `cordis.patch.yml` 的关系；
3. 在 `dsh-ecosystem-spec/adapters/` 增加至少一篇 Adapter Note，映射 Cordis bundle → v0.15 manifest；
4. 以 `dsh-tui-vscode` 分支 `feat/dsh-ecosystem-spec` 作为第一个真实试点参考。

## 涉及仓库 / Repos

- `dsh-tui-ecosystem/plugin-template`
- `ccch1mneyyy/dsh-TUI` (`docs/plugins.md`)
- `T-Auto/dsh-ecosystem-spec` (`adapters/`)
- `baobaolaodie/dsh-tui-vscode`（试点参考）

## 状态跟踪 / Status

- **维持本地记录**：按 2026-08 决策仅保留本文件记录，暂不提交上游 issue / PR；
- 后续如上游进入 Candidate 验收需要示例插件，可再评估补提。
- **2026-08-23 时效审计更新**：子项 2（`docs/plugins.md` 未提及 v0.15）已失效——该文档现含完整「社区互操作规范（Community Consensus v0.15）」章节且宿主侧实现（校验库 / Host Descriptor 构建 / 授权存储 / 效果台账 / `/plugins`）已落地；子项 3（全 GitHub 搜 `filename:dsh-plugin.json` 为 0）已失效——现命中约 200+（含 dsh-data-agent / dsh-lark-bot / dsh-deepread 等真实插件仓及第三方市场目录）。子项 1（plugin-template 缺 manifest）本轮未复核，状态不明。「规范强制后现存社区插件全不兼容」的风险判断随之显著下调。

---
# Gap Report 3 — 多命令插件的 `commands.invoke` 授权语义在现行规则下不可满足

## 现象 / Symptom

对运行中的 dsh-tui 0.8.8 执行 `/plugins check <manifest>`，单条命名空间 scope 的授权报错：

```
语义校验失败：commands.invoke scope is not a declared command: com.baobaolaodie.dsh-tui-vscode
```

改为逐命令 scope（两条 `commands.invoke`，scope 分别为 `.start` / `.resume`）后，
在**同一套 std 上**于 parse 阶段即被拒：

```
component spec.facets[0].permissions contains duplicate permission
  "community.dsh/v1alpha1\u0000Permission\u0000commands.invoke"
```

## 根因 / Root cause

三条规则合取后互相矛盾（均为实测/读源码确认）：

1. **@dsh-std/manifest 0.1.0 解析层**（spec pin `614dfa1` 与 dsh-tui 0.8.8 内置副本行为一致）：社区 manifest 权限按
   `community.dsh/v1alpha1␀Permission␀<name>` 去重——**同 name 仅允许一条，scope 不参与去重键**；
2. **dsh-tui profile 层正向校验**（`plugin-spec/validate.js`）：每条 `commands.invoke` 的 scope 必须命中 `contributes.commands[].id`；
3. **dsh-tui profile 层反向校验**（同文件）：每个已声明命令都必须存在 scope 恰等于该命令 id 的 `commands.invoke` 授权。

⇒ 插件声明 N≥2 个命令时需要 N 条同名权限（规则 3），但规则 1 只允许 1 条；而仅声明 1 条时其 scope 只能覆盖 1 个命令（规则 2），其余命令必然违反规则 3。**不存在可过审的 manifest 形态。**

## 影响 / Impact

- 任何声明 ≥2 个命令的插件都无法通过 `/plugins check` 或上游 `validate:manifest`；
- 直接阻碍上游进入 Candidate 所需的「多实现证据」——多命令插件是常态而非例外；
- 本试点被迫收敛为单命令最小合规形态（仅 `.start`），`resume` 声明暂缓。

## 复现 / Reproduction

- dsh-tui 0.8.8（global 与 profile 副本一致），@dsh-std/manifest 0.1.0；
- spec 侧：T-Auto/dsh-ecosystem-spec main `d406de4` + vendor pin `614dfa1`，`npm run validate:manifest`；
- 宿主侧：headless 复刻 `/plugins check` 全链（parseManifest → projectManifest → createContractIndex(vendored) → validatePlugin → buildHostDescriptor → negotiate），两种形态的错误均复现；
- 单命令最小形态：双侧同时 PASS / `compatible`。

## 建议修复 / Suggested fix（二选一，需上游裁决）

1. **改 std**：解析层去重键改为 `name␀scope`（lib 内已有先例键形），允许同 name 不同 scope 的多条授权；
2. **改 dsh-tui profile 层**：放宽为「action 级授权覆盖全部已声明命令」（如支持插件命名空间前缀 scope），或取消反向覆盖要求。

## 涉及仓库 / Repos

- `Yan-Zero/dsh-std`（@dsh-std/manifest 解析层去重键）
- `ccch1mneyyy/dsh-TUI`（`src/plugin-spec/validate.js` 正反向校验）
- `T-Auto/dsh-ecosystem-spec`（vendor pin 与 conformance fixture 未覆盖多命令场景）

## 状态跟踪 / Status

- **维持本地记录**：按 2026-08 决策暂不提交上游 issue；本试点已按单命令最小合规形态保持双侧全绿，上游裁决后恢复 `resume` 声明。
