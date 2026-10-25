declare module 'lucide-react' {
  import * as React from 'react';

  export interface LucideProps extends React.SVGProps<SVGSVGElement> {
    size?: string | number;
    absoluteStrokeWidth?: boolean;
  }

  export type LucideIcon = React.ForwardRefExoticComponent<
    Omit<LucideProps, 'ref'> & React.RefAttributes<SVGSVGElement>
  >;

  export const Activity: LucideIcon;
  export const AlertCircle: LucideIcon;
  export const AlertTriangle: LucideIcon;
  export const ArrowDown: LucideIcon;
  export const ArrowRight: LucideIcon;
  export const ArrowUp: LucideIcon;
  export const BarChart3: LucideIcon;
  export const Bell: LucideIcon;
  export const BellOff: LucideIcon;
  export const BookOpen: LucideIcon;
  export const Bookmark: LucideIcon;
  export const Box: LucideIcon;
  export const Brain: LucideIcon;
  export const Cable: LucideIcon;
  export const Check: LucideIcon;
  export const CheckCircle2: LucideIcon;
  export const ChevronDown: LucideIcon;
  export const ChevronRight: LucideIcon;
  export const Clipboard: LucideIcon;
  export const Clock: LucideIcon;
  export const Copy: LucideIcon;
  export const Cpu: LucideIcon;
  export const Crosshair: LucideIcon;
  export const Database: LucideIcon;
  export const DollarSign: LucideIcon;
  export const Download: LucideIcon;
  export const Expand: LucideIcon;
  export const ExternalLink: LucideIcon;
  export const Eye: LucideIcon;
  export const FileCode: LucideIcon;
  export const FileCode2: LucideIcon;
  export const FileDiff: LucideIcon;
  export const FileEdit: LucideIcon;
  export const FileMinus: LucideIcon;
  export const FilePlus: LucideIcon;
  export const FileText: LucideIcon;
  export const Folder: LucideIcon;
  export const FolderOpen: LucideIcon;
  export const Gauge: LucideIcon;
  export const GitBranch: LucideIcon;
  export const GitCommit: LucideIcon;
  export const GitMerge: LucideIcon;
  export const GitPullRequest: LucideIcon;
  export const GitPullRequestDraft: LucideIcon;
  export const Globe: LucideIcon;
  export const HardDrive: LucideIcon;
  export const Hexagon: LucideIcon;
  export const History: LucideIcon;
  export const Image: LucideIcon;
  export const Key: LucideIcon;
  export const Layers: LucideIcon;
  export const Lightbulb: LucideIcon;
  export const Loader2: LucideIcon;
  export const MessageSquare: LucideIcon;
  export const Minus: LucideIcon;
  export const Monitor: LucideIcon;
  export const MoreHorizontal: LucideIcon;
  export const PanelLeftClose: LucideIcon;
  export const PanelRight: LucideIcon;
  export const Pause: LucideIcon;
  export const PenLine: LucideIcon;
  export const Pencil: LucideIcon;
  export const Play: LucideIcon;
  export const PlayCircle: LucideIcon;
  export const Plus: LucideIcon;
  export const Radio: LucideIcon;
  export const RefreshCw: LucideIcon;
  export const RotateCcw: LucideIcon;
  export const RotateCw: LucideIcon;
  export const Scissors: LucideIcon;
  export const Search: LucideIcon;
  export const Send: LucideIcon;
  export const Settings: LucideIcon;
  export const Settings2: LucideIcon;
  export const ShieldCheck: LucideIcon;
  export const SlidersHorizontal: LucideIcon;
  export const Sparkles: LucideIcon;
  export const Square: LucideIcon;
  export const Star: LucideIcon;
  export const Tag: LucideIcon;
  export const Terminal: LucideIcon;
  export const TerminalSquare: LucideIcon;
  export const ThumbsDown: LucideIcon;
  export const ThumbsUp: LucideIcon;
  export const Trash2: LucideIcon;
  export const TrendingUp: LucideIcon;
  export const Users: LucideIcon;
  export const Volume2: LucideIcon;
  export const VolumeOff: LucideIcon;
  export const Wifi: LucideIcon;
  export const WifiOff: LucideIcon;
  export const Wrench: LucideIcon;
  export const X: LucideIcon;
  export const XCircle: LucideIcon;
  export const Zap: LucideIcon;
}

// Subpath modules used by the lucide-shims raw-SVG renderer.
// Each icon file exports an __iconNode data array we render manually
// to bypass the Tauri webview rendering bug in the lucide React components.
declare module 'lucide-react/dist/esm/icons/*.js' {
  export const __iconNode: import('lucide-react/dist/lucide-react').IconNode;
}
