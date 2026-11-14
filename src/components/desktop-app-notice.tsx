// Served where the removed browser console used to load (/, /dashboard, /mobile).
// Static on purpose: no client code, no redirect, no sign-in.
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
        <h1 style={{ margin: 0, fontSize: 20, lineHeight: 1.3, fontWeight: 600 }}>o8 runs in the desktop app</h1>
        <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5, color: '#AEAEB2' }}>
          The browser console has been removed. Open the o8 app on this computer.
        </p>
      </div>
    </main>
  );
}
