import { notFound } from 'next/navigation';
import { CompactionThreadPreview } from './CompactionThreadPreview';

export default async function CompactionThreadPreviewPage({ searchParams }: { searchParams: Promise<{ view?: string; composer?: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { view, composer } = await searchParams;
  return <CompactionThreadPreview reloaded={view === 'reloaded'} composer={composer === '1'} />;
}
