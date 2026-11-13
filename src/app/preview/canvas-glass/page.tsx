'use client';

/**
 * /preview/canvas-glass — the Canvas-mode material + motion test page (#1232).
 *
 * Purpose: nail the glass and the design language BEFORE the real shell
 * revamp. Anatomy (all mock — no backend, no dispatch):
 *
 *   - top dock        → the important header controls (NOT Symon — Symon
 *                       lives in the macOS dock above everything) + the
 *                       orchestrator-dock toggle
 *   - left spawn dock → spawn component cards: orchestrator packet,
 *                       browser, terminal, review/diff, o8.md notes
 *   - left/right edge → hover-reveal rails (sessions / activity)
 *   - bottom input    → the orchestrator composer for the scoped repo;
 *                       first contact ALWAYS happens here
 *   - right dock      → OPT-IN: dock the
 *                       conversation after you've talked, or open it to
 *                       see every running orchestrator and switch lanes.
 *                       Fades into the canvas — no hard panel.
 *   - glass cards     → draggable component cards; drop an image anywhere
 *                       and it piles "in the back" (desktop-on-desktop)
 *
 * In the o8 app the window swaps to the operator's chosen native material
 * (set_canvas_material) and the page paints NOTHING behind the glass —
 * the real desktop reads through ("Liquid" = raw transparent, sharpest).
 * In a plain browser the diffusion backdrop stands in for the desktop.
 * Gated on the experimentalCanvas operator flag like every canvas surface.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import {
  CANVAS_GLASS_DEFAULTS,
  applyCanvasGlassSettings,
  readCanvasGlassSettings,
  readPersonalDefault,
  savePersonalDefault,
  writeCanvasGlassSettings,
  type CanvasGlassSettings,
} from '@/lib/canvas-mode/glass-settings';
import { useExperimentalCanvasFlag } from '@/lib/operator/use-experimental-canvas';
import { checkAliveSessions } from '@/lib/terminal/tab-state';
import { RealtimeVoiceHost } from '@/components/desktop/dictation/RealtimeVoiceHost';
import { isTauri, onFileOpenRequest, setCanvasBackdropBlur, setCanvasMaterial, symonSpeakStatus, takePendingFileOpens } from '@/lib/tauri/bridge';
import { useDesktopWebSocket } from '@/components/desktop/hooks/useDesktopWebSocket';
import { ComposerDictationContext, useComposerDictation } from '@/components/desktop/dictation/ComposerDictation';
import { MicButton } from '@/components/desktop/thoughts/MicButton';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { DEFAULT_ORCHESTRATOR_MODEL } from '@/components/desktop/thoughts/use-orchestrator-stream/shared';
import { THINKING_EFFORTS, isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { spawnCanvasCard } from './canvas-card-state';
import { chromeRectsCanvas } from './chrome-rects';
import type { GridItem, Slot } from './form-fit';
import { NavigatorLoupe } from './navigator-loupe';
import { ORB_DEFAULTS, readOrbSettings, writeOrbSettings, type OrbSettings } from './orb-settings';
import { CanvasBackdropLayer } from './backdrops';
import type { SnapGeometry } from './canvas-persistence';
import type { DiffCard } from './diff-card';
import { CanvasCard } from './cards';
import { DiffusionBackdrop, DockGlyphButton, EdgeRail, SpawnGlyphButton } from './chrome';
import { CanvasFeedbackButton } from './canvas-feedback';
import { ProximityDock } from './proximity-dock';
import { AnticipationRing } from './anticipation-ring';
import { ComposerPartialsFill, useAgentPartialsMorph } from './agent-partials-morph';
import { OrchestratorDock } from './dock';
import type { SwarmScoutView } from '@/components/desktop/thoughts/chat-panel/SwarmStatusCard';
import { getMedia } from './canvas-media-store';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import type { TermCard } from './terminal-card';
import { TunerPanel } from './tuner';
import { WelcomeModal } from './welcome-modal';
import { ShareBetaModal } from './share-beta';
import { CanvasTour } from './canvas-tour';
import { useCanvasOrchestrator, type CanvasThreadEvent } from './use-canvas-orchestrator';
import { useSendBuffer, UndoSendPill, QueuedSends, SEND_UNDO_GRACE_MS, type ComposerImage } from './use-send-buffer';
import { DispatchDock, phaseFor, type DispatchLane } from './dispatch-dock';
import { emptyTurnTools, recordTool, recordToolResult, synthesizeResultEntries, type TurnTools } from './result-cards';
import { CARD_ENTRANCE, FONT, TONE_DOT, canvasZoom, glass, glassPop, relAge, type DockEntry, type MockCard, type NewDockEntry, type CanvasThreadRow, type OrchestratorLane } from './ui';
import { SymonVoicePresencePill } from './symon-voice-presence';
import { useCanvasQuickActions } from './use-canvas-quick-actions';
import { useCanvasMediaLifecycle } from './use-canvas-media-lifecycle';
import { CanvasCardLayers } from './canvas-card-layers';
import { useCanvasMediaSpawners } from './use-canvas-media-spawners';
import { useCanvasSpawners, type LaneRow, type SpawnChoreography, type SpawnReservation } from './use-canvas-spawners';
import { useCanvasCards } from './use-canvas-cards';
import { useCanvasSnapshot } from './use-canvas-snapshot';
import { useCanvasChatCards } from './use-canvas-chat-cards';
import { useCanvasGrid } from './use-canvas-grid';
import { useCanvasIntentBus } from './use-canvas-intent-bus';
import { ChipButton, DrawerLabel, ModeGlyph, ModeRow, PickerRow } from './canvas-composer-controls';
import { clearCanvasTurnAccumulators, setCanvasConversation, updateCanvasConversation } from './canvas-conversation-retention';
import { CanvasSearchOverlay } from './canvas-search';
import { CanvasCommandPalette } from './canvas-command-palette';
import {
  CANVAS_FIT_ZOOM, CANVAS_ZOOM_STEPS as ZOOM_STEPS,
  useCanvasZoomHotkeys,
  type CanvasCardKind,
} from './canvas-commands';
import { capCanvasReadContent, canvasCardTitle, dockEntryReadLine, type CanvasCardLite } from './canvas-card-intents';
import { useUiLoopProofCardSpawner } from './proof-card';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
/** Live rows for the wired chrome — inbox items, active lanes, commits. */
interface InboxRow {
  id: string;
  title: string;
  detail?: string | null;
  severity?: string | null;
  kind?: string | null;
}
interface CommitRow {
  hash: string;
  message: string;
  date: string;
}

/** Terminal glass veil — persisted while Q dials it in (dev tuner). */
const TERM_VEIL_KEY = 'o8:canvas-term-veil';
const TERM_VEIL_DEFAULT = 0.35;

function readTermVeil(): number {
  if (typeof window === 'undefined') return TERM_VEIL_DEFAULT;
  try {
    const raw = window.localStorage.getItem(TERM_VEIL_KEY);
    const parsed = raw === null ? Number.NaN : Number.parseFloat(raw);
    return Number.isFinite(parsed) ? Math.min(0.85, Math.max(0, parsed)) : TERM_VEIL_DEFAULT;
  } catch {
    return TERM_VEIL_DEFAULT;
  }
}

interface RepoPickerRowData {
  name: string;
  path: string;
  project: string | null;
}

/** Mini zoom — fixed steps, zoom OUT only. Just breathing room around the
 *  cards, not a camera. 100% is the operator's tuned default view (the look
 *  that used to sit at the old 70% step); 85% and 70% scale OUT from there.
 *  Label and actual CSS-zoom are decoupled — `label` is what the chip reads,
 *  `value` is what `--cnv-zoom` carries for the pointer math. Persisted. */
const ZOOM_KEY = 'o8:canvas-zoom';
/** Canvas layout mode — 'grid' = form-fit hard placement (#1239), else free-flow. */
/** Navigator loupe size (#1281) — operator-adjustable via the canvas tuner.
 *  A standalone pref (mirrors ZOOM_KEY/GRID_MODE_KEY) so glass presets don't
 *  resize it. The old hardcoded value was 160. */
const LOUPE_SIZE_KEY = 'o8:canvas-loupe-size';
const LOUPE_SIZE_DEFAULT = 160;
const LOUPE_SIZE_RANGE = { min: 120, max: 240, step: 4 };
// Module-scope so the intent listener's deps stay stable. The card verbs let an
// agent drive the canvas the way a human can: SEE every card (list), then move
// / resize / focus / close one by (kind, id).
type CanvasToast = { id: number; message: string; tone: 'error' | 'info' | 'success' };

// Account dossier (the Clerk sign-in popover) — one row vocabulary shared by
// Manage account / Sign out / Sign in, matching the operator's reference.
const DOSSIER_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  paddingTop: 7,
  paddingBottom: 7,
  paddingLeft: 6,
  paddingRight: 8,
  borderRadius: 10,
  borderWidth: 0,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: FONT,
  fontSize: 12.5,
  fontWeight: 400,
  letterSpacing: '-0.1px',
  color: 'var(--cnv-ink)',
  textAlign: 'left',
  width: '100%',
};
const DOSSIER_TILE: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 9,
  flexShrink: 0,
  background: 'var(--cnv-tint)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--cnv-ink-muted)',
};

// Mirrors COMPOSER_MODEL_OPTIONS in thoughts/InputButtons.tsx (not exported).
const CANVAS_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
];
const CANVAS_MODEL_KEY = 'o8:canvas-model';
const CANVAS_EFFORT_KEY = 'o8:canvas-effort';
const CANVAS_MODE_KEY = 'o8:canvas-mode';
/** Pre-rename keys — read-only fallback so a saved canvas survives the rename. */
const LEGACY_CANVAS_KEYS: Record<string, string> = {
  [CANVAS_MODEL_KEY]: 'o8:canvas-model',
  [CANVAS_EFFORT_KEY]: 'o8:canvas-effort',
  [CANVAS_MODE_KEY]: 'o8:canvas-mode',
};
const readCanvasSetting = (key: string): string | null => {
  const legacy = LEGACY_CANVAS_KEYS[key];
  return window.localStorage.getItem(key) ?? (legacy ? window.localStorage.getItem(legacy) : null);
};
/** First-run welcome modal — set once the operator dismisses the hero. */
const CANVAS_WELCOME_KEY = 'o8:canvas-welcome-seen';
/** Guided coach-mark tour — set once the operator finishes or skips it. */
const CANVAS_TOUR_KEY = 'o8:canvas-tour-seen';

/** How the canvas orchestrator runs a turn — mirrors the default composer's
 *  MODE chip so the operator can keep it from spawning Codex workers at all.
 *   - fleet   — orchestrator dispatches sub-agents in worktrees (default).
 *   - single  — talk to the orchestrator solo, no dispatch.
 *   - fusion  — the deep parallel, cross-verified multi-agent pass. */
type CanvasMode = OrchestratorExecutionMode;
const CANVAS_MODES: Array<{ id: CanvasMode; title: string; detail: string }> = [
  { id: 'fleet', title: 'Fleet orchestration', detail: 'Orchestrator dispatches sub-agents in worktrees.' },
  { id: 'single', title: 'Single agent', detail: 'Talk to the orchestrator solo · no dispatch.' },
  { id: 'fusion', title: 'Fusion', detail: 'Deep multi-agent pass · parallel agents, cross-verified.' },
];

/** Pickers pop out only as tall as the spawn rail (7 glyph buttons) and
 *  centered like it — not the full window height. Mirrors the rail's measured
 *  height; centering uses top:50% + marginTop so framer keeps the transform. */
const RAIL_PANEL_HEIGHT = 296;

/** Dock-matched Lisse panel surface — the dock's solid blur, no border, so a
 *  panel wrapped in <SmoothCorners> reads as the same family as the
 *  orchestrator dock (just thinner). Shared by the Review + Sessions pickers. */
const LISSE_PANEL_SURFACE = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--cnv-tint-deep)',
  backdropFilter: 'blur(var(--cnv-frost)) saturate(var(--cnv-sat, 1.6))',
  WebkitBackdropFilter: 'blur(var(--cnv-frost)) saturate(var(--cnv-sat, 1.6))',
  boxShadow: '0 14px 42px rgba(0, 0, 0, 0.22)',
  color: 'var(--cnv-ink)',
} as React.CSSProperties;

/** Home-dir agents (#1244): an all-local agent CLI spawned in $HOME as its own
 *  canvas card — no repo, worktree, dispatch, or merge governance. Reuses the
 *  terminal-in-~ PTY path; the chosen `command` is sent to the shell on attach.
 *  opencode is intentionally omitted (experimentalOpencode-gated elsewhere). */
const HOME_AGENTS: { id: string; label: string; command: string }[] = [
  { id: 'claude', label: 'Claude', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini' },
];

export default function CanvasGlassPreviewPage() {
  const canvasEnabled = useExperimentalCanvasFlag();
  const [settings, setSettings] = useState<CanvasGlassSettings>(CANVAS_GLASS_DEFAULTS);
  const [cards, setCards] = useState<MockCard[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  // Form-fit "hard placement" mode (#1239) — cards pack into a viewport-filling
  // grid. Free-flow is the default. winSize re-grids the layout on resize.
  const [gridMode, setGridMode] = useState(false);
  const [winSize, setWinSize] = useState({ w: 1600, h: 900 });
  // Infinite-canvas pan (#1239 Phase 2) — view offset in canvas px. Free mode
  // only; grid mode resets it to origin and packs to the viewport.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Live mirror of pan for the placement helpers (findFreeSpot / grid), which run
  // off refs so their identity stays stable — reading pan directly would churn
  // every callback that depends on them on each scroll frame.
  const panRef = useRef(pan);
  const panTweenRef = useRef<number | null>(null);
  const [composerValue, setComposerValue] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [inTauri, setInTauri] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  // Whether the bottom-center DispatchDock agents tray is expanded (owned here so
  // the grid can re-reserve space for the taller tray — see the re-grid effect).
  const [dockTrayExpanded, setDockTrayExpanded] = useState(false);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [orbSettings, setOrbSettings] = useState<OrbSettings>(ORB_DEFAULTS);
  const [canvasZoomLevel, setCanvasZoomLevel] = useState<number>(CANVAS_FIT_ZOOM);
  useCanvasZoomHotkeys(setCanvasZoomLevel);
  const [loupeSize, setLoupeSize] = useState<number>(LOUPE_SIZE_DEFAULT);
  const [personalDefault, setPersonalDefault] = useState<CanvasGlassSettings | null>(null);
  const [activeRepoPath, setActiveRepoPath] = useState<string | null>(null);
  const [composerMenu, setComposerMenu] = useState<'repo' | 'model' | 'mode' | null>(null);
  const [orchModel, setOrchModel] = useState(DEFAULT_ORCHESTRATOR_MODEL);
  const [orchEffort, setOrchEffort] = useState<ThinkingEffort>('adaptive');
  const [orchMode, setOrchMode] = useState<CanvasMode>('fleet');
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [shareBetaOpen, setShareBetaOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [orchBusy, setOrchBusy] = useState(false);
  const [convos, setConvos] = useState<Record<string, DockEntry[]>>({});
  // Live native-Claude scouts (Task-tool fan-out) per lane — surfaced in the
  // dock's crew card while the turn runs, cleared when it settles. Without this
  // the scouts vanish into the collapsed "N actions" tool cluster.
  const [liveScouts, setLiveScouts] = useState<Record<string, SwarmScoutView[]>>({});
  const {
    termCards, setTermCards, fileCards, setFileCards, treeCards, setTreeCards,
    imageCards, setImageCards, imageCardsRef, videoCards, setVideoCards,
    diffCards, setDiffCards, specCards, setSpecCards, brainCards, setBrainCards,
    markdownCards, setMarkdownCards, agentCards, setAgentCards,
    browserCards, setBrowserCards, chatCards, setChatCards,
    zPeakRef, canvasCardsRef, findCanvasCard, focusCard,
    focusTermCard, focusFileCard, focusTreeCard, focusImageCard, focusVideoCard,
    focusBrowserCard, focusChatCard, focusDiffCard, focusSpecCard, focusBrainCard,
    focusMarkdownCard, focusAgentCard, moveTermCard, resizeTermCard,
    moveFileCard, resizeFileCard, closeFileCard, moveTreeCard, resizeTreeCard,
    closeTreeCard, moveDiffCard, resizeDiffCard, closeDiffCard,
    moveAgentCard, resizeAgentCard, closeAgentCard,
    moveBrainCard, resizeBrainCard, closeBrainCard,
    moveMarkdownCard, resizeMarkdownCard, closeMarkdownCard,
    moveSpecCard, resizeSpecCard, closeSpecCard, toggleAgentCardExpand,
  } = useCanvasCards();
  // Which card the dragged photo is currently hovering over (→ would stack).
  // Drives the "Drop to stack" highlight. A ref mirror of imageCards lets the
  // move handler hit-test against the other cards without a stale closure.
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const canvasMedia = useCanvasMediaLifecycle(videoCards);
  const [termVeil, setTermVeil] = useState(TERM_VEIL_DEFAULT);
  const [termPickerOpen, setTermPickerOpen] = useState(false);
  const [filePathPickerOpen, setFilePathPickerOpen] = useState(false);
  const [filePathInput, setFilePathInput] = useState('');
  const [filePickerBusy, setFilePickerBusy] = useState(false);
  const [canvasToast, setCanvasToast] = useState<CanvasToast | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionsRepoFilter, setSessionsRepoFilter] = useState<string | null>(null);
  const [composerImages, setComposerImages] = useState<Array<{ name: string; dataUri: string }>>([]);
  // Render-on-screen (#1270) — markdown explainer cards the orchestrator paints
  // via the `render` intent. Content IS the card, so snapshot it with geometry.
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const chatSendDefaults = useMemo(() => ({ model: orchModel, thinkingEffort: orchEffort }), [orchEffort, orchModel]);
  const [topMenu, setTopMenu] = useState<'alerts' | 'agents' | 'profile' | null>(null);
  const [inboxItems, setInboxItems] = useState<InboxRow[]>([]);
  // Which alerts the operator has already clicked — dims the row + drops it
  // from the bell's unseen count. Persisted so a reload doesn't re-surface
  // what you've acted on.
  const [seenAlerts, setSeenAlerts] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = window.localStorage.getItem('o8:canvas-alerts-seen');
      const arr = raw ? JSON.parse(raw) : [];
      return new Set<string>(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  });
  const [activeLanes, setActiveLanes] = useState<LaneRow[]>([]);
  const [recentThreads, setRecentThreads] = useState<CanvasThreadRow[]>([]);
  const [recentCommits, setRecentCommits] = useState<CommitRow[]>([]);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const { guardSubmit: guardSlashSubmit, onChange: handleComposerChange, palette: quickActionPalette } = useCanvasQuickActions(setComposerValue, composerInputRef);
  // Shared identity hook (Clerk) — safe even with no keys: returns a disabled,
  // signed-out state, so the account control degrades to a "Sign in" door.
  const auth = useO8Auth();
  // Push-to-talk for the primary stage composer — speak instead of type, same
  // engine as the default IDE. Speech lands via a functional setState so it
  // appends to whatever is already drafted (no stale snapshot).
  const dictationId = useComposerDictation({
    nodeRef: composerInputRef, active: false, scopeKey: activeRepoPath ?? 'canvas-main',
    onText: text => setComposerValue(current => current.trim() ? `${current.trim()} ${text}` : text),
  });
  const reduceMotion = useReducedMotion() ?? false;
  // Right-Option agent dictation morphs the composer in place — its controls
  // fade out and the live partial words stream where you'd type, growing the
  // pill upward like the outside HUD. Latch + HUD-yield claim live in the hook;
  // `canClaim` only lets the canvas own the partials when its composer is truly
  // on screen + the window is focused (else the outside HUD keeps painting).
  const partialsMorph = useAgentPartialsMorph(() => {
    if (!canvasEnabled) return false;
    if (typeof document === 'undefined') return false;
    if (document.visibilityState !== 'visible') return false;
    if (!document.hasFocus()) return false;
    // offsetParent === null ⇒ the composer is display:none / a backgrounded tab.
    if (composerInputRef.current && composerInputRef.current.offsetParent === null) return false;
    return true;
  });
  const [repos, setRepos] = useState<RepoPickerRowData[] | null>(null);
  const nextIdRef = useRef(1);
  const entryIdRef = useRef(1);
  // Cleared on every send; the first sign of life (text or tool) per turn
  // resolves the pending "Thinking" row and opens the dock.
  const firstOutputRef = useRef(new Set<string>());
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const xtermHandlesRef = useRef(new Map<string, XtermPanelHandle>());
  const liveSessionsRef = useRef(new Set<string>());
  const cdSentRef = useRef(new Set<string>());
  const symonSpawnPacketIdsRef = useRef(new Set<string>());
  const symonSpawnWindowUntilRef = useRef(0);
  const spokenSymonLaneIdsRef = useRef(new Set<string>());
  const announcedSymonLaneIdsRef = useRef(new Set<string>());
  const dataSeenRef = useRef(new Set<string>());
  // First spawn of the visit gets the full reveal (min-play); the rest
  // bail the instant the shell answers — speed stays the default.
  const firstSpawnRef = useRef(true);
  // Agent-card bloom: lanes already carded (so a lane blooms exactly once), the
  // monotonic address number ("agent two"). Dedupe-by-laneId: a lane is only ever
  // carded once. Entering the canvas cards ALL currently-running lanes (fleet
  // dispatched from the IDE/MCP while the canvas was closed), not just lanes born
  // after entry — the dedupe set keeps a re-card from ever double-blooming.
  const cardedLaneIdsRef = useRef<Set<string>>(new Set());
  const agentNumberRef = useRef(1);
  // Where the last agent card (overall + per-repo) landed — the preferred anchor
  // so a fresh sibling clusters NEAR its group instead of scattering.
  const agentAnchorsRef = useRef<{ last: { x: number; y: number } | null; byRepo: Map<string, { x: number; y: number }> }>({ last: null, byRepo: new Map() });
  const mountedCardIdsRef = useRef<Set<number>>(new Set());
  const spawnChoreographyRef = useRef<SpawnChoreography[]>([]);
  const spawnReservationsRef = useRef<SpawnReservation[]>([]);
  const canvasToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Real terminals ride the production WebSocket — same transport, tmux
  // sessions and XtermPanel as the dashboard tabs.
  const {
    connectionState,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
  } = useDesktopWebSocket(undefined, {
    onTerminalCreated: (sessionName, requestId) => {
      if (!requestId || !requestId.startsWith('cnv-term-')) return;
      liveSessionsRef.current.add(sessionName);
      setTermCards((previous) => previous.map((card) => (
        card.requestId === requestId ? { ...card, sessionName } : card
      )));
    },
    onTerminalData: (sessionName, data, historical) => {
      xtermHandlesRef.current.get(sessionName)?.writeData(data, historical);
      // First PTY byte = the shell is real — flip the title off the
      // summoning verb. One-shot per session, not per chunk.
      if (!dataSeenRef.current.has(sessionName)) {
        dataSeenRef.current.add(sessionName);
        setTermCards((previous) => previous.map((card) => (
          card.sessionName === sessionName && !card.live ? { ...card, live: true } : card
        )));
      }
    },
    onTerminalAttached: (sessionName) => {
      // First-attach steering (one-shot per session). Today's bundled ws-server
      // ignores the create-payload cwd, so we cd the fresh shell here; once the
      // server-side cwd ships, the pty already starts there and this is a no-op.
      if (cdSentRef.current.has(sessionName)) return;
      const card = termCards.find((existing) => existing.sessionName === sessionName);
      if (!card) return;
      cdSentRef.current.add(sessionName);
      if (card.cwd) {
        const escaped = card.cwd.replace(/'/g, `'\\''`);
        sendTerminalInput(sessionName, `cd '${escaped}' && clear\n`);
      }
      // Home agent (#1244): auto-launch the chosen local agent CLI — an
      // all-local agent in the home dir (cwd null → PTY's HOME default), no
      // repo/worktree. `agentCli` is the command (claude | codex | gemini).
      if (card.agentCli) {
        sendTerminalInput(sessionName, `${card.agentCli}\n`);
      }
    },
    onTerminalExited: (sessionName) => {
      liveSessionsRef.current.delete(sessionName);
      xtermHandlesRef.current.get(sessionName)?.setExited();
      setTermCards((previous) => previous.map((card) => (
        card.sessionName === sessionName ? { ...card, exited: true } : card
      )));
    },
    onTerminalError: (sessionName, error) => {
      xtermHandlesRef.current.get(sessionName)?.setError(error);
    },
  });

  useEffect(() => {
    const stored = readCanvasGlassSettings();
    setSettings(stored);
    applyCanvasGlassSettings(stored);
    setInTauri(isTauri());
    setPersonalDefault(readPersonalDefault());
    setTermVeil(readTermVeil());
    try {
      const storedModel = readCanvasSetting(CANVAS_MODEL_KEY);
      if (storedModel && CANVAS_MODEL_OPTIONS.some((option) => option.value === storedModel)) setOrchModel(storedModel);
      const storedEffort = readCanvasSetting(CANVAS_EFFORT_KEY);
      if (isThinkingEffort(storedEffort)) setOrchEffort(storedEffort);
      const storedMode = readCanvasSetting(CANVAS_MODE_KEY);
      if (storedMode === 'fleet' || storedMode === 'single' || storedMode === 'fusion') setOrchMode(storedMode);
      // First-run welcome — springs in over a frosted canvas until dismissed.
      if (window.localStorage.getItem(CANVAS_WELCOME_KEY) !== '1') setWelcomeOpen(true);
      const storedZoom = Number.parseFloat(window.localStorage.getItem(ZOOM_KEY) ?? '');
      if (ZOOM_STEPS.some((step) => step.value === storedZoom)) setCanvasZoomLevel(storedZoom);
      const storedLoupe = Number.parseFloat(window.localStorage.getItem(LOUPE_SIZE_KEY) ?? '');
      if (Number.isFinite(storedLoupe) && storedLoupe >= LOUPE_SIZE_RANGE.min && storedLoupe <= LOUPE_SIZE_RANGE.max) setLoupeSize(storedLoupe);
      // Image cards restore through the canvas snapshot (loadCanvasSnapshot)
      // like every other card kind — NOT through a second store here. Loading
      // them in both places spawned a perfect-overlap duplicate that only
      // showed when you dragged one off the other.
    } catch {
      // defaults stand
    }
  }, []);

  // DEV — quick re-open while iterating on dev-bridge (the real entry is the end
  // of the welcome tour, wired below): window.__o8OpenShareBeta(). Strip at ship.
  useEffect(() => {
    (window as unknown as { __o8OpenShareBeta?: () => void }).__o8OpenShareBeta = () => setShareBetaOpen(true);
    return () => { delete (window as unknown as { __o8OpenShareBeta?: () => void }).__o8OpenShareBeta; };
  }, []);

  // Stamp + persist the zoom — drag handlers read --cnv-zoom for their
  // pointer math, so the stamp must land before any drag at this level.
  useEffect(() => {
    document.documentElement.style.setProperty('--cnv-zoom', String(canvasZoomLevel));
    try {
      window.localStorage.setItem(ZOOM_KEY, String(canvasZoomLevel));
    } catch {
      // non-critical
    }
  }, [canvasZoomLevel]);

  useEffect(() => () => {
    if (canvasToastTimerRef.current) clearTimeout(canvasToastTimerRef.current);
  }, []);

  // Persist the operator-adjustable navigator loupe size (#1281).
  useEffect(() => {
    try {
      window.localStorage.setItem(LOUPE_SIZE_KEY, String(loupeSize));
    } catch {
      // non-critical
    }
  }, [loupeSize]);

  // Keep the pan mirror fresh for the ref-based placement helpers.
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  // Kill the text-selection "highlight" a drag leaves behind: dragging the
  // navigator ball / a card / panning the canvas paints a selection across the
  // whole screen. The canvas is user-select:none by design, but WebKit still
  // lets a drag that STARTS on a non-selectable surface extend a selection over
  // the page. Suppress selectstart everywhere EXCEPT real text entry (composer,
  // CodeMirror, inputs) so dragging never highlights while typing still selects.
  useEffect(() => {
    const onSelectStart = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
      event.preventDefault();
    };
    document.addEventListener('selectstart', onSelectStart);
    return () => document.removeEventListener('selectstart', onSelectStart);
  }, []);

  // Stamp the right-dock reserve (screen px it eats) on the same channel as
  // --cnv-zoom, so drag-boundary resistance keeps cards clear of the dock.
  // 0 when closed; 424 = dock.tsx right:24 + width:400.
  useEffect(() => {
    document.documentElement.style.setProperty('--cnv-dock-reserve', dockOpen ? '424' : '0');
  }, [dockOpen]);

  // Escape closes every ephemeral layer — popovers, pickers, drawers,
  // search. They all have outside-click veils; this is the keyboard peer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setTopMenu(null);
      setComposerMenu(null);
      setTermPickerOpen(false);
      setFilePathPickerOpen(false);
      setReviewPickerOpen(false);
      setSessionsOpen(false);
      setSearchOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Repos load at mount — the composer is scoped to a repo from the first
  // keystroke, not from the first picker open. Default scope: o8, else first.
  useEffect(() => {
    let disposed = false;
    Promise.all([
      fetch('/api/panel/repos').then((response) => (response.ok ? response.json() : { repos: [] })),
      fetch('/api/projects').then((response) => (response.ok ? response.json() : { projects: [] })).catch(() => ({ projects: [] })),
    ])
      .then(([data, projectData]: [
        { repos?: Array<{ id?: string | null; name?: string | null; localPath?: string | null }> },
        { projects?: Array<{ name?: string | null; repos?: Array<{ repoId?: string | null }> }> },
      ]) => {
        if (disposed) return;
        const projectByRepoId = new Map<string, string>();
        for (const project of projectData?.projects ?? []) {
          if (!project?.name) continue;
          for (const member of project.repos ?? []) {
            if (member?.repoId) projectByRepoId.set(member.repoId, project.name);
          }
        }
        const rows = Array.isArray(data?.repos)
          ? data.repos
            .filter((repo) => typeof repo?.localPath === 'string' && repo.localPath.length > 0)
            .map((repo) => ({
              name: repo.name && repo.name.length > 0 ? repo.name : (repo.localPath!.split('/').pop() ?? repo.localPath!),
              path: repo.localPath!,
              project: (repo.id && projectByRepoId.get(repo.id)) || null,
            }))
          : [];
        setRepos(rows);
        setActiveRepoPath((current) => current ?? rows.find((row) => row.name === 'o8')?.path ?? rows[0]?.path ?? null);
      })
      .catch(() => {
        if (!disposed) setRepos([]);
      });
    return () => {
      disposed = true;
    };
  }, []);

  /** One lanes refetch used by the poll, the Review drawer, and the live
   *  lane-lifecycle push — agent spawns/review-ready land in real time. */
  const refreshLanes = useCallback(() => {
    fetch('/api/lanes?active=true')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { lanes?: LaneRow[] } | null) => {
        if (data && Array.isArray(data.lanes)) setActiveLanes(data.lanes);
      })
      .catch(() => {});
  }, []);

  // Live chrome data — inbox badge, running agents, past sessions. Light
  // polling: the canvas is ambient, not a realtime surface.
  useEffect(() => {
    let disposed = false;
    const refreshBadges = () => {
      fetch('/api/mobile/inbox')
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { items?: InboxRow[] } | null) => {
          if (!disposed && data && Array.isArray(data.items)) setInboxItems(data.items);
        })
        .catch(() => {});
      refreshLanes();
    };
    const refreshThreads = () => {
      fetch('/api/mobile/orchestrator/threads')
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { threads?: CanvasThreadRow[] } | null) => {
          if (!disposed && data && Array.isArray(data.threads)) setRecentThreads(data.threads);
        })
        .catch(() => {});
    };
    refreshBadges();
    refreshThreads();
    const badgeTimer = setInterval(refreshBadges, 90_000);
    const threadTimer = setInterval(refreshThreads, 120_000);
    return () => {
      disposed = true;
      clearInterval(badgeTimer);
      clearInterval(threadTimer);
    };
  }, [refreshLanes]);

  // Opening the Sessions popover (or the search, which lists sessions too)
  // refetches so the list is never two minutes stale.
  useEffect(() => {
    if (!sessionsOpen && !searchOpen) return;
    let disposed = false;
    fetch('/api/mobile/orchestrator/threads')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { threads?: CanvasThreadRow[] } | null) => {
        if (!disposed && data && Array.isArray(data.threads)) setRecentThreads(data.threads);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [searchOpen, sessionsOpen]);

  // Same for the Review drawer — lanes move fast, the list must be live.
  useEffect(() => {
    if (reviewPickerOpen) refreshLanes();
  }, [refreshLanes, reviewPickerOpen]);

  // Right rail mirrors the active repo's recent commits.
  useEffect(() => {
    if (!activeRepoPath) return;
    let disposed = false;
    fetch(`/api/panel/commits?workspace=${encodeURIComponent(activeRepoPath)}&limit=5`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { commits?: CommitRow[] } | null) => {
        if (!disposed && data && Array.isArray(data.commits)) setRecentCommits(data.commits);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [activeRepoPath]);

  // Terminal sends drop silently while the socket is down and the server
  // never re-attaches a client — each connect bumps the epoch so every
  // mounted XtermPanel resets + re-attaches (scrollback replays).
  const [wsEpoch, setWsEpoch] = useState(0);
  useEffect(() => {
    if (connectionState === 'connected') setWsEpoch((epoch) => epoch + 1);
  }, [connectionState]);

  // Background material + backdrop blur: apply the stored choices while
  // this page is up, restore the chrome on the way out. No-op in a browser.
  useEffect(() => {
    if (!canvasEnabled) return;
    const stored = readCanvasGlassSettings();
    void setCanvasMaterial(stored.material);
    void setCanvasBackdropBlur(stored.backdropFrost);
    const timers = timersRef.current;
    return () => {
      void setCanvasMaterial('default');
      void setCanvasBackdropBlur(0);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [canvasEnabled]);

  const updateSettings = useCallback((patch: Partial<CanvasGlassSettings>) => {
    // Material + backdrop blur are native, not CSS — swap the window live.
    if (patch.material) void setCanvasMaterial(patch.material);
    if (patch.backdropFrost !== undefined) void setCanvasBackdropBlur(patch.backdropFrost);
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      writeCanvasGlassSettings(next);
      return next;
    });
  }, []);

  // Orb refraction dials — scoped per canvas tone (glass reads differently on a
  // light vs dark backdrop), persisted, and applied to the WebGL ball live.
  useEffect(() => {
    setOrbSettings(readOrbSettings(settings.tone));
  }, [settings.tone]);
  const updateOrbSettings = useCallback((patch: Partial<OrbSettings>) => {
    setOrbSettings((previous) => {
      const next = { ...previous, ...patch };
      writeOrbSettings(settings.tone, next);
      return next;
    });
  }, [settings.tone]);
  const resetOrbSettings = useCallback(() => {
    writeOrbSettings(settings.tone, ORB_DEFAULTS);
    setOrbSettings({ ...ORB_DEFAULTS });
  }, [settings.tone]);

  const appendEntries = useCallback((lane: string, entries: NewDockEntry[]) => {
    setConvos((previous) => {
      const next: DockEntry[] = entries.map((entry) => {
        const id = entryIdRef.current;
        entryIdRef.current += 1;
        return { ...entry, id };
      });
      return updateCanvasConversation(previous, lane, (current) => [...current, ...next]);
    });
  }, []);

  const resolveStatus = useCallback((lane: string, text: string) => {
    setConvos((previous) => updateCanvasConversation(previous, lane, (entries) => entries.map((entry) => {
        // The turn settling also settles any live reasoning stream.
        if (entry.role === 'thinking' && entry.live) return { ...entry, live: false };
        if (entry.role !== 'status' || !entry.pending) return entry;
        // A live tool cluster settles to its own tally, not the turn label.
        if (entry.kind === 'tool') {
          const count = entry.count ?? 1;
          return { ...entry, pending: false, text: `${count} action${count === 1 ? '' : 's'}` };
        }
        return { ...entry, pending: false, text };
      })));
  }, []);

  /** Tool calls absorb into one live cluster per work phase — the row
   *  shows the latest tool name + a running count instead of a pill per
   *  call. A text delta in between starts the next cluster. */
  const noteToolUse = useCallback((lane: string, name: string) => {
    setConvos((previous) => {
      const entries = previous[lane] ?? [];
      const last = entries[entries.length - 1];
      if (last && last.role === 'status' && last.kind === 'tool' && last.pending) {
        const updated = [...entries];
        updated[updated.length - 1] = { ...last, text: name, count: (last.count ?? 1) + 1 };
        return setCanvasConversation(previous, lane, updated);
      }
      const id = entryIdRef.current;
      entryIdRef.current += 1;
      return setCanvasConversation(previous, lane, [...entries, { role: 'status', text: name, pending: true, kind: 'tool', count: 1, id }]);
    });
  }, []);

  /** The full assistant answer for the in-flight turn, per lane — fed to the
   *  end-of-turn playback bar so it can speak "the entire thing he said." */
  const turnTextRef = useRef(new Map<string, string>());

  /** Real orchestrator deltas grow the last live text entry in place.
   *  A text delta also settles any live reasoning stream above it. */
  const appendAssistantDelta = useCallback((lane: string, delta: string) => {
    turnTextRef.current.set(lane, (turnTextRef.current.get(lane) ?? '') + delta);
    setConvos((previous) => {
      const entries = previous[lane] ?? [];
      const last = entries[entries.length - 1];
      if (last && last.role === 'text' && last.live) {
        const updated = [...entries];
        updated[updated.length - 1] = { ...last, text: last.text + delta };
        return setCanvasConversation(previous, lane, updated);
      }
      const id = entryIdRef.current;
      entryIdRef.current += 1;
      const settled = entries.map((entry) => (entry.role === 'thinking' && entry.live ? { ...entry, live: false } : entry));
      return setCanvasConversation(previous, lane, [...settled, { role: 'text', text: delta, live: true, id }]);
    });
  }, []);

  /** Reasoning deltas — the model thinking out loud, rendered as a staged
   *  timeline (Q's reference). Paragraph boundaries stamp REAL elapsed
   *  marks so each stage carries its own time chip. */
  const appendThinkingDelta = useCallback((lane: string, delta: string) => {
    setConvos((previous) => {
      const entries = previous[lane] ?? [];
      const last = entries[entries.length - 1];
      if (last && last.role === 'thinking' && last.live) {
        const text = last.text + delta;
        const previousStages = last.text.split(/\n\s*\n/).length;
        const stages = text.split(/\n\s*\n/).length;
        const startedAt = last.startedAt ?? Date.now();
        const marks = stages > previousStages
          ? [...(last.marks ?? []), Math.round((Date.now() - startedAt) / 1000)]
          : last.marks;
        const updated = [...entries];
        updated[updated.length - 1] = { ...last, text, marks };
        return setCanvasConversation(previous, lane, updated);
      }
      const id = entryIdRef.current;
      entryIdRef.current += 1;
      return setCanvasConversation(previous, lane, [...entries, { role: 'thinking', text: delta, live: true, startedAt: Date.now(), marks: [], id }]);
    });
  }, []);

  /** ONE event pipeline for every live line — the dock's repo-keyed convo
   *  AND each chat card's thread-keyed convo flow through here. */
  // One result-card accumulator per lane — collects the turn's edits / PR and
  // rolls them into result entries when the turn settles (status 'ready').
  const turnToolsRef = useRef(new Map<string, TurnTools>());
  const ensureTurnTools = useCallback((lane: string): TurnTools => {
    let acc = turnToolsRef.current.get(lane);
    if (!acc) { acc = emptyTurnTools(); turnToolsRef.current.set(lane, acc); }
    return acc;
  }, []);

  const handleOrchEvent = useCallback((lane: string, event: CanvasThreadEvent): void => {
    if (event.type === 'output') {
      if (!firstOutputRef.current.has(lane)) {
        firstOutputRef.current.add(lane);
        resolveStatus(lane, 'Working');
      }
      if (event.thinking) {
        appendThinkingDelta(lane, event.text);
        return;
      }
      appendAssistantDelta(lane, event.text);
    } else if (event.type === 'tool') {
      if (!firstOutputRef.current.has(lane)) {
        firstOutputRef.current.add(lane);
        resolveStatus(lane, 'Working');
      }
      // Fold the edit into the turn's result accumulator (→ a rolled-up
      // "Edited N files" card at turn end), then surface the live activity line.
      recordTool(ensureTurnTools(lane), event.name, event.args);
      noteToolUse(lane, event.name);
      // Native Claude scouts (Task-tool sub-agents) — surface them as a live
      // crew instead of letting them disappear into the tool-count cluster.
      if (event.name === 'Task' || event.name.toLowerCase() === 'task') {
        const args = event.args ?? {};
        const description = typeof args.description === 'string' ? args.description.trim() : '';
        const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type.trim() : '';
        setLiveScouts((previous) => {
          const existing = previous[lane] ?? [];
          const label = description || subagentType || `Scout ${existing.length + 1}`;
          return { ...previous, [lane]: [...existing, { id: `${lane}-scout-${existing.length}`, label, status: 'running' }] };
        });
      }
    } else if (event.type === 'tool-result') {
      // Only `gh pr create` output matters (the PR card). MUST stay above the
      // `else` — that reads event.error, which a tool-result lacks (would throw).
      recordToolResult(ensureTurnTools(lane), event.name, event.args, event.output);
    } else if (event.type === 'status') {
      if (event.status === 'dead') {
        clearCanvasTurnAccumulators(lane, turnTextRef.current, turnToolsRef.current);
        setLiveScouts((previous) => ({ ...previous, [lane]: [] }));
        resolveStatus(lane, 'Session ended');
      } else if (event.status === 'unreported') {
        clearCanvasTurnAccumulators(lane, turnTextRef.current, turnToolsRef.current);
        setLiveScouts((previous) => ({ ...previous, [lane]: [] }));
        resolveStatus(lane, 'Needs attention');
        appendEntries(lane, [{ role: 'status', text: `Needs attention: ${event.reason ?? 'turn ended without an outcome report'}`, pending: false }]);
      } else if (event.status === 'ready') {
        // Roll the turn's edits / PR / captured screenshots into result cards.
        const acc = turnToolsRef.current.get(lane);
        const toAppend: NewDockEntry[] = acc ? synthesizeResultEntries(acc) : [];
        // …then a playback bar at the very end, carrying the full answer so the
        // operator can hear the whole turn read back (Symon voice).
        const said = (turnTextRef.current.get(lane) ?? '').trim();
        if (said) toAppend.push({ role: 'playback', text: said });
        if (toAppend.length) appendEntries(lane, toAppend);
        clearCanvasTurnAccumulators(lane, turnTextRef.current, turnToolsRef.current);
        setLiveScouts((previous) => ({ ...previous, [lane]: [] }));
        resolveStatus(lane, 'Done');
      }
    } else if (event.type === 'notice') { appendEntries(lane, [{ role: 'status', text: event.message, pending: false }]); } else {
      clearCanvasTurnAccumulators(lane, turnTextRef.current, turnToolsRef.current);
      setLiveScouts((previous) => ({ ...previous, [lane]: [] }));
      resolveStatus(lane, 'Failed');
      appendEntries(lane, [{ role: 'status', text: event.error.slice(0, 200), pending: false }]);
    }
  }, [appendAssistantDelta, appendEntries, appendThinkingDelta, ensureTurnTools, noteToolUse, resolveStatus]);

  // The REAL orchestrator — same ws-server channel the OrchestratorTab
  // speaks, scoped to the composer's repo. Convos are keyed by repo path.
  const orch = useCanvasOrchestrator(activeRepoPath, {
    onOutput: (repo, text, thinking) => {
      if (!firstOutputRef.current.has(repo)) setDockOpen(true);
      handleOrchEvent(repo, { type: 'output', text, thinking });
    },
    onToolUse: (repo, name, args) => {
      if (!firstOutputRef.current.has(repo)) setDockOpen(true);
      handleOrchEvent(repo, { type: 'tool', name, args });
    },
    onToolResult: (repo, name, args, output) => {
      handleOrchEvent(repo, { type: 'tool-result', name, args, output });
    },
    onStatus: (repo, status, reason) => {
      setOrchBusy(status === 'busy');
      if (status === 'unreported') setDockOpen(true);
      handleOrchEvent(repo, { type: 'status', status, reason });
    },
    onNotice: (repo, message) => { setDockOpen(true); handleOrchEvent(repo, { type: 'notice', message }); },
    onError: (repo, error) => {
      handleOrchEvent(repo, { type: 'error', error });
    },
    onLaneLifecycle: refreshLanes,
  });

  // The dock survives reloads like the cards do — an empty lane whose repo
  // has a persisted thread re-seeds its transcript from chat history (the
  // same source pickThread uses for floating cards).
  const dockSeededRef = useRef(new Set<string>());
  useEffect(() => {
    if (!dockOpen || !activeRepoPath) return;
    const repo = activeRepoPath;
    if ((convos[repo]?.length ?? 0) > 0) return;
    const threadId = orch.threadIdFor(repo);
    if (!threadId || dockSeededRef.current.has(threadId)) return;
    dockSeededRef.current.add(threadId);
    void fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { messages?: Array<{ role?: string; content?: string }> } | null) => {
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        if (!messages.length) return;
        const entries: DockEntry[] = [];
        for (const message of messages) {
          const text = typeof message.content === 'string' ? message.content.trim() : '';
          if (!text) continue;
          const id = entryIdRef.current;
          entryIdRef.current += 1;
          entries.push(message.role === 'user' ? { role: 'user', text, id } : { role: 'text', text, id });
        }
        // A turn that started while we fetched wins the lane.
        setConvos((previous) => ((previous[repo]?.length ?? 0) > 0 ? previous : setCanvasConversation(previous, repo, entries)));
      })
      .catch(() => {});
  }, [dockOpen, activeRepoPath, convos, orch]);

  /** Erase a lane's transcript back to a boundary — powers undo-send
   *  (everything at/after the just-sent user entry vanishes, like it never was). */
  const truncateLane = useCallback((lane: string, fromEntryId: number) => {
    setConvos((previous) => updateCanvasConversation(previous, lane, (entries) => entries.filter((entry) => entry.id < fromEntryId)));
  }, []);

  /** The raw send for the docked / bottom conversation — fires the turn,
   *  appends the user entry, and returns the undo-truncation boundary (or null
   *  if it never went out). */
  const dispatchMain = useCallback((text: string, images: ComposerImage[]) => {
    const lane = activeRepoPath;
    if (!lane) return null;
    firstOutputRef.current.delete(lane);
    const threadId = orch.send(text, {
      model: orchModel,
      thinkingEffort: orchEffort,
      orchestrationMode: orchMode,
      ...(images.length ? { attachments: images } : {}),
    });
    const fromEntryId = entryIdRef.current;
    const userEntry = {
      role: 'user' as const,
      text,
      ...(images.length ? { images: images.map((image) => image.dataUri) } : {}),
    };
    if (!threadId) {
      appendEntries(lane, [userEntry, { role: 'status', text: 'Not connected yet — try again in a second', pending: false }]);
      setDockOpen(true);
      return null;
    }
    // The bottom composer and the dock are one view of this lane. If it's
    // currently floating as an undocked card, adopt the card's thread lane (the
    // complete record, incl. turns typed in the card) onto the dock lane BEFORE
    // appending this turn, then fold the card away — never two views at once.
    const tId = orch.threadIdFor(lane);
    if (tId) {
      setConvos((previous) => (previous[`thread:${tId}`] ? setCanvasConversation(previous, lane, previous[`thread:${tId}`]) : previous));
      setChatCards((previous) => previous.filter((card) => card.threadId !== tId));
    }
    appendEntries(lane, [userEntry, { role: 'status', text: 'Thinking', pending: true }]);
    setDockOpen(true);
    return { lane, fromEntryId };
  }, [activeRepoPath, appendEntries, orch, orchEffort, orchModel, orchMode, setChatCards]);

  // Mistake-proofing for the main conversation (bottom pill + dock): undo-send
  // grace buffer + queue-when-busy. Both composers route through `mainSend`.
  const {
    send: mainSend,
    stopOrUndo: mainStopOrUndo,
    undoArmed: mainUndoArmed,
    queued: mainQueued,
    cancelQueued: mainCancelQueued,
  } = useSendBuffer({
    busy: orchBusy,
    dispatch: dispatchMain,
    interrupt: orch.interrupt,
    restore: (text, images) => {
      setComposerValue(text);
      setComposerImages(images);
      composerInputRef.current?.focus();
    },
    truncate: truncateLane,
  });

  /** One send path for every main-conversation composer — the bottom pill AND
   *  the dock's own reply input. Queues when busy; arms undo when it goes out. */
  const sendPrompt = useCallback((prompt: string, attachments?: Array<{ dataUri: string; name?: string }>): boolean => {
    const images: ComposerImage[] = (attachments ?? []).map((attachment) => ({ name: attachment.name ?? 'image', dataUri: attachment.dataUri }));
    return mainSend(prompt, images);
  }, [mainSend]);

  /** Files dropped or pasted onto the composer become picture pills,
   *  ready to ride the next send as real image blocks. */
  const addComposerImages = useCallback((files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUri = typeof reader.result === 'string' ? reader.result : null;
        if (!dataUri) return;
        setComposerImages((previous) => previous.length >= 8 ? previous : [...previous, { name: file.name || 'image', dataUri }]);
      };
      reader.readAsDataURL(file);
    }
  }, []);
  const submit = useCallback(() => {
    const prompt = composerValue.trim();
    const images = composerImages;
    if (!prompt && images.length === 0) return;
    if (guardSlashSubmit(prompt)) return;
    if (sendPrompt(prompt || 'Take a look at these.', images.length ? images : undefined)) {
      setComposerValue('');
      setComposerImages([]);
    }
  }, [composerImages, composerValue, guardSlashSubmit, sendPrompt]);
  const chooseModel = useCallback((value: string) => {
    setOrchModel(value);
    // Drawer stays open — the merged picker lets you set model AND thinking in
    // one visit; the backdrop click dismisses it.
    try {
      window.localStorage.setItem(CANVAS_MODEL_KEY, value);
    } catch {
      // non-critical
    }
  }, []);

  const chooseEffort = useCallback((value: ThinkingEffort) => {
    setOrchEffort(value);
    // Stays open (see chooseModel) — set model + thinking, then click away.
    try {
      window.localStorage.setItem(CANVAS_EFFORT_KEY, value);
    } catch {
      // non-critical
    }
  }, []);

  const chooseMode = useCallback((value: CanvasMode) => {
    setOrchMode(value);
    setComposerMenu(null);
    try {
      window.localStorage.setItem(CANVAS_MODE_KEY, value);
    } catch {
      // non-critical
    }
  }, []);

  const closeWelcome = useCallback(() => {
    setWelcomeOpen(false);
    try {
      window.localStorage.setItem(CANVAS_WELCOME_KEY, '1');
    } catch {
      // non-critical
    }
  }, []);

  // Start the journey — dismiss the hero, then run the guided tour (unless it's
  // already been seen). Skipping the hero (✕/Esc) takes closeWelcome instead.
  const startFromWelcome = useCallback(() => {
    closeWelcome();
    let seen = false;
    try { seen = window.localStorage.getItem(CANVAS_TOUR_KEY) === '1'; } catch { /* default unseen */ }
    if (!seen) setTourOpen(true);
  }, [closeWelcome]);

  const closeTour = useCallback(() => {
    setTourOpen(false);
    try {
      window.localStorage.setItem(CANVAS_TOUR_KEY, '1');
    } catch {
      // non-critical
    }
  }, []);

  /** A PAST session opens as its OWN draggable glass box — the dock stays
   *  reserved for the docked live orchestrator. The card's dock glyph
   *  promotes it into the dock if wanted. */
  // ── Spawn placement — new cards land on open canvas, not on each other.
  // A ref mirror keeps the finder stable (no per-mutation callback churn).
  const cardRectsRef = useRef<Array<{ x: number; y: number; w: number; h: number }>>([]);
  useEffect(() => {
    const ids = [
      ...cards.map((card) => card.id),
      ...termCards.map((card) => card.id),
      ...fileCards.map((card) => card.id),
      ...treeCards.map((card) => card.id),
      ...imageCards.map((card) => card.id),
      ...videoCards.map((card) => card.id),
      ...browserCards.map((card) => card.id),
      ...chatCards.map((card) => card.id),
      ...diffCards.map((card) => card.id),
      ...specCards.map((card) => card.id),
      ...brainCards.map((card) => card.id),
      ...markdownCards.map((card) => card.id),
      ...agentCards.map((card) => card.id),
    ];
    const reduce = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const id of ids) {
      if (mountedCardIdsRef.current.has(id)) continue;
      mountedCardIdsRef.current.add(id);
      window.requestAnimationFrame(() => {
        const el = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement | null;
        if (!el) return;
        const animation = reduce
          ? `cnv-card-fade-in ${CARD_ENTRANCE.reducedMs}ms ease both`
          : `cnv-card-enter ${CARD_ENTRANCE.enterMs}ms ${CARD_ENTRANCE.ease} both, cnv-card-border-draw ${CARD_ENTRANCE.borderMs}ms ease-out both`;
        const token = `${id}:${Date.now()}`;
        el.setAttribute('data-cnv-entrance', token);
        el.style.animation = animation;
        el.style.transformOrigin = 'center center';
        window.setTimeout(() => {
          if (el.getAttribute('data-cnv-entrance') !== token) return;
          el.style.animation = '';
          el.style.transformOrigin = '';
          el.removeAttribute('data-cnv-entrance');
        }, reduce ? CARD_ENTRANCE.reducedMs + 20 : CARD_ENTRANCE.borderMs + 20);
      });
    }
  }, [agentCards, brainCards, browserCards, cards, chatCards, diffCards, fileCards, imageCards, markdownCards, specCards, termCards, treeCards, videoCards]);

  useEffect(() => {
    cardRectsRef.current = [
      ...termCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 36 })),
      ...fileCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 36 })),
      ...treeCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 63 })),
      ...imageCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 28 })),
      ...browserCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 92 })),
      ...chatCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
      ...diffCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 36 })),
      ...specCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
      ...brainCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 92 })),
      ...markdownCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 36 })),
      ...agentCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 36 })),
    ];
  }, [termCards, fileCards, treeCards, imageCards, browserCards, chatCards, diffCards, specCards, brainCards, markdownCards, agentCards]);

  /** Nearest clear spot to an anchor (the viewport centre by default, or a caller
   *  -supplied cluster origin) inside the VISIBLE viewport — least-covered cell
   *  when the field is genuinely full. Reading-order first-fit used to let each
   *  new card drift down-and-right until a session read "scattered everywhere";
   *  gathering around the anchor keeps a working session visually together.
   *  Existing floating chrome (composer, dispatch dock, review picker, right
   *  dock) is treated as occupied, so a card never spawns under it. `anchor` is
   *  optional (canvas px) — the agent-card cluster passes its own. */
  const findFreeSpot = useCallback((w: number, h: number, anchor?: { x: number; y: number } | null): { x: number; y: number } => {
    const z = canvasZoom();
    const p = panRef.current;
    const taken = [
      ...cardRectsRef.current,
      ...spawnReservationsRef.current,
      ...chromeRectsCanvas(p, z),
    ];
    const pad = 18;
    // Visible viewport in canvas px (screen 0,0,w,h → canvas via (screen − pan)/z).
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1600;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
    const viewX = -p.x / z;
    const viewY = -p.y / z;
    const minX = viewX + 96 / z; // clear the left spawn rail
    const minY = viewY + 84 / z; // clear the top control pill
    const maxX = Math.max(minX, viewX + (vw - 24) / z - w);
    const maxY = Math.max(minY, viewY + (vh - 96) / z - Math.min(h, 360));
    // Anchor the search: caller cluster origin, else the viewport centre.
    const anchorX = anchor ? anchor.x : viewX + vw / z / 2;
    const anchorY = anchor ? anchor.y : viewY + vh / z / 2;
    let free: { x: number; y: number } | null = null;
    let freeDist = Infinity;
    let best = { x: minX, y: minY };
    let bestOverlap = Infinity;
    for (let y = minY; y <= maxY; y += 56) {
      for (let x = minX; x <= maxX; x += 64) {
        let overlap = 0;
        for (const rect of taken) {
          const ox = Math.max(0, Math.min(x + w, rect.x + rect.w + pad) - Math.max(x, rect.x - pad));
          const oy = Math.max(0, Math.min(y + h, rect.y + rect.h + pad) - Math.max(y, rect.y - pad));
          overlap += ox * oy;
        }
        if (overlap === 0) {
          // Distance from the candidate CENTRE to the anchor — nearest wins.
          const dx = x + w / 2 - anchorX;
          const dy = y + h / 2 - anchorY;
          const dist = dx * dx + dy * dy;
          if (dist < freeDist) { freeDist = dist; free = { x, y }; }
        } else if (overlap < bestOverlap) {
          bestOverlap = overlap;
          best = { x, y };
        }
      }
    }
    return free ?? best;
  }, []);

  const {
    pickThread,
    noteCardSend,
    moveChatCard,
    resizeChatCard,
    closeChatCard,
    dockChatCard,
    undockToCard,
    redockActiveLane,
  } = useCanvasChatCards({
    activeRepoPath,
    convos,
    repos,
    orch,
    nextIdRef,
    entryIdRef,
    firstOutputRef,
    turnTextRef,
    turnToolsRef,
    chatCards,
    setChatCards,
    zPeakRef,
    setConvos,
    setDockOpen,
    setActiveRepoPath,
    findFreeSpot,
    appendEntries,
  });
  const moveCard = useCallback((id: number, x: number, y: number) => {
    setCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  // ── Form-fit grid (#1239) — pack every card into a viewport-filling grid.
  // A ref mirror of all card geometry keeps applyGridLayout's identity stable so
  // the trigger effect below never loops on the layout's own per-frame writes.
  const gridItemsRef = useRef<Array<GridItem & { x: number; y: number; w: number; h: number }>>([]);

  const gridAnimRef = useRef<{ stop: () => void } | null>(null);
  const [gridPlaceholder, setGridPlaceholder] = useState<Slot | null>(null);

  /** Spawn a REAL shell — production transport, canvas treatment. */
  const spawnTerminal = useCallback((cwd: string | null, cwdLabel: string | null, at?: SnapGeometry, opts?: { agentCli?: string }) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    const requestId = `cnv-term-${id}-${Math.random().toString(36).slice(2, 8)}`;
    const revealHold = firstSpawnRef.current;
    firstSpawnRef.current = false;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const z = zPeakRef.current;
    const spot = at ?? findFreeSpot(560, 336);
    setTermCards((previous) => spawnCanvasCard(previous, {
      id,
      requestId,
      sessionName: null,
      exited: false,
      live: false,
      revealHold,
      x: spot.x,
      y: spot.y,
      w: at?.w ?? 560,
      h: at?.h ?? 300,
      z,
      cwd,
      cwdLabel,
      agentCli: opts?.agentCli,
    }));
    sendTerminalCreate(120, 30, requestId, cwd ?? undefined);
  }, [findFreeSpot, sendTerminalCreate, setTermCards, zPeakRef]);

  // #6 persistent terminals — re-attach a canvas shell whose tmux session
  // survived a restart/crash instead of respawning fresh. The card is created
  // with `sessionName` already set, so XtermPanel mounts keyed on it and its
  // mount effect sends terminal-attach (the ws-server re-attach path replays
  // scrollback). cdSentRef is pre-seeded so the cd+clear on first attach does
  // NOT run — the surviving shell keeps its own cwd and history.
  const reattachTerminal = useCallback((sessionName: string, cwd: string | null, cwdLabel: string | null, at?: SnapGeometry) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    firstSpawnRef.current = false;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const z = zPeakRef.current;
    const spot = at ?? findFreeSpot(560, 336);
    liveSessionsRef.current.add(sessionName);
    cdSentRef.current.add(sessionName);
    setTermCards((previous) => [...previous, {
      id,
      requestId: `cnv-term-${id}-reattach`,
      sessionName,
      exited: false,
      live: false,
      revealHold: false,
      x: spot.x,
      y: spot.y,
      w: at?.w ?? 560,
      h: at?.h ?? 300,
      z,
      cwd,
      cwdLabel,
    }]);
  }, [findFreeSpot, setTermCards, zPeakRef]);

  const requestDiffCardChanges = useCallback((card: DiffCard) => {
    setComposerValue(`Request changes on ${card.title}${card.branch ? ` (${card.branch})` : ''}: `);
    composerInputRef.current?.focus();
  }, []);
  const specScreenMap = useMemo(() => ({ zoom: canvasZoomLevel, panX: pan.x, panY: pan.y }), [canvasZoomLevel, pan.x, pan.y]);
  const showCanvasToast = useCallback((message: string, tone: CanvasToast['tone'] = 'error') => {
    const id = Date.now();
    setCanvasToast({ id, message, tone });
    if (canvasToastTimerRef.current) clearTimeout(canvasToastTimerRef.current);
    canvasToastTimerRef.current = setTimeout(() => {
      setCanvasToast((current) => (current?.id === id ? null : current));
      canvasToastTimerRef.current = null;
    }, 3600);
  }, []);

  const reducedMotion = useCallback(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ), []);

  const viewportSpawnOrigin = useCallback(() => {
    const z = canvasZoom();
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1600;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
    return {
      x: (vw / 2 - pan.x) / z - 140,
      y: (vh / 2 - pan.y) / z - 64,
    };
  }, [pan.x, pan.y]);

  const takeSpawnChoreography = useCallback((): SpawnChoreography | null => {
    const now = Date.now();
    spawnChoreographyRef.current = spawnChoreographyRef.current.filter((entry) => entry.expiresAt > now);
    const [entry] = spawnChoreographyRef.current.splice(0, 1);
    return entry ?? null;
  }, []);

  const {
    bloomAgentCard,
    spawnAgents,
    spawnDiffCard,
    spawnWorktreeDiffCard,
    refreshWorktreeDiffCard,
    spawnReviewDiffCard,
    spawnSpecCard,
    spawnBrainCard,
    spawnMarkdownCard,
    spawnBrowserCard,
    moveBrowserCard,
    resizeBrowserCard,
    changeBrowserTabs,
    closeBrowserCard,
    spawnFileCard,
    spawnFileTreeCard,
    openPathAsFileCard,
  } = useCanvasSpawners({
    activeRepoPath,
    repos,
    specCards,
    brainCards,
    nextIdRef,
    zPeakRef,
    timersRef,
    symonSpawnPacketIdsRef,
    symonSpawnWindowUntilRef,
    agentNumberRef,
    agentAnchorsRef,
    spawnChoreographyRef,
    spawnReservationsRef,
    setAgentCards,
    setDiffCards,
    setSpecCards,
    setBrainCards,
    setMarkdownCards,
    setBrowserCards,
    setFileCards,
    setTreeCards,
    setFilePathPickerOpen,
    setFilePathInput,
    findFreeSpot,
    reducedMotion,
    takeSpawnChoreography,
    viewportSpawnOrigin,
    refreshLanes,
    focusSpecCard,
    focusBrainCard,
    showCanvasToast,
    getCanvasDiffCards: () => canvasCardsRef.current.diff,
  });

  /** Watch live lanes: bloom a card for every lane not yet carded — including the
   *  fleet already running when the canvas opens (dispatched from the IDE/MCP
   *  while it was closed). Entering the canvas cards them ALL (entrance animation,
   *  no choreography), deduped by laneId. Cards read their phase live from
   *  activeLanes thereafter; a lane leaving the set settles its card to "done". */
  useEffect(() => {
    if (!canvasEnabled) return;
    for (const lane of activeLanes) {
      if (cardedLaneIdsRef.current.has(lane.id)) continue;
      cardedLaneIdsRef.current.add(lane.id);
      bloomAgentCard(lane);
    }
  }, [activeLanes, bloomAgentCard, canvasEnabled]);

  useEffect(() => {
    if (!canvasEnabled || !inTauri) return;
    const liveIds = new Set(activeLanes.map((lane) => lane.id));
    for (const card of agentCards) {
      // Announce the ASSIGNED card name the moment a Symon-spawned card lands —
      // the spawn is async, so the model can't know the codename at dispatch
      // time and must never invent one (2026-07-08: voice "Pigeon", card "Pike").
      if (card.symonOrigin && liveIds.has(card.laneId) && !announcedSymonLaneIdsRef.current.has(card.laneId)) {
        announcedSymonLaneIdsRef.current.add(card.laneId);
        const spawnLabel = card.codename || card.title || `Agent ${card.number}`;
        void symonSpeakStatus(`${spawnLabel} is on it`);
      }
      if (!card.symonOrigin || liveIds.has(card.laneId) || spokenSymonLaneIdsRef.current.has(card.laneId)) continue;
      spokenSymonLaneIdsRef.current.add(card.laneId);
      const label = card.codename || card.title || `Agent ${card.number}`;
      void symonSpeakStatus(`${label} is done`);
    }
  }, [activeLanes, agentCards, canvasEnabled, inTauri]);

  const reviewAgentCard = useCallback((laneId: string) => {
    const lane = activeLanes.find((row) => row.id === laneId);
    if (lane) void spawnDiffCard(lane);
  }, [activeLanes, spawnDiffCard]);

  // Auto-show YOUR working tree the moment the Review picker opens — no
  // hunting for the row. spawnWorktreeDiffCard dedupes, so this never stacks.
  useEffect(() => {
    if (reviewPickerOpen && activeRepoPath) void spawnWorktreeDiffCard();
  }, [reviewPickerOpen, activeRepoPath, spawnWorktreeDiffCard]);

  /** Mark an alert seen — dims the row + drops it from the bell count, and
   *  persists so a reload doesn't re-surface what you've already acted on. */
  const acknowledgeAlert = useCallback((id: string) => {
    setSeenAlerts((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      try { window.localStorage.setItem('o8:canvas-alerts-seen', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  /** Alerts dropdown → jump to the surface that resolves the row, and mark it
   *  seen. A review opens (or focuses) the PR diff card — the review branch vs
   *  its base, NOT the active repo's working tree (that mismatch was the bug).
   *  Everything else — the mirrored chat, a pending approval, an agent alert —
   *  opens the orchestrator dock, where those threads and approvals live. */
  const jumpToAlert = useCallback((item: InboxRow) => {
    setTopMenu(null);
    acknowledgeAlert(item.id);
    if (item.kind === 'review') {
      const open = diffCards.find((card) => card.laneId.startsWith('review:'));
      if (open) focusDiffCard(open.id);
      else void spawnReviewDiffCard();
      return;
    }
    setDockOpen(true);
  }, [acknowledgeAlert, diffCards, focusDiffCard, spawnReviewDiffCard]);

  // Agents reach this browser too — o8_view_open_browser (operator MCP)
  // dispatches this same event for the default side; on canvas it lands as
  // a browser card. New tab per URL, reusing an existing tab on a match.
  useEffect(() => {
    const onOpenBrowser = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string | null }>).detail?.url?.trim() || `${window.location.origin}/dashboard`;
      setBrowserCards((previous) => {
        if (previous.length === 0) {
          const id = nextIdRef.current;
          nextIdRef.current += 1;
          zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
          const spot = findFreeSpot(640, 492);
          return [{ id, x: spot.x, y: spot.y, z: zPeakRef.current, w: 640, h: 400, tabs: [{ id: 1, url }], activeTabId: 1 }];
        }
        const top = previous.reduce((best, card) => (card.z > best.z ? card : best), previous[0]);
        return previous.map((card) => {
          if (card.id !== top.id) return card;
          const existing = card.tabs.find((tab) => tab.url === url);
          if (existing) return { ...card, activeTabId: existing.id };
          const nextTabId = card.tabs.reduce((max, tab) => Math.max(max, tab.id), 0) + 1;
          return { ...card, tabs: [...card.tabs, { id: nextTabId, url }], activeTabId: nextTabId };
        });
      });
    };
    window.addEventListener('o8:open-browser', onOpenBrowser);
    return () => window.removeEventListener('o8:open-browser', onOpenBrowser);
  }, [findFreeSpot, setBrowserCards, zPeakRef]);

  const changeTermVeil = useCallback((value: number) => {
    setTermVeil(value);
    try {
      window.localStorage.setItem(TERM_VEIL_KEY, String(value));
    } catch {
      // non-critical — the dialed value just won't survive reload
    }
  }, []);

  useCanvasSnapshot({
    activeRepoPath, dockOpen, termCards, fileCards, treeCards, imageCards, videoCards,
    browserCards, chatCards, diffCards, specCards, markdownCards, brainCards,
    setActiveRepoPath, setDockOpen, setBrowserCards, setSpecCards, setBrainCards,
    setImageCards, setMarkdownCards, setVideoCards, nextIdRef, zPeakRef, canvasMedia,
    getMedia, checkAliveSessions, spawnFileCard, spawnFileTreeCard, pickThread,
    spawnDiffCard, spawnWorktreeDiffCard, spawnTerminal, reattachTerminal,
  });

  // Finder "Open With → o8" / dock drop — drain the OS-handed paths into
  // file cards, both at mount (cold launch routed here by FileOpenBridge)
  // and live while the canvas is up.
  useEffect(() => {
    if (!canvasEnabled || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const drain = () => {
      void takePendingFileOpens().then((paths) => {
        if (disposed) return;
        paths.forEach((path) => spawnFileCard(path));
      });
    };
    drain();
    void onFileOpenRequest(() => drain()).then((dispose) => {
      if (disposed) dispose?.();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [canvasEnabled, spawnFileCard]);

  /** Rail Open file: native Tauri picker when present, visible path fallback otherwise. */
  const openFilePicker = useCallback(() => {
    setFilePathPickerOpen(false);
    setFilePickerBusy(true);
    void (async () => {
      if (isTauri()) {
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const chosen = await open({ multiple: false, directory: false, title: 'Open a file on the canvas' });
          const path = Array.isArray(chosen) ? chosen[0] : chosen;
          if (typeof path === 'string' && path) {
            openPathAsFileCard(path);
            return;
          }
          showCanvasToast('No file selected.', 'info');
          return;
        } catch {
          showCanvasToast('Native file picker unavailable. Enter a path instead.', 'error');
        }
      } else {
        showCanvasToast('Enter an absolute path to open a file card.', 'info');
      }
      setFilePathPickerOpen(true);
    })().finally(() => setFilePickerBusy(false));
  }, [openPathAsFileCard, showCanvasToast]);

  /** The spawn-dock terminal button opens the cwd picker; rows spawn. */
  const toggleTermPicker = useCallback(() => {
    setTermPickerOpen((value) => !value);
  }, []);

  /** Close = exit the shell (kills the tmux session) + detach + drop the card. */
  const closeTerminal = useCallback((card: TermCard) => {
    if (card.sessionName && !card.exited) {
      sendTerminalInput(card.sessionName, 'exit\n');
      sendTerminalDetach(card.sessionName);
      liveSessionsRef.current.delete(card.sessionName);
      xtermHandlesRef.current.delete(card.sessionName);
    }
    setTermCards((previous) => previous.filter((existing) => existing.id !== card.id));
  }, [sendTerminalDetach, sendTerminalInput, setTermCards]);

  const registerXtermHandle = useCallback((sessionName: string, handle: XtermPanelHandle | null) => {
    if (handle) xtermHandlesRef.current.set(sessionName, handle);
    else xtermHandlesRef.current.delete(sessionName);
  }, []);

  // Leaving the canvas exits every live canvas shell — they are canvas
  // objects, not dashboard tabs; lingering tmux sessions would get adopted
  // by the dashboard's terminal restore.
  useEffect(() => {
    const sessions = liveSessionsRef.current;
    return () => {
      for (const sessionName of sessions) {
        sendTerminalInput(sessionName, 'exit\n');
        sendTerminalDetach(sessionName);
      }
      sessions.clear();
    };
  }, [sendTerminalDetach, sendTerminalInput]);

  const {
    spawnImageCard,
    moveImageCard,
    resizeImageCard,
    closeImageCard,
    dropImageCard,
    cycleImageCard,
    spreadImageCard,
    spawnVideoCard,
    moveVideoCard,
    resizeVideoCard,
    setVideoPoster,
    closeVideoCard,
    dropImages,
  } = useCanvasMediaSpawners({
    nextIdRef,
    zPeakRef,
    imageCardsRef,
    canvasMedia,
    setImageCards,
    setVideoCards,
    setDropTargetId,
  });

  const spawnUiLoopProofCard = useUiLoopProofCardSpawner(canvasCardsRef, nextIdRef, zPeakRef, setImageCards, findFreeSpot);

  const canvasViewport = useCallback((nextZoom = canvasZoomLevel, nextPan?: { x: number; y: number }) => {
    const p = nextPan ?? pan;
    return {
      x: Math.round((0 - p.x) / nextZoom),
      y: Math.round((0 - p.y) / nextZoom),
      w: Math.round(winSize.w / nextZoom),
      h: Math.round(winSize.h / nextZoom),
      zoom: nextZoom,
    };
  }, [canvasZoomLevel, pan, winSize.h, winSize.w]);

  const animatePanTo = useCallback((target: { x: number; y: number }) => {
    if (panTweenRef.current !== null) cancelAnimationFrame(panTweenRef.current);
    const start = { ...pan };
    const started = performance.now();
    const duration = 350;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - t) ** 3;
      setPan({
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      });
      if (t < 1) panTweenRef.current = requestAnimationFrame(tick);
      else panTweenRef.current = null;
    };
    panTweenRef.current = requestAnimationFrame(tick);
  }, [pan]);

  const cardDomText = useCallback((id: number) => {
    const node = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement | null;
    if (!node) return '';
    const textarea = node.querySelector('textarea') as HTMLTextAreaElement | null;
    if (textarea) return textarea.value;
    return node.innerText.trim();
  }, []);

  const readCanvasCard = useCallback((kind: CanvasCardKind, card: CanvasCardLite, lines: number) => {
    let content = '';
    let truncated = false;
    if (kind === 'term') {
      if (!card.sessionName) return { ok: false, error: 'content-unavailable' };
      content = xtermHandlesRef.current.get(card.sessionName)?.readText(lines) ?? '';
      if (!content) return { ok: false, error: 'content-unavailable' };
    } else if (kind === 'chat') {
      const entries = (card.entries ?? []).slice(-lines);
      content = entries.map((entry) => {
        const role = typeof entry.role === 'string' ? entry.role : 'entry';
        const text = 'text' in entry && typeof entry.text === 'string'
          ? entry.text
          : 'body' in entry && typeof entry.body === 'string'
            ? entry.body
            : 'title' in entry && typeof entry.title === 'string'
              ? entry.title
              : JSON.stringify(entry);
        return `${role}: ${text}`;
      }).join('\n');
    } else if (kind === 'markdown') {
      content = card.markdown ?? '';
    } else if (kind === 'diff') {
      content = card.diff ?? '';
      truncated = Boolean(card.truncated);
    } else if (kind === 'file') {
      content = cardDomText(card.id);
      if (!content) return { ok: false, error: 'content-unavailable' };
    } else if (kind === 'tree') {
      content = cardDomText(card.id);
      if (!content) return { ok: false, error: 'content-unavailable' };
    } else if (kind === 'brain') {
      content = cardDomText(card.id);
      if (!content || content.startsWith('Ask the Engineering Brain')) return { ok: false, error: 'content-unavailable' };
    } else if (kind === 'spec') {
      return { ok: false, error: 'unsupported-kind' };
    } else if (kind === 'browser') {
      const active = card.tabs?.find((tab) => tab.id === card.activeTabId) ?? card.tabs?.[0];
      return { ok: true, content: { url: active?.url ?? null, title: active?.title ?? canvasCardTitle(kind, card) }, truncated: false };
    } else if (kind === 'image') {
      return { ok: true, content: { items: card.items ?? [], count: card.items?.length ?? 0 }, truncated: false };
    } else if (kind === 'video') {
      return { ok: true, content: { src: card.src ?? null, name: card.name ?? null, mediaId: card.mediaId ?? null, poster: Boolean(card.poster) }, truncated: false };
    } else if (kind === 'agent') {
      const lane = activeLanes.find((row) => row.id === card.laneId) ?? null;
      const phase = phaseFor(lane?.status ?? 'done');
      const transcriptKey = lane?.repoPath ?? card.repoPath ?? null;
      const transcript = (transcriptKey ? convos[transcriptKey] : undefined) ?? [];
      const transcriptTail = transcript.slice(-lines).map(dockEntryReadLine).filter(Boolean);
      content = [
        `phase: ${phase.label}`,
        `status: ${lane?.status ?? 'done'}`,
        `task: ${card.title ?? ''}`,
        `repo: ${lane?.repoPath ?? ''}`,
        `runtime: ${lane?.runtime ?? card.runtime ?? ''}`,
        transcriptTail.length ? `transcript:\n${transcriptTail.join('\n')}` : '',
      ].filter(Boolean).join('\n');
    } else {
      return { ok: false, error: 'unsupported-kind' };
    }
    const capped = capCanvasReadContent(content);
    return { ok: true, content: capped.content, truncated: truncated || capped.truncated };
  }, [activeLanes, cardDomText, convos]);

  const {
    minimapCards,
    loupeArea,
    patchCanvasCardGeom,
    dismissCanvasCard,
  } = useCanvasGrid({
    termCards,
    setTermCards,
    fileCards,
    setFileCards,
    treeCards,
    setTreeCards,
    imageCards,
    setImageCards,
    videoCards,
    setVideoCards,
    browserCards,
    setBrowserCards,
    chatCards,
    setChatCards,
    diffCards,
    setDiffCards,
    specCards,
    setSpecCards,
    brainCards,
    setBrainCards,
    markdownCards,
    setMarkdownCards,
    agentCards,
    setAgentCards,
    canvasCardsRef,
    gridMode,
    setGridMode,
    winSize,
    setWinSize,
    pan,
    setPan,
    panRef,
    canvasZoomLevel,
    dockOpen,
    activeLanes,
    dockTrayExpanded,
    gridItemsRef,
    gridAnimRef,
    setGridPlaceholder,
    closeTerminal,
    closeFileCard,
    closeTreeCard,
    closeImageCard,
    closeVideoCard,
    closeBrowserCard,
    closeChatCard,
  });

  const commandPaletteCommands = useCanvasIntentBus({
    activeRepoPath,
    repos,
    convos,
    canvasEnabled,
    canvasZoomLevel,
    dockOpen,
    gridMode,
    pan,
    winSize,
    nextIdRef,
    composerInputRef,
    canvasCardsRef,
    findCanvasCard,
    focusCard,
    imageCardsRef,
    setImageCards,
    zPeakRef,
    pickThread,
    redockActiveLane,
    patchCanvasCardGeom,
    dismissCanvasCard,
    cycleImageCard,
    spreadImageCard,
    spawnImageCard,
    spawnVideoCard,
    spawnAgents,
    spawnBrainCard,
    spawnBrowserCard,
    spawnFileCard,
    spawnFileTreeCard,
    spawnMarkdownCard,
    spawnSpecCard,
    spawnWorktreeDiffCard,
    setSessionsOpen,
    setSearchQuery,
    setSearchOpen,
    setCanvasZoomLevel,
    setDockOpen,
    setGridMode,
    openFilePicker,
    showCanvasToast,
    viewportSpawnOrigin,
    spawnTerminal,
    sendPrompt,
    spawnUiLoopProofCard,
    canvasViewport,
    animatePanTo,
    readCanvasCard,
  });

  if (!canvasEnabled) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0c10', fontFamily: FONT }}>
        <span style={{ fontSize: 13, fontWeight: 300, color: 'rgba(255,255,255,0.65)', letterSpacing: '-0.1px', textAlign: 'center', lineHeight: 1.6, maxWidth: 380 }}>
          Canvas mode is off.
          <br />
          Enable “Experimental: Canvas mode” in Settings → Operator Defaults to unlock this surface.
        </span>
      </div>
    );
  }

  // The dock's switcher only lists lanes that are actually running (have a
  // conversation) — scoping a NEW repo happens from the composer chip.
  const runningLanes: OrchestratorLane[] = (repos ?? [])
    .filter((repo) => (convos[repo.path]?.length ?? 0) > 0)
    .map((repo) => ({
      id: repo.path,
      label: repo.name,
      repo: repo.name,
      tone: repo.path === activeRepoPath && orchBusy ? 'working' : 'idle',
    }));
  const activeRepoName = repos?.find((repo) => repo.path === activeRepoPath)?.name ?? null;
  const activeConvo = convos[activeRepoPath ?? ''] ?? [];
  const hasTalked = Object.values(convos).some((entries) => entries.length > 0);
  // Composer dispatch dock — real dispatched packets, or the dev demo seed when
  // one is set (so the motion is visible with nothing actually running).
  const dispatchLanes: DispatchLane[] = activeLanes;

  return (
    // In the app the transparent window loses macOS's corner mask — clip the
    // whole canvas to the window radius ourselves (continuous curve). The
    // desktop reads through the clipped corners, restoring the Apple edge.
    <SmoothCorners
      corners={{ radius: inTauri ? 12 : 0 }}
      autoEffects={false}
      onDragOver={(event) => { event.preventDefault(); }}
      onDrop={dropImages}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', fontFamily: FONT, background: inTauri ? 'transparent' : '#07090d', userSelect: 'none' }}
    >
      <style>{CARD_ENTRANCE.keyframes}</style>
      {/* Realtime voice host — also mounted here (not just the dashboard) so the
          full-page nav into the canvas auto-resumes the session via the handoff
          instead of going silent. Renders only its own fixed pill. */}
      <RealtimeVoiceHost />
      <SymonVoicePresencePill />
      <CanvasCommandPalette commands={commandPaletteCommands} repo={activeRepoPath} />

      {/* In the app the desktop IS the backdrop (native material). The
          diffusion only stands in where there is no desktop to show. */}
      {inTauri ? null : <DiffusionBackdrop />}

      {/* Window-wide veil + the canvas dot grid — the continuous darkness
          control for the background itself, painted over the material. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--cnv-bg-veil)',
          backgroundImage: 'radial-gradient(circle, var(--cnv-bg-dot, rgba(255,255,255,0.055)) 1px, transparent 1.4px)',
          backgroundSize: '26px 26px',
          pointerEvents: 'none',
          zIndex: 1,
          // Drag-flicker fix: a moving backdrop-filter card forces WebKit to
          // re-rasterize its repaint region, which includes this full-screen
          // veil. Without its own compositor layer the veil drops a frame and
          // the dark native vibrancy (HudWindow) flashes through. Pin it to a
          // persistent, isolated GPU layer so card movement never re-paints it.
          transform: 'translateZ(0)',
          willChange: 'transform',
          backfaceVisibility: 'hidden',
          WebkitBackfaceVisibility: 'hidden',
          isolation: 'isolate',
        } as React.CSSProperties}
      />

      {/* Depth layer — the paper/shader mood from the Canvas tuner. */}
      <CanvasBackdropLayer kind={settings.backdrop} tone={settings.tone} customBackground={settings.customBackground} />

      {/* Center emblem retired (operator call 2026-06-12) — the empty
          canvas stays clean; a logo / Lottie motion piece comes later. */}

      {/* ── The card layer — CSS-zoomed as one unit. Chrome (top dock,
            rails, composer, drawers) stays at 1:1; only the workspace
            scales, buying breathing room around the cards. Drag/resize
            handlers divide pointer deltas by the zoom (canvasZoom()). */}
      <CanvasCardLayers
        canvasZoomLevel={canvasZoomLevel}
        pan={pan}
        termCards={termCards}
        fileCards={fileCards}
        treeCards={treeCards}
        imageCards={imageCards}
        videoCards={videoCards}
        browserCards={browserCards}
        diffCards={diffCards}
        agentCards={agentCards}
        brainCards={brainCards}
        markdownCards={markdownCards}
        chatCards={chatCards}
        specCards={specCards}
        activeLanes={activeLanes}
        convos={convos}
        dropTargetId={dropTargetId}
        specScreenMap={specScreenMap}
        terminal={{
          termVeil,
          connectionEpoch: wsEpoch,
          onMove: moveTermCard,
          onResize: resizeTermCard,
          onFocus: focusTermCard,
          onClose: closeTerminal,
          onTermVeilChange: changeTermVeil,
          registerHandle: registerXtermHandle,
          sendTerminalAttach,
          sendTerminalInput,
          sendTerminalResize,
          sendTerminalDetach,
        }}
        file={{ termVeil, onMove: moveFileCard, onResize: resizeFileCard, onFocus: focusFileCard, onClose: closeFileCard }}
        tree={{ spawnFileCard, onMove: moveTreeCard, onResize: resizeTreeCard, onFocus: focusTreeCard, onClose: closeTreeCard }}
        image={{ onMove: moveImageCard, onResize: resizeImageCard, onFocus: focusImageCard, onDrop: dropImageCard, cycleImageCard, onSpread: spreadImageCard, onClose: closeImageCard }}
        video={{ onMove: moveVideoCard, onResize: resizeVideoCard, onFocus: focusVideoCard, onClose: closeVideoCard, onPoster: setVideoPoster }}
        browser={{ onMove: moveBrowserCard, onResize: resizeBrowserCard, onFocus: focusBrowserCard, onTabsChange: changeBrowserTabs, onClose: closeBrowserCard }}
        diff={{ onMove: moveDiffCard, onResize: resizeDiffCard, onFocus: focusDiffCard, onClose: closeDiffCard, onRequestChanges: requestDiffCardChanges, onRefresh: refreshWorktreeDiffCard }}
        agent={{ onMove: moveAgentCard, onResize: resizeAgentCard, onFocus: focusAgentCard, onClose: closeAgentCard, onReview: reviewAgentCard, onToggleExpand: toggleAgentCardExpand }}
        brain={{ onMove: moveBrainCard, onResize: resizeBrainCard, onFocus: focusBrainCard, onClose: closeBrainCard }}
        markdown={{ onMove: moveMarkdownCard, onResize: resizeMarkdownCard, onFocus: focusMarkdownCard, onClose: closeMarkdownCard }}
        chat={{ sendDefaults: chatSendDefaults, onLiveEvent: handleOrchEvent, onUserSend: noteCardSend, onTruncate: truncateLane, onMove: moveChatCard, onResize: resizeChatCard, onFocus: focusChatCard, onDock: dockChatCard, onClose: closeChatCard }}
        spec={{ onMove: moveSpecCard, onResize: resizeSpecCard, onFocus: focusSpecCard, onClose: closeSpecCard }}
      >
      {/* ── Grid drag placeholder — the ghost slot the lifted card will land in.
            Sits behind the cards in the hole they reflow open; glides between
            slots as the target changes. ─────────────────────────────────── */}
      {gridPlaceholder ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: gridPlaceholder.x,
            top: gridPlaceholder.y,
            width: gridPlaceholder.w,
            height: gridPlaceholder.h,
            borderRadius: 22,
            border: '2px dashed var(--cnv-ink-muted)',
            background: 'rgba(255, 255, 255, 0.04)',
            opacity: 0.6,
            zIndex: 0,
            pointerEvents: 'none',
            transition: 'left 130ms ease, top 130ms ease, width 130ms ease, height 130ms ease',
          }}
        />
      ) : null}

      {/* ── Component cards ──────────────────────────────────────── */}
      {cards.map((card) => (
        <CanvasCard key={card.id} card={card} selected={selectedCardId === card.id} onMove={moveCard} onSelect={setSelectedCardId} />
      ))}
      </CanvasCardLayers>

      {/* ── Top dock — the important header controls ─────────────── */}
      <div
        style={{
          position: 'absolute',
          top: 18,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 40,
          paddingLeft: 16,
          paddingRight: 10,
          borderRadius: 20,
          zIndex: 40,
          ...glass(true),
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 500, letterSpacing: '0.02em' }}>o8</span>
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <button
          type="button"
          aria-label="Glass tuner"
          onClick={() => setTunerOpen((value) => !value)}
          style={{
            borderWidth: 0,
            background: 'transparent',
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            paddingRight: 0,
            fontSize: 11.5,
            fontWeight: tunerOpen ? 400 : 300,
            color: tunerOpen ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
            cursor: 'pointer',
            fontFamily: FONT,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { if (!tunerOpen) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          Canvas
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <DockGlyphButton
          label="Agents"
          active={topMenu === 'agents'}
          badge={activeLanes.length}
          onClick={() => setTopMenu((value) => (value === 'agents' ? null : 'agents'))}
          path="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
          extra={<circle cx="9" cy="7" r="4" />}
        />
        <DockGlyphButton
          label="Alerts"
          active={topMenu === 'alerts'}
          badge={inboxItems.filter((item) => !seenAlerts.has(item.id)).length}
          onClick={() => setTopMenu((value) => (value === 'alerts' ? null : 'alerts'))}
          path="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"
        />
        <DockGlyphButton
          label="Orchestrators"
          active={dockOpen}
          onClick={() => (dockOpen ? undockToCard() : redockActiveLane())}
          path="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
          extra={<path d="M15 3v18" />}
        />
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <button
          type="button"
          onClick={() => {
            // Restore the chrome BEFORE the hard navigation — the unmount
            // cleanup is not guaranteed across location.assign.
            void Promise.allSettled([setCanvasMaterial('default'), setCanvasBackdropBlur(0)]).then(() => {
              window.location.assign('/dashboard');
            });
          }}
          style={{
            borderWidth: 0,
            background: 'transparent',
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 4,
            paddingRight: 6,
            fontSize: 11,
            fontWeight: 300,
            color: 'var(--cnv-ink-muted)',
            cursor: 'pointer',
            fontFamily: FONT,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          Exit
        </button>
      </div>

      {/* Top-dock popovers — live agents / live inbox, real data. */}
      <AnimatePresence>
        {topMenu === 'agents' || topMenu === 'alerts' ? (
          <>
            <div role="presentation" onClick={() => setTopMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              style={{
                position: 'absolute',
                top: 64,
                left: '50%',
                marginLeft: -150,
                width: 300,
                maxHeight: 320,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 6,
                paddingRight: 6,
                borderRadius: 13,
                zIndex: 46,
                scrollbarWidth: 'none',
                ...glassPop(),
              } as React.CSSProperties}
            >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 4 }}>
                {topMenu === 'agents' ? 'Running agents' : 'Alerts'}
              </span>
              {topMenu === 'agents' ? (
                activeLanes.length === 0 ? (
                  <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingTop: 2, paddingBottom: 4 }}>
                    No agents running — dispatch from the orchestrator below.
                  </span>
                ) : (
                  activeLanes.slice(0, 10).map((lane) => (
                    <div key={lane.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8 }}>
                      <span
                        aria-hidden
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: lane.status === 'running' || lane.status === 'launching'
                            ? '#22c55e'
                            : lane.status === 'awaiting_input' || lane.status === 'reviewing'
                              ? '#f59e0b'
                              : lane.status === 'failed'
                                ? '#ef4444'
                                : 'rgba(255,255,255,0.4)',
                        }}
                      />
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, fontFamily: FONT }}>
                        <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {lane.label || lane.id}
                        </span>
                        <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                          {[lane.repoPath?.split('/').pop(), lane.runtime, lane.status].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </div>
                  ))
                )
              ) : inboxItems.length === 0 ? (
                <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingTop: 2, paddingBottom: 4 }}>
                  All clear — nothing needs you.
                </span>
              ) : (
                inboxItems.slice(0, 10).map((item) => {
                  const seen = seenAlerts.has(item.id);
                  return (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => jumpToAlert(item)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      borderWidth: 0,
                      background: 'transparent',
                      cursor: 'pointer',
                      borderRadius: 8,
                      paddingTop: 6,
                      paddingBottom: 6,
                      paddingLeft: 8,
                      paddingRight: 8,
                      fontFamily: FONT,
                      opacity: seen ? 0.5 : 1,
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        flexShrink: 0,
                        marginTop: 4,
                        background: seen
                          ? 'rgba(255,255,255,0.22)'
                          : item.severity === 'critical' || item.severity === 'high'
                            ? '#ef4444'
                            : item.kind === 'approval' || item.severity === 'warning'
                              ? '#f59e0b'
                              : 'rgba(255,255,255,0.4)',
                      }}
                    />
                    <span style={{ display: 'flex', flex: 1, flexDirection: 'column', gap: 1, minWidth: 0, fontFamily: FONT }}>
                      <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.title}
                      </span>
                      {item.detail ? (
                        <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.detail}
                        </span>
                      ) : null}
                    </span>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, marginTop: 3, opacity: 0.4 }}>
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                  );
                })
              )}
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      {/* ── Top-right — search + the operator (reference borrow) ──── */}
      <div
        style={{
          position: 'absolute',
          top: 18,
          right: 24,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          paddingLeft: 6,
          paddingRight: 6,
          borderRadius: 20,
          zIndex: 41,
          ...glass(true),
        }}
      >
        <CanvasFeedbackButton />
        <button
          type="button"
          aria-label="Search the canvas"
          onClick={() => setSearchOpen((value) => !value)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderWidth: 0,
            background: 'transparent',
            borderRadius: 14,
            color: searchOpen ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
            cursor: 'pointer',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { if (!searchOpen) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          {/* width/height as inline style — attribute sizing collapses to 0
              in this flex context (the missing-search-icon bug). */}
          <svg style={{ width: 13, height: 13, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Account"
          onClick={() => setTopMenu((value) => (value === 'profile' ? null : 'profile'))}
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: topMenu === 'profile' ? 'var(--cnv-ink-muted)' : 'var(--cnv-edge)',
            backgroundColor: auth.signedIn && auth.user?.avatarUrl ? 'transparent' : 'var(--cnv-tint)',
            backgroundImage: auth.signedIn && auth.user?.avatarUrl ? `url("${auth.user.avatarUrl}")` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: topMenu === 'profile' ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
            flexShrink: 0,
            cursor: 'pointer',
            overflow: 'hidden',
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            paddingRight: 0,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { if (topMenu !== 'profile') event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          {auth.signedIn && auth.user?.avatarUrl ? null : (
            <svg style={{ width: 12, height: 12, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
            </svg>
          )}
        </button>
      </div>

      {/* Account dossier — the Clerk sign-in popover (operator's reference). */}
      <AnimatePresence>
        {topMenu === 'profile' ? (
          <>
            <div role="presentation" onClick={() => setTopMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              style={{
                position: 'absolute',
                top: 64,
                right: 24,
                width: 268,
                display: 'flex',
                flexDirection: 'column',
                paddingTop: 14,
                paddingBottom: 10,
                paddingLeft: 14,
                paddingRight: 14,
                borderRadius: 16,
                zIndex: 46,
                fontFamily: FONT,
                ...glassPop(),
              }}
            >
              {auth.signedIn && auth.user ? (
                <>
                  {/* Identity — avatar, name, email. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 2, paddingRight: 2, paddingBottom: 12 }}>
                    <div
                      aria-hidden
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        flexShrink: 0,
                        backgroundColor: 'var(--cnv-tint)',
                        backgroundImage: auth.user.avatarUrl ? `url("${auth.user.avatarUrl}")` : undefined,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        border: '1px solid var(--cnv-edge)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--cnv-ink-muted)',
                      }}
                    >
                      {auth.user.avatarUrl ? null : (
                        <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                        </svg>
                      )}
                    </div>
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {auth.user.name || 'Account'}
                      </span>
                      {auth.user.email ? (
                        <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {auth.user.email}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div aria-hidden style={{ height: 1, background: 'var(--cnv-edge)', marginLeft: 2, marginRight: 2, marginBottom: 6 }} />
                  <button
                    type="button"
                    onClick={() => { auth.openManageAccount(); setTopMenu(null); }}
                    style={DOSSIER_ROW}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={DOSSIER_TILE} aria-hidden>
                      <svg style={{ width: 15, height: 15 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 4 6.5v9L12 20l8-4.5v-9L12 2Z" /><circle cx="12" cy="11.5" r="2.6" /></svg>
                    </span>
                    Manage account
                  </button>
                  <button
                    type="button"
                    onClick={() => { void auth.signOut(); setTopMenu(null); }}
                    style={DOSSIER_ROW}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={DOSSIER_TILE} aria-hidden>
                      <svg style={{ width: 15, height: 15 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
                    </span>
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  {/* Signed-out is the complete local profile; account is optional. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 2, paddingRight: 2, paddingBottom: 12 }}>
                    <div aria-hidden style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, background: 'var(--cnv-tint)', border: '1px solid var(--cnv-edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cnv-ink-muted)' }}>
                      <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                      </svg>
                    </div>
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: '-0.1px', color: 'var(--cnv-ink)' }}>Local profile</span>
                      <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.45 }}>
                        Free · stored on this Mac
                      </span>
                    </div>
                  </div>
                  <div aria-hidden style={{ height: 1, background: 'var(--cnv-edge)', marginLeft: 2, marginRight: 2, marginBottom: 6 }} />
                  <button
                    type="button"
                    onClick={() => { auth.signIn(); setTopMenu(null); }}
                    style={DOSSIER_ROW}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={DOSSIER_TILE} aria-hidden>
                      <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                    </span>
                    Sign in to o8
                  </button>
                </>
              )}
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      {/* Search popover — Enter brings the first matching card forward. */}
      <AnimatePresence>
        {searchOpen ? (
          <CanvasSearchOverlay
            query={searchQuery}
            activeRepoPath={activeRepoPath}
            onQueryChange={setSearchQuery}
            onClose={() => setSearchOpen(false)}
            onFocusCard={focusCard}
            onPickThread={pickThread}
            spawnFileCard={spawnFileCard}
            termCards={termCards}
            fileCards={fileCards}
            imageCards={imageCards}
            browserCards={browserCards}
            chatCards={chatCards}
            diffCards={diffCards}
            specCards={specCards}
            brainCards={brainCards}
            recentThreads={recentThreads}
          />
        ) : null}
      </AnimatePresence>

      {/* ── Left spawn dock — the component vocabulary ───────────── */}
      <ProximityDock
        axis="y"
        itemRadius={11}
        style={{
          position: 'absolute',
          left: 16,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 6,
          paddingRight: 6,
          borderRadius: 16,
          zIndex: 40,
          ...glass(true),
        }}
      >
        <SpawnGlyphButton
          label="Message the orchestrator"
          onClick={() => {
            if ((convos[activeRepoPath ?? '']?.length ?? 0) > 0) redockActiveLane();
            composerInputRef.current?.focus();
          }}
        >
          <circle cx="12" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M12 8v4M12 12l-6 4M12 12l6 4" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Sessions" onClick={() => setSessionsOpen((value) => !value)}>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn browser" onClick={spawnBrowserCard}>
          <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn terminal" onClick={toggleTermPicker}>
          <path d="m4 17 6-6-6-6" /><line x1="12" x2="20" y1="19" y2="19" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Open file" onClick={openFilePicker}>
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Review diffs" onClick={() => setReviewPickerOpen((value) => !value)}>
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect width="8" height="4" x="8" y="2" rx="1" /><path d="m9 14 2 2 4-4" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Open o8.md" onClick={spawnSpecCard}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </SpawnGlyphButton>
      </ProximityDock>

      <AnimatePresence>
        {filePathPickerOpen ? (
          <>
            <div role="presentation" onClick={() => setFilePathPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.form
              initial={{ opacity: 0, x: -10, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -10, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              onSubmit={(event) => {
                event.preventDefault();
                openPathAsFileCard(filePathInput);
              }}
              style={{
                ...glassPop(),
                position: 'absolute',
                left: 64,
                top: '50%',
                marginTop: -26,
                width: 316,
                display: 'flex',
                flexDirection: 'column',
                gap: 9,
                paddingTop: 12,
                paddingBottom: 12,
                paddingLeft: 12,
                paddingRight: 12,
                borderRadius: 14,
                zIndex: 46,
                fontFamily: FONT,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)' }}>
                  Open file
                </span>
                <button
                  type="button"
                  aria-label="Close file path picker"
                  onClick={() => setFilePathPickerOpen(false)}
                  style={{ width: 22, height: 22, borderWidth: 0, borderRadius: 8, background: 'transparent', color: 'var(--cnv-ink-muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
                >
                  <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, borderRadius: 10, border: '1px solid var(--cnv-edge)', background: 'var(--cnv-tint)', paddingLeft: 10, paddingRight: 8 }}>
                <input
                  autoFocus
                  value={filePathInput}
                  onChange={(event) => setFilePathInput(event.target.value)}
                  placeholder="/Users/you/project/file.ts"
                  aria-label="Absolute file path"
                  style={{ flex: 1, minWidth: 0, borderWidth: 0, outline: 'none', background: 'transparent', color: 'var(--cnv-ink)', fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px', fontFamily: FONT }}
                />
                <button
                  type="submit"
                  disabled={filePickerBusy}
                  style={{ height: 24, paddingLeft: 10, paddingRight: 10, borderRadius: 8, border: '1px solid var(--cnv-edge)', background: 'var(--cnv-tint-deep)', color: 'var(--cnv-ink)', cursor: filePickerBusy ? 'default' : 'pointer', fontFamily: FONT, fontSize: 11, fontWeight: 300 }}
                >
                  Open
                </button>
              </div>
            </motion.form>
          </>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {canvasToast ? (
          <motion.div
            key={canvasToast.id}
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            role="status"
            style={{
              ...glassPop(),
              position: 'absolute',
              top: 18,
              left: 0,
              right: 0,
              width: 'fit-content',
              marginLeft: 'auto',
              marginRight: 'auto',
              zIndex: 60,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              maxWidth: 360,
              paddingTop: 9,
              paddingBottom: 9,
              paddingLeft: 12,
              paddingRight: 13,
              borderRadius: 14,
              fontFamily: FONT,
              fontSize: 11.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              border: `1px solid ${canvasToast.tone === 'error' ? 'var(--t-danger, #ef4444)' : canvasToast.tone === 'success' ? 'var(--t-success, #16a34a)' : 'var(--cnv-edge)'}`,
              color: canvasToast.tone === 'error' ? 'var(--t-danger, #ef4444)' : 'var(--cnv-ink)',
            }}
          >
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: canvasToast.tone === 'error' ? 'var(--t-danger, #ef4444)' : canvasToast.tone === 'success' ? 'var(--t-success, #16a34a)' : 'var(--cnv-ink-muted)' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{canvasToast.message}</span>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── Navigator loupe (#1239) — minimap + −/fit/+ zoom + Free/Grid toggle,
            replacing the old zoom-level chip. Bottom-left. ───────────── */}
      <NavigatorLoupe
        cards={minimapCards}
        area={loupeArea}
        size={loupeSize}
        zoomSteps={ZOOM_STEPS}
        zoomValue={canvasZoomLevel}
        onZoomChange={setCanvasZoomLevel}
        gridMode={gridMode}
        onGridModeChange={setGridMode}
        onPanBy={(dx, dy) => setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }))}
        orbSettings={orbSettings}
        onOrbChange={updateOrbSettings}
        onOrbReset={resetOrbSettings}
        tone={settings.tone}
        panKey={Math.round(pan.x) + Math.round(pan.y)}
      />

      {/* ── Terminal cwd drawer — same system as the Sessions drawer:
            tuner-matched glass, hard edges, the list dissolves at both
            ends as you scroll. ───── */}
      <AnimatePresence>
        {termPickerOpen ? (
          <>
            <div role="presentation" onClick={() => setTermPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              data-canvas-chrome
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              style={{
                position: 'absolute',
                left: 64,
                top: 74,
                bottom: 96,
                width: 272,
                display: 'flex',
                flexDirection: 'column',
                paddingTop: 12,
                paddingBottom: 4,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 6,
                zIndex: 46,
                ...glass(true),
              }}
            >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 7 }}>
                Open terminal in
              </span>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  paddingTop: 14,
                  paddingBottom: 18,
                  scrollbarWidth: 'none',
                  maskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                } as React.CSSProperties}
              >
                {HOME_AGENTS.map((agent) => (
                  <PickerRow
                    key={agent.id}
                    name={`${agent.label} agent`}
                    path="local · ~"
                    onClick={() => {
                      // Home agent (#1244): an all-local agent CLI session in the
                      // home dir (no repo / worktree / governance) — auto-launches
                      // the chosen CLI on attach. Bypasses the mission pipeline.
                      spawnTerminal(null, `${agent.label} · ~`, undefined, { agentCli: agent.command });
                      setTermPickerOpen(false);
                    }}
                  />
                ))}
                <PickerRow
                  name="Home"
                  path="~"
                  onClick={() => {
                    spawnTerminal(null, null);
                    setTermPickerOpen(false);
                  }}
                />
                {(repos ?? []).map((repo) => (
                  <PickerRow
                    key={repo.path}
                    name={repo.name}
                    path={repo.path.replace(/^\/Users\/[^/]+/, '~')}
                    onClick={() => {
                      spawnTerminal(repo.path, repo.name);
                      setTermPickerOpen(false);
                    }}
                  />
                ))}
                {repos === null ? (
                  <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingTop: 4 }}>
                    Loading repos…
                  </span>
                ) : null}
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      {/* ── Review drawer — live lanes; in-review first. Click one and
            its diff lands as a glass card with the governance actions. */}
      <AnimatePresence>
        {reviewPickerOpen ? (
          <>
            <div role="presentation" onClick={() => setReviewPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              data-canvas-chrome
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              style={{
                position: 'absolute',
                left: 80,
                top: '50%',
                height: RAIL_PANEL_HEIGHT,
                marginTop: -(RAIL_PANEL_HEIGHT / 2),
                width: 272,
                zIndex: 46,
                display: 'grid',
                // Pin the single row to the box height (minmax 0-floor stops it
                // growing to content) so a long list scrolls INSIDE the 296px
                // panel instead of overflowing it. Plain '1fr' wouldn't — its
                // auto min-floor lets the row grow.
                gridTemplateRows: 'minmax(0, 1fr)',
                fontFamily: FONT,
              }}
            >
              <SmoothCorners
                corners={{ radius: 22 }}
                shadowStrategy="box-shadow"
                style={{ ...LISSE_PANEL_SURFACE, paddingTop: 12, paddingBottom: 4, paddingLeft: 8, paddingRight: 8 }}
              >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 7 }}>
                Review
              </span>
              {/* Pinned — YOUR uncommitted changes, not just agent lanes. */}
              <button
                type="button"
                onClick={() => {
                  void spawnWorktreeDiffCard();
                  setReviewPickerOpen(false);
                }}
                disabled={!activeRepoPath}
                style={{ display: 'flex', alignItems: 'center', gap: 7, paddingTop: 7, paddingBottom: 7, paddingLeft: 8, paddingRight: 8, borderRadius: 9, borderWidth: 0, background: 'transparent', cursor: activeRepoPath ? 'pointer' : 'default', fontFamily: FONT, textAlign: 'left', width: '100%', opacity: activeRepoPath ? 1 : 0.5 }}
                onMouseEnter={(event) => { if (activeRepoPath) event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                <svg style={{ width: 11, height: 11, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M3 21h18" />
                </svg>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px' }}>
                    Your working tree
                  </span>
                  <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                    {activeRepoName ? `uncommitted changes · ${activeRepoName}` : 'pick a repo first'}
                  </span>
                </span>
              </button>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  paddingTop: 14,
                  paddingBottom: 18,
                  scrollbarWidth: 'none',
                  maskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                } as React.CSSProperties}
              >
                {activeLanes.length === 0 ? (
                  <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', paddingLeft: 8, paddingTop: 2, paddingBottom: 4, fontFamily: FONT, lineHeight: 1.6 }}>
                    No agents running yet — dispatch from the composer and lane diffs land here. (Your own changes are above.)
                  </span>
                ) : (
                  [...activeLanes]
                    .sort((a, b) => Number((b.status ?? '').includes('review')) - Number((a.status ?? '').includes('review')))
                    .map((lane) => (
                      <button
                        key={lane.id}
                        type="button"
                        onClick={() => {
                          spawnDiffCard(lane);
                          setReviewPickerOpen(false);
                        }}
                        style={{ display: 'flex', alignItems: 'center', gap: 7, paddingTop: 7, paddingBottom: 7, paddingLeft: 8, paddingRight: 8, borderRadius: 9, borderWidth: 0, background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left', width: '100%' }}
                        onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                      >
                        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: (lane.status ?? '').includes('review') ? TONE_DOT.waiting : TONE_DOT.working, flexShrink: 0 }} />
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 210 }}>
                            {lane.label?.trim() || lane.id}
                          </span>
                          <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                            {[lane.status, lane.runtime].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </button>
                    ))
                )}
              </div>
            </SmoothCorners>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      {/* ── Sessions drawer — history lives on the left, like the
            default page. Glass matches the operator's tuner (no opaque
            slab), hard edges, and the list dissolves at both ends as
            you scroll — the cue that older sessions are down there. */}
      <AnimatePresence>
        {sessionsOpen ? (
          <>
            <div role="presentation" onClick={() => setSessionsOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              data-canvas-chrome
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              style={{
                position: 'absolute',
                left: 80,
                top: '50%',
                height: RAIL_PANEL_HEIGHT,
                marginTop: -(RAIL_PANEL_HEIGHT / 2),
                width: 272,
                zIndex: 46,
                display: 'grid',
                // Pin the single row to the box height (minmax 0-floor stops it
                // growing to content) so a long list scrolls INSIDE the 296px
                // panel instead of overflowing it. Plain '1fr' wouldn't — its
                // auto min-floor lets the row grow.
                gridTemplateRows: 'minmax(0, 1fr)',
                fontFamily: FONT,
              }}
            >
              <SmoothCorners
                corners={{ radius: 22 }}
                shadowStrategy="box-shadow"
                style={{ ...LISSE_PANEL_SURFACE, paddingTop: 12, paddingBottom: 4, paddingLeft: 8, paddingRight: 8 }}
              >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 7 }}>
                Sessions
              </span>
              {/* Repo filter — newest-first stays the spine; chips narrow it. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingLeft: 6, paddingRight: 6, paddingBottom: 4 }}>
                {[null, ...[...new Set(recentThreads.map((thread) => thread.repoName).filter(Boolean))]].map((repoName) => {
                  const active = sessionsRepoFilter === repoName;
                  return (
                    <button
                      key={repoName ?? 'all'}
                      type="button"
                      onClick={() => setSessionsRepoFilter(repoName as string | null)}
                      style={{
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: active ? 'var(--cnv-ink-muted)' : 'var(--cnv-edge)',
                        background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
                        borderRadius: 999,
                        paddingTop: 2,
                        paddingBottom: 2,
                        paddingLeft: 9,
                        paddingRight: 9,
                        fontSize: 9.5,
                        fontWeight: active ? 500 : 300,
                        color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
                        cursor: 'pointer',
                        fontFamily: FONT,
                      }}
                    >
                      {repoName ?? 'All'}
                    </button>
                  );
                })}
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  paddingTop: 14,
                  paddingBottom: 18,
                  scrollbarWidth: 'none',
                  maskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                } as React.CSSProperties}
              >
              {(convos[activeRepoPath ?? '']?.length ?? 0) > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    redockActiveLane();
                    setSessionsOpen(false);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, paddingTop: 7, paddingBottom: 7, paddingLeft: 8, paddingRight: 8, borderRadius: 9, borderWidth: 0, background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left', width: '100%' }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: orchBusy ? TONE_DOT.working : TONE_DOT.idle, flexShrink: 0 }} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--cnv-ink)', letterSpacing: '-0.1px' }}>
                      Live — {activeRepoName ?? 'orchestrator'}
                    </span>
                    <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                      {orchBusy ? 'Working now · open the dock' : 'Open the dock'}
                    </span>
                  </span>
                </button>
              ) : null}
              {recentThreads.length === 0 ? (
                <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', paddingLeft: 8, paddingTop: 2, paddingBottom: 4, fontFamily: FONT }}>
                  No orchestrator sessions yet — talk below.
                </span>
              ) : (
                recentThreads.filter((thread) => !sessionsRepoFilter || thread.repoName === sessionsRepoFilter).slice(0, 20).map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => {
                      pickThread(thread.id, thread.repoPath, { title: thread.title, repoName: thread.repoName });
                      setSessionsOpen(false);
                    }}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8, borderRadius: 9, borderWidth: 0, background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left', width: '100%' }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                      {thread.title?.trim() || 'Untitled session'}
                    </span>
                    <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                      {[thread.repoName, relAge(thread.lastMessageAt)].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                ))
              )}
              </div>
            </SmoothCorners>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      {/* ── Edge hover rail — real commits on the right ──────────── */}
      {dockOpen ? null : (
        <EdgeRail
          side="right"
          open={rightRailOpen}
          onOpenChange={setRightRailOpen}
          title="Activity"
          rows={recentCommits.slice(0, 5).map((commit) => [
            commit.message,
            [commit.hash, relAge(commit.date)].filter(Boolean).join(' · '),
          ])}
          emptyHint="No recent commits on this repo."
        />
      )}

      {/* ── The docked orchestrator (opt-in) ── */}
      <AnimatePresence>
        {dockOpen ? (
          <OrchestratorDock
            lanes={runningLanes}
            entries={activeConvo}
            activeLane={activeRepoPath ?? ''}
            scouts={liveScouts[activeRepoPath ?? ''] ?? []}
            activeLabel={activeRepoName ?? '…'}
            activeTone={orchBusy ? 'working' : 'idle'}
            onSelectLane={setActiveRepoPath}
            onSend={sendPrompt}
            busy={orchBusy}
            queued={mainQueued}
            onCancelQueued={mainCancelQueued}
            undoArmed={mainUndoArmed}
            onUndoSend={mainStopOrUndo}
            onClose={undockToCard}
          />
        ) : null}
      </AnimatePresence>

      {/* Dock affordance — appears once you have talked, until docked. */}
      <AnimatePresence>
        {hasTalked && !dockOpen ? (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            onClick={redockActiveLane}
            style={{
              position: 'absolute',
              bottom: 86,
              right: 24,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 999,
              cursor: 'pointer',
              zIndex: 40,
              fontSize: 10.5,
              fontWeight: 300,
              color: 'var(--cnv-ink-muted)',
              fontFamily: FONT,
              ...glass(true),
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            Dock orchestrator
            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M15 3v18" />
            </svg>
          </motion.button>
        ) : null}
      </AnimatePresence>

      {/* Picture pills — images dropped or pasted on the composer wait
          here, then ride the next send as real image blocks. */}
      <AnimatePresence>
        {composerImages.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            style={{
              position: 'absolute',
              bottom: 78,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 13,
              zIndex: 40,
              ...glass(true),
            }}
          >
            {composerImages.map((image, index) => (
              <div key={`${image.name}-${index}`} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, paddingRight: 4 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.dataUri} alt={image.name} style={{ width: 30, height: 30, borderRadius: 7, objectFit: 'cover', display: 'block' }} />
                <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {image.name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => setComposerImages((previous) => previous.filter((_, i) => i !== index))}
                  style={{ borderWidth: 0, background: 'transparent', padding: 2, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontSize: 10, fontFamily: FONT }}
                  onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
                >
                  ✕
                </button>
              </div>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Mistake-proofing — queued follow-ups + the undo-send pill, floating
          just above the composer (clears of the picture pills when present). */}
      <div
        style={{
          position: 'absolute',
          bottom: composerImages.length ? 132 : 78,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(680px, calc(100vw - 240px))',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          zIndex: 41,
          pointerEvents: dispatchLanes.length || mainQueued.length || mainUndoArmed ? 'auto' : 'none',
        }}
      >
        {/* Live agents working — grows out of the composer.
            Sits ABOVE the queue so the two stack and never collide. */}
        <div data-canvas-chrome data-canvas-bottom-stack style={{ width: '100%' }}>
          <AnimatePresence>
            {dispatchLanes.length ? (
              <DispatchDock
                lanes={dispatchLanes}
                onSelect={(lane) => { if (lane.repoPath) setActiveRepoPath(lane.repoPath); setDockOpen(true); }}
                onReview={(lane) => { void spawnDiffCard(lane); }}
                onExpandedChange={setDockTrayExpanded}
              />
            ) : null}
          </AnimatePresence>
        </div>
        <div style={{ width: '100%' }}>
          <QueuedSends items={mainQueued} onCancel={mainCancelQueued} />
        </div>
        <AnimatePresence>
          {mainUndoArmed ? <UndoSendPill key="undo" onUndo={mainStopOrUndo} graceMs={SEND_UNDO_GRACE_MS} /> : null}
        </AnimatePresence>
      </div>

      {/* ── Bottom orchestrator input — first contact lives here ─── */}
      <div
        data-canvas-chrome
        data-canvas-bottom-stack
        onDragOver={(event) => {
          // Claim drags over the composer — the page-level veil stays out
          // of it and the drop becomes a picture pill, not a canvas card.
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer?.files?.length) addComposerImages(event.dataTransfer.files);
        }}
        style={{
          position: 'absolute',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(680px, calc(100vw - 240px))',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 48,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 10,
          paddingRight: 10,
          borderRadius: 24,
          zIndex: 40,
          ...glass(true),
        }}
      >
        <AnticipationRing focused={composerFocused} radius={24} />
        {/* Controls layer — fades out AND drops out of flow while an agent-lane
            (Right-Option) dictation morphs the composer into the live partials
            transcript, so the transcript fill alone drives the pill's height. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0,
            ...(partialsMorph.active
              ? { position: 'absolute', top: 8, bottom: 8, left: 10, right: 10 }
              : null),
            opacity: partialsMorph.active && !partialsMorph.closing ? 0 : 1,
            pointerEvents: partialsMorph.active && !partialsMorph.closing ? 'none' : 'auto',
            transition: reduceMotion ? undefined : 'opacity 120ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
        {/* Mode — fleet (dispatch) / single (solo) / fusion. The glyph IS the
            chip (the operator asked for "a fleet icon"); the popover carries the
            labels. Orange marks the live mode, matching the default composer. */}
        <button
          type="button"
          aria-label="Orchestration mode"
          aria-haspopup="menu"
          aria-expanded={composerMenu === 'mode'}
          title={`Mode: ${CANVAS_MODES.find((option) => option.id === orchMode)?.title ?? 'Fleet orchestration'}`}
          onClick={() => setComposerMenu((value) => (value === 'mode' ? null : 'mode'))}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            height: 24,
            paddingLeft: 8,
            paddingRight: 6,
            borderRadius: 999,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--cnv-edge)',
            background: composerMenu === 'mode' ? 'var(--cnv-tint)' : 'transparent',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; }}
          onMouseLeave={(event) => { if (composerMenu !== 'mode') event.currentTarget.style.background = 'transparent'; }}
        >
          <span aria-hidden style={{ display: 'inline-flex', color: 'var(--t-brand-orange, #FF5A1F)' }}>
            <ModeGlyph mode={orchMode} size={12} />
          </span>
          <svg width={8} height={8} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ opacity: 0.7 }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <ChipButton
          label={activeRepoName ?? '…'}
          active={composerMenu === 'repo'}
          onClick={() => setComposerMenu((value) => (value === 'repo' ? null : 'repo'))}
        />
        <textarea
          ref={composerInputRef}
          value={composerValue}
          onChange={handleComposerChange}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter drops a newline (the field grows to fit).
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          onPaste={(event) => {
            const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
            if (files.length) {
              event.preventDefault();
              addComposerImages(files);
            }
          }}
          placeholder={`Message the orchestrator · ${activeRepoName ?? '…'}`}
          aria-label="Orchestrator composer"
          onFocus={() => { setComposerFocused(true); }}
          onBlur={() => setComposerFocused(false)}
          rows={1}
          style={{
            flex: 1,
            minWidth: 0,
            borderWidth: 0,
            outline: 'none',
            background: 'transparent',
            color: 'var(--cnv-ink)',
            fontSize: 13,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            fontFamily: FONT,
            // Grow with the content instead of nested scrolling (design-eng
            // tip). field-sizing is supported in the app's WebKit — verified
            // live; it caps at maxHeight, then scrolls.
            fieldSizing: 'content',
            resize: 'none',
            maxHeight: 160,
            overflowY: 'auto',
            lineHeight: 1.4,
            paddingTop: 0,
            paddingBottom: 0,
          } as React.CSSProperties}
        />
        {/* One model chip — its drawer sets BOTH model + thinking. The current
            thinking effort rides as a muted suffix so it stays at-a-glance. */}
        <ChipButton
          label={CANVAS_MODEL_OPTIONS.find((option) => option.value === orchModel)?.label ?? orchModel}
          sub={orchEffort}
          active={composerMenu === 'model'}
          onClick={() => setComposerMenu((value) => (value === 'model' ? null : 'model'))}
        />
        {/* Push-to-talk — speak the prompt. Canvas-tinted to sit flush with the
            send arrow; hides itself when no dictation host is mounted. */}
        <ComposerDictationContext.Provider value={dictationId}><MicButton idleColor="var(--cnv-ink-muted)" /></ComposerDictationContext.Provider>
        <button
          type="button"
          aria-label={orchBusy ? (mainUndoArmed ? 'Stop and undo the send' : 'Interrupt the orchestrator') : 'Send'}
          onClick={() => {
            if (orchBusy) mainStopOrUndo();
            else submit();
          }}
          style={{
            borderWidth: 0,
            background: 'transparent',
            padding: 4,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: 'var(--cnv-ink-muted)',
            flexShrink: 0,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          {orchBusy ? (
            <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" />
            </svg>
          )}
        </button>
        </div>
        {/* Live agent partials — the Right-Option dictation streams here in place
            of the controls, the pill growing upward like the outside HUD. */}
        {partialsMorph.active ? (
          <ComposerPartialsFill
            phase={partialsMorph.phase}
            text={partialsMorph.text}
            closing={partialsMorph.closing}
            reduce={reduceMotion}
          />
        ) : null}
      </div>

      {/* Composer menus — repo scope / model / thinking effort. */}
      <AnimatePresence>
        {composerMenu ? (
          <>
            <div role="presentation" onClick={() => setComposerMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              style={{
                position: 'absolute',
                bottom: 84,
                left: '50%',
                // framer owns `transform` while animating — offset by margin.
                marginLeft: -124,
                width: 248,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 14,
                zIndex: 46,
                ...glassPop(),
              }}
            >
              {composerMenu === 'repo' ? (
                <>
                  <DrawerLabel>Orchestrator repo</DrawerLabel>
                  {(() => {
                    const rows = repos ?? [];
                    const projectNames = [...new Set(rows.map((row) => row.project).filter((value): value is string => Boolean(value)))];
                    const groups = [
                      ...projectNames.map((label) => ({ label, rows: rows.filter((row) => row.project === label) })),
                      { label: projectNames.length ? 'Independent' : null, rows: rows.filter((row) => !row.project) },
                    ].filter((group) => group.rows.length > 0);
                    return groups.map((group) => (
                      <div key={group.label ?? 'solo'} style={{ display: 'flex', flexDirection: 'column' }}>
                        {group.label ? (
                          <span style={{ fontSize: 8.5, fontWeight: 300, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingTop: 8, paddingBottom: 3, opacity: 0.8 }}>
                            {group.label}
                          </span>
                        ) : null}
                        {group.rows.map((repo) => (
                          <PickerRow
                            key={repo.path}
                            name={repo.name}
                            path={repo.path.replace(/^\/Users\/[^/]+/, '~')}
                            onClick={() => {
                              setActiveRepoPath(repo.path);
                              setComposerMenu(null);
                            }}
                          />
                        ))}
                      </div>
                    ));
                  })()}
                </>
              ) : composerMenu === 'mode' ? (
                <>
                  <DrawerLabel>Mode</DrawerLabel>
                  {CANVAS_MODES.map((option) => (
                    <ModeRow
                      key={option.id}
                      mode={option.id}
                      title={option.title}
                      detail={option.detail}
                      active={option.id === orchMode}
                      onClick={() => chooseMode(option.id)}
                    />
                  ))}
                </>
              ) : (
                <>
                  {/* Merged Model + Thinking drawer (operator call 2026-06-14):
                      one chip, two sections, checkmark on the live choice, set
                      both before dismissing. */}
                  <DrawerLabel>Model</DrawerLabel>
                  {CANVAS_MODEL_OPTIONS.map((option) => (
                    <PickerRow key={option.value} name={option.label} active={option.value === orchModel} onClick={() => chooseModel(option.value)} />
                  ))}
                  <div style={{ height: 1, background: 'var(--cnv-edge)', opacity: 0.6, marginTop: 7, marginBottom: 5, marginLeft: 8, marginRight: 8 }} />
                  <DrawerLabel>Thinking</DrawerLabel>
                  {THINKING_EFFORTS.map((effort) => (
                    <PickerRow key={effort} name={effort} active={effort === orchEffort} onClick={() => chooseEffort(effort)} />
                  ))}
                </>
              )}
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
      {quickActionPalette}
      {/* Glass tuner — drops down under the "Canvas" word in the top dock. */}
      <AnimatePresence>
        {tunerOpen ? (
          <TunerPanel
            settings={settings}
            onChange={updateSettings}
            inTauri={inTauri}
            full
            personalDefault={personalDefault}
            loupeSize={loupeSize}
            loupeSizeRange={LOUPE_SIZE_RANGE}
            onLoupeSizeChange={setLoupeSize}
            onSaveDefault={() => {
              savePersonalDefault(settings);
              setPersonalDefault({ ...settings });
            }}
          />
        ) : null}
      </AnimatePresence>

      {/* First-run welcome — frosts the canvas behind a hero card. Rendered at
          chrome level (outside the zoom layer) so it sits at device 1:1. */}
      <WelcomeModal open={welcomeOpen} onClose={closeWelcome} onStart={startFromWelcome} tone={settings.tone} />
      <ShareBetaModal open={shareBetaOpen} onClose={() => setShareBetaOpen(false)} tone={settings.tone} />
      <CanvasTour open={tourOpen} onClose={closeTour} onComplete={() => setShareBetaOpen(true)} />
    </SmoothCorners>
  );
}
