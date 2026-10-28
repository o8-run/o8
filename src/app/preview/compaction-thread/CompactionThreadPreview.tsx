'use client';

import { ThemeProvider } from '@/lib/theme/context';
import dynamic from 'next/dynamic';
import { deserializeStoredTranscript, serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import { resolveVisibleChatMessages } from '@/components/desktop/thoughts/chat-panel/resolve-display-messages';
import { compactionThread } from '@/components/desktop/thoughts/chat-panel/fixtures/compaction-thread';
import { DesktopWebSocketProvider } from '@/components/desktop/hooks/DesktopWebSocketContext';

// The app loads saved turns in the browser, where text measurement is available.
const ChatMessageList = dynamic(() => import('@/components/desktop/thoughts/chat-panel/ChatMessageList').then(module => module.ChatMessageList), { ssr: false });
const ComposerArea = dynamic(() => import('@/components/desktop/thoughts/chat-panel/ComposerArea').then(module => module.ComposerArea), { ssr: false });

export function CompactionThreadPreview({ reloaded, composer = false }: { reloaded: boolean; composer?: boolean }) {
  const restored = deserializeStoredTranscript(serializeTranscriptForStorage(compactionThread));
  const messages = resolveVisibleChatMessages({ historyEntries: [], isOrchestratorMode: true, isChatMode: false,
    chatMessages: reloaded ? restored : restored.slice(0, 2),
    streamMessages: reloaded ? [] : [restored[2], ...restored.slice(3), { ...restored[0], id: 'orch-user-orch-send-prime' }],
  });
  return <ThemeProvider>
    <main style={{ boxSizing: 'border-box', minHeight: '100vh', paddingTop: 24, paddingBottom: 24,
      background: 'var(--t-canvas-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
      <div style={{ paddingLeft: 12, paddingRight: 12, marginBottom: 12, fontSize: 12, fontWeight: 300, color: 'var(--t-text-muted)' }}>
        {reloaded ? 'Reloaded conversation' : 'Live conversation after compaction'}
      </div>
      <DesktopWebSocketProvider><div style={{ boxSizing: 'border-box', display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 760,
        height: composer ? 'calc(100vh - 80px)' : undefined, minHeight: 0,
        marginLeft: 'auto', marginRight: 'auto', borderRadius: 8, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-chat-surface-bg)' }}>
        <ChatMessageList displayMessages={messages} displayWaiting={false} activeTargetLabel="Lead" activeTargetColor="var(--t-accent)"
          thoughtsMutedGlass="var(--t-hover)" thoughtsElevatedBorder="var(--t-divider-subtle)" thoughtsElevatedShadow="none" emptyStateFallback={null}
          composeFirst={!composer} logLabel={reloaded ? 'Reloaded conversation' : 'Live conversation'} />
        {composer ? <ComposerArea literalInput input="Keep the next follow-up visible." onInputChange={() => {}} isOrchestratorMode displayWaiting={false}
          chatMessages={messages} sessionRulesThreadId="thoughts-fixture" repoPath="/fixture" showBrain={false} activeTargetLabel="Lead"
          targetAgentExists thoughtsBodyBackground="transparent" enhancing={false} preEnhanceInput={null} onEnhance={() => {}} onUndoEnhance={() => {}}
          onSubmit={() => {}} onSlashCommand={() => {}} modelLabel="Default" effort="high" onEffortChange={() => {}}
          adaptiveEnabled={false} repoLabel="Sample" displayMessagesCount={messages.length} hasAssistantActivity /> : null}
      </div></DesktopWebSocketProvider>
    </main>
  </ThemeProvider>;
}
