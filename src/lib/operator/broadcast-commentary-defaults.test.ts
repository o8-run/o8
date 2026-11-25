import { describe, expect, it } from 'vitest';

import {
  applyBroadcastCommentaryUpdate,
  BROADCAST_COMMENTARY_FALLBACK,
  resolveBroadcastCommentaryDefaults,
} from './broadcast-commentary-defaults';

describe('Broadcast operator defaults', () => {
  it('starts with the feed off and the Calendar and check-in posts enabled', () => {
    expect(resolveBroadcastCommentaryDefaults({})).toMatchObject({
      broadcastVoice: 'off',
      broadcastVoiceCalendar: true,
      broadcastVoiceCalendarLeadMinutes: 15,
      broadcastVoiceTimeCheckins: true,
    });
  });

  it('round-trips valid policy updates and rejects an out-of-range lead time', () => {
    const stored = { ...BROADCAST_COMMENTARY_FALLBACK };
    applyBroadcastCommentaryUpdate(stored, {
      broadcastVoice: 'on',
      broadcastVoiceTimeCheckins: false,
      broadcastVoiceCalendarLeadMinutes: 20,
    });
    expect(stored).toMatchObject({
      broadcastVoice: 'on',
      broadcastVoiceTimeCheckins: false,
      broadcastVoiceCalendarLeadMinutes: 20,
    });
    expect(() => applyBroadcastCommentaryUpdate(stored, {
      broadcastVoiceCalendarLeadMinutes: 1_441,
    })).toThrow(/1 through 1440/);
  });
});
