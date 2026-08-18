/**
 * 生成插入到 dsh-tui 输入框的 @-mention 引用。
 *
 * 基准算法沿用 Claude Code 官方 `insertAtMention`(行号 1-based),但做了
 * dsh-tui 适配:
 * - **dsh-tui 的 `@` 提及不认 `#L` 行区间**(`@路径#L12-14` 会被整体当文件名,
 *   提交时弹「未找到引用」),因此 `@` token 只到相对路径:提交时 dsh-tui 会把
 *   整个文件的内容附加到消息。
 * - **行区间**退化为空格分隔的纯文本提示(`L12` / `L12-14`)附在 `@` 引用之后,
 *   供模型聚焦;不会被 `extractMentions` 误解析。
 * - 未选中时引用整个文件:`@相对路径`。
 *
 * 输出形态:
 * - 未选中:   `@src/a.ts`
 * - 单行:     `@src/a.ts L12`
 * - 多行:     `@src/a.ts L12-14`
 *
 * 纯函数,不依赖 vscode,可直接单测。
 */

export interface MentionSelection {
  /** 选区是否为空(光标未选中任何文本)。为空时引用整个文件。 */
  isEmpty: boolean
  /** 选区起始行(0-based,VS Code 语义)。 */
  startLine: number
  /** 选区结束行(0-based,VS Code 语义)。 */
  endLine: number
}

/** 把编辑器选区映射为 dsh-tui 可用的 `@相对路径[ L起-止]` 引用字符串。 */
export function buildAtMention(relativePath: string, selection: MentionSelection): string {
  if (selection.isEmpty) return `@${relativePath}`
  const start = selection.startLine + 1 // 1-based
  const end = selection.endLine + 1
  const range = start !== end ? `L${start}-${end}` : `L${start}`
  return `@${relativePath} ${range}`
}