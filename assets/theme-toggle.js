// Shared, local SVG artwork. Theme state and persistence stay with the page shells.
(function () {
  'use strict';
  const icons = Array.from(document.querySelectorAll('.start-theme-toggle-icon'));
  let sequence = 0;
  icons.forEach(icon => {
    let id;
    do { id = 'relatum-theme-moon-' + ++sequence; } while (document.getElementById(id));
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-24" y="-24" width="72" height="72" style="mask-type:luminance">
        <rect x="-24" y="-24" width="72" height="72" fill="white" stroke="none"/>
        <circle class="theme-icon-cutout" cx="24" cy="9" r="6" fill="black" stroke="none"/>
      </mask></defs>
      <circle class="theme-icon-disc" cx="12" cy="12" r="5.5" fill="currentColor" stroke="none" mask="url(#${id})"/>
      <path class="theme-icon-rays" d="M12 1.5v2M12 20.5v2M1.5 12h2M20.5 12h2M4.58 4.58 6 6M18 18l1.42 1.42M4.58 19.42 6 18M18 6l1.42-1.42" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
  });
  function finish() {
    icons.forEach(icon => icon.getAnimations?.({ subtree: true }).forEach(animation => {
      try { animation.finish(); } catch (_) {}
    }));
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(); });
  window.addEventListener('canvasdesktop:visibility', () => { if (document.documentElement.dataset.desktopMinimized === '1') finish(); });
  window.addEventListener('pagehide', finish);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  motion.addEventListener('change', () => { if (motion.matches) finish(); });
})();
