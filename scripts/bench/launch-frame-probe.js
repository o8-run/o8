(() => {
  const observe = () => {
    const content = document.body && [...document.body.children].some(node => {
      if (['SCRIPT', 'STYLE', 'LINK'].includes(node.tagName)) return false;
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    if (!content) return requestAnimationFrame(observe);
    requestAnimationFrame(() => {
      window.__o8LaunchRenderedFrame = { pageMs: performance.now(), epochMs: Date.now(),
        method: 'two-frame observation of nonempty dashboard content' };
      performance.mark('o8:launch:rendered-frame');
    });
  };
  requestAnimationFrame(observe);
})();
