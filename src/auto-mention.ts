/**
 * 选区变化自动引用的纯函数决策层——IDE 选区通道缺席时的键入回退路径。
 *
 * 背景:「编辑器选区自动进入会话上下文」需要扩展与终端程序之间的专用通道;
 * dsh-tui 是独立 TUI,没有该通道,`dsh-tui-vscode` 又只有 `terminal.sendText`
 * 一条输入通道,因此通道不可用时只能做「降级近似」:监听选区变化 → 防抖后把
 * `@相对路径#L起-止` 自动键入运行中的 dsh-tui 输入框。
 *
 * 因为这是实打实地往终端输入框敲字(不是独立的上下文注入),该回退路径必须
 * 克制:仅在有运行中会话时注入、对同一选区去重;本模块只做决策(是否插 /
 * 插什么),计时与实际 `sendText` 由 extension.ts 接线负责——决策保持纯函数,
 * 便于全量单测。
 */

import { buildAtMention, normalizeMentionPath } from './at-mention'

/** 一次编辑器选区事件的快照(0-based 行区间,**含端**——见 selectionLineRange)。 */
export interface SelectionSnapshot {
  /** 文件路径(尚未归一化,保持 as-is;决策时会用 normalizeMentionPath)。 */
  path: string
  /** 选区起始行(0-based)。 */
  startLine: number
  /** 选区最后一个被覆盖的行(0-based 含端)。 */
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
  /**
   * VS Code 工作区根(首个 workspaceFolder 的 fsPath,可缺省)。
   * 提供时引用输出为工作区相对路径(`@src/a.ts#L12-14`),与 dsh-tui 会话
   * cwd(即本扩展终端的工作区根)匹配;缺省时兜底绝对路径。
   */
  workspaceRoot?: string
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
  const mention = buildMentionForSnapshot(gates.snapshot, gates.workspaceRoot)
  if (gates.lastInserted !== undefined && gates.lastInserted === mention) {
    return { action: 'skip', reason: 'duplicate' }
  }
  return { action: 'insert', mention }
}

/** 由选区快照生成要键入的引用原文(归一化路径 + `@路径[#L起-止]`,根内相对化)。 */
export function buildMentionForSnapshot(
  snapshot: SelectionSnapshot,
  workspaceRoot?: string,
): string {
  return buildAtMention(
    normalizeMentionPath(snapshot.path),
    {
      isEmpty: false,
      startLine: snapshot.startLine,
      endLine: snapshot.endLine,
    },
    workspaceRoot,
  )
}

/**
 * 是否仍应把本次选区推给 IDE 通道(协议 v2 的推送路径)——与「是否往输入框
 * 敲字」分开判定。
 *
 * 两个只属于**键入回退**的门槛:
 * - 「与上次相同」(duplicate):推送是幂等的状态更新,不占输入框也不会刷屏。
 *   若拿它挡推送,两次行区间相同、正文不同的手势(整行选区按含端归一化后很
 *   常见:先把末尾拖到 (7,1),再拖成整行)就会停在**上一次**的正文上——徽标与
 *   transcript 指示行都按行数显示,屏幕上看不出差别。
 * - 「无终端」(no-terminal):敲字需要终端,推送不需要——手动启动(lock 扫描
 *   发现)的 dsh-tui 没有扩展自己创建的终端,却是一等订阅者。拿它挡推送会让
 *   该路径收不到任何非空选区,而空选区的清除通知又照常发出(两条路径自相矛盾)。
 * disabled / no-selection 才是真正的「不推」。
 */
export function shouldBroadcastSelection(outcome: AutoInsertOutcome): boolean {
  if (outcome.action === 'insert') return true
  return outcome.reason === 'duplicate' || outcome.reason === 'no-terminal'
}
