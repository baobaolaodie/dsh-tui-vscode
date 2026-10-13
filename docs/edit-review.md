# 实时变更审阅（插件内实现）

## 当前交付

本轮续作（2026-10-13，GMT+8）已完成未完成的宿主验收与安全修补；本地源码仍未安装到日常 VS Code。

仅修改 `dsh-tui-vscode`，不修改 DSH、dsh-tui 或 VS Code。本地增强版版本号仍为 0.7.6，未发布 Marketplace。可维护源码放在当前 Proma 项目的 `dsh-tui-vscode/`。

### 默认自动审阅

从插件启动/恢复的 DeepSeek 终端运行期间，工作区 UTF-8 文本文件的外部修改会进入 **AI Edits / AI 修改** 列表。

- **实时比较：** 新待审文件默认打开 VS Code 原生 diff 编辑器，保留终端键盘焦点。原稿在左、当前真实文件在右；Keep 某处后原稿侧自动更新。
- **逐块 Keep / Undo：** 每个变更处的 CodeLens 或鼠标悬浮提供独立按钮；Keep 只提升该块为原稿，Undo 只恢复该块。
- **逐行 Keep / Undo：** 将光标放到改动行，右键选择 `dsh-tui: Keep current line change` / `Undo current line change`。连续多行即使合并成一个 diff 块，也能单行决定。纯删除以删除间隙附近的存活行作为锚点；多条删除共用锚点时弹出选择列表。
- **整文件：** 编辑器标题栏或侧栏文件行的 Keep / Undo；CodeLens 首行也提供文件级操作。
- **全部文件：** AI Edits 视图标题栏的 Keep All / Undo All。
- **待审入口：** 状态栏 `dsh: N pending` 打开待审文件选择。

关闭自动弹出 diff：设置 `dsh-tui-vscode.editReview.autoShowDiff = false`。这不关闭内联操作、列表或手动 Compare。CodeLens 可见性遵循用户已有 `editor.codeLens`，插件不改 VS Code 设置。

## 与 Copilot 原生 UI 的关系

查阅并核验了本机 VS Code 1.141.0 的 Chat Editing 源码：

- [ChatEditingSession 外部修改前后快照](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingSession.ts)
- [ChatEditingTextModelChangeService Keep/Undo](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingTextModelChangeService.ts)
- [ChatEditingCodeEditorIntegration 原生视图区域和按钮](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingCodeEditorIntegration.ts)
- [Copilot ExternalEditTracker](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/extensions/copilot/src/extension/chatSessions/common/externalEditTracker.ts)

实现采用相同的决策语义：Keep 将选中修改提升为原稿，Undo 把原稿选中部分写回当前文件。**自动路径不是把 Copilot 的内部浮层复制出来**，而是稳定扩展 API 提供的 CodeLens、Hover、Decoration、TreeView 与 `vscode.diff`。原生多行旧稿显示在 diff 编辑器中；普通编辑器内的 ghost text 为简短预览，不承诺像素一致。

### 可选原生实验

保留已安装插件的 `Start native review for current/open files (experimental)` 入口：

1. 在 DSH 修改前选择已有、已保存文件并确认风险说明。
2. 进入外部编辑 callback 后，让 DSH 修改这些文件。
3. 点击 `Finish native review`。
4. 使用 VS Code 原生 Keep / Undo 和旧行显示。

`response.externalEdit` 目前属于 proposed API 的兼容实现细节；本机版本直接调用未设 proposal gate，不代表未来版本稳定承诺。追踪期间原生编辑器可能只读，完整审阅需 Finish 后使用。callback/`snapshotReady` 单独不证明原生条目实际创建。需要可用 Chat 环境，即使本 participant 不调用模型。不会启用 proposal 参数、伪装 Copilot 身份或修改宿主。

## 数据保护与范围

- 启动先捕获已打开文档和有界工作区原稿；从插件开启新会话前等待初始化并刷新已知原稿。
- 单文件最大 256 KiB；启动扫描上限 5000 文件、48 MiB。binary、非 UTF-8、排除目录和符号链接不进入普通审阅。
- 工作区目录清单可以确认新文件；未捕获原稿的既有文件拒绝 Undo，不猜测原稿或误删文件。
- 行/块按钮绑定 entry id、前后稿 hash 和位置；过期按钮不匹配最近一块。文件级 CodeLens 也绑定 hash。
- dirty buffer 或编辑器与磁盘不一致时拒绝 Undo；待审期间用户编辑/保存会标记冲突，逐块撤销拒绝、整文件撤销必须明确确认。非模态拒绝提示不会阻塞同路径操作队列。
- UTF-8 BOM 以磁盘前导字节保留在基线和保存屏蔽中，避免普通保存生成虚假待审；由于 VS Code `TextDocument` 正文不含编码 BOM，当前版本对包含 BOM 的待审恢复安全拒绝，不能对这类文件使用 Undo。
- 携带版本 hint 的文件级 Keep 会校验磁盘/干净编辑器内容仍与待审 after 一致；无 hint 的标题/命令入口表示接受当前已保存内容，在已标记 userTouched 的混合修改时允许接受该当前版本而不写盘。侧栏条目携带版本 hint，旧按钮不会接受后来写入。保存参与者改写会保留原稿并将当前内容标为用户冲突，不回滚参与者结果。
- 关闭扩展时会等待已开始的同路径决定、初始化和最终 workspace storage flush；storage 临时文件使用进程/随机后缀。
- 新文件部分 Keep 后接受其存在性，后续整文件 Undo 恢复已 Keep 部分，而不是删除文件。删除未接受的新文件必须确认，使用回收站（宿主支持时）。
- 同路径事件与命令串行；恢复已删除文件使用独占创建，已有新文件时拒绝覆盖；写后核对保存参与者是否改变内容，失败保留原稿。
- 待审状态按 VS Code workspace storage 隔离，有序原子替换写入；从旧 global storage 迁移时只载入当前工作区内容。
- 原生实验追踪的文件删除后不会自动重建或假装已解决；可对确认缺失的单个 native-owned 文件执行“Return current resolved file to ordinary review”，停止该路径保护而不写回文件；其余路径 ownership 不受影响。

**剩余边界：** 普通文件系统事件不携带写入进程身份，不能证明每一项都来自 DSH。同时运行格式化、构建、Git 切换或其他外部写入工具会混入审阅；请勿将该列表当作可信的进程归因。UTF-8 BOM 文件的自动恢复仍未支持，当前以安全拒绝替代；原生实验对已删除文件只提供显式放弃保护的出口。普通文件系统没有跨进程内容 compare-and-swap；即使插件队列和前后校验可缩小风险，也不能保证与任意外部进程同时写同一文件绝对安全。建议待 DSH 停止写该文件后操作 Undo。同一 workspace storage 的唯一临时文件避免临时文件相撞，但不提供多窗口/多 writer 状态合并；正常 deactivate 会等待 flush，强制结束进程或宿主关闭超时仍可能丢失未落盘状态。所有操作不是 Git 暂存，不修改 Git 索引。

## 验证

- `npm run typecheck`
- `npm test`（原有插件测试及新增审阅检查）
- 独立 VS Code 1.141.0 扩展宿主：实际 watcher 存底、扁平 CodeLens、每块按钮、逐行 Keep / Undo、实时原稿刷新、CRLF/无末尾换行、保存后 2 秒内外部重写、整文件撤销、Keep All、新文件接受及删除恢复。
- 独立安全审查指出的问题已补回归测试；没有请求 Copilot/DSH 推理或复制登录凭据。

最新实际宿主结果保存在 `docs/review-host-result.json`。2026-10-13 完整检查：TypeScript 通过，160 项原有测试 + 90 项审阅测试 = 250 项通过；最终扩展宿主在两个独立 profile 中完整成功。宿主新增 dirty/saved 用户编辑、过期控件、新文件部分 Keep、批量 Undo、BOM 安全拒绝及保存屏蔽、保存参与者改写和 awaited shutdown 验证。原生 `externalEdit` UI、本轮 native missing 出口仅有 Node 检查，不以此声明原生 UI 的 fresh 验收。历史原生截图证据来自此前已安装插件的 `docs/`，本次不把它们当作新拍截图，也不声称独立 Copilot 像素对照完成。

### 复跑与安装包

Windows PowerShell（使用已有 VS Code，不下载、不安装）：

```powershell
$env:VSCODE_EXECUTABLE = "D:\Microsoft VS Code\Code.exe"
npm run test:review:host
```

`DSH_REVIEW_ARTIFACT_ROOT` 可指定隔离 profile 和证据输出目录；默认 `.scratch/review-host/`。每个运行有阶段/命令超时及 90 秒外层上限，只终止该运行器创建的独立进程树。不会重载日常窗口、复制凭据或执行 DSH 推理。

本地包为 `dsh-tui-vscode-0.7.6-edit-review.vsix`，与正式版默认产物名区分。`npm run package` 和 `npm run install:local` 共用该命名逻辑；同名版本安装会替换当前 `baobaolaodie.dsh-tui-vscode`，必须先确认；本轮未安装、未发布。文档和测试不进入 VSIX。
