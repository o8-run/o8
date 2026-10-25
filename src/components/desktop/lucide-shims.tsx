// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- CLI imports must also discover the ambient wildcard module.
/// <reference path="../../types/lucide-react.d.ts" />

'use client';

/**
 * Lucide icon shims — raw SVG renderer to bypass the Tauri webview rendering bug.
 * Each icon imports its __iconNode data array from lucide-react and renders
 * via a controlled <svg> path so we never invoke the broken lucide-react React
 * component tree.
 *
 * Public API matches lucide-react: <IconName size strokeWidth color className style />
 */

import { createElement, type ReactElement, type SVGProps } from 'react';

type IconNodeAttrs = Record<string, string | number>;
type IconNode = ReadonlyArray<readonly [string, IconNodeAttrs]>;

import { __iconNode as ActivityNode } from 'lucide-react/dist/esm/icons/activity.js';
import { __iconNode as AlertCircleNode } from 'lucide-react/dist/esm/icons/circle-alert.js';
import { __iconNode as AlertTriangleNode } from 'lucide-react/dist/esm/icons/triangle-alert.js';
import { __iconNode as ArchiveNode } from 'lucide-react/dist/esm/icons/archive.js';
import { __iconNode as ArrowDownNode } from 'lucide-react/dist/esm/icons/arrow-down.js';
import { __iconNode as ArrowRightNode } from 'lucide-react/dist/esm/icons/arrow-right.js';
import { __iconNode as ArrowUpNode } from 'lucide-react/dist/esm/icons/arrow-up.js';
import { __iconNode as BarChart3Node } from 'lucide-react/dist/esm/icons/chart-column.js';
import { __iconNode as BellNode } from 'lucide-react/dist/esm/icons/bell.js';
import { __iconNode as BellOffNode } from 'lucide-react/dist/esm/icons/bell-off.js';
import { __iconNode as BookOpenNode } from 'lucide-react/dist/esm/icons/book-open.js';
import { __iconNode as BookmarkNode } from 'lucide-react/dist/esm/icons/bookmark.js';
import { __iconNode as BrainNode } from 'lucide-react/dist/esm/icons/brain.js';
import { __iconNode as CheckNode } from 'lucide-react/dist/esm/icons/check.js';
import { __iconNode as CheckCircle2Node } from 'lucide-react/dist/esm/icons/circle-check.js';
import { __iconNode as ChevronDownNode } from 'lucide-react/dist/esm/icons/chevron-down.js';
import { __iconNode as ChevronRightNode } from 'lucide-react/dist/esm/icons/chevron-right.js';
import { __iconNode as ClipboardNode } from 'lucide-react/dist/esm/icons/clipboard.js';
import { __iconNode as ClockNode } from 'lucide-react/dist/esm/icons/clock.js';
import { __iconNode as CopyNode } from 'lucide-react/dist/esm/icons/copy.js';
import { __iconNode as CpuNode } from 'lucide-react/dist/esm/icons/cpu.js';
import { __iconNode as CrosshairNode } from 'lucide-react/dist/esm/icons/crosshair.js';
import { __iconNode as DollarSignNode } from 'lucide-react/dist/esm/icons/dollar-sign.js';
import { __iconNode as DownloadNode } from 'lucide-react/dist/esm/icons/download.js';
import { __iconNode as ExpandNode } from 'lucide-react/dist/esm/icons/expand.js';
import { __iconNode as ExternalLinkNode } from 'lucide-react/dist/esm/icons/external-link.js';
import { __iconNode as EyeNode } from 'lucide-react/dist/esm/icons/eye.js';
import { __iconNode as FileCodeNode } from 'lucide-react/dist/esm/icons/file-code.js';
import { __iconNode as FileCode2Node } from 'lucide-react/dist/esm/icons/file-code-corner.js';
import { __iconNode as FileEditNode } from 'lucide-react/dist/esm/icons/file-pen.js';
import { __iconNode as FileMinusNode } from 'lucide-react/dist/esm/icons/file-minus.js';
import { __iconNode as FilePlusNode } from 'lucide-react/dist/esm/icons/file-plus.js';
import { __iconNode as FileTextNode } from 'lucide-react/dist/esm/icons/file-text.js';
import { __iconNode as FolderNode } from 'lucide-react/dist/esm/icons/folder.js';
import { __iconNode as FolderOpenNode } from 'lucide-react/dist/esm/icons/folder-open.js';
import { __iconNode as GaugeNode } from 'lucide-react/dist/esm/icons/gauge.js';
import { __iconNode as GitBranchNode } from 'lucide-react/dist/esm/icons/git-branch.js';
import { __iconNode as GitCommitNode } from 'lucide-react/dist/esm/icons/git-commit-horizontal.js';
import { __iconNode as GitMergeNode } from 'lucide-react/dist/esm/icons/git-merge.js';
import { __iconNode as GitPullRequestNode } from 'lucide-react/dist/esm/icons/git-pull-request.js';
import { __iconNode as GitPullRequestDraftNode } from 'lucide-react/dist/esm/icons/git-pull-request-draft.js';
import { __iconNode as GlobeNode } from 'lucide-react/dist/esm/icons/globe.js';
import { __iconNode as HexagonNode } from 'lucide-react/dist/esm/icons/hexagon.js';
import { __iconNode as ImageNode } from 'lucide-react/dist/esm/icons/image.js';
import { __iconNode as KeyNode } from 'lucide-react/dist/esm/icons/key.js';
import { __iconNode as LayersNode } from 'lucide-react/dist/esm/icons/layers.js';
import { __iconNode as LayoutGridNode } from 'lucide-react/dist/esm/icons/layout-grid.js';
import { __iconNode as LightbulbNode } from 'lucide-react/dist/esm/icons/lightbulb.js';
import { __iconNode as Loader2Node } from 'lucide-react/dist/esm/icons/loader-circle.js';
import { __iconNode as MenuNode } from 'lucide-react/dist/esm/icons/menu.js';
import { __iconNode as MessageSquareNode } from 'lucide-react/dist/esm/icons/message-square.js';
import { __iconNode as MinusNode } from 'lucide-react/dist/esm/icons/minus.js';
import { __iconNode as MonitorNode } from 'lucide-react/dist/esm/icons/monitor.js';
import { __iconNode as MoreHorizontalNode } from 'lucide-react/dist/esm/icons/ellipsis.js';
import { __iconNode as PanelLeftCloseNode } from 'lucide-react/dist/esm/icons/panel-left-close.js';
import { __iconNode as PanelRightNode } from 'lucide-react/dist/esm/icons/panel-right.js';
import { __iconNode as PauseNode } from 'lucide-react/dist/esm/icons/pause.js';
import { __iconNode as PenLineNode } from 'lucide-react/dist/esm/icons/pen-line.js';
import { __iconNode as PencilNode } from 'lucide-react/dist/esm/icons/pencil.js';
import { __iconNode as PlayNode } from 'lucide-react/dist/esm/icons/play.js';
import { __iconNode as PlayCircleNode } from 'lucide-react/dist/esm/icons/circle-play.js';
import { __iconNode as PlusNode } from 'lucide-react/dist/esm/icons/plus.js';
import { __iconNode as RadioNode } from 'lucide-react/dist/esm/icons/radio.js';
import { __iconNode as RefreshCwNode } from 'lucide-react/dist/esm/icons/refresh-cw.js';
import { __iconNode as RotateCcwNode } from 'lucide-react/dist/esm/icons/rotate-ccw.js';
import { __iconNode as RotateCwNode } from 'lucide-react/dist/esm/icons/rotate-cw.js';
import { __iconNode as SearchNode } from 'lucide-react/dist/esm/icons/search.js';
import { __iconNode as SendNode } from 'lucide-react/dist/esm/icons/send.js';
import { __iconNode as Settings2Node } from 'lucide-react/dist/esm/icons/settings-2.js';
import { __iconNode as ShieldCheckNode } from 'lucide-react/dist/esm/icons/shield-check.js';
import { __iconNode as SlidersHorizontalNode } from 'lucide-react/dist/esm/icons/sliders-horizontal.js';
import { __iconNode as SmartphoneNode } from 'lucide-react/dist/esm/icons/smartphone.js';
import { __iconNode as SparklesNode } from 'lucide-react/dist/esm/icons/sparkles.js';
import { __iconNode as SquareNode } from 'lucide-react/dist/esm/icons/square.js';
import { __iconNode as StarNode } from 'lucide-react/dist/esm/icons/star.js';
import { __iconNode as TagNode } from 'lucide-react/dist/esm/icons/tag.js';
import { __iconNode as TerminalNode } from 'lucide-react/dist/esm/icons/terminal.js';
import { __iconNode as TerminalSquareNode } from 'lucide-react/dist/esm/icons/square-terminal.js';
import { __iconNode as ThumbsDownNode } from 'lucide-react/dist/esm/icons/thumbs-down.js';
import { __iconNode as ThumbsUpNode } from 'lucide-react/dist/esm/icons/thumbs-up.js';
import { __iconNode as Trash2Node } from 'lucide-react/dist/esm/icons/trash-2.js';
import { __iconNode as TrendingUpNode } from 'lucide-react/dist/esm/icons/trending-up.js';
import { __iconNode as Volume2Node } from 'lucide-react/dist/esm/icons/volume-2.js';
import { __iconNode as VolumeOffNode } from 'lucide-react/dist/esm/icons/volume-off.js';
import { __iconNode as WifiOffNode } from 'lucide-react/dist/esm/icons/wifi-off.js';
import { __iconNode as WrenchNode } from 'lucide-react/dist/esm/icons/wrench.js';
import { __iconNode as XNode } from 'lucide-react/dist/esm/icons/x.js';
import { __iconNode as XCircleNode } from 'lucide-react/dist/esm/icons/circle-x.js';
import { __iconNode as ZapNode } from 'lucide-react/dist/esm/icons/zap.js';
import { __iconNode as GithubNode } from 'lucide-react/dist/esm/icons/github.js';
import { __iconNode as LogOutNode } from 'lucide-react/dist/esm/icons/log-out.js';
import { __iconNode as CircleUserNode } from 'lucide-react/dist/esm/icons/circle-user.js';

export interface LucideProps extends Omit<SVGProps<SVGSVGElement>, "color"> {
  size?: number | string;
  strokeWidth?: number | string;
  color?: string;
  absoluteStrokeWidth?: boolean;
}

export type LucideIcon = (props: LucideProps) => ReactElement;

function makeIcon(node: IconNode, displayName: string): LucideIcon {
  const Icon = ({
    size = 24,
    color = "currentColor",
    strokeWidth = 2,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    ...rest
  }: LucideProps) => {
    void _absoluteStrokeWidth;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...rest}
      >
        {node.map(([tag, attrs], i) => createElement(tag, { ...attrs, key: typeof attrs.key === "string" ? attrs.key : i }))}
      </svg>
    );
  };
  Icon.displayName = displayName;
  return Icon;
}

export const Activity: LucideIcon = makeIcon(ActivityNode as IconNode, 'Activity');
export const AlertCircle: LucideIcon = makeIcon(AlertCircleNode as IconNode, 'AlertCircle');
export const AlertTriangle: LucideIcon = makeIcon(AlertTriangleNode as IconNode, 'AlertTriangle');
export const Archive: LucideIcon = makeIcon(ArchiveNode as IconNode, 'Archive');
export const ArrowDown: LucideIcon = makeIcon(ArrowDownNode as IconNode, 'ArrowDown');
export const ArrowRight: LucideIcon = makeIcon(ArrowRightNode as IconNode, 'ArrowRight');
export const ArrowUp: LucideIcon = makeIcon(ArrowUpNode as IconNode, 'ArrowUp');
export const BarChart3: LucideIcon = makeIcon(BarChart3Node as IconNode, 'BarChart3');
export const Bell: LucideIcon = makeIcon(BellNode as IconNode, 'Bell');
export const BellOff: LucideIcon = makeIcon(BellOffNode as IconNode, 'BellOff');
export const BookOpen: LucideIcon = makeIcon(BookOpenNode as IconNode, 'BookOpen');
export const Bookmark: LucideIcon = makeIcon(BookmarkNode as IconNode, 'Bookmark');
export const Brain: LucideIcon = makeIcon(BrainNode as IconNode, 'Brain');
export const Check: LucideIcon = makeIcon(CheckNode as IconNode, 'Check');
export const CheckCircle2: LucideIcon = makeIcon(CheckCircle2Node as IconNode, 'CheckCircle2');
export const ChevronDown: LucideIcon = makeIcon(ChevronDownNode as IconNode, 'ChevronDown');
export const ChevronRight: LucideIcon = makeIcon(ChevronRightNode as IconNode, 'ChevronRight');
export const Clipboard: LucideIcon = makeIcon(ClipboardNode as IconNode, 'Clipboard');
export const Clock: LucideIcon = makeIcon(ClockNode as IconNode, 'Clock');
export const Copy: LucideIcon = makeIcon(CopyNode as IconNode, 'Copy');
export const Cpu: LucideIcon = makeIcon(CpuNode as IconNode, 'Cpu');
export const Crosshair: LucideIcon = makeIcon(CrosshairNode as IconNode, 'Crosshair');
export const DollarSign: LucideIcon = makeIcon(DollarSignNode as IconNode, 'DollarSign');
export const Download: LucideIcon = makeIcon(DownloadNode as IconNode, 'Download');
export const Expand: LucideIcon = makeIcon(ExpandNode as IconNode, 'Expand');
export const ExternalLink: LucideIcon = makeIcon(ExternalLinkNode as IconNode, 'ExternalLink');
export const Eye: LucideIcon = makeIcon(EyeNode as IconNode, 'Eye');
export const FileCode: LucideIcon = makeIcon(FileCodeNode as IconNode, 'FileCode');
export const FileCode2: LucideIcon = makeIcon(FileCode2Node as IconNode, 'FileCode2');
export const FileEdit: LucideIcon = makeIcon(FileEditNode as IconNode, 'FileEdit');
export const FileMinus: LucideIcon = makeIcon(FileMinusNode as IconNode, 'FileMinus');
export const FilePlus: LucideIcon = makeIcon(FilePlusNode as IconNode, 'FilePlus');
export const FileText: LucideIcon = makeIcon(FileTextNode as IconNode, 'FileText');
export const Folder: LucideIcon = makeIcon(FolderNode as IconNode, 'Folder');
export const FolderOpen: LucideIcon = makeIcon(FolderOpenNode as IconNode, 'FolderOpen');
export const Gauge: LucideIcon = makeIcon(GaugeNode as IconNode, 'Gauge');
export const GitBranch: LucideIcon = makeIcon(GitBranchNode as IconNode, 'GitBranch');
export const GitCommit: LucideIcon = makeIcon(GitCommitNode as IconNode, 'GitCommit');
export const GitMerge: LucideIcon = makeIcon(GitMergeNode as IconNode, 'GitMerge');
export const GitPullRequest: LucideIcon = makeIcon(GitPullRequestNode as IconNode, 'GitPullRequest');
export const GitPullRequestDraft: LucideIcon = makeIcon(GitPullRequestDraftNode as IconNode, 'GitPullRequestDraft');
export const Globe: LucideIcon = makeIcon(GlobeNode as IconNode, 'Globe');
export const Hexagon: LucideIcon = makeIcon(HexagonNode as IconNode, 'Hexagon');
export const Image: LucideIcon = makeIcon(ImageNode as IconNode, 'Image');
export const Key: LucideIcon = makeIcon(KeyNode as IconNode, 'Key');
export const Layers: LucideIcon = makeIcon(LayersNode as IconNode, 'Layers');
export const LayoutGrid: LucideIcon = makeIcon(LayoutGridNode as IconNode, 'LayoutGrid');
export const Lightbulb: LucideIcon = makeIcon(LightbulbNode as IconNode, 'Lightbulb');
export const Loader2: LucideIcon = makeIcon(Loader2Node as IconNode, 'Loader2');
export const Menu: LucideIcon = makeIcon(MenuNode as IconNode, 'Menu');
export const MessageSquare: LucideIcon = makeIcon(MessageSquareNode as IconNode, 'MessageSquare');
export const Minus: LucideIcon = makeIcon(MinusNode as IconNode, 'Minus');
export const Monitor: LucideIcon = makeIcon(MonitorNode as IconNode, 'Monitor');
export const MoreHorizontal: LucideIcon = makeIcon(MoreHorizontalNode as IconNode, 'MoreHorizontal');
export const PanelLeftClose: LucideIcon = makeIcon(PanelLeftCloseNode as IconNode, 'PanelLeftClose');
export const PanelRight: LucideIcon = makeIcon(PanelRightNode as IconNode, 'PanelRight');
export const Pause: LucideIcon = makeIcon(PauseNode as IconNode, 'Pause');
export const PenLine: LucideIcon = makeIcon(PenLineNode as IconNode, 'PenLine');
export const Pencil: LucideIcon = makeIcon(PencilNode as IconNode, 'Pencil');
export const Play: LucideIcon = makeIcon(PlayNode as IconNode, 'Play');
export const PlayCircle: LucideIcon = makeIcon(PlayCircleNode as IconNode, 'PlayCircle');
export const Plus: LucideIcon = makeIcon(PlusNode as IconNode, 'Plus');
export const Radio: LucideIcon = makeIcon(RadioNode as IconNode, 'Radio');
export const RefreshCw: LucideIcon = makeIcon(RefreshCwNode as IconNode, 'RefreshCw');
export const RotateCcw: LucideIcon = makeIcon(RotateCcwNode as IconNode, 'RotateCcw');
export const RotateCw: LucideIcon = makeIcon(RotateCwNode as IconNode, 'RotateCw');
export const Search: LucideIcon = makeIcon(SearchNode as IconNode, 'Search');
export const Send: LucideIcon = makeIcon(SendNode as IconNode, 'Send');
export const Settings2: LucideIcon = makeIcon(Settings2Node as IconNode, 'Settings2');
export const ShieldCheck: LucideIcon = makeIcon(ShieldCheckNode as IconNode, 'ShieldCheck');
export const SlidersHorizontal: LucideIcon = makeIcon(SlidersHorizontalNode as IconNode, 'SlidersHorizontal');
export const Smartphone: LucideIcon = makeIcon(SmartphoneNode as IconNode, 'Smartphone');
export const Sparkles: LucideIcon = makeIcon(SparklesNode as IconNode, 'Sparkles');
export const Square: LucideIcon = makeIcon(SquareNode as IconNode, 'Square');
export const Star: LucideIcon = makeIcon(StarNode as IconNode, 'Star');
export const Tag: LucideIcon = makeIcon(TagNode as IconNode, 'Tag');
export const Terminal: LucideIcon = makeIcon(TerminalNode as IconNode, 'Terminal');
export const TerminalSquare: LucideIcon = makeIcon(TerminalSquareNode as IconNode, 'TerminalSquare');
export const ThumbsDown: LucideIcon = makeIcon(ThumbsDownNode as IconNode, 'ThumbsDown');
export const ThumbsUp: LucideIcon = makeIcon(ThumbsUpNode as IconNode, 'ThumbsUp');
export const Trash2: LucideIcon = makeIcon(Trash2Node as IconNode, 'Trash2');
export const TrendingUp: LucideIcon = makeIcon(TrendingUpNode as IconNode, 'TrendingUp');
export const Volume2: LucideIcon = makeIcon(Volume2Node as IconNode, 'Volume2');
export const VolumeOff: LucideIcon = makeIcon(VolumeOffNode as IconNode, 'VolumeOff');
export const WifiOff: LucideIcon = makeIcon(WifiOffNode as IconNode, 'WifiOff');
export const Wrench: LucideIcon = makeIcon(WrenchNode as IconNode, 'Wrench');
export const X: LucideIcon = makeIcon(XNode as IconNode, 'X');
export const XCircle: LucideIcon = makeIcon(XCircleNode as IconNode, 'XCircle');
export const Zap: LucideIcon = makeIcon(ZapNode as IconNode, 'Zap');
export const Github: LucideIcon = makeIcon(GithubNode as IconNode, 'Github');
export const LogOut: LucideIcon = makeIcon(LogOutNode as IconNode, 'LogOut');
export const CircleUser: LucideIcon = makeIcon(CircleUserNode as IconNode, 'CircleUser');
