# @-mention 设计说明(dsh-tui-vscode.insertAtMention)

> 记录「把选中代码/整个文件引用到 dsh-tui 输入框」的当前实现、dsh-tui 侧机制、以及
> 与 Claude Code 官方扩展的对齐差距与未来补丁计划。issue #6 · PR #7。

## 1. 背景

- issue #6:快捷键把选中代码(未选中时整个文件)「引用」到 dsh-tui 的输入框。
- 基准:Claude Code 官方 VS Code 扩展的 `insertAtMention`(官方插入 `@path#Lx-y`)。
- 硬约束:dsh-tui 是**运行在真实 PTY 里的终端程序**(DeepSeek Harness 的 TUI),没有
  webview、没有官方那种「原生面板 + 选区上下文 IPC」。扩展与它的唯一输入通道是
  `terminal.sendText`(往 PTY 键入)。

## 2. dsh-tui 的 @-mention 机制(为什么必须绝对路径)

dsh-tui **以「会话自己的工作目录 `state.cwd`」为中心**,自带 `dsh-fs-local` FS 服务,
**并不感知 VS Code 工作区**。`@` 提及在 **提交时**展开(不是输入时):

```
deliverUserText(text) → expandMentions(mentionFs, state.cwd, text)
```

`expandMentions(src/dsh-adapter/channel.ts)` 的关键解析:

```ts
const absolute = isAbsolute(mention.path) ? mention.path : join(cwd, mention.path)
```

- **相对路径** → 以会话 `state.cwd` 为基准解析 → 不在 cwd 下 → 进 `missing` →
  黄条「未找到引用」(原文仍照发);
- **绝对路径** → 源码注释原话 *“absolute paths pass through untouched”* → 直通,
  与 cwd 无关。
- 附加模型:你的原文永远是第一条 text 块(气泡显示原文);每个成功解析的提及再
  **追加**一个块——文本 → `<attached-file path="…">`、图片 → image 块、目录 → 列表。
- **无行区间能力**:`@路径#L12-14` 会被整体当文件名 → 必弹「未找到引用」。
- **输入通道限制**:PTY raw 模式逐键读;注入文本若带 `\n`/`\r` 会被 ConPTY 当
  「整行管道」**直接提交**(绕过输入框),所以只能单行注入、**绝不自动回车**。

## 3. 当前实现(适配后的最终形态)

- `@` 路径 = **正斜杠绝对路径**:`editor.document.uri.fsPath` →
  `normalizeMentionPath()`(反斜杠→`/`),保证与会话 cwd/盘符/分隔符无关。
- 输出形态:
  - 未选中:`@D:/repo/src/a.ts`
  - 单行:`@D:/repo/src/a.ts L12`
  - 多行:`@D:/repo/src/a.ts L12-14`(行号 1-based)
  - 路径含空白:双引号形式 `@"D:/My Some/a.ts"`(dsh-tui `extractMentions` 原生支持)
- 投递:有运行中的 DeepSeek 终端 → `terminal.show()` + `sendText(mention, false)`
  (单行、不回车 → 落在输入框,用户补问题后回车;提交时 dsh-tui 自动附加整个文件);
  无会话 → 复制到剪贴板 + 提示。
- 入口:`Ctrl+Alt+K`(macOS `Cmd+Alt+K`,`editorTextFocus`)+ 命令面板
  `dsh-tui: Insert @-mention / 插入 @文件引用` + 编辑器右键。
- 为什么行区间是纯文本而非 `#L`:dsh-tui 不支持,`#L` 会破坏 `@` 解析。

## 4. 与 Claude Code 官方扩展的差距

| 维度 | 官方 Claude Code | dsh-tui-vscode 现状 |
| --- | --- | --- |
| @-mention 路径 | 相对 workspace | 绝对路径(会话 cwd 不感知工作区) |
| 行区间 | `@path#L12-14` 受支持 | 仅 `L12-14` 纯文本提示,附加整文件 |
| 选区上下文 | 经 IPC 直接进对话(显示 N lines) | 无此通道,近似为「整文件附加+行号提示」 |
| 输入表面 | 原生面板 | 终端输入框(sendText 键入) |

差距源于 dsh-tui 的架构(会话 cwd 中心 + 无 IPC 选区上下文),而非扩展能力不足。

## 5. 未来计划:给 dsh-TUI 打补丁,对齐官方设计

目标:让 `@相对路径` 与行区间在 dsh-tui 中原生可用,扩展回归「相对路径 + 行区间」,
体验对齐 Claude Code 官方扩展。方向(以 RFC/Draft 提交到 `ccch1mneyyy/dsh-TUI`):

1. **相对路径基准**:让 @-mention 支持「工作区/调用方提供的根」——扩展把 workspace
   根经 stdin 初始提示 / 环境变量 / 轻量 IPC 传给 TUI;**改 `expandMentions` 的相对
   解析基准**(join 用「工作区根」而非仅 `state.cwd`,或按优先级回退)。
2. **行区间语法**:实现 `@路径#L12-14` / `#L12` 精确附加指定行(改文件读取路径,
   按行切片);文档、fixture、conformance 同步(spec 仓库
   `dsh-ecosystem-spec` 的 TUI-proposal 也可同步一条)。
3. **(可选)选区上下文通道**:为「N lines selected」提供标准注入点,供 web/tui 策略
   消费。
4. **补丁落地后**:本扩展的 `buildAtMention` 可从「绝对路径」切回「相对工作区路径 +
   #L 行区间」,绝对路径保留为兜底(仍合法)。

## 6. 验收(未来补丁)

- [ ] dsh-tui 解析 `@相对路径#L12-14`(或等价)并按行附加,越界/缺失明确提示;
- [ ] 相对路径基于「会话 cwd 或显式传入的工作区根」,跨盘/跨目录稳定;
- [ ] 扩展侧:相对路径 + 行区间为主,绝对路径兜底;快捷键/右键体验不变。
