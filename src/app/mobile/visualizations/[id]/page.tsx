import { notFound } from 'next/navigation';
import { ThemeProvider } from '@/lib/theme/context';
import { VISUALIZATION_ID } from '@/lib/visualizations/types';
import { VisualizationWorkspace } from '@/components/desktop/visualizations/VisualizationWorkspace';

export default async function MobileVisualizationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!VISUALIZATION_ID.test(id)) notFound();
  return <ThemeProvider>
    <main style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0,
      background: 'var(--t-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
      <a href="/mobile" style={{ display: 'flex', alignItems: 'center', minHeight: 44, flexShrink: 0,
        paddingLeft: 12, paddingRight: 12, paddingTop: 'env(safe-area-inset-top, 0px)',
        color: 'var(--t-text-muted)', fontSize: 12, fontWeight: 300 }}>Back to mobile</a>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <VisualizationWorkspace id={id} />
      </div>
    </main>
  </ThemeProvider>;
}
