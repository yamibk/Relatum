(function () {
  'use strict';

  const TOOLTIP_SELECTOR = '[data-ui-tooltip]';
  const TITLE_SELECTOR = '[title]';
  const FOCUS_DELAY = 80;
  const VIEWPORT_GAP = 10;
  const ANCHOR_GAP = 10;

  const HOVER_KEY = 'canvas:tooltipHoverDelay';
  const HIDE_KEY = 'canvas:tooltipHideDelay';
  const HOVER_DEFAULT = 3500;
  const HIDE_DEFAULT = 70;

  let hoverDelay = HOVER_DEFAULT;
  let hideDelay = HIDE_DEFAULT;

  function readStoredDelay(key, fallback) {
    try {
      const v = parseInt(localStorage.getItem(key), 10);
      if (Number.isFinite(v)) return Math.max(0, Math.min(5000, v));
    } catch (e) {}
    return fallback;
  }

  function loadDelays() {
    hoverDelay = readStoredDelay(HOVER_KEY, HOVER_DEFAULT);
    hideDelay = readStoredDelay(HIDE_KEY, HIDE_DEFAULT);
  }

  let tooltip = null;
  let activeElement = null;
  let showTimer = null;
  let hideTimer = null;
  let describedElement = null;
  let previousDescribedBy = '';
  let lastPointerDown = 0;
  const blockers = new Set();

  function ensureTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.id = 'relatum-ui-tooltip';
    tooltip.className = 'ui-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-hidden', 'true');
    tooltip.innerHTML = '<span class="ui-tooltip-copy"></span><span class="ui-tooltip-arrow" aria-hidden="true"></span>';
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function tooltipText(element) {
    return element && String(element.dataset.uiTooltip || '').trim();
  }

  function migrateTitle(element) {
    if (!(element instanceof Element)) return;
    const title = element.getAttribute('title');
    if (title == null) return;
    const text = title.trim();
    if (text) {
      element.dataset.uiTooltip = text;
      const language = window.RelatumI18n && window.RelatumI18n.language;
      const localizedSource = element.dataset.i18nSourceTitle;
      if (localizedSource || language !== 'en' || !element.dataset.uiTooltipSource) {
        element.dataset.uiTooltipSource = localizedSource || text;
      }
      if (element.matches('iframe') && !element.hasAttribute('aria-label')) {
        element.setAttribute('aria-label', text);
      }
    } else {
      delete element.dataset.uiTooltip;
    }
    element.removeAttribute('title');
    if (activeElement === element) {
      if (!text) hide(true);
      else if (tooltip) {
        tooltip.querySelector('.ui-tooltip-copy').textContent = text;
        positionTooltip(element);
      }
    }
  }

  function migrateTree(root) {
    if (!(root instanceof Element) && root !== document) return;
    if (root instanceof Element && root.hasAttribute('title')) migrateTitle(root);
    root.querySelectorAll(TITLE_SELECTOR).forEach(migrateTitle);
  }

  function restoreDescription() {
    if (!describedElement) return;
    if (previousDescribedBy) describedElement.setAttribute('aria-describedby', previousDescribedBy);
    else describedElement.removeAttribute('aria-describedby');
    describedElement = null;
    previousDescribedBy = '';
  }

  function attachDescription(element) {
    restoreDescription();
    describedElement = element;
    previousDescribedBy = element.getAttribute('aria-describedby') || '';
    const ids = previousDescribedBy.split(/\s+/).filter(Boolean);
    if (!ids.includes('relatum-ui-tooltip')) ids.push('relatum-ui-tooltip');
    element.setAttribute('aria-describedby', ids.join(' '));
  }

  function positionTooltip(element) {
    if (!tooltip || !element || !element.isConnected) return;
    const anchor = element.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const availableAbove = anchor.top - VIEWPORT_GAP;
    const availableBelow = window.innerHeight - anchor.bottom - VIEWPORT_GAP;
    const placeAbove = availableBelow < box.height + ANCHOR_GAP && availableAbove > availableBelow;
    let top = placeAbove
      ? anchor.top - box.height - ANCHOR_GAP
      : anchor.bottom + ANCHOR_GAP;
    let left = anchor.left + (anchor.width - box.width) / 2;

    left = Math.max(VIEWPORT_GAP, Math.min(left, window.innerWidth - box.width - VIEWPORT_GAP));
    top = Math.max(VIEWPORT_GAP, Math.min(top, window.innerHeight - box.height - VIEWPORT_GAP));

    const arrowX = Math.max(16, Math.min(anchor.left + anchor.width / 2 - left, box.width - 16));
    tooltip.dataset.placement = placeAbove ? 'top' : 'bottom';
    tooltip.style.setProperty('--ui-tooltip-arrow-x', arrowX + 'px');
    tooltip.style.transform = 'translate3d(' + Math.round(left) + 'px,' + Math.round(top) + 'px,0)';
  }

  function show(element) {
    const text = tooltipText(element);
    if (!text || !element.isConnected || blockers.size) return;
    const layer = ensureTooltip();
    activeElement = element;
    layer.querySelector('.ui-tooltip-copy').textContent = text;
    layer.classList.add('is-measuring');
    layer.setAttribute('aria-hidden', 'false');
    positionTooltip(element);
    layer.classList.remove('is-measuring');
    layer.classList.add('is-visible');
    attachDescription(element);
  }

  function scheduleShow(element, delay) {
    if (!tooltipText(element) || blockers.size) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (activeElement === element && tooltip && tooltip.classList.contains('is-visible')) {
      positionTooltip(element);
      return;
    }
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = null;
      show(element);
    }, delay);
  }

  function hide(immediate) {
    if (showTimer) clearTimeout(showTimer);
    showTimer = null;
    const finish = () => {
      if (tooltip) {
        tooltip.classList.remove('is-visible', 'is-measuring');
        tooltip.setAttribute('aria-hidden', 'true');
      }
      activeElement = null;
      restoreDescription();
      hideTimer = null;
    };
    if (immediate) {
      if (hideTimer) clearTimeout(hideTimer);
      finish();
    } else {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(finish, hideDelay);
    }
  }

  function closestTooltipTarget(target) {
    return target instanceof Element ? target.closest(TOOLTIP_SELECTOR) : null;
  }

  function refreshLocalizedTooltips() {
    document.querySelectorAll(TOOLTIP_SELECTOR).forEach((element) => {
      const source = element.dataset.i18nSourceTitle || element.dataset.uiTooltipSource;
      if (!source || !window.RelatumI18n) return;
      element.dataset.uiTooltip = window.RelatumI18n.language === 'en'
        ? window.RelatumI18n.t(source)
        : source;
    });
    if (activeElement) {
      const text = tooltipText(activeElement);
      if (!text) hide(true);
      else {
        tooltip.querySelector('.ui-tooltip-copy').textContent = text;
        positionTooltip(activeElement);
      }
    }
  }

  function start() {
    loadDelays();
    ensureTooltip();
    migrateTree(document);

    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'attributes') {
          migrateTitle(record.target);
          return;
        }
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) migrateTree(node);
        });
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['title']
    });

    document.addEventListener('pointerover', (event) => {
      const target = closestTooltipTarget(event.target);
      if (!target || target.contains(event.relatedTarget)) return;
      scheduleShow(target, hoverDelay);
    });
    document.addEventListener('pointerout', (event) => {
      const target = closestTooltipTarget(event.target);
      if (!target || target.contains(event.relatedTarget)) return;
      hide(false);
    });
    document.addEventListener('focusin', (event) => {
      const target = closestTooltipTarget(event.target);
      if (!target) return;
      const delay = (Date.now() - lastPointerDown < 500) ? hoverDelay : FOCUS_DELAY;
      scheduleShow(target, delay);
    });
    document.addEventListener('focusout', (event) => {
      const target = closestTooltipTarget(event.target);
      if (target) hide(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && activeElement) hide(true);
    });
    document.addEventListener('pointerdown', () => { lastPointerDown = Date.now(); hide(true); }, true);
    document.addEventListener('relatum:languagechange', refreshLocalizedTooltips);
    window.addEventListener('resize', () => activeElement ? positionTooltip(activeElement) : null);
    window.addEventListener('scroll', () => hide(true), true);
    window.addEventListener('blur', () => hide(true));
    document.addEventListener('canvas:tooltip-hover-delay', (event) => {
      hoverDelay = Number.isFinite(event.detail) ? Math.max(0, Math.min(5000, event.detail)) : HOVER_DEFAULT;
    });
    document.addEventListener('canvas:tooltip-hide-delay', (event) => {
      hideDelay = Number.isFinite(event.detail) ? Math.max(0, Math.min(5000, event.detail)) : HIDE_DEFAULT;
    });
    // A color chooser needs unobstructed swatches, including when a tooltip
    // was pending on the row underneath it. Owners release on close/pagehide.
    document.addEventListener('canvas:tooltip-block', (event) => {
      const owner = event.detail?.owner;
      if (!(owner instanceof Element)) return;
      if (event.detail.blocked) blockers.add(owner); else blockers.delete(owner);
      if (blockers.size) hide(true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
