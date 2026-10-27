import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';

export function ThreadActivity({ tasks }: { tasks: TaskPoolTask[] }) {
  const observed = Math.max(0, ...tasks.map(task => Date.parse(task.thread?.observedAt ?? '') || 0));
  const events = [...new Map(tasks.flatMap(task => task.thread?.history ?? []).map(event => [event.id, event])).values()];
  const bins = Array<number>(24).fill(0);
  for (const event of events) {
    const age = observed - Date.parse(event.at);
    if (age >= 0 && age < 86_400_000) bins[23 - Math.floor(age / 3_600_000)]++;
  }
  const highest = Math.max(1, ...bins);
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, color: 'var(--t-text-faint)', fontSize: 10 }}>
    <span>Recorded activity · 24h</span><svg role="img" aria-label={`${bins.reduce((sum, value) => sum + value, 0)} recorded events in the last 24 hours`} width="120" height="20" viewBox="0 0 120 20">
      {bins.map((value, index) => <rect key={index} x={index * 5} y={20 - Math.max(1, value / highest * 20)} width="3" height={Math.max(1, value / highest * 20)} fill="currentColor" opacity={value ? 0.8 : 0.2} />)}
    </svg><span>Bounded history</span>
  </div>;
}
