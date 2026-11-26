import type { DecorationOptions, DecorationRenderOptions, Range } from 'vscode'

/** Per-range attachments belong inside renderOptions, not at the top level. */
export function deletedTextDecoration(
  range: Range,
  before: NonNullable<DecorationRenderOptions['before']>,
): DecorationOptions {
  return { range, renderOptions: { before } }
}
