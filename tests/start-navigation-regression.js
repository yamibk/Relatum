'use strict';

// Deterministic behavior tests for the actual browser controller, without application dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'start-navigation.js'), 'utf8');

function clock() {
  let now = 0, sequence = 0;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) { const id = ++sequence; tasks.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...tasks].filter(([, task]) => task.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].at;
        tasks.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    get size() { return tasks.size; },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(extra) {
  const scheduler = clock(), commits = [], previews = [], errors = [];
  const context = { window: {}, Set, Object, Promise, AbortController };
  vm.runInNewContext(source, context, { filename: 'start-navigation.js' });
  let nav;
  nav = context.window.RelatumStartNavigation.create(Object.assign({
    scheduler,
    initialRoute: { view: 'library', groupId: '' },
    feedback: route => previews.push(route.view + ':' + (route.groupId || '')),
    commit(route, previous, ctx) {
      assert.equal(nav.getState().current, route, 'current is submitted before the host commit');
      assert.equal(nav.getState().pending, false, 'the synchronous host commit sees a committed route');
      commits.push({ route, previous, ctx });
    },
    error: error => errors.push(error),
  }, extra));
  return { nav, scheduler, commits, previews, errors };
}

async function microtasks() { await Promise.resolve(); await Promise.resolve(); }

async function run() {
  {
    const f = fixture();
    f.nav.request({ view: 'calendar' }); f.scheduler.tick(30);
    f.nav.request({ view: 'notes' }); f.scheduler.tick(30);
    const id = f.nav.request({ view: 'study' }); f.scheduler.tick(39);
    assert.equal(f.commits.length, 0);
    assert.equal(f.nav.getState().desired.view, 'study');
    f.scheduler.tick(1);
    assert.equal(f.commits.length, 1);
    assert.equal(f.commits[0].route.view, 'study');
    assert(f.nav.isCurrent(id));
    assert.equal(f.scheduler.size, 0, 'steady navigation owns no timer or animation loop');
  }
  {
    const f = fixture();
    const id = f.nav.request({ view: 'calendar' }); f.scheduler.tick(20);
    f.nav.request({ view: 'library', groupId: '' }); f.scheduler.tick(100);
    assert.equal(f.commits.length, 0, 'reversing to the current route cancels an unsubmitted excursion');
    assert.equal(f.nav.isCurrent(id), false);
    assert.equal(f.nav.getState().pending, false);
    assert.equal(f.scheduler.size, 0);
  }
  {
    const ready = deferred(), prepared = [];
    const f = fixture({ prepare(route, ctx) { prepared.push(ctx); return route.view === 'focus' ? ready.promise : undefined; } });
    const stale = f.nav.request({ view: 'focus' }); f.scheduler.tick(40);
    f.nav.request({ view: 'calendar' }); f.scheduler.tick(40);
    ready.resolve(); await microtasks();
    assert.equal(f.commits.length, 1);
    assert.equal(f.nav.getState().current.view, 'calendar');
    assert.equal(f.nav.isCurrent(stale), false);
    assert.equal(prepared[0].isCurrent(), false, 'late module readiness cannot run stale attached actions');
    assert.equal(prepared[0].signal.aborted, true, 'replacing a request releases its readiness listeners');
  }
  {
    const f = fixture();
    f.nav.setComposing(true);
    f.nav.request({ view: 'study' }); f.scheduler.tick(100);
    f.nav.request({ view: 'notes' }, { immediate: true }); f.scheduler.tick(100);
    assert.equal(f.commits.length, 0, 'candidate input retains the editor until composition ends');
    f.nav.setComposing(false);
    assert.equal(f.commits.length, 0, 'compositionend handlers finish before immediate commit');
    f.scheduler.tick(0);
    assert.equal(f.commits.length, 1);
    assert.equal(f.commits[0].route.view, 'notes');
  }
  {
    const ready = deferred();
    let calls = 0;
    const contexts = [];
    const f = fixture({ prepare(route, ctx) { calls += 1; contexts.push(ctx); return ready.promise; } });
    f.nav.request({ view: 'notes' }); f.scheduler.tick(40);
    f.nav.setComposing(true); ready.resolve(); await microtasks();
    assert.equal(f.commits.length, 0);
    assert.equal(contexts[0].signal.aborted, true, 'composition restores a page faded by preparation');
    assert.equal(contexts[0].isCurrent(), false);
    f.nav.setComposing(false); f.scheduler.tick(40); await microtasks();
    assert.equal(f.commits.length, 1);
    assert.equal(calls, 2, 'preparation restarts after final composition input is handed off');
  }
  {
    let nav;
    const f = fixture({ prepare(route, ctx) {
      if (route.view === 'focus') ctx.signal.addEventListener('abort', () => {
        nav.request({ view: 'study' }, { immediate: true });
      }, { once: true });
    } });
    nav = f.nav;
    nav.request({ view: 'focus' }, { immediate: true });
    nav.request({ view: 'notes' }, { immediate: true });
    assert.equal(nav.getState().current.view, 'study', 'an abort callback cannot be overwritten by the interrupted request');
    assert.equal(nav.getState().desired.view, 'study');
    assert.equal(nav.getState().pending, false);
  }
  {
    const f = fixture();
    const id = f.nav.request({ view: 'study' }); f.scheduler.tick(20);
    assert.equal(f.nav.request({ view: 'study' }), id);
    f.scheduler.tick(20);
    f.nav.request({ view: 'study' }); f.scheduler.tick(40);
    assert.equal(f.commits.length, 1, 'ordinary same-route input does not replay activation');
    f.nav.request({ view: 'study' }, { action: 'toggle', immediate: true });
    assert.equal(f.commits.length, 2);
    assert.equal(f.commits[1].ctx.options.action, 'toggle');
    const action = () => {};
    f.nav.request({ view: 'study' }, { afterActivate: action, immediate: true });
    assert.equal(f.commits[2].ctx.options.afterActivate, action);
    f.nav.request({ view: 'focus' }, { forceTimer: true, immediate: true });
    assert.equal(f.commits[3].ctx.options.forceTimer, true);
  }
  {
    const ready = deferred();
    let signal;
    const f = fixture({ prepare(route, ctx) { signal = ctx.signal; return ready.promise; } });
    const id = f.nav.request({ view: 'focus' }); f.scheduler.tick(40);
    f.nav.cancel(); ready.resolve(); await microtasks();
    assert.equal(f.commits.length, 0);
    assert.equal(f.nav.getState().desired.view, 'library');
    assert.equal(f.nav.getState().pending, false);
    assert.equal(f.nav.isCurrent(id), false);
    assert.equal(signal.aborted, true);
    assert.equal(f.scheduler.size, 0);
  }
  {
    let signal, aborted = 0;
    const f = fixture({ prepare(route, ctx) {
      signal = ctx.signal;
      return new Promise(resolve => ctx.signal.addEventListener('abort', () => { aborted += 1; resolve(); }, { once: true }));
    } });
    f.nav.request({ view: 'focus' }); f.scheduler.tick(40);
    f.nav.destroy(); await microtasks();
    assert.equal(signal.aborted, true);
    assert.equal(aborted, 1);
    assert.equal(f.commits.length, 0);
  }
  {
    let shown = true;
    const f = fixture({ visible: () => shown });
    f.nav.request({ view: 'calendar' }); shown = false; f.scheduler.tick(40);
    assert.equal(f.commits.length, 0);
    assert.equal(f.nav.getState().pending, false);
    shown = true; f.nav.resume();
    assert.equal(f.scheduler.size, 0, 'returning does not replay an old hidden request');
    f.nav.request({ view: 'notes' }); f.nav.destroy(); f.scheduler.tick(100);
    assert.equal(f.commits.length, 0);
    assert.equal(f.scheduler.size, 0);
  }
  {
    const failure = new Error('cannot prepare'), f = fixture({ prepare() { throw failure; } });
    f.nav.request({ view: 'calendar' }); f.scheduler.tick(40);
    assert.equal(f.nav.getState().current.view, 'library');
    assert.equal(f.nav.getState().pending, false);
    assert.equal(f.previews[f.previews.length - 1], 'library:');
    assert.equal(f.errors[0], failure);
  }
  {
    let nav;
    const f = fixture({ prepare(route, ctx) {
      if (route.view !== 'focus') return;
      ctx.signal.addEventListener('abort', () => nav.request({ view: 'notes' }), { once: true });
      throw new Error('superseded failure');
    } });
    nav = f.nav;
    nav.request({ view: 'focus' }, { immediate: true });
    assert.equal(nav.getState().desired.view, 'notes');
    assert.equal(f.previews[f.previews.length - 1], 'notes:', 'failure cleanup cannot overwrite a newer target preview');
    assert.equal(f.errors.length, 0);
    f.scheduler.tick(40);
    assert.equal(nav.getState().current.view, 'notes');
  }
  {
    const failure = new Error('async preparation failed'), ready = deferred();
    const f = fixture({ prepare: () => ready.promise });
    const id = f.nav.request({ view: 'focus' }); f.scheduler.tick(40);
    ready.reject(failure); await microtasks();
    assert.equal(f.nav.getState().current.view, 'library');
    assert.equal(f.nav.getState().pending, false);
    assert.equal(f.nav.isCurrent(id), false);
    assert.equal(f.errors[0], failure);
  }
  {
    const failure = new Error('cannot commit'), f = fixture({ commit() { throw failure; } });
    const id = f.nav.request({ view: 'notes' }, { immediate: true });
    assert.equal(f.nav.getState().current.view, 'library');
    assert.equal(f.nav.getState().desired.view, 'library');
    assert.equal(f.nav.isCurrent(id), false);
    assert.equal(f.errors[0], failure);
  }
  {
    let nav, calls = 0;
    const f = fixture({ commit(route) {
      calls += 1;
      if (route.view === 'study') nav.request({ view: 'notes' }, { immediate: true });
    } });
    nav = f.nav;
    nav.request({ view: 'study' }, { immediate: true });
    assert.equal(calls, 2);
    assert.equal(nav.getState().current.view, 'notes', 'host reentry cannot be overwritten by the older commit');
    assert.equal(nav.getState().pending, false);
  }
  {
    const late = deferred(), f = fixture({ prepare: () => late.promise });
    f.nav.request({ view: 'focus' }); f.scheduler.tick(40);
    f.nav.cancel(); late.reject(new Error('stale failure')); await microtasks();
    assert.equal(f.errors.length, 0, 'cancelled preparation failure is not shown for another page');
  }
  {
    const f = fixture({ enabled: route => route.view !== 'review' });
    f.nav.request({ view: 'review' }, { immediate: true });
    assert.equal(f.commits.length, 0);
    const request = { view: 'library', groupId: 'a' };
    f.nav.request(request); request.groupId = 'changed outside'; f.scheduler.tick(40);
    assert.equal(f.nav.getState().current.groupId, 'a', 'caller mutation cannot retarget a queued route');
    assert.equal(Object.isFrozen(f.nav.getState().current), true);
  }
  {
    const late = deferred(), f = fixture({ prepare: () => late.promise });
    const changed = f.nav.requestAsync({ view: 'none' }, { immediate: true });
    late.resolve(); await microtasks();
    assert.equal(await changed, true);
    assert.equal(f.nav.getState().current.view, 'none');
    const cancelled = f.nav.requestAsync({ view: 'review' }); f.nav.cancel();
    assert.equal(await cancelled, false, 'a cancelled layout handoff always settles');
  }
  {
    const f = fixture({ commit() { throw Error('storage unavailable'); } });
    assert.equal(await f.nav.requestAsync({ view: 'none' }, { immediate: true }), false);
    assert.equal(f.nav.getState().current.view, 'library', 'failed visibility commit restores the current route');
  }
  {
    const late = deferred(), f = fixture({ prepare: () => late.promise });
    const changed = f.nav.requestAsync({ view: 'study' }, { immediate: true });
    f.nav.setComposing(true); late.resolve(); await microtasks();
    f.nav.setComposing(false); f.scheduler.tick(0); await microtasks();
    assert.equal(await changed, true, 'composition transfers layout completion to the replacement request');
  }
  console.log('start navigation regression passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
