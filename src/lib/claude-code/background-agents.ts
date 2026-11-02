export interface BackgroundAgentAnswer {
  id: string;
  output: string;
  isError: boolean;
}

/**
 * A background agent's call returns at launch. Its answer arrives in a
 * task_notification, and the model reads that answer in a request of its own,
 * so the turn stays open until it has. Background shells report tasks too, but
 * a dev server never finishes, so only agents count.
 */
export function createBackgroundAgents() {
  const running = new Set<string>();
  let unreadAnswer = false;
  let seen = false;
  return {
    /** Reads a `system` event and returns the answer it carries, if any. */
    observe(event: Record<string, unknown>): BackgroundAgentAnswer | null {
      const id = typeof event.tool_use_id === 'string' ? event.tool_use_id : null;
      if (event.subtype === 'task_started' && id && event.is_backgrounded === true && event.task_type === 'local_agent') {
        running.add(id);
        seen = true;
      } else if (event.subtype === 'task_notification' && id && running.delete(id)) {
        unreadAnswer = true;
        return {
          id,
          output: typeof event.summary === 'string' ? event.summary : '',
          isError: event.status !== 'completed' && event.status !== 'stopped',
        };
      } else if (event.subtype === 'status' && event.status === 'requesting') {
        unreadAnswer = false;
      }
      return null;
    },
    isRunning: (id: string) => running.has(id),
    holdsResult: () => running.size > 0 || unreadAnswer,
    seen: () => seen,
    forget() {
      running.clear();
      unreadAnswer = false;
    },
  };
}
