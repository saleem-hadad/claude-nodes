import {
  Archive,
  BookOpen,
  BrushCleaning,
  Bug,
  Download,
  Eraser,
  FileText,
  Gauge,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Hammer,
  Lightbulb,
  ListChecks,
  MessageSquare,
  Package,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  TestTube,
  Upload,
  WandSparkles,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { DEFAULT_ACTION_ICON, isActionIcon, type ActionIcon as IconName } from '@shared/actions'

export const ACTION_ICON_COMPONENTS: Record<IconName, LucideIcon> = {
  zap: Zap,
  'refresh-cw': RefreshCw,
  'git-merge': GitMerge,
  'git-pull-request': GitPullRequest,
  'git-commit-horizontal': GitCommitHorizontal,
  upload: Upload,
  download: Download,
  archive: Archive,
  'brush-cleaning': BrushCleaning,
  eraser: Eraser,
  sparkles: Sparkles,
  'wand-sparkles': WandSparkles,
  'test-tube': TestTube,
  bug: Bug,
  rocket: Rocket,
  package: Package,
  'file-text': FileText,
  'book-open': BookOpen,
  'list-checks': ListChecks,
  search: Search,
  'shield-check': ShieldCheck,
  hammer: Hammer,
  'square-terminal': SquareTerminal,
  gauge: Gauge,
  lightbulb: Lightbulb,
  'message-square': MessageSquare
}

export function ActionIcon({ name, size = 15 }: { name: string; size?: number }) {
  const Icon = ACTION_ICON_COMPONENTS[isActionIcon(name) ? name : DEFAULT_ACTION_ICON]
  return <Icon size={size} strokeWidth={2} />
}
