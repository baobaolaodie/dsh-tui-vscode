/**
 * 生成插入到 dsh-tui 输入框的 @-mention 引用。
 *
 * 基准算法沿用 Claude Code 官方 `insertAtMention`(行号 1-based),但做了
 * dsh-tui 适配:
 * - **dsh-tui 解析 `@路径` 时,相对路径以「会话自己的 cwd」为基准**,不认 VS Code
 *   工作区(实测=弹「未找到引用」)。因此调用方应传入 **归一化为正斜杠的绝对路径**
 *   (`normalizeMentionPath`),dsh-tui 对绝对路径原样直通(`isAbsolute` → 不加 cwd)。
 * - **dsh-tui 不认 `#L` 行区间**(`@路径#L12-14` 会被整体当文件名),因此 `@` token
 *   止于路径本身:提交时 dsh-tui 附加**整个文件**。
 * - **行区间**退化为空格分隔的纯文本提示(`L12` / `L12-14`),供模型聚焦,不会被
 *   `extractMentions` 误解析。
 * - 路径含空白时用双引号形式 `@"路径"`(dsh-tui 的 extractMentions 支持)。
 * - 未选中时引用整个文件。
 *
 * 输出形态:
 * - 未选中:   `@D:/repo/src/a.ts`
 * - 单行:     `@D:/repo/src/a.ts L12`
 * - 多行:     `@D:/repo/src/a.ts L12-14`
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

/** 把编辑器选区映射为 dsh-tui 可用的 `@路径[ L起-止]` 引用字符串(路径建议传绝对路径)。 */
export function buildAtMention(path: string, selection: MentionSelection): string {
  const reference = /\s/.test(path) ? `@"${path}"` : `@${path}`
  if (selection.isEmpty) return reference
  const start = selection.startLine + 1 // 1-based
  const end = selection.endLine + 1
  const range = start !== end ? `L${start}-${end}` : `L${start}`
  return `${reference} ${range}`
}