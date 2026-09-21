/**
 * 生成插入到 dsh-tui 输入框的 @-mention 引用。
 *
 * 基准行为对齐 Claude Code 官方 `insertAtMention`(行号 1-based),并按 dsh-tui
 * 的 @ 提及语义适配(dsh-TUI 原生解析 `#L` 行区间):
 * - **优先输出工作区相对路径**:dsh-tui 解析 `@路径` 时,相对路径以「会话自己的
 *   cwd」为基准,而扩展启动的终端 cwd 即 VS Code 工作区根。因此调用方传入
 *   workspaceRoot 时把绝对路径相对化(`relativeToWorkspace`,大小写不敏感匹配、
 *   正斜杠归一化);根外或未传 workspaceRoot 时兜底绝对路径——dsh-tui 对绝对
 *   路径原样直通(`isAbsolute` → 不加 cwd),与 cwd 无关。
 * - **行区间**用 `#L` 后缀(1-based、含端点:单行 `#L12`,多行 `#L12-14`),
 *   空选区输出裸路径引用整个文件。旧的「空格分隔纯文本提示」(` L12-14`)形态
 *   已按上游新的 `#L` 语法彻底移除,不做双格式兼容分支。
 * - 路径含空白时用双引号形式 `@"路径"`(#L 后缀紧邻闭合引号,dsh-tui 可解析)。
 *
 * 输出形态(workspaceRoot = D:/repo):
 * - 未选中:   @src/a.ts
 * - 单行:     @src/a.ts#L12
 * - 多行:     @src/a.ts#L12-14
 * - 根外兜底: @D:/other/b.ts#L4-6
 *
 * 纯函数,不依赖 vscode,可直接单测。
 */

/** 把平台 fsPath 归一化为正斜杠:dsh-tui 的 @ 提及与模型侧 fs 都按 `/` 处理最稳。 */
export function normalizeMentionPath(fsPath: string): string {
  return fsPath.replace(/\\/g, '/')
}

export interface MentionSelection {
  /** 选区是否为空(光标未选中任何文本)。为空时引用整个文件。 */
  isEmpty: boolean
  /** 选区起始行(0-based)。 */
  startLine: number
  /** 选区最后一个被覆盖的行(0-based **含端**)——由 `selectionLineRange` 从
   *  VS Code 选区归一化而来,不是 `selection.end.line`(整行选区时后者大 1)。 */
  endLine: number
}

/**
 * 路径比较是否忽略大小写:Windows 与 macOS 的文件系统默认不区分大小写
 * (盘符/目录大小写漂移),Linux 区分。
 *
 * 早先的实现是**无条件**小写化,与「为 Windows 漂移而做」的本意不符:在
 * 区分大小写的系统上,`/work/Repo/a.ts` 会被当成 `/work/repo` 工作区内的
 * 文件,产出 `@a.ts#L…`——TUI 以会话 cwd 解析它,指向的是另一个文件
 * (issue #21 第 3 条)。判定与上游 dsh-TUI 的 platformCaseInsensitive 一致。
 */
function platformCaseInsensitive(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

/**
 * 把路径相对化到工作区根;根外或未给根时兜底返回归一化后的原路径。
 * 匹配是否忽略大小写由平台决定(见 {@link platformCaseInsensitive}),结果
 * 一律保留路径原有大小写。`caseInsensitive` 可注入,便于在单一平台上把两个
 * 分支都测到。
 */
export function relativeToWorkspace(
  path: string,
  workspaceRoot?: string,
  caseInsensitive: boolean = platformCaseInsensitive(),
): string {
  const normalized = normalizeMentionPath(path)
  if (!workspaceRoot) return normalized
  const root = normalizeMentionPath(workspaceRoot).replace(/\/+$/, '')
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value)
  const matchPath = fold(normalized)
  const matchRoot = fold(root)
  const relative =
    matchPath === matchRoot || !matchPath.startsWith(`${matchRoot}/`)
      ? undefined
      : normalized.slice(root.length + 1)
  // 恰好等于根本身没有可引用的相对形态,兜底绝对路径。
  return relative === undefined || relative === '' ? normalized : relative
}

/** 把编辑器选区映射为 dsh-tui 可用的 `@路径[#L起[-止]]` 引用字符串。 */
export function buildAtMention(
  path: string,
  selection: MentionSelection,
  workspaceRoot?: string,
): string {
  const mentionPath = relativeToWorkspace(path, workspaceRoot)
  const reference = /\s/.test(mentionPath) ? `@"${mentionPath}"` : `@${mentionPath}`
  if (selection.isEmpty) return reference
  const start = selection.startLine + 1 // 1-based
  const end = selection.endLine + 1
  const range = start !== end ? `#L${start}-${end}` : `#L${start}`
  return `${reference}${range}`
}
