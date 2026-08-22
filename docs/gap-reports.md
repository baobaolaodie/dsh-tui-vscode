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
