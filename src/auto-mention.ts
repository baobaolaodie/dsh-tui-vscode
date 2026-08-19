/**
 * 选区变化自动引用(experimental)的纯函数决策层。
 *
 * 背景:Claude Code 官方「编辑器选区自动出现在会话引用」在 webview 与终端模式
 * 都走 `~/.claude/ide` WebSocket(`selection_changed`)通道,由 CLI 消费后显示。
 * dsh-tui 是独立 TUI,不消费该通道,`dsh-tui-vscode` 又只有 `terminal.sendText`
 * 一条输入通道,因此只能做「降级近似」:监听选区变化 → 防抖后把
 * `@绝对路径 L起-止` 自动键入运行中的 dsh-tui 输入框。
 *
 * 因为这是实打实地往终端输入框敲字(不是官方那种"更新上下文标记"),
 * 默认**关闭**,需用户在设置里显式开启;本模块只做决策(是否插 / 插什么),
 * 计时与实际 `sendText` 由 extension.ts 接线负责——决策保持纯函数,便于全量单测。
 */

import { buildAtMention, normalizeMentionPath } from './at-mention'

/** 一次编辑器选区事件的快照(0-based 行号,VS Code 语义)。 */
export interface SelectionSnapshot {
  /** 文件路径(尚未归一化,保持 as-is;决策时会用 normalizeMentionPath)。 */
  path: string
  /** 选区起始行(0-based)。 */
  startLine: number
  /** 选区结束行(0-based)。 */
  endLine: number
}

export interface AutoMentionGates {
  /** dsh-tui-vscode.autoInsertMention(experimental)是否开启。 */
  enabled: boolean
  /** 编辑器当前是否有非空选区。 */
  hasSelection: boolean
  /** 是否存在运行中的 DeepSeek 终端(dsh-tui 会话)。 */
  hasTerminal: boolean
  /** 本次选区快照。 */
  snapshot: SelectionSnapshot
  /** 上一次真正注入过的引用原文(用于去重)。 */
  lastInserted: string | undefined
}

export type AutoInsertOutcome =
  | { action: 'skip'; reason: 'disabled' | 'no-selection' | 'no-terminal' | 'duplicate' }
  | { action: 'insert'; mention: string }

/**
 * 决策:这次选区事件是否应触发一次自动引用注入。
 *
 * 门控顺序:开关 → 有选区 → 有运行中会话 → 与上次注入去重。
 * 只要满足任一门控就返回 skip;否则返回 insert + 注入原文。
 * 防抖窗口不在本函数处理(由调用方在两次 insert 之间用 setTimeout 收敛)。
 */
export function decideAutoInsert(gates: AutoMentionGates): AutoInsertOutcome {
  if (!gates.enabled) return { action: 'skip', reason: 'disabled' }
  if (!gates.hasSelection) return { action: 'skip', reason: 'no-selection' }
  if (!gates.hasTerminal) return { action: 'skip', reason: 'no-terminal' }
  const mention = buildMentionForSnapshot(gates.snapshot)
  if (gates.lastInserted !== undefined && gates.lastInserted === mention) {
    return { action: 'skip', reason: 'duplicate' }
  }
  return { action: 'insert', mention }
}

/** 由选区快照生成要键入的引用原文(归一化路径 + `@绝对路径 L起-止`)。 */
export function buildMentionForSnapshot(snapshot: SelectionSnapshot): string {
  return buildAtMention(normalizeMentionPath(snapshot.path), {
    isEmpty: false,
    startLine: snapshot.startLine,
    endLine: snapshot.endLine,
  })
}
