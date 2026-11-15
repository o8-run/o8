import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'o8',
  description: "Your agents write the code. o8 reviews it, sends it back until it's right, and merges it.",
  other: {
    'theme-color': '#1C1C1E',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" style={{ background: '#1C1C1E' }} suppressHydrationWarning>
      <head></head>
      <body style={{ background: '#1C1C1E', margin: 0 }} suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
