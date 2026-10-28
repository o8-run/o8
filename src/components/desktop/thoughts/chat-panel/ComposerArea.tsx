'use client';

import { ComposerVoiceTurnContext } from './ComposerVoiceTurnContext';
import type { ComposerAreaProps } from './composer-area-types';
import { ComposerDictationContext, useComposerDictation, useComposerTextareaRef } from '../../dictation/ComposerDictation';
import { useComposerImageBridge } from './useComposerImageBridge';
import Image from 'next/image';
import { useComposerClock } from './useComposerClock';
import { forwardRef, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useComposerAutosize } from './useComposerAutosize';
import { InputButtons } from '../InputButtons';
import { ComposerPopoverVisibilityContext } from './ComposerPopover';
import { BrainPipButton } from '../../brain/BrainPipButton';
import { composerModeSpec } from '../composer-mode';
import { SlashCommandPicker } from './SlashCommandPicker';
import { transcriptRunningTools } from '../../transcript/activity';
import { ComposerStatusBar } from './ComposerStatusBar';
import { CompactionStatus } from './CompactionStatus';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import { getOrchestratorSlashCommandSuggestions, type OrchestratorSlashCommandDefinition } from '@/lib/slash-commands';
import { MODE_ROUTING_SLASH_COMMANDS } from '@/lib/composer-mode-routing';
import { registerComposerCenter } from '../../composer-center-registry';
import { PromptStashRow } from '../PromptStashRow';
import { stashPrompt } from '@/lib/orchestrator/prompt-stash';
import { OPEN_PROMPT_LIBRARY_EVENT, SAVE_PROMPT_LIBRARY_EVENT } from '@/lib/prompt-library/client';
import {
  cycleComposerSelectorMode,
  isComposerEffortShortcut,
  readComposerSelectorV1Flag,
  resolveEffectiveComposerLeadModelId,
  stepComposerEffort,
} from '../composer-selector/state';
import { useComposerSelectorState } from '../composer-selector/useComposerSelectorState';
import { ComposerContextRow } from './ComposerContextRow';
import { ComposerPermissionChip, WORKSPACE_FULL_ACCESS_DETAIL } from './ComposerPermissionChip';
import { ComposerFileTags } from './ComposerFileTags';
import { WorkerCorrections } from './WorkerCorrections';
import { addComposerFileReference, readComposerFileReferences, writeComposerFileReferences } from './composer-file-references';
const subscribeToComposerSelectorFlag = () => () => undefined;
export type { ComposerAreaProps } from './composer-area-types';
export const ComposerArea = forwardRef<HTMLTextAreaElement, ComposerAreaProps>(function ComposerArea({
  activeComposer = false, dictationId, dictationScopeKey,
  showBrain = true,
  inputLabel,
  placeholder,
  literalInput = false,
  draftWarning,
  footerOverride,
  attachmentContent,
  inputDisabled = false,
  input,
  onInputChange,
  isOrchestratorMode,
  isChatMode = false,
  isSingleMode = false,
  displayWaiting,
  chatMessages,
  workerPackets,
  activityContent,
  voiceControl,
  workerContext,
  activeTargetLabel,
  targetAgentExists,
  enhancing,
  preEnhanceInput,
  onEnhance,
  onUndoEnhance,
  onSubmit,
  onStop,
  onSlashCommand,
  modelLabel,
  modelId,
  isolatedModelSelection = false,
  onModelRestore,
  onModelChange,
  activeBackend,
  onBackendChange,
  effort,
  operatorDefaultEffort = effort,
  codexDefaultDispatchModel,
  onEffortChange,
  adaptiveEnabled,
  sessionRulesThreadId,
  repoLabel,
  displayMessagesCount,
  hasAssistantActivity,
  footerMeterSlot,
  attachedImages = [],
  attachedFiles = [],
  dragOver = false,
  dragHandlers,
  onAttachedImageRemove,
  onAttachedImageAnnotate,
  onAttachedFileRemove,
  onUploadDiskFiles,
  composerMode,
  onComposerModeChange,
  composerModeStorageId,
  repoPath,
  workspaceTargets,
  selectedRepoPath,
  onSelectRepoPath,
  permissionMode,
  onPermissionModeChange,
  contextLocationSlot,
  composerLeadingExtras,
  onSteer,
  canSteerLive = false,
  queueSaving = false,
  sendBufferStatus,
  promptStash,
  voiceModeEnabled,
  onVoiceModeChange,
}, inputRef) {
  const composerCenterRef = useRef<HTMLDivElement>(null);
  const [textareaRef, setTextareaRef] = useComposerTextareaRef(inputRef);
  const voiceDelivery = useRef<((text: string) => boolean) | null>(null);
  const localDictationId = useComposerDictation({
    active: activeComposer, enabled: !dictationId, nodeRef: textareaRef,
    scopeKey: JSON.stringify([dictationScopeKey, repoPath, sessionRulesThreadId, inputLabel]),
    onText: text => {
      if (voiceDelivery.current?.(text)) return;
      if (text) onInputChange(`${input}${input && !/\s$/.test(input) ? ' ' : ''}${text}`);
    },
  });
  const voiceTurnTarget = useMemo(() => ({
    dictationId: dictationId ?? localDictationId,
    intercept: (handler: (text: string) => boolean) => {
      voiceDelivery.current = handler;
      return () => { if (voiceDelivery.current === handler) voiceDelivery.current = null; };
    },
  }), [dictationId, localDictationId]);
  const now = useComposerClock(activeComposer && isOrchestratorMode);
  const fileReferences = useMemo(() => literalInput ? { body: input, paths: [] } : readComposerFileReferences(input), [input, literalInput]);
  useComposerAutosize(textareaRef, fileReferences.body, activeComposer);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState<string | null>(null);
  const composerSelectorV1Enabled = useSyncExternalStore(subscribeToComposerSelectorFlag, readComposerSelectorV1Flag, () => true);
  const selectorModelId = resolveEffectiveComposerLeadModelId(activeBackend, modelId, codexDefaultDispatchModel);
  const selectorControls = useComposerSelectorState({
    enabled: isOrchestratorMode,
    mode: composerMode,
    modeStorageId: composerModeStorageId,
    modelId: selectorModelId,
    modelLabel,
    backend: activeBackend,
    effort,
    operatorDefaultEffort,
    adaptiveEnabled,
    threadId: sessionRulesThreadId ?? null,
    repoPath,
    onModeChange: onComposerModeChange,
    isolated: isolatedModelSelection,
    onModelRestore,
    onModelChange,
    onBackendChange,
    onEffortChange,
  });
  const runningTools = useMemo<MobileTranscriptToolCall[]>(() => isOrchestratorMode
    ? transcriptRunningTools(chatMessages, displayWaiting, now) : [], [chatMessages, displayWaiting, isOrchestratorMode, now]);
  const slashSuggestions = useMemo(() => {
    const normalizedInput = input.trimStart();
    if (!isOrchestratorMode || literalInput || dismissedSlashInput === input || !normalizedInput.startsWith('/')) {
      return [];
    }
    const commandToken = normalizedInput.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    return [
      ...getOrchestratorSlashCommandSuggestions(input),
      ...MODE_ROUTING_SLASH_COMMANDS.filter((item) => item.command.startsWith(commandToken)),
    ];
  }, [dismissedSlashInput, input, isOrchestratorMode, literalInput]);

  useEffect(() => {
    const composerCenter = composerCenterRef.current;
    if (!composerCenter || !activeComposer) return;
    return registerComposerCenter(composerCenter);
  }, [activeComposer]);
  const acceptsDirectInput = isOrchestratorMode || isChatMode || isSingleMode;
  // Keep the textarea typeable during a running turn for steering.
  // The Send button itself still flips to Stop via `working` on InputButtons.
  const isDisabled = inputDisabled || (!acceptsDirectInput && !targetAgentExists);
  useComposerImageBridge(composerCenterRef, activeComposer, isDisabled, JSON.stringify([repoPath, selectedRepoPath, sessionRulesThreadId, composerModeStorageId]), attachedImages, onUploadDiskFiles);
  const showReasoningControls = (isOrchestratorMode || isSingleMode) && !isChatMode;
  const isWorkingLocked = isOrchestratorMode && (displayWaiting || runningTools.length > 0);
  const [preferredSendMode, setPreferredSendMode] = useState<'Steer' | 'Queue'>('Steer');
  const sendMode = canSteerLive && onSteer ? preferredSendMode : 'Queue';
  const submit = isWorkingLocked && sendMode === 'Steer' ? onSteer! : onSubmit;
  const toggleSendMode = () => setPreferredSendMode(current => current === 'Steer' ? 'Queue' : 'Steer');
  let composerPlaceholder = `Message ${activeTargetLabel}…`;
  if (isWorkingLocked) {
    composerPlaceholder = sendMode === 'Steer' ? 'Steer the agent…' : 'Queue for the next turn…';
  } else if (isOrchestratorMode) {
    // Cursor-parity (Q 2026-07-17): the placeholder teaches the active mode;
    // the chip beside "+" is the persistent indicator.
    composerPlaceholder = composerModeSpec(composerMode ?? 'solo').placeholder;
  } else if (displayWaiting) {
    composerPlaceholder = `${activeTargetLabel} is thinking...`;
  }

  const activeSlashCommand = slashSuggestions[Math.min(activeSlashIndex, Math.max(0, slashSuggestions.length - 1))] ?? null;
  const footerLeadingSlot = hasAssistantActivity && !showReasoningControls ? <span>{displayMessagesCount} messages</span> : null;

  const updateInput = (nextValue: string) => {
    if (dismissedSlashInput !== null && dismissedSlashInput !== nextValue) {
      setDismissedSlashInput(null);
    }
    setActiveSlashIndex(0);
    onInputChange(nextValue);
  };

  const getInputNode = () => (
    inputRef && typeof inputRef !== 'function' && 'current' in inputRef ? inputRef.current : null
  );

  const handleTextareaPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items || !onUploadDiskFiles) return;

    const files: File[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (items[index].kind !== 'file') continue;
      const file = items[index].getAsFile();
      if (file) files.push(file);
    }

    if (files.length === 0) return;
    event.preventDefault();
    onUploadDiskFiles(files);
  };

  const handleFileReferenceSelect = (filePath: string) => {
    const node = getInputNode();
    const next = addComposerFileReference(input, filePath, node?.selectionStart ?? fileReferences.body.length);
    updateInput(next.input);
    requestAnimationFrame(() => {
      const nextNode = getInputNode();
      nextNode?.focus();
      if (!nextNode) return;
      nextNode.selectionStart = next.cursor;
      nextNode.selectionEnd = next.cursor;
      nextNode.style.height = 'auto';
      nextNode.style.height = `${Math.min(nextNode.scrollHeight, 200)}px`;
    });
  };

  const handleSelectSlashCommand = (definition: OrchestratorSlashCommandDefinition) => {
    setDismissedSlashInput(null);
    if (definition.requiresArgument) {
      const nextValue = `${definition.command} `;
      updateInput(nextValue);
      requestAnimationFrame(() => {
        const node = inputRef && 'current' in inputRef ? inputRef.current : null;
        node?.focus();
        if (node) node.selectionStart = node.selectionEnd = node.value.length;
      });
      return;
    }
    onSlashCommand(definition.command);
  };

  return (
    <ComposerVoiceTurnContext.Provider value={dictationId ? null : voiceTurnTarget}>
    <ComposerDictationContext.Provider value={dictationId ?? localDictationId}>
    <div data-o8-composer-root="" style={{
      position: 'relative',
      paddingTop: 24,
      paddingRight: 12,
      paddingBottom: 12,
      paddingLeft: 12,
      flexShrink: 0,
      // No background band (the "bar") — the composer floats; the transcript
      // fades behind it. (2026-07-02)
      background: 'transparent',
    }}>
      {isOrchestratorMode && repoPath && sessionRulesThreadId ? <CompactionStatus repoPath={repoPath} threadId={sessionRulesThreadId}
        messages={chatMessages} turnBusy={displayWaiting} /> : null}
      {promptStash ? <PromptStashRow onRestore={promptStash.onRestore} /> : null}
      {/* Orchestrator activity belongs to the transcript. Keep independent workers visible. */}
      {isOrchestratorMode ? (
        <ComposerStatusBar
          displayWaiting={false}
          runningTools={[]}
          workerPackets={workerPackets}
          activeTargetLabel={activeTargetLabel}
          latestUserMessageId={null}
          awaitingReply={false}
        />
      ) : null}
      {activityContent}
      {sendBufferStatus}
      {draftWarning ? <div role="status" style={{ fontSize: 11, color: 'var(--t-text-secondary)', paddingBottom: 8 }}>{draftWarning}</div> : null}
      <div data-brain-composer-anchor="" style={{ position: 'relative' }}>
        {!literalInput && isOrchestratorMode && sessionRulesThreadId && (selectedRepoPath ?? repoPath) ? <WorkerCorrections
          key={`${selectedRepoPath ?? repoPath}:${sessionRulesThreadId}`} repoPath={(selectedRepoPath ?? repoPath)!} threadId={sessionRulesThreadId}
          draft={input} hasAttachments={Boolean(attachedImages.length || attachedFiles.length)} working={displayWaiting} active={activeComposer} workerContext={workerContext}
          onDelivered={sent => { if (input === sent) onInputChange(''); }}
        /> : null}
        {showBrain ? <BrainPipButton preferredRuntime={activeBackend} active={activeComposer} repoPath={selectedRepoPath ?? repoPath} conversationKey={sessionRulesThreadId} /> : null}
        <SlashCommandPicker
          suggestions={slashSuggestions}
          activeIndex={activeSlashIndex}
          onSelect={handleSelectSlashCommand}
        />
        <div
          // The footer controls register against this active composer.
          data-composer-center=""
          ref={composerCenterRef}
          onDragOver={dragHandlers?.onDragOver}
          onDragLeave={dragHandlers?.onDragLeave}
          onDrop={dragHandlers?.onDrop}
          style={{
            position: 'relative',
            borderRadius: 14,
            border: 'none',
            background: 'var(--t-chat-surface-input-bg, var(--t-input-bg))',
            // Floating composer (2026-07-02) — NO border; the input
            // bg + a soft warm lift define it, so the edge just FADES into the
            // transcript instead of drawing a boxed outline. (Supersedes the
            // earlier flat/no-shadow request.)
            boxShadow: '0 1px 3px rgba(40,30,20,0.05), 0 6px 20px rgba(40,30,20,0.07)',
            overflow: 'hidden',
            opacity: isDisabled ? 0.6 : 1,
            outline: dragOver ? '2px solid var(--t-accent)' : 'none',
            outlineOffset: -2,
          }}
        >
          {attachmentContent}
          {attachedImages.length > 0 ? (
            <div style={{
              display: 'flex',
              gap: 10,
              paddingTop: 12,
              paddingRight: 14,
              paddingBottom: 6,
              paddingLeft: 14,
              overflowX: 'auto',
            }}>
              {attachedImages.map((image, index) => (
                <div key={`${image.name}-${index}`} style={{ position: 'relative', width: 66, flexShrink: 0 }}>
                  <Image width={56} height={56} unoptimized
                    src={image.dataUri}
                    alt={image.name}
                    title={onAttachedImageAnnotate ? 'Click to annotate' : undefined}
                    onClick={onAttachedImageAnnotate ? () => onAttachedImageAnnotate(index) : undefined}
                    style={{
                      display: 'block',
                      width: 56,
                      height: 56,
                      objectFit: 'cover',
                      borderRadius: 10,
                      border: '1px solid var(--t-input-border)',
                      background: 'var(--t-bg-card)',
                      cursor: onAttachedImageAnnotate ? 'pointer' : 'default',
                    }}
                  />
                  {onAttachedImageAnnotate ? (
                    <button
                      type="button"
                      aria-label={`Annotate ${image.name}`}
                      title="Annotate"
                      onClick={() => onAttachedImageAnnotate(index)}
                      style={{
                        position: 'absolute',
                        top: 39,
                        right: 4,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 18,
                        height: 18,
                        borderRadius: 999,
                        border: '1px solid var(--t-input-border)',
                        background: 'var(--t-input-bg)',
                        color: 'var(--t-text-muted)',
                        cursor: 'pointer',
                        paddingTop: 0,
                        paddingRight: 0,
                        paddingBottom: 0,
                        paddingLeft: 0,
                        boxShadow: 'var(--t-panel-shadow)',
                      }}
                    >
                      <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                  ) : null}
                  <div style={{
                    width: 60,
                    marginTop: 4,
                    color: 'var(--t-text-faint)',
                    fontSize: 10,
                    lineHeight: 1.15,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-sans-system)',
                  }}>
                    {image.name}
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => onAttachedImageRemove?.(index)}
                    style={{
                      position: 'absolute',
                      top: -5,
                      right: 4,
                      width: 18,
                      height: 18,
                      borderRadius: 999,
                      border: '1px solid var(--t-input-border)',
                      background: 'var(--t-input-bg)',
                      color: 'var(--t-text-muted)',
                      cursor: 'pointer',
                      fontSize: 11,
                      lineHeight: '16px',
                      textAlign: 'center',
                      paddingTop: 0,
                      paddingRight: 0,
                      paddingBottom: 0,
                      paddingLeft: 0,
                      boxShadow: 'var(--t-panel-shadow)',
                    }}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {attachedFiles.length > 0 ? (
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              paddingTop: attachedImages.length > 0 ? 2 : 12,
              paddingRight: 14,
              paddingBottom: 6,
              paddingLeft: 14,
            }}>
              {attachedFiles.map((fileName) => (
                <span key={fileName} style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  maxWidth: '100%',
                  paddingTop: 4,
                  paddingRight: 7,
                  paddingBottom: 4,
                  paddingLeft: 8,
                  borderRadius: 7,
                  border: '1px solid var(--t-accent-border)',
                  background: 'var(--t-accent-soft)',
                  color: 'var(--t-accent)',
                  fontSize: 11,
                  fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
                }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fileName.split('/').pop()}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${fileName}`}
                    onClick={() => onAttachedFileRemove?.(fileName)}
                    style={{
                      borderWidth: 0,
                      background: 'transparent',
                      color: 'var(--t-accent)',
                      cursor: 'pointer',
                      paddingTop: 0,
                      paddingRight: 0,
                      paddingBottom: 0,
                      paddingLeft: 0,
                      lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <ComposerFileTags paths={fileReferences.paths} repoPath={selectedRepoPath ?? repoPath} onRemove={path => {
            updateInput(writeComposerFileReferences(fileReferences.body, fileReferences.paths.filter(item => item !== path)));
            getInputNode()?.focus();
          }} />
          <textarea
            ref={setTextareaRef}
            data-o8-active-composer={activeComposer ? 'true' : undefined}
            aria-label={inputLabel}
            value={fileReferences.body}
            onChange={(event) => {
              updateInput(writeComposerFileReferences(event.target.value, fileReferences.paths));
            }}
            onKeyDown={(event) => {
              if (
                promptStash
                && event.key.toLowerCase() === 's'
                && event.metaKey
                && event.shiftKey
                && !event.ctrlKey
                && !event.altKey
                && input.trim().length > 0
              ) {
                event.preventDefault();
                const entry = stashPrompt({
                  text: input,
                  repoPath: promptStash.repoPath,
                  threadId: promptStash.threadId,
                });
                if (!entry) return;
                updateInput('');
                event.currentTarget.style.height = 'auto';
                return;
              }
              if (
                !literalInput && composerSelectorV1Enabled
                && composerMode
                && onComposerModeChange
                && event.key === 'Tab'
                && event.shiftKey
                && !event.altKey
                && !event.metaKey
                && !event.ctrlKey
                && slashSuggestions.length === 0
                && document.activeElement === event.currentTarget
              ) {
                event.preventDefault();
                selectorControls.onModeChange(cycleComposerSelectorMode(selectorControls.state.mode, 1, selectorControls.state.leadBackend));
                return;
              }
              if (
                !literalInput && composerSelectorV1Enabled
                && selectorModelId
                && activeBackend
                && isComposerEffortShortcut(event.nativeEvent)
                && document.activeElement === event.currentTarget
              ) {
                event.preventDefault();
                selectorControls.onEffortChange(stepComposerEffort(
                  selectorControls.state.effort,
                  selectorControls.state.effortOptions,
                  event.shiftKey ? -1 : 1,
                ));
                return;
              }
              if (slashSuggestions.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveSlashIndex((current) => (current + 1) % slashSuggestions.length);
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveSlashIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDismissedSlashInput(input);
                  setActiveSlashIndex(0);
                  return;
                }
              }
              if (event.key === 'ArrowUp' && !input.trim()) {
                event.preventDefault();
                const lastUserMsg = [...chatMessages].reverse().find((message) => message.role === 'user');
                if (lastUserMsg) updateInput(lastUserMsg.text);
                return;
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.shiftKey && isWorkingLocked && canSteerLive) {
                event.preventDefault(); toggleSendMode(); return;
              }
              // Keep the direct steering shortcut, gated by the same capability.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if ((!input.trim() && attachedImages.length === 0) || !canSteerLive || !onSteer || queueSaving) return;
                onSteer();
                if (event.currentTarget) {
                  event.currentTarget.style.height = 'auto';
                }
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (isWorkingLocked) {
                  if ((!input.trim() && attachedImages.length === 0) || queueSaving) return;
                  submit();
                  if (event.currentTarget) {
                    event.currentTarget.style.height = 'auto';
                  }
                  return;
                }
                if (slashSuggestions.length > 0 && activeSlashCommand) {
                  const normalized = input.trim();
                  const [commandToken] = normalized.split(/\s+/, 1);
                  const commandAliases = activeSlashCommand.aliases ?? [];
                  const exactCommandToken = commandToken === activeSlashCommand.command
                    || commandAliases.includes(commandToken);
                  if (!exactCommandToken && normalized === commandToken) {
                    updateInput(`${activeSlashCommand.command}${activeSlashCommand.requiresArgument ? ' ' : ''}`);
                    return;
                  }
                  if (activeSlashCommand.requiresArgument && exactCommandToken && normalized === commandToken) {
                    updateInput(`${activeSlashCommand.command} `);
                    return;
                  }
                  const typedCommandMatches = normalized.startsWith(activeSlashCommand.command)
                    || commandAliases.some((alias) => normalized.startsWith(alias));
                  const nextCommand = typedCommandMatches
                    ? normalized
                    : activeSlashCommand.command;
                  onSlashCommand(nextCommand);
                  if (event.currentTarget) {
                    event.currentTarget.style.height = 'auto';
                  }
                  return;
                }
                onSubmit();
                if (event.currentTarget) {
                  event.currentTarget.style.height = 'auto';
                }
              }
            }}
            onPaste={handleTextareaPaste}
            placeholder={placeholder ?? composerPlaceholder}
            disabled={isDisabled}
            rows={2}
            style={{
              width: '100%',
              minHeight: 52,
              maxHeight: 'max(52px, min(200px, 28vh, calc(100cqh - 120px)))',
              display: 'block',
              paddingTop: 11,
              paddingRight: 14,
              paddingBottom: 4,
              paddingLeft: 14,
              borderWidth: 0,
              background: 'transparent',
              fontSize: 13,
              color: 'var(--t-text)',
              resize: 'none',
              outline: 'none',
              fontFamily: 'var(--font-sans-system)',
              lineHeight: 1.4,
              boxSizing: 'border-box',
              // X hidden, not auto: text wraps (pre-wrap) so horizontal
              // overflow is never real — but WKWebView misreports textarea
              // scrollWidth under fractional CSS zoom and painted a phantom
              // h-scrollbar across the composer (operator screenshot
              // 2026-07-15, 80% zoom) that also ate clicks along its band.
              overflowX: 'hidden',
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              overflowWrap: 'anywhere',
            }}
          />
          {footerOverride}
          {/* Keep the chat's Live owner mounted when the visible footer changes. */}
          {footerOverride != null && !voiceControl ? null : <ComposerPopoverVisibilityContext.Provider value={footerOverride == null}>
            <div style={{ display: footerOverride != null ? 'none' : 'contents' }}>
              <InputButtons
                input={input}
                hasAttachments={attachedImages.length > 0}
                enhancing={enhancing}
                preEnhanceInput={preEnhanceInput}
                onEnhance={onEnhance}
                onUndoEnhance={onUndoEnhance}
                onSubmit={submit}
                sendDisabled={queueSaving}
                modelLabel={modelLabel}
                modelId={isOrchestratorMode ? selectorModelId : undefined}
                onModelChange={isOrchestratorMode ? selectorControls.onModelChange : undefined}
                activeBackend={isOrchestratorMode ? activeBackend : undefined}
                onBackendChange={isOrchestratorMode ? selectorControls.onBackendChange : undefined}
                effort={selectorControls.state.effort}
                onEffortChange={selectorControls.onEffortChange}
                adaptiveEnabled={adaptiveEnabled}
                sessionRulesThreadId={sessionRulesThreadId}
                repoLabel={null}
                displayMessagesCount={displayMessagesCount}
                working={isOrchestratorMode && displayWaiting && !input.trim() && attachedImages.length === 0}
                onStop={isOrchestratorMode ? onStop : undefined}
                onUploadDiskFiles={onUploadDiskFiles}
                composerMode={composerMode}
                onComposerModeChange={selectorControls.onModeChange}
                composerSelectorController={selectorControls}
                onFileReferenceSelect={handleFileReferenceSelect}
                repoPath={repoPath}
                workspaceTargets={workspaceTargets}
                selectedRepoPath={selectedRepoPath}
                onSelectRepoPath={onSelectRepoPath}
                inlineLeadingExtras={composerLeadingExtras || (isWorkingLocked && canSteerLive && onSteer) ? <>{composerLeadingExtras}{isWorkingLocked && canSteerLive && onSteer ? <button type="button"
                  aria-label={`Message mode: ${sendMode}`} title={`Switch to ${sendMode === 'Steer' ? 'Queue' : 'Steer'} (Cmd/Ctrl+Shift+Enter)`}
                  onClick={toggleSendMode} style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--t-text-muted)', font: 'inherit', fontSize: 11, fontWeight: 300, cursor: 'pointer' }}>{sendMode}</button> : null}</> : undefined}
                managedVoiceControl={voiceControl}
                permissionControl={isOrchestratorMode && permissionMode && onPermissionModeChange
                  ? <ComposerPermissionChip mode={permissionMode} onChange={onPermissionModeChange}
                    allowOutsideWorkspace={(activeBackend === 'o8' || activeBackend === 'pi') && composerMode !== 'moa'}
                    // The o8 and Pi leads run on the built-in Pi orchestrator, whose commands stay in the workspace.
                    fullAccessDetail={activeBackend === 'o8' || activeBackend === 'pi' ? WORKSPACE_FULL_ACCESS_DETAIL : undefined} /> : null}
                inlineMeterSlot={showReasoningControls ? footerMeterSlot : null}
                voiceModeEnabled={voiceModeEnabled}
                onVoiceModeChange={onVoiceModeChange}
                onBrowsePrompts={isOrchestratorMode ? () => {
                  window.dispatchEvent(new CustomEvent(OPEN_PROMPT_LIBRARY_EVENT));
                } : undefined}
                onSavePrompt={isOrchestratorMode ? (body) => {
                  window.dispatchEvent(new CustomEvent(SAVE_PROMPT_LIBRARY_EVENT, {
                    detail: { body, repoPath: repoPath ?? null },
                  }));
                } : undefined}
                composerSelectorV1Enabled={isOrchestratorMode ? composerSelectorV1Enabled : false}
                onRequestTextareaFocus={() => composerCenterRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()}
              />
            </div>
          </ComposerPopoverVisibilityContext.Provider>}
        </div>
      </div>
      <ComposerContextRow
        showRepoTarget={displayMessagesCount === 0 && !displayWaiting && !hasAssistantActivity}
        contextLocationSlot={contextLocationSlot}
        repoLabel={repoLabel}
        workspaceTargets={workspaceTargets}
        selectedRepoPath={selectedRepoPath}
        onSelectRepoPath={onSelectRepoPath}
        onAddProject={() => window.dispatchEvent(new CustomEvent('o8:open-add-repo-flow', { detail: { mode: 'existing' } }))}
      />
      {footerLeadingSlot ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 6, paddingLeft: 2, paddingRight: 2, fontSize: 10, color: 'var(--t-text-faint)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {footerLeadingSlot}
          </div>
        </div>
      ) : null}
    </div>
    </ComposerDictationContext.Provider>
    </ComposerVoiceTurnContext.Provider>
  );
});
