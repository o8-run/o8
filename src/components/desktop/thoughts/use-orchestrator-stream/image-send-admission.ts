import { useEffect, useMemo, useState } from 'react';

export type ImageSendAdmission = { status: 'accepted' | 'rejected' | 'unconfirmed' | 'cancelled'; error?: string };

/** Only a correlated server acknowledgement permits retiring an image draft. */
export function createImageSendAdmissions() {
  const pending = new Map<string, { resolve: (result: ImageSendAdmission) => void; timer: ReturnType<typeof setTimeout> }>();
  const settle = (id: string, result: ImageSendAdmission) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer); entry.resolve(result);
  };
  return {
    register(id: string): Promise<ImageSendAdmission> {
      return new Promise(resolve => {
        const timer = setTimeout(() => settle(id, { status: 'unconfirmed' }), 20_000);
        pending.set(id, { resolve, timer });
      });
    },
    settle,
    observe(event: { event: string; data?: Record<string, unknown> }) {
      const id = event.data?.clientMessageId;
      if (typeof id !== 'string') return;
      if (event.event === 'send-ack' && (event.data?.state === 'accepted' || event.data?.state === 'replayed')) settle(id, { status: 'accepted' });
      if (event.event === 'error') settle(id, { status: 'rejected', error: typeof event.data?.error === 'string' ? event.data.error : 'The attachment was refused.' });
    },
    clear() { for (const id of pending.keys()) settle(id, { status: 'unconfirmed' }); },
  };
}

type AdmissionActivity = { event: string; data?: Record<string, unknown>; observedAt: number };
type SubmissionFailure = { userMessageId: string; outcome: 'failed'; text: string };

export function useImageSendAdmissions(activity: { current: (event: AdmissionActivity) => void }) {
  const [admissions] = useState(createImageSendAdmissions);
  useEffect(() => () => admissions.clear(), [admissions]);
  return useMemo(() => ({ ...admissions,
    observe(event: AdmissionActivity) { admissions.observe(event); activity.current(event); },
    onFailure(id: string, notify: (receipt: SubmissionFailure) => void) {
      return (receipt: SubmissionFailure) => { admissions.settle(id, { status: 'rejected', error: receipt.text }); notify(receipt); };
    },
  }), [activity, admissions]);
}
