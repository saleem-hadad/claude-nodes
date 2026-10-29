// Shared by the main process, which asks Claude to pick an action's icon, and
// the renderer, which draws it.

/** Icons an action can have, by lucide name. The renderer maps each to its component. */
export const ACTION_ICONS = [
  'zap',
  'refresh-cw',
  'git-merge',
  'git-pull-request',
  'git-commit-horizontal',
  'upload',
  'download',
  'archive',
  'brush-cleaning',
  'eraser',
  'sparkles',
  'wand-sparkles',
  'test-tube',
  'bug',
  'rocket',
  'package',
  'file-text',
  'book-open',
  'list-checks',
  'search',
  'shield-check',
  'hammer',
  'square-terminal',
  'gauge',
  'lightbulb',
  'message-square'
] as const

export type ActionIcon = (typeof ACTION_ICONS)[number]

export const DEFAULT_ACTION_ICON: ActionIcon = 'zap'

export function isActionIcon(name: unknown): name is ActionIcon {
  return typeof name === 'string' && (ACTION_ICONS as readonly string[]).includes(name)
}
