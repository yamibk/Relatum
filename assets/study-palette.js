/* 学习页、目标树与记账页共用的 12 色粉彩色库及浮层控制器。
 * 色值、DOM、定位、焦点与出入场时序都只在这里维护；不写用户数据。 */
(function () {
  'use strict';
  var COLORS = [
    { value: '', label: '默认' },
    { value: '#fce2cc', label: '杏橙' },
    { value: '#e2ece4', label: '薄荷' },
    { value: '#e8ecf2', label: '天空' },
    { value: '#f0dee4', label: '蔷薇' },
    { value: '#ece2ee', label: '丁香' },
    { value: '#f3ecd8', label: '暖金' },
    { value: '#f2d9d6', label: '赤霞' },
    { value: '#def0ec', label: '青瓷' },
    { value: '#dde3f2', label: '雾蓝' },
    { value: '#eaf0dc', label: '新绿' },
    { value: '#f0efe9', label: '月灰' },
  ];

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
        return '<button type="button" class="study-route-color-swatch' + (active ? ' is-active' : '') + '"'
          + ' data-color="' + escapeHtml(value) + '" aria-label="' + escapeHtml(translate(item.label)) + '"'
          + (value ? ' style="background:' + value + '"' : '') + '></button>';
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
    createPopoverController: createPopoverController,
  });
})();
