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
| `permissions` | `commands.invoke`（scope 限定到本插件声明的命令 ID） |
| `contributes.commands` | `dsh-tui-vscode.start` / `dsh-tui-vscode.resume` |
| `subscriptions` | 无（当前不订阅 messages.observe 等事件） |
| Host Descriptor | 未发布；dsh-tui 本体尚未提供真实 Host Descriptor |
| effect ledger | 未实现；当前通过 VS Code 终端/会话文件系统读写，无标准 ledger |

## 已知偏差

- **D-1 entry 不可被 dsh 直接加载**：`out/extension.js` 是 VS Code Extension Host 入口，不能由 dsh/Cordis 直接加载。当前 `dsh-plugin.json` 是“声明性试点”，不是可执行插件。
- **D-2 无 Host Descriptor**：dsh-tui 本体还没有发布符合 `host-descriptor.schema.json` 的真实 Host Descriptor；本仓库也无法单独声明宿主能力。
- **D-3 无 effect ledger / lifecycle 实现**：当前没有 activation instance、runtime generation、effect ledger 等 v0.15 生命周期实体。
- **D-4 与 Cordis bundle 双轨并存**：实际可运行层仍是 `package.json` 的 `dsh.bundle` + `cordis.patch.yml`；`dsh-plugin.json` 是额外试点声明，两者尚未统一。
- **D-5 未通过 conformance negotiation**：因为缺少真实 Host Descriptor 和可加载 entry，当前只能达到 `Declared` 级，不能声称 `Tested` / `Verified`。

## 证据

- 仓库：https://github.com/baobaolaodie/dsh-tui-vscode
- 分支：`feat/dsh-ecosystem-spec`
- `dsh-plugin.json`：本仓库根目录（试点声明）
- 现有 CI：`npm test` / `npm run test:e2e` 覆盖 VS Code 扩展行为，不覆盖 v0.15 conformance。

## 收敛计划

1. 等 dsh-tui 本体发布真实 Host Descriptor；
2. 等 Cordis 或 dsh loader 支持读取 `dsh-plugin.json` 作为包身份层；
3. 再决定 entry 是否需要改为独立的 Node/Cordis 入口；
4. 届时补 effect ledger 与 lifecycle 映射，并从 `Declared` 升级到更高证据等级。