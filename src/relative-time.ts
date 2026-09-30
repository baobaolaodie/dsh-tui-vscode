/**
 * Compact relative time, Claude Code style: just now / 12m / 3h / 2d.
 *
 * Pure module (ADR-004): no host/runtime imports, so it can be unit tested
 * without an editor process. The sub-minute bucket returns the English key
 * "just now"; the view layer wraps the result with the host l10n helper so
 * the wording can be translated, while numeric units stay language-neutral.
 */
const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24

export function relativeTime(epochMs: number, now: number = Date.now()): string {
  const diff = now - epochMs
  const minutes = Math.floor(diff / MS_PER_MINUTE)
  if (minutes < 1) return 'just now'
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  if (hours < HOURS_PER_DAY) return `${hours}h`
  return `${Math.floor(hours / HOURS_PER_DAY)}d`
}
