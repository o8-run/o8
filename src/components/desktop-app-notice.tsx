// Served where the removed browser console used to load (/, /dashboard, /mobile),
// in a browser and in the older Windows and Linux window, which loads /dashboard.
// No redirect and no sign-in. It has no client code of its own; the root layout
// still wraps it.
export function DesktopAppNotice() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: '#1C1C1E',
        color: '#F2F2F7',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 420 }}>
        <h1 style={{ margin: 0, fontSize: 20, lineHeight: 1.3, fontWeight: 600 }}>The browser console has been removed</h1>
        <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5, color: '#AEAEB2' }}>
          This page no longer shows the o8 console. o8 runs in its native desktop window.
        </p>
      </div>
    </main>
  );
}
