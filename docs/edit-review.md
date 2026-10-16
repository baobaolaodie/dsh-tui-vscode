# AI 编辑审阅修复说明

## 默认行为（本次修复）

默认审阅现在只接受**经过扩展与 DSH 文件工具事务桥核验的写入**：

1. DSH `write`、`edit`、`str_replace_editor` 等支持的文件工具在真正写入前发送 `edit/begin`。
2. 扩展校验调用身份、工作区路径、符号链接、原稿、编辑器 dirty 状态和同路径并发状态。
3. 工具执行成功后发送 `edit/end`，扩展再次校验磁盘内容，再建立待审 entry。
4. 普通终端命令、Git、脚本、其他编辑器和无法证明来源的文件系统事件只更新普通 settled baseline，**不会因为 DeepSeek 终端存在而标记为 AI 改动**。

桥接通道使用单独的随机 token，只通过本机 loopback WebSocket 传输；token 不写入 lock 文件、日志或文档。桥接加载使用本次扩展启动命令携带的一次性 `--patch`，不会修改 DSH 永久 profile，也不修改 DSH、dsh-tui 或 VS Code 源码。

设置：

- `dsh-tui-vscode.editReview.bridge`：默认 `true`。关闭后不建立已核验 AI 文件事务，普通外部写入不会伪装成 AI。
- `dsh-tui-vscode.editReview.native`：默认 `false`。原生 `response.externalEdit` 自动路径仍属于宿主兼容实验，且本机宿主实测连续 Keep 后再次写入的原生控件生命周期不稳定，因此不作为默认路径。
- `dsh-tui-vscode.editReview.autoShowDiff`：控制新待审 entry 是否自动打开 `vscode.diff`，不影响审阅 entry 和按钮。

## Keep / Undo 状态修复

- CodeLens、Hover、侧栏和命令现在使用同一个 after 快照和 hash；实际生成的按钮参数会绑定 entry、before/after hash 和精确 hunk 偏移。
- 无内容变化的保存、空 `contentChanges`、编辑器同步事件不会再把按钮永久标记为过期。
- 非重叠的用户修改会被重基到 before/after 两侧，用户内容保留且不被归类为 AI；与 AI 变更重叠或无法唯一映射时暂停块按钮并显示 Compare，不静默覆盖。
- 保存参与者改变 Undo 结果时保留原稿、保留当前文件，并标记明确冲突。
- 同路径 AI 工具调用串行；上一笔事务完成后，下一笔重新读取原稿和磁盘状态。
- Undo 仍保留 BOM、dirty buffer、路径越界、符号链接、原稿缺失和写后校验等安全拒绝条件，但不再用一个永久 `userTouched` 标志阻断所有可安全执行的操作。

## 删除行和主题显示

- 删除旧文字 decoration 已修正为 VS Code 要求的：

```javascript
{
  range,
  renderOptions: { before: oldTextDecoration }
}
```

- 普通编辑器中的旧文字是短预览；完整多行删除内容使用 Compare with original 的 VS Code diff 编辑器显示。
- Diff 编辑器使用 VS Code 主题的 inserted/deleted 配色。Undo 入口使用 `$(undo)` 图标，不再使用在深色主题下难以识别的 `$(discard)`。
- 实际隔离宿主截图已检查 Default Dark+、Default Light+、Default High Contrast：稳定路径的 Keep/Undo CodeLens、绿色新行、红色旧文字，以及 8 行中文完整删除的 diff 显示均可见。

## 和 Copilot 的边界

Copilot 的核心顺序是“具体编辑事务 → 原稿快照 → 用户编辑重基 → 宿主原生 view zone 和 Keep/Undo”。本次默认路径复用了其中的数据一致性原则和操作语义，但扩展没有伪装 Copilot 身份，也没有注入工作台 DOM：

- 可靠来源来自 DSH 文件工具事务，而不是终端存在状态。
- 稳定 UI 使用公开扩展 API：CodeLens、Hover、Decoration、TreeView 和 `vscode.diff`。
- 原生 `externalEdit` 保留为手动实验入口；自动 native 选项默认关闭，只有用户明确打开并接受宿主兼容限制时才尝试。

## 验证记录（2026-10-13，GMT+8）

- `npm run typecheck`：通过。
- `npm test`：160 项通用/功能测试、103 项审阅测试、3 项 VSIX 命名测试通过，共 266 项。
- 稳定路径隔离 VS Code 1.141.0 宿主：通过普通外部写入不归因、实际 CodeLens/Keep/Undo、无改动保存、连续工具写入、非重叠/重叠用户编辑、8 行中文删除、BOM、保存参与者和 shutdown 持久化。
- 视觉宿主结果：
  - `C:\Users\linus\.proma\agent-workspaces\vscode-dsh-tui\4fdc334b-8643-40f9-ad53-b61de0f6399f\stable-ui-2\screenshots\`
  - 含 Dark、Light、高对比的 inline 与 diff PNG/JSON。
  - 实际鼠标点击 Keep/Undo 通过，结果写入和恢复内容核验通过。
- 真实 DSH 生产桥隔离验证：
  - `write`、`edit`、`str_replace_editor`、`insert`、`create`，中文、CRLF、无 EOF、并行不同文件和失败调用矩阵通过。
  - 20/20 场景通过，14 个事务 commit、28 个 begin/end 请求。
  - observer fiber dispose 后 edit socket 从 1 降为 0；token 文件泄漏检查为 false。
  - 证据：`C:\Users\linus\.proma\agent-workspaces\vscode-dsh-tui\4fdc334b-8643-40f9-ad53-b61de0f6399f\probe-dsh\production-bridge-20261013\`。
- 原生自动路径额外测试确认：首次 externalEdit 能显示完整红色旧行和深/浅/高对比 Keep/Undo，但连续 Keep 后再次写入的原生 lifecycle 在当前宿主上不稳定。因此该选项默认关闭，不能把实验截图当作默认交付。

## 未覆盖范围

- 任意 shell 写入没有可靠的 DSH 工具事务身份，默认不会标 AI。
- 同一文件被未知外部进程在事务期间并发写入时，扩展会保守拒绝或保留冲突；不承诺跨进程绝对 compare-and-swap。
- UTF-8 BOM 文件的自动恢复仍安全拒绝。
- 本地 VSIX 尚未安装到用户日常 VS Code，也未发布 Marketplace。生成包前需要再次运行 `npm run package`；安装会替换同名扩展，需另行确认。
