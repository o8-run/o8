import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentPanel } from '@/components/desktop/AgentPanel';
import { ChatListCard } from '@/app/dashboard/ChatListCard';
import { ChatListColumn } from '@/components/desktop/shell/ChatListColumn';
import { CompactNavigationRail } from '@/components/desktop/shell/CompactNavigationRail';
import { NAVIGATION_RAIL_WIDTH, SHELL_HEADER_HEIGHT } from '@/components/desktop/shell/shell-geometry';

// The production dashboard retains the panel but hides its column on collapse.
// Data/host services are supplied by the browser test; navigation is production UI.
function NavigationFixture() {
  const [visible, setVisible] = useState(true);
  const [selected, select] = useState('');
  Object.assign(window, { setChatsVisible: setVisible, selectedChat: selected });
  const noop = () => {};
  return <main style={{ display: 'flex', height: '100vh', color: 'var(--t-text)', background: 'var(--t-sidebar-bg)', fontFamily: 'var(--font-sans-system)' }}>
    <CompactNavigationRail activeDestination="agents" glassSurface={false} onHome={noop}
      onNewSession={noop} onCreateTerminal={noop} onOpenProjects={noop} onOpenSettings={noop}
      onOpenShortcuts={noop} onOpenPRs={noop} onOpenUsage={noop} />
    <div aria-hidden style={{ width: NAVIGATION_RAIL_WIDTH, flexShrink: 0 }} />
    <ChatListColumn visible={visible} width={320} overlay={false} onClose={() => setVisible(false)}>
      <div style={{ height: SHELL_HEADER_HEIGHT, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 12 }}>Chats</div>
      <ChatListCard glass={false} joined overlay={false}>
        <AgentPanel navigationRail onOpenHistoryChat={id => select(id)} />
      </ChatListCard>
    </ChatListColumn>
    <section aria-label="Fixture workspace" style={{ flex: 1, minWidth: 0, paddingTop: 48, paddingLeft: 24, background: 'var(--t-chat-surface-bg)' }}>
      Navigation density fixture · 72 saved chats
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<NavigationFixture />);
