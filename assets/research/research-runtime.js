import {
  advanceResearchTime, advanceResearchTimeSlice, nextResearchBoundary, refreshResearchWallTime, resetResearchComputeRuntime,
} from './research-compute.js';

const SPEEDS = new Set([0.25, 0.5, 1, 2, 4]);

export function createResearchSimulationController(options = {}) {
  const getRuntime = typeof options.getRuntime === 'function' ? options.getRuntime : () => null;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
  const readNow = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  let selectedPageId = '';
  let active = false;
  let visible = true;
  let disposed = false;
  let timerId = null;
  let wallTimerId = null;
  let generation = 0;
  let advanceTask = null;
  let lastWall = 0;
  const pageState = new Map();
  const counters = { scheduleCount: 0, cancellationCount: 0, tickCount: 0, stepCount: 0 };

  function state(pageId = selectedPageId) {
    pageId = String(pageId || '');
    if (!pageState.has(pageId)) pageState.set(pageId, { running: false, resumeIntent: false, speed: 1 });
    return pageState.get(pageId);
  }

  function operational() { return active && visible && !disposed; }

  function cancel() {
    generation += 1;
    advanceTask = null;
    if (timerId != null) { clearTimer(timerId); timerId = null; counters.cancellationCount += 1; }
    if (wallTimerId != null) { clearTimer(wallTimerId); wallTimerId = null; }
  }

  function publish() {
    const current = state();
    onStateChange(selectedPageId, {
      running: current.running && operational(), intent: current.resumeIntent,
      speed: current.speed, canStep: !!getRuntime(selectedPageId),
    });
  }

  function scheduleWall() {
    if (!operational() || wallTimerId != null || !selectedPageId) return;
    const scheduledGeneration = generation;
    wallTimerId = setTimer(() => {
      if (scheduledGeneration !== generation) return;
      wallTimerId = null;
      const runtime = getRuntime(selectedPageId);
      if (runtime) { refreshResearchWallTime(runtime, readNow()); onUpdate(selectedPageId, runtime.result, { wall: true }); }
      scheduleWall();
    }, 1000);
  }

  function schedule() {
    cancel();
    scheduleWall();
    const current = state(); const runtime = getRuntime(selectedPageId);
    if (!operational() || !current.running || !runtime || runtime.halted) { publish(); return; }
    const next = nextResearchBoundary(runtime);
    if (!Number.isFinite(next)) { publish(); return; }
    const simulationDelay = Math.max(1, next - runtime.simulationTime);
    const wallDelay = Math.max(4, Math.round(simulationDelay / current.speed));
    const scheduledAt = readNow();
    const scheduledGeneration = generation;
    counters.scheduleCount += 1;
    const continueAdvance = (target) => {
      if (scheduledGeneration !== generation) return;
      timerId = null;
      if (!operational() || !state().running) return;
      const live = getRuntime(selectedPageId);
      if (!live) return;
      const slice = advanceResearchTimeSlice(live, target, advanceTask, {
        maxSources: Number(options.maxSourcesPerSlice) || 256,
        timeBudgetMs: Number(options.timeBudgetMs) || 4,
        measureNow: typeof options.measureNow === 'function' ? options.measureNow : undefined,
      });
      advanceTask = slice.task;
      if (!slice.done) {
        timerId = setTimer(() => continueAdvance(target), 0);
        return;
      }
      counters.tickCount += 1;
      onUpdate(selectedPageId, live.result, { simulation: true });
      schedule();
    };
    timerId = setTimer(() => {
      if (scheduledGeneration !== generation) return;
      const live = getRuntime(selectedPageId);
      if (!live) return;
      const elapsed = Math.max(wallDelay, readNow() - scheduledAt);
      const target = Math.max(next, live.simulationTime + elapsed * state().speed);
      continueAdvance(target);
    }, wallDelay);
    publish();
  }

  function selectPage(pageId, speed = 1) {
    pageId = String(pageId || '');
    if (!pageId) return false;
    cancel(); selectedPageId = pageId;
    state(pageId).speed = SPEEDS.has(Number(speed)) ? Number(speed) : state(pageId).speed;
    lastWall = readNow(); schedule(); return true;
  }

  function run() {
    const current = state(); current.resumeIntent = true; current.running = true;
    lastWall = readNow(); schedule(); return true;
  }

  function pause(options = {}) {
    const current = state();
    if (!options.suspendOnly) current.resumeIntent = false;
    current.running = false; cancel(); scheduleWall(); publish(); return true;
  }

  function step() {
    const runtime = getRuntime(selectedPageId);
    if (!runtime) return false;
    const next = nextResearchBoundary(runtime);
    if (!Number.isFinite(next)) return false;
    advanceResearchTime(runtime, next); counters.stepCount += 1;
    onUpdate(selectedPageId, runtime.result, { simulation: true, step: true });
    publish(); return true;
  }

  function reset() {
    const runtime = getRuntime(selectedPageId);
    if (!runtime) return false;
    resetResearchComputeRuntime(runtime); onUpdate(selectedPageId, runtime.result, { reset: true, persistent: true });
    schedule(); return true;
  }

  function setSpeed(speed) {
    speed = Number(speed);
    if (!SPEEDS.has(speed)) return false;
    state().speed = speed; schedule(); return true;
  }

  function refresh() {
    if (disposed) return false;
    schedule(); return true;
  }

  function activate() {
    if (disposed) return false;
    active = true; visible = true;
    const current = state(); current.running = current.resumeIntent;
    lastWall = readNow(); schedule(); return true;
  }

  function suspend() {
    if (disposed) return true;
    const current = state(); current.resumeIntent = current.resumeIntent || current.running;
    current.running = false; active = false; cancel(); publish(); return true;
  }

  function setVisible(nextVisible) {
    visible = !!nextVisible;
    const current = state();
    if (!visible) { current.resumeIntent = current.resumeIntent || current.running; current.running = false; cancel(); }
    else if (active) { current.running = current.resumeIntent; lastWall = readNow(); schedule(); }
    publish(); return true;
  }

  function removePage(pageId) {
    pageState.delete(String(pageId || ''));
    if (String(pageId || '') === selectedPageId) { selectedPageId = ''; cancel(); }
  }

  function stats() {
    return { ...counters, selectedPageId, active, visible, pending: timerId != null, ...state() };
  }

  function dispose() {
    if (disposed) return true;
    cancel(); disposed = true; active = false; pageState.clear(); selectedPageId = ''; return true;
  }

  return Object.freeze({ activate, dispose, pause, refresh, removePage, reset, run, selectPage, setSpeed, setVisible, stats, step, suspend });
}
