/**
 * 生成插入到 dsh-tui 输入框的 @-mention 引用。
 *
 * 算法与 Claude Code 官方 VS Code 扩展 `claude-code.insertAtMentioned` /
 * `claude-vscode.insertAtMention` 完全一致:
 * - 未选中:    `@相对路径`(引用整个文件)
 * - 单行:      `@相对路径#L12`
 * - 多行:      `@相对路径#L12-14`(行号 1-based)
 *
 * dsh-tui 原生支持 `@` 文件引用:发送消息时会把引用文件的内容自动附加到消息中。
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

/** 把编辑器选区映射为 `@相对路径#L起-止` 引用字符串。 */
export function buildAtMention(relativePath: string, selection: MentionSelection): string {
  if (selection.isEmpty) return `@${relativePath}`
  const start = selection.startLine + 1 // 1-based,与官方实现一致
  const end = selection.endLine + 1
  return start !== end ? `@${relativePath}#L${start}-${end}` : `@${relativePath}#L${start}`
}