// Canvas workspace navigation: one desired route, one quiet-period task, no frame loop.
(function () {
  'use strict';

  const VIEWS = new Set(['none', 'library', 'review', 'calendar', 'cadence', 'notes', 'tree', 'study', 'focus']);

  function routeOf(value) {
    if (!value || !VIEWS.has(value.view)) return null;
    return Object.freeze(value.view === 'library'
      ? { view: 'library', groupId: typeof value.groupId === 'string' ? value.groupId : '' }
      : { view: value.view });
  }

  function sameRoute(a, b) {
    return a.view === b.view && (a.view !== 'library' || a.groupId === b.groupId);
  }

  function create(config) {
    const settings = config || {};
    const scheduler = settings.scheduler || window;
    const later = scheduler.setTimeout.bind(scheduler);
    const clear = scheduler.clearTimeout.bind(scheduler);
    let current = routeOf(settings.initialRoute) || routeOf({ view: 'library' });
    let desired = current;
    let version = 0;
    let pending = null;
    let timer = null;
    let requestController = null;
    let composing = false;
    let destroyed = false;

    function report(error) {
      if (typeof settings.error === 'function') settings.error(error);
    }

    function visible() {
      return !destroyed && (typeof settings.visible !== 'function' || settings.visible() !== false);
    }

    function feedback(route) {
      if (typeof settings.feedback === 'function') settings.feedback(route);
    }

    function clearTimer() {
      if (timer !== null) clear(timer);
      timer = null;
    }

    function abortRequest() {
      const controller = requestController;
      requestController = null;
      if (controller) controller.abort();
    }

    function settle(entry, ok) { entry?.waiters?.splice(0).forEach(resolve => resolve(ok)); }

    function createRequest(route, options, transfer = false) {
      clearTimer();
      const previous = pending;
      const previousController = requestController;
      const controller = new AbortController();
      const id = ++version;
      const entry = { id, route, options, phase: 'waiting', context: null, waiters: transfer ? previous?.waiters || [] : [] };
      if (!transfer) settle(previous, false);
      entry.context = { id, options, signal: controller.signal, isCurrent: () => isCurrent(id) };
      requestController = controller;
      desired = route;
      pending = entry;
      // Publish the replacement first: abort listeners may themselves request navigation.
      if (previousController) previousController.abort();
      return entry;
    }

    function isCurrent(id) {
      return !destroyed && id === version && visible();
    }

    function cancel() {
      if (destroyed) return;
      clearTimer();
      const cancelledVersion = ++version;
      settle(pending, false);
      pending = null;
      desired = current;
      abortRequest();
      if (version === cancelledVersion) feedback(current);
    }

    function usable(entry) {
      if (destroyed || pending !== entry || version !== entry.id) return false;
      if (!visible()) { cancel(); return false; }
      return true;
    }

    function fail(entry, error, previous) {
      if (destroyed || version !== entry.id) return;
      settle(entry, false);
      clearTimer();
      const failureVersion = ++version;
      pending = null;
      if (previous) current = previous;
      desired = current;
      abortRequest();
      if (version !== failureVersion) return;
      feedback(current);
      if (version === failureVersion) report(error);
    }

    function commit(entry) {
      if (!usable(entry) || composing) return;
      const previous = current;
      // The host derives its legacy flags from getState() during its synchronous commit.
      current = entry.route;
      desired = current;
      // Host activation is synchronous. During it there is no uncommitted pending route.
      pending = null;
      try {
        if (typeof settings.commit === 'function') settings.commit(current, previous, entry.context);
      } catch (error) {
        fail(entry, error, previous);
        return;
      }
      settle(entry, true);
    }

    function prepared(entry) {
      if (!usable(entry)) return;
      entry.phase = 'ready';
      if (!composing) commit(entry);
    }

    function attempt(entry) {
      if (!usable(entry) || composing) return;
      if (entry.phase === 'ready') { commit(entry); return; }
      if (entry.phase === 'preparing') return;
      entry.phase = 'preparing';
      let result;
      try {
        if (typeof settings.enabled === 'function' && !settings.enabled(entry.route, entry.options)) {
          cancel();
          return;
        }
        result = typeof settings.prepare === 'function'
          ? settings.prepare(entry.route, entry.context) : undefined;
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).then(() => prepared(entry), error => fail(entry, error));
          return;
        }
      } catch (error) {
        fail(entry, error);
        return;
      }
      prepared(entry);
    }

    function schedule(entry, deferImmediate) {
      clearTimer();
      if (!usable(entry) || composing || entry.phase === 'preparing') return;
      if (entry.options.immediate && !deferImmediate) { attempt(entry); return; }
      timer = later(() => {
        timer = null;
        attempt(entry);
      }, entry.options.immediate ? 0 : 40);
    }

    function request(value, options) {
      if (destroyed) return version;
      if (!visible()) { cancel(); return version; }
      const route = routeOf(value);
      if (!route) return version;
      const opts = Object.assign({}, options);
      const hasAction = !!opts.action || opts.forceTimer === true || typeof opts.afterActivate === 'function';
      try {
        if (typeof settings.enabled === 'function' && !settings.enabled(route, opts)) return version;
      } catch (error) { report(error); return version; }
      if (pending && sameRoute(desired, route) && !hasAction) {
        if (opts.immediate && !pending.options.immediate) {
          pending.options.immediate = true;
          schedule(pending, false);
        }
        return pending ? pending.id : version;
      }
      if (sameRoute(current, route) && !hasAction) {
        if (pending) cancel();
        return version;
      }
      const entry = createRequest(route, opts);
      const id = entry.id;
      if (pending !== entry || version !== id) return id;
      try { feedback(route); }
      catch (error) { fail(entry, error); return id; }
      if (pending === entry) schedule(entry, false);
      return id;
    }

    function setComposing(value) {
      if (destroyed || composing === !!value) return;
      composing = !!value;
      clearTimer();
      if (composing && pending && pending.phase !== 'waiting') {
        // Preparation may have faded an editable page. Abort it while retaining the latest intent.
        createRequest(pending.route, pending.options, true);
      }
      // Even an immediate request waits for the compositionend event and final input handlers.
      if (!composing && pending) schedule(pending, true);
    }

    function resume() {
      if (destroyed) return;
      if (!visible()) { cancel(); return; }
      feedback(desired);
      if (pending) schedule(pending, true);
    }

    function destroy() {
      if (destroyed) return;
      clearTimer();
      destroyed = true;
      version += 1;
      settle(pending, false);
      pending = null;
      desired = current;
      composing = false;
      abortRequest();
    }

    return {
      request, cancel, resume, setComposing, isCurrent, destroy,
      requestAsync(value, options) {
        const route = routeOf(value);
        if (!route) return Promise.resolve(false);
        const id = request(route, options);
        if (pending?.id === id && sameRoute(pending.route, route)) return new Promise(resolve => pending.waiters.push(resolve));
        return Promise.resolve(!!route && sameRoute(current, route) && !pending);
      },
      getState() { return { current, desired, version, pending: !!pending }; },
    };
  }

  window.RelatumStartNavigation = { create };
})();
