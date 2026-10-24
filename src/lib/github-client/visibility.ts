'use client';
import { useSyncExternalStore } from 'react';
const subscribe = (callback: () => void) => {
  document.addEventListener('visibilitychange', callback);
  return () => document.removeEventListener('visibilitychange', callback);
};
/** Rescheduling observers on a visibility transition avoids one last fast hidden poll. */
export function useGithubWindowHidden() {
  return useSyncExternalStore(subscribe, () => document.hidden, () => false);
}
