/* 学习页、树状页、目标树与记账页共用的 12 色主题色库及浮层控制器。
 * 持久化色值、主题呈现色、DOM、定位、焦点与出入场时序都只在这里维护；不写用户数据。 */
(function () {
  'use strict';
  // value 是已有数据的颜色标识；light / dark 仅控制显示，不改写保存值。
  // lightAccent 独立保留浅色描边；深色使用更鲜活的完整色面与配套墨色文字。
  var DARK_INK = '#172033';
  var LIGHT_INK = '#edf0ea';
  var FORCED_DARK_INK = '#000000';
  var FORCED_LIGHT_INK = '#ffffff';
  var CONTRAST_TARGET = 4.5;
  var COLORS = [
    { value: '', label: '默认' },
    { value: '#fce2cc', label: '杏橙', light: '#fceee3', lightAccent: '#654e40', dark: '#ffa563' },
    { value: '#e2ece4', label: '薄荷', light: '#eaf6ee', lightAccent: '#3f5b4e', dark: '#55dcae' },
    { value: '#e8ecf2', label: '天空', light: '#eaf4fc', lightAccent: '#3c576b', dark: '#56c9f5' },
    { value: '#f0dee4', label: '蔷薇', light: '#ffe3ef', lightAccent: '#654958', dark: '#f47eac' },
    { value: '#ece2ee', label: '丁香', light: '#f4edfa', lightAccent: '#564d6c', dark: '#b18cf4' },
    { value: '#f3ecd8', label: '暖金', light: '#fafec3', lightAccent: '#685c3e', dark: '#f8d34e' },
    { value: '#f2d9d6', label: '赤霞', light: '#fcede9', lightAccent: '#694c48', dark: '#fa867e' },
    { value: '#def0ec', label: '青瓷', light: '#daf5ef', lightAccent: '#3c5d5b', dark: '#49d4cf' },
    { value: '#dde3f2', label: '雾蓝', light: '#e3e9ff', lightAccent: '#485570', dark: '#7da4fa' },
    { value: '#eaf0dc', label: '新绿', light: '#f1f7e6', lightAccent: '#515f42', dark: '#a4dd72' },
    { value: '#f0efe9', label: '月灰', light: '#f5f3ee', lightAccent: '#585650', dark: '#b7c5da' },
  ];

  function toneFor(value) {
    value = String(value || '').trim().toLowerCase();
    if (!value) return null;
    var item = COLORS.find(function (candidate) {
      return String(candidate.value || '').toLowerCase() === value;
    });
    return item ? {
      light: item.light || item.value,
      lightAccent: item.lightAccent || item.value,
      dark: item.dark || item.value,
      darkInk: DARK_INK,
    } : null;
  }

  function rgbFor(value) {
    var match = String(value || '').trim().match(/^#([0-9a-f]{6})$/i);
    if (!match) return null;
    return [
      parseInt(match[1].slice(0, 2), 16),
      parseInt(match[1].slice(2, 4), 16),
      parseInt(match[1].slice(4, 6), 16),
    ];
  }

  function mixRgb(first, second, amount) {
    var a = rgbFor(first);
    var b = rgbFor(second);
    if (!a || !b) return b || a;
    amount = Math.max(0, Math.min(1, Number(amount) || 0));
    return a.map(function (channel, index) {
      return Math.round(channel * amount + b[index] * (1 - amount));
    });
  }

  function relativeLuminance(rgb) {
    if (!rgb) return 0;
    var linear = rgb.map(function (value) {
      value /= 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
  }

  function contrastRatio(first, second) {
    var high = Math.max(relativeLuminance(first), relativeLuminance(second));
    var low = Math.min(relativeLuminance(first), relativeLuminance(second));
    return (high + 0.05) / (low + 0.05);
  }

  function classContains(element, name) {
    return !!(element && element.classList && typeof element.classList.contains === 'function'
      && element.classList.contains(name));
  }

  function darkPresentationFor(scope) {
    var source = window.RelatumBoot && window.RelatumBoot.darkCardPresentation;
    var value = source && source[scope];
    var fill = Number(value && value.fill);
    var ink = value && (value.ink === 'auto' || value.ink === 'dark') ? value.ink : 'light';
    return {
      fill: Number.isFinite(fill) ? Math.max(0, Math.min(100, fill)) : 15,
      ink: ink,
    };
  }

  function darkPresentationInk(element, name, tone, scope) {
    var presentation = darkPresentationFor(scope);
    if (presentation.ink === 'light') return FORCED_LIGHT_INK;
    if (presentation.ink === 'dark') return FORCED_DARK_INK;
    var fill = presentation.fill / 100;
    var coloredSurface = tone.dark;
    var baseSurface = '#242a26';
    if (scope === 'tree' && classContains(element, 'is-root')) {
      coloredSurface = tone.light;
      baseSurface = '#f0eee7';
    } else if (name === 'task-color') {
      if (classContains(element, 'study-temporary-card')) baseSurface = '#242725';
      else if (classContains(element, 'study-list-row')) baseSurface = '#111213';
      else baseSurface = '#1c1e1d';
    }
    var surface = mixRgb(coloredSurface, baseSurface, fill);
    var dark = rgbFor(DARK_INK);
    var light = rgbFor(LIGHT_INK);
    var darkContrast = contrastRatio(surface, dark);
    var lightContrast = contrastRatio(surface, light);
    var preferred = darkContrast >= lightContrast ? DARK_INK : LIGHT_INK;
    if (Math.max(darkContrast, lightContrast) >= CONTRAST_TARGET) return preferred;
    var black = [0, 0, 0];
    var white = [255, 255, 255];
    return contrastRatio(surface, black) >= contrastRatio(surface, white) ? '#000000' : '#ffffff';
  }

  function applyColorTones(element, name, value, options) {
    if (!element || !name) return;
    var tone = toneFor(value);
    var lightName = '--' + name + '-light';
    var darkName = '--' + name + '-dark';
    var lightAccentName = '--' + name + '-light-accent';
    var darkInkName = '--' + name + '-dark-ink';
    var scope = options && (options.scope === 'tree' || options.scope === 'study')
      ? options.scope : '';
    if (tone) {
      element.style.setProperty(lightName, tone.light);
      element.style.setProperty(darkName, tone.dark);
      element.style.setProperty(lightAccentName, tone.lightAccent);
      element.style.setProperty(darkInkName, scope
        ? darkPresentationInk(element, name, tone, scope)
        : tone.darkInk);
      if (scope && element.dataset) element.dataset.darkCardPresentationScope = scope;
    } else {
      element.style.removeProperty(lightName);
      element.style.removeProperty(darkName);
      element.style.removeProperty(lightAccentName);
      element.style.removeProperty(darkInkName);
      if (element.dataset) delete element.dataset.darkCardPresentationScope;
    }
  }

  var darkPresentationFrame = 0;
  function refreshDarkCardPresentation() {
    darkPresentationFrame = 0;
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    document.querySelectorAll('[data-dark-card-presentation-scope][data-task-color], [data-dark-card-presentation-scope][data-branch-color]')
      .forEach(function (element) {
        var scope = element.dataset.darkCardPresentationScope;
        if (element.hasAttribute('data-task-color')) {
          applyColorTones(element, 'task-color', element.getAttribute('data-task-color'), { scope: scope });
        } else {
          applyColorTones(element, 'branch-color', element.getAttribute('data-branch-color'), { scope: scope });
        }
      });
  }

  function scheduleDarkCardPresentationRefresh() {
    if (darkPresentationFrame) return;
    if (typeof window.requestAnimationFrame !== 'function') {
      refreshDarkCardPresentation();
      return;
    }
    darkPresentationFrame = window.requestAnimationFrame(refreshDarkCardPresentation);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function createPopoverController(options) {
    options = options || {};
    var popover = null;
    var trigger = null;
    var anchorX = 0;
    var anchorY = 0;
    var pick = null;
    var positionFrame = 0;
    var reducedMotion = !!options.reducedMotion;
    var translate = typeof options.translate === 'function' ? options.translate : function (value) { return value; };

    function buildPalette(currentColor) {
      currentColor = String(currentColor || '').trim().toLowerCase();
      return '<div class="study-route-color-palette">' + COLORS.map(function (item) {
        var value = String(item.value || '').toLowerCase();
        var active = value === currentColor || (!value && !currentColor);
        var swatchStyle = value ? ' style="--palette-swatch-light:' + (item.light || value)
          + ';--palette-swatch-dark:' + (item.dark || value) + '"' : '';
        return '<button type="button" class="study-route-color-swatch' + (active ? ' is-active' : '') + '"'
          + ' data-color="' + escapeHtml(value) + '" aria-label="' + escapeHtml(translate(item.label)) + '"'
          + swatchStyle + '></button>';
      }).join('') + '</div>';
    }

    function position() {
      if (!popover) return;
      var rect = popover.getBoundingClientRect();
      var edge = 12;
      var left = anchorX + 10;
      var top = anchorY + 10;
      if (left + rect.width > window.innerWidth - edge) left = anchorX - rect.width - 10;
      if (top + rect.height > window.innerHeight - edge) top = anchorY - rect.height - 10;
      popover.style.left = Math.round(Math.max(edge, left)) + 'px';
      popover.style.top = Math.round(Math.max(edge, top)) + 'px';
    }

    function schedulePosition() {
      if (!popover || positionFrame) return;
      positionFrame = window.requestAnimationFrame(function () {
        positionFrame = 0;
        if (!trigger || !trigger.isConnected) {
          close(false, true);
          return;
        }
        position();
      });
    }

    function close(restoreFocus, instant) {
      var box = popover;
      var returnTarget = trigger;
      if (!box) return;
      if (positionFrame) window.cancelAnimationFrame(positionFrame);
      positionFrame = 0;
      popover = null;
      trigger = null;
      pick = null;
      if (typeof options.onClose === 'function') options.onClose(box, returnTarget);
      var finish = function () {
        if (box.isConnected) box.remove();
        if (restoreFocus && returnTarget && returnTarget.isConnected) returnTarget.focus({ preventScroll: true });
      };
      if (instant || reducedMotion) {
        finish();
        return;
      }
      box.classList.remove('is-open');
      box.classList.add('is-closing');
      window.setTimeout(finish, 190);
    }

    function open(nextTrigger, clientX, clientY, openOptions) {
      openOptions = openOptions || {};
      if (!nextTrigger) return null;
      close(false, true);
      trigger = nextTrigger;
      var triggerRect = trigger.getBoundingClientRect();
      anchorX = Number.isFinite(clientX) ? clientX : triggerRect.right;
      anchorY = Number.isFinite(clientY) ? clientY : triggerRect.bottom;
      pick = typeof openOptions.pick === 'function' ? openOptions.pick : null;
      var box = document.createElement('section');
      box.className = 'study-color-popover';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', openOptions.label || translate('选择颜色'));
      box.innerHTML = buildPalette(openOptions.currentColor || '');
      box.addEventListener('contextmenu', function (event) { event.preventDefault(); });
      box.addEventListener('click', function (event) {
        var swatch = event.target.closest('button[data-color]');
        if (!swatch) return;
        var handler = pick;
        var value = swatch.dataset.color || '';
        close(false, true);
        if (handler) handler(value);
      });
      popover = box;
      document.body.appendChild(box);
      position();
      window.requestAnimationFrame(function () {
        if (popover !== box) return;
        box.classList.add('is-open');
        position();
      });
      window.setTimeout(function () {
        if (popover !== box) return;
        var active = box.querySelector('.study-route-color-swatch.is-active');
        var target = active || box.querySelector('.study-route-color-swatch');
        if (target) target.focus({ preventScroll: true });
      }, reducedMotion ? 0 : 80);
      return box;
    }

    return Object.freeze({
      open: open,
      close: close,
      schedulePosition: schedulePosition,
      isOpen: function () { return !!popover; },
      getElement: function () { return popover; },
      getTrigger: function () { return trigger; },
    });
  }

  window.RelatumStudyPalette = Object.freeze({
    COLORS: Object.freeze(COLORS.map(function (item) { return Object.freeze(item); })),
    toneFor: toneFor,
    applyColorTones: applyColorTones,
    createPopoverController: createPopoverController,
  });
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('relatum:dark-card-presentation-change', scheduleDarkCardPresentationRefresh);
  }
})();
