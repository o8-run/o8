'use client';

import { Profiler, forwardRef, memo, useCallback } from 'react';
import type { ComponentPropsWithoutRef, ProfilerOnRenderCallback } from 'react';
import { ChatMessageList } from './ChatMessageList';

type ProfiledChatMessageListProps = ComponentPropsWithoutRef<typeof ChatMessageList>;

const LIST_COMMIT_LOG_INTERVAL_MS = 1000;

let lastListCommitLogAt = 0;

function getNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function logListCommit(phase: string, actualDuration: number, count: number): void {
  const now = getNowMs();
  if (now - lastListCommitLogAt < LIST_COMMIT_LOG_INTERVAL_MS) return;
  lastListCommitLogAt = now;

  console.log(
    '[perf][list-commit] phase=%s actualDuration=%sms count=%d',
    phase,
    actualDuration.toFixed(1),
    count,
  );
}

export const ProfiledChatMessageList = memo(forwardRef<HTMLDivElement, ProfiledChatMessageListProps>(
  function ProfiledChatMessageList(props, ref) {
    const count = props.displayMessages.length;
    const handleRender = useCallback<ProfilerOnRenderCallback>((_id, phase, actualDuration) => {
      logListCommit(phase, actualDuration, count);
    }, [count]);

    return (
      <Profiler id="chat-message-list" onRender={handleRender}>
        <ChatMessageList {...props} ref={ref} />
      </Profiler>
    );
  },
));
