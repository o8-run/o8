import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import BroadcastPage from '@/components/broadcast/BroadcastPage';

createRoot(document.getElementById('broadcast-root')!).render(createElement(BroadcastPage));
