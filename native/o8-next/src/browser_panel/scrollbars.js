// Presentation-only portion of lib/browser/native-agent-source.ts.
(() => {
  function hideScrollbarChrome() {
    if (!document.documentElement || document.getElementById('o8-native-scrollbars')) return;
    const style = document.createElement('style');
    style.id = 'o8-native-scrollbars';
    style.textContent = '* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }';
    document.documentElement.appendChild(style);
  }
  hideScrollbarChrome();
  document.addEventListener('DOMContentLoaded', hideScrollbarChrome, { once: true });
})();
