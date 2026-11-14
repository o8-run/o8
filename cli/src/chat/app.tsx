import React, { useEffect, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import type { ResolvedConfig } from '../config.js';
import { ChatClient, historyMessages, readThread, type ThreadHistory } from './client.js';
import { editInput, graphemes, type InputValue } from './input.js';
import { initialChatState, receiveEvent, safeText, type ChatRoute } from './state.js';
import { Composer, Transcript, Welcome, composerLines, palette, transcriptLines, type ViewLine } from './view.js';
import { terminalInput } from './terminal-input.js';
import { attachmentPaths, attachmentTurn, pastedAttachmentPaths, stageAttachments, type Attachment } from './attachments.js';
import { createTerminalStatusReporter } from '../terminal-status.js';
import { chatStatusReport, initialTurnTracker, trackTurn, type TurnSignal } from './tab-status.js';

const HELP = [
  '/help        This guide',
  '/session     Conversation identity and resume command',
  '/reconnect   Reopen the connection and read saved history',
  '/attach path Attach images or UTF-8 files (quote spaces)',
  '/attachments List all staged files before sending',
  '/remove n    Remove attachment n, or /remove all',
  '/quit        Leave chat; active work continues in o8',
  '',
  'Enter sends   Ctrl+J adds a line   Esc requests stop',
  'Ctrl+O expands tools   Page Up/Down reads the transcript',
  'Ctrl+G returns to latest   Drop file paths to attach',
  '↑/↓ recalls prompts   Ctrl+U clears the draft',
  '',
  'This is the existing o8 orchestrator. Its normal approval',
  'and workspace rules still apply. No saved settings change.',
].map((text): ViewLine => ({ text, tone: 'muted' }));
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Activity({ busy, noMotion, text }: { busy: boolean; noMotion: boolean; text: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!busy || noMotion) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % (text.length + 8)), 100);
    return () => clearInterval(timer);
  }, [busy, noMotion, text.length]);
  const start = Math.max(0, frame - 4);
  return <Text color={busy ? palette.accent : palette.muted}>
    {busy ? noMotion ? '◌' : FRAMES[frame % FRAMES.length] : '·'}{' '}
    {busy && !noMotion
      ? <>{text.slice(0, start)}<Text color={palette.soft}>{text.slice(start, frame)}</Text>{text.slice(frame)}</>
      : text}
  </Text>;
}

function ChatApp({ cfg, route, history, noMotion, terminal }: {
  cfg: ResolvedConfig; route: ChatRoute; history: ThreadHistory; noMotion: boolean; terminal: ReturnType<typeof terminalInput>;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [state, setState] = useState(() => {
    const initial = initialChatState();
    initial.messages = historyMessages(history);
    return initial;
  });
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [input, setInput] = useState<InputValue>({ text: '', cursor: 0 });
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<'chat' | 'help' | 'session' | 'attachments'>('chat');
  const [top, setTop] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const [staging, setStaging] = useState(false);
  const stagingRef = useRef(false);
  const [hint, setHint] = useState('');
  const clientRef = useRef<ChatClient | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const promptHistory = useRef(historyMessages(history).filter((m) => m.role === 'user').map((m) => m.text));
  const historyIndex = useRef(promptHistory.current.length);
  const savedDraft = useRef('');
  const exitArmed = useRef(0);

  const tabStatus = useMemo(() => createTerminalStatusReporter({ human: true, verbose: false }), []);
  const [turn, setTurn] = useState(initialTurnTracker);
  const signalTurn = (signal: TurnSignal) => setTurn((previous) => trackTurn(previous, signal));
  const turnEpoch = useRef(0);
  const historyRequest = useRef(0);
  const recovering = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const refreshPending = useRef(false);
  const stopRefresh = () => { clearInterval(refreshTimer.current); refreshTimer.current = undefined; };
  const stagePaths = async (paths: string[]) => {
    if (stagingRef.current) { setHint('Finishing the previous attachment. Your draft is preserved.'); return; }
    stagingRef.current = true; setStaging(true); setHint('Reading attachments…');
    try {
      const next = await stageAttachments(paths, attachmentsRef.current, route.repoPath, route.backend);
      if (!alive.current) return;
      attachmentsRef.current = next; setAttachments(next);
      setHint('Attachments ready. Add a message, then Enter to send. /remove n removes one.');
    } catch (error) {
      if (alive.current) setHint(safeText(error instanceof Error ? error.message : String(error)));
    } finally { stagingRef.current = false; if (alive.current) setStaging(false); }
  };

  const reconcile = async () => {
    const epoch = generation.current;
    const turn = turnEpoch.current;
    const request = ++historyRequest.current;
    refreshPending.current = true;
    try {
      const saved = await readThread(cfg, route.threadId);
      if (!alive.current || epoch !== generation.current || turn !== turnEpoch.current || request !== historyRequest.current) return;
      setState((previous) => ({ ...previous,
        messages: historyMessages(saved).map((m) => ({ ...m,
          tools: previous.messages.find((old) => old.id === m.id)?.tools ?? [],
        })),
      }));
    } catch {
      if (alive.current && request === historyRequest.current) setHint('Saved history could not be refreshed. Live output is preserved.');
    } finally {
      if (request === historyRequest.current) refreshPending.current = false;
    }
  };

  const connect = async (reload: boolean) => {
    clientRef.current?.close();
    stopRefresh();
    setConnection('connecting');
    const epoch = ++generation.current;
    recovering.current = reload || Boolean(history.repoPath);
    signalTurn('reset');
    setState((previous) => ({ ...previous, busy: false, cursor: 0, error: null, notice: null }));
    try {
      const client = new ChatClient(cfg, route, (event) => {
        if (!alive.current || epoch !== generation.current) return;
        const wire = event as { event?: string; data?: { status?: string; snapshot?: boolean } };
        // An attached active turn may predate the bounded replay window. Read
        // complete saved snapshots during that turn instead of guessing where
        // streamed deltas join the persisted prefix. New turns stream normally.
        if (!(recovering.current && wire.event === 'output')) {
          setState((previous) => receiveEvent(previous, event, route));
        }
        if (wire.event === 'status' && wire.data?.snapshot && wire.data.status === 'busy') {
          recovering.current = true;
          setHint('Reattached to active work. Refreshing the saved response.');
          void reconcile();
          stopRefresh();
          refreshTimer.current = setInterval(() => {
            if (!refreshPending.current) void reconcile();
          }, 2000);
        }
        if (wire.event === 'status' && !wire.data?.snapshot && wire.data?.status === 'busy') turnEpoch.current += 1;
        if (wire.event === 'status' && wire.data?.status === 'busy') signalTurn('started');
        else if (wire.event === 'status' && wire.data?.status === 'ready' && !wire.data.snapshot) signalTurn('ready');
        else if (wire.event === 'error' || (wire.event === 'status' && wire.data?.status === 'dead')) signalTurn('failed');
        if ((wire.event === 'status' && ['ready', 'dead'].includes(wire.data?.status ?? '')) || wire.event === 'error') {
          stopRefresh(); recovering.current = false;
          setHint('');
          void reconcile();
        }
      }, () => {
        if (!alive.current || epoch !== generation.current) return;
        stopRefresh();
        setConnection('disconnected');
        signalTurn('reset');
        setState((previous) => ({ ...previous, busy: false, activity: 'Connection lost',
          notice: 'Delivery and turn state may be unknown. /reconnect checks saved history. Nothing is resent automatically.' }));
      });
      clientRef.current = client;
      await client.connect();
      if (alive.current && epoch === generation.current) setConnection('connected');
    } catch (error) {
      if (!alive.current || epoch !== generation.current) return;
      clientRef.current?.close(); stopRefresh();
      setConnection('disconnected');
      setState((previous) => ({ ...previous, error: safeText(error instanceof Error ? error.message : String(error)) }));
    }
  };

  useEffect(() => {
    alive.current = true;
    void connect(false);
    const resize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on('resize', resize);
    const paste = (text: string) => {
      const paths = pastedAttachmentPaths(text);
      if (paths) void stagePaths(paths);
      else setInput((value) => editInput(value, text, {}));
    };
    const overflow = () => setHint('Paste exceeds 1 MiB. Use a smaller excerpt or reference the file.');
    terminal.paste.on('paste', paste);
    terminal.paste.on('overflow', overflow);
    return () => {
      alive.current = false; stopRefresh(); clientRef.current?.close(); stdout.off('resize', resize);
      terminal.paste.off('paste', paste); terminal.paste.off('overflow', overflow);
    };
    // A ChatApp owns one route for its entire mounted lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const failed = Boolean(state.error);
  useEffect(() => {
    tabStatus.report(chatStatusReport({ connection, busy: state.busy, error: failed, replyReady: turn.replyReady }));
  }, [tabStatus, state.busy, failed, connection, turn.replyReady]);

  const interrupt = () => {
    try { clientRef.current?.interrupt(); signalTurn('stop-requested'); setHint('Stop requested. Waiting for o8 to confirm.'); }
    catch (error) { setHint(safeText(error instanceof Error ? error.message : String(error))); }
  };
  const leave = () => {
    if (Date.now() - exitArmed.current < 2000) { clientRef.current?.close(); exit(); return; }
    exitArmed.current = Date.now();
    setHint('Press Ctrl+D again to leave. Active work continues in o8.');
  };
  const submit = () => {
    const text = input.text.trim();
    if (stagingRef.current) { setHint('Wait for the attachment to finish reading.'); return; }
    if (!text && !attachments.length) return;
    if (text.startsWith('/')) {
      if (text === '/quit' || text === '/exit') { clientRef.current?.close(); exit(); return; }
      if (text === '/help') setPage('help');
      else if (text === '/session') setPage('session');
      else if (text === '/attachments') setPage('attachments');
      else if (text === '/reconnect') { if (connection !== 'connecting') void connect(true); }
      else if (text === '/attach' || text.startsWith('/attach ')) {
        try { void stagePaths(attachmentPaths(text.slice(7).trim())); }
        catch (error) { setHint(safeText(error instanceof Error ? error.message : String(error))); return; }
      }
      else if (text.startsWith('/remove ')) {
        const target = text.slice(8).trim();
        if (target !== 'all' && (!/^\d+$/.test(target) || Number(target) < 1 || Number(target) > attachments.length)) {
          setHint('Use /remove <attachment number> or /remove all.'); return;
        }
        const next = target === 'all' ? [] : attachments.filter((_, index) => index !== Number(target) - 1);
        attachmentsRef.current = next; setAttachments(next); setHint('Attachment removed.');
      }
      else if (pastedAttachmentPaths(text)) void stagePaths(pastedAttachmentPaths(text)!);
      else { setHint('Unknown command. Type /help for the short guide.'); return; }
      setInput({ text: '', cursor: 0 });
      setTop(null);
      return;
    }
    if (connection !== 'connected') { setHint('Waiting for a connection. /reconnect retries without resending your draft.'); return; }
    if (state.busy) { setHint('This turn is still running. Your draft is saved here; Esc requests stop.'); return; }
    try {
      const id = randomUUID();
      const turn = attachmentTurn(text, attachments);
      turnEpoch.current += 1; recovering.current = false; stopRefresh();
      clientRef.current!.send(turn.message, id, turn);
      signalTurn('started');
      setState((previous) => ({ ...previous, busy: true, error: null, notice: null, activity: 'Sending', activeMessageId: null,
        messages: [...previous.messages, { id, role: 'user', text: turn.displayMessage, tools: [] }],
      }));
      attachmentsRef.current = []; setAttachments([]);
      promptHistory.current.push(text);
      historyIndex.current = promptHistory.current.length;
      savedDraft.current = '';
      setInput({ text: '', cursor: 0 });
      setPage('chat'); setTop(null); setHint('');
    } catch (error) { setHint(safeText(error instanceof Error ? error.message : String(error))); }
  };

  useInput((text, key) => {
    if (key.ctrl && text === 'd') { leave(); return; }
    if (key.ctrl && text === 'c') {
      if (state.busy) interrupt();
      else if (input.text) setInput({ text: '', cursor: 0 });
      else leave();
      return;
    }
    if (key.escape) {
      if (page !== 'chat') setPage('chat');
      else if (state.busy) interrupt();
      else setHint('');
      return;
    }
    if (size.columns < 36 || size.rows < 12) return;
    if (key.ctrl && text === 'o') { setExpanded((value) => !value); return; }
    if (key.ctrl && text === 'g') { setTop(null); return; }
    if (key.pageUp) { setTop((value) => Math.max(0, (value ?? Math.max(0, displayed.length - bodyHeight)) - Math.max(4, bodyHeight - 2))); return; }
    if (key.pageDown) { setTop((value) => {
      if (value === null) return null;
      const next = value + Math.max(4, bodyHeight - 2);
      return next >= displayed.length - bodyHeight ? null : next;
    }); return; }
    if ((key.upArrow || key.downArrow) && !input.text.includes('\n')) {
      if (historyIndex.current === promptHistory.current.length) savedDraft.current = input.text;
      historyIndex.current = Math.max(0, Math.min(promptHistory.current.length, historyIndex.current + (key.upArrow ? -1 : 1)));
      const recalled = promptHistory.current[historyIndex.current] ?? savedDraft.current;
      setInput({ text: recalled, cursor: graphemes(recalled).length }); return;
    }
    if (key.return && !(key.ctrl || key.shift || key.meta)) { submit(); return; }
    if (key.return) { setInput((value) => editInput(value, 'j', { ctrl: true })); return; }
    setInput((value) => editInput(value, text, key));
  });

  const width = Math.max(20, Math.min(108, size.columns - 4));
  const inputHeight = Math.min(4, composerLines(input, width - 6).lines.length) + 2;
  const attachmentHeight = attachments.length ? Math.min(2, attachments.length) : 0;
  const bodyHeight = Math.max(2, size.rows - inputHeight - 9 - attachmentHeight);
  const lines = useMemo(() => transcriptLines(state.messages, width, expanded), [state.messages, width, expanded]);
  const sessionLines: ViewLine[] = [
    { text: 'This conversation', tone: 'accent', bold: true },
    ...transcriptLines([{ id: 'session', role: 'notice', tools: [], text:
      `${route.threadId}\n${route.repoPath}\n${route.backend} · ${route.model ?? 'backend default'}\n\nResume:\no8 chat --resume ${route.threadId}\n\nLeaving the terminal does not stop active work.\nUse Esc during a turn to request interruption.` }], width, true),
  ];
  const fileLines = transcriptLines([{ id: 'files', role: 'notice', tools: [], text: attachments.length
    ? attachments.map((file, index) => `${index + 1}. ${file.name} (${file.image ? 'image' : 'text'}, ${file.bytes} bytes)\n${file.path}`).join('\n\n')
    : 'No attachments. Use /attach <path> or drop a file path into the terminal.' }], width, false);
  const displayed = page === 'help' ? HELP : page === 'session' ? sessionLines : page === 'attachments' ? fileLines : lines;
  useEffect(() => {
    const scroll = (delta: number) => setTop((value) => {
      const last = Math.max(0, displayed.length - bodyHeight);
      const next = Math.max(0, (value ?? last) + delta);
      return next >= last ? null : next;
    });
    terminal.paste.on('scroll', scroll);
    return () => { terminal.paste.off('scroll', scroll); };
  }, [bodyHeight, displayed.length, terminal]);
  const status = state.error || hint || state.notice;
  if (size.columns < 36 || size.rows < 12) return <Text wrap="truncate-end">Resize to at least 36 × 12 to use chat.</Text>;
  return <Box flexDirection="column" paddingLeft={2} paddingRight={2} height={Math.max(10, size.rows - 1)}>
    <Box width={width} justifyContent="space-between">
      <Text bold color={palette.accent}>o8 <Text color={palette.muted}>/ {safeText(basename(route.repoPath))}</Text></Text>
      <Text color={palette.dim}>{connection === 'connected' ? '● connected' : connection === 'connecting' ? '◌ connecting' : '○ disconnected'}</Text>
    </Box>
    <Text color={palette.muted} wrap="truncate-end">{safeText(route.backend)} · {safeText(route.model ?? 'backend default')} · {route.permissionMode === 'plan' ? 'plan mode' : 'full access'}</Text>
    <Text color={palette.dim}>{'─'.repeat(width)}</Text>
    <Box height={bodyHeight} flexDirection="column" overflow="hidden">
      {!state.messages.length && page === 'chat'
        ? <Welcome repo={route.repoPath} width={width} />
        : <Transcript lines={displayed} height={bodyHeight} top={top} />}
    </Box>
    <Activity busy={state.busy || connection === 'connecting'} noMotion={noMotion} text={connection === 'connecting' ? 'Connecting to o8' : state.activity} />
    <Text color={state.error ? palette.error : palette.muted} wrap="truncate-end">{top !== null ? 'Reading earlier messages · Ctrl+G returns to latest' : status ? safeText(status) : ' '}</Text>
    {attachments.slice(0, 2).map((file, index) => <Text key={file.path} color={palette.soft} wrap="truncate-end">
      {index + 1}. {file.image ? 'Image' : 'File'} · {file.name} · {Math.ceil(file.bytes / 1024)} KiB{index === 1 && attachments.length > 2 ? ` · +${attachments.length - 2} more` : ''}
    </Text>)}
    <Composer value={input} width={width} connected={connection === 'connected'} />
    <Text color={palette.dim} wrap="truncate-end">{staging ? 'Reading files' : '↵ send'}  ·  Ctrl+J newline  ·  {state.busy ? 'Esc stop' : '/attach'}  ·  /help  ·  Ctrl+D leave</Text>
  </Box>;
}

export async function startChat(cfg: ResolvedConfig, route: ChatRoute, history: ThreadHistory, noMotion: boolean): Promise<void> {
  process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h');
  const terminal = terminalInput(process.stdin);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l');
  };
  // Standard synchronized frames avoid the incremental renderer's trailing-
  // newline cursor drift inside an alternate buffer.
  const app = render(<ChatApp cfg={cfg} route={route} history={history} noMotion={noMotion} terminal={terminal} />,
    { stdin: terminal.stream, exitOnCtrlC: false, patchConsole: false, maxFps: 30 });
  const terminate = () => { app.unmount(); restore(); };
  process.once('SIGTERM', terminate);
  process.once('SIGHUP', terminate);
  try { await app.waitUntilExit(); }
  finally {
    app.unmount(); terminal.close(); restore();
    process.off('SIGTERM', terminate); process.off('SIGHUP', terminate);
    // Leaving chat removes its mark from the tab. Active work continues in o8.
    createTerminalStatusReporter({ human: true, verbose: false }).report({ state: 'clear' });
  }
  process.stdout.write(`\nResume this conversation: o8 chat --resume ${route.threadId}\n`);
}
