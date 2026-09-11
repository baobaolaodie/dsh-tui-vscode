/**
 * 生成插入到 dsh-tui 输入框的 @-mention 引用。
 *
 * 基准行为对齐 Claude Code 官方 `insertAtMention`(行号 1-based),并按 dsh-tui
 * 的 @ 提及语义适配(dsh-TUI PR-A 起原生解析 `#L` 行区间):
 * - **优先输出工作区相对路径**:dsh-tui 解析 `@路径` 时,相对路径以「会话自己的
 *   cwd」为基准,而扩展启动的终端 cwd 即 VS Code 工作区根。因此调用方传入
 *   workspaceRoot 时把绝对路径相对化(`relativeToWorkspace`,大小写不敏感匹配、
 *   正斜杠归一化);根外或未传 workspaceRoot 时兜底绝对路径——dsh-tui 对绝对
 *   路径原样直通(`isAbsolute` → 不加 cwd),与 cwd 无关。
 * - **行区间**用 `#L` 后缀(1-based、含端点:单行 `#L12`,多行 `#L12-14`),
 *   空选区输出裸路径引用整个文件。旧的「空格分隔纯文本提示」(` L12-14`)形态
 *   已按 DESIGN D10 彻底移除,不做双格式兼容分支。
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
  /** 选区起始行(0-based,VS Code 语义)。 */
  startLine: number
  /** 选区结束行(0-based,VS Code 语义)。 */
  endLine: number
}

/**
 * 把路径相对化到工作区根;根外或未给根时兜底返回归一化后的原路径。
 * 匹配大小写不敏感(Windows 盘符/目录大小写漂移),结果保留路径原有大小写。
 */
export function relativeToWorkspace(path: string, workspaceRoot?: string): string {
  const normalized = normalizeMentionPath(path)
  if (!workspaceRoot) return normalized
  const root = normalizeMentionPath(workspaceRoot).replace(/\/+$/, '')
  const lowerPath = normalized.toLowerCase()
  const lowerRoot = root.toLowerCase()
  const relative =
    lowerPath === lowerRoot || !lowerPath.startsWith(`${lowerRoot}/`)
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
