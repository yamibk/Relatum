// Shared finite scheduler: numbers, coalesced pointer work and wheel inertia.
export function scheduler() {
  const jobs = new Map(); let frame = 0, enabled = true, ticking = false;
  function tick(now) {
    frame = 0; ticking = true;
    for (const [key, job] of [...jobs]) if (job(now) !== true) jobs.delete(key);
    ticking = false;
    if (enabled && jobs.size) frame = requestAnimationFrame(tick);
  }
  return {
    add(key, job) { jobs.set(key, job); if (enabled && !frame && !ticking) frame = requestAnimationFrame(tick); },
    remove(key) { jobs.delete(key); if (!jobs.size && frame) { cancelAnimationFrame(frame); frame = 0; } },
    stop() { enabled = false; jobs.clear(); cancelAnimationFrame(frame); frame = 0; },
    start() { enabled = true; }, get size() { return jobs.size; }
  };
}
export function scrolling(scroll, schedule, canRun) {
  const defaults = { strength: 100, inertia: 45, acceleration: 60, maxSpeed: 2400, pauseReveal: false };
  let prefs = defaults, idleMs = 50, height = 0, max = 0, velocity = 0, last = 0, wheelAt = 0, idle = 0, paused = false;
  function read() {
    try { prefs = { ...defaults, ...JSON.parse(localStorage.getItem('canvas:careerScrollFeel:v1') || '{}') }; idleMs = Number(localStorage.getItem('canvas:careerScrollIdleMs:v1') || 50); } catch (_) {}
  }
  read();
  const measure = () => { height = scroll.clientHeight; max = Math.max(0, scroll.scrollHeight-height); };
  const ro = new ResizeObserver(measure); ro.observe(scroll);
  const content = scroll.querySelector('[data-role="career-report"]'); if (content) ro.observe(content);
  function stop() { velocity = 0; last = 0; schedule.remove('wheel'); }
  function tick(now) {
    if (!canRun() || Math.abs(velocity) < 2) { stop(); return false; }
    const delta = last ? Math.min(40, now-last) : 1000/60; last = now;
    const before = scroll.scrollTop, next = Math.max(0, Math.min(max, before + velocity*delta/1000));
    scroll.scrollTop = next;
    velocity *= Math.pow(.84 + Math.min(100, Math.max(0,prefs.inertia))*.0014, delta/(1000/60));
    if (next === before || next === 0 || next === max) { stop(); return false; }
    return true;
  }
  const abort = new AbortController(), signal = abort.signal;
  scroll.addEventListener('wheel', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) { stop(); return; }
    if (event.target.closest('input,textarea,select,[data-career-graph]')) { stop(); return; }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || prefs.inertia <= 0 || (event.deltaMode === 0 && Math.abs(event.deltaY) < 40)) { stop(); return; }
    event.preventDefault();
    const now = performance.now(), amount = event.deltaY*(event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
    const burst = now-wheelAt < 190 ? 1 + prefs.acceleration*.006 : 1; wheelAt = now;
    const impulse = amount * (prefs.strength/100) * 8 * burst;
    velocity = Math.max(-prefs.maxSpeed, Math.min(prefs.maxSpeed, Math.sign(impulse) !== Math.sign(velocity) ? impulse : velocity*.45 + impulse));
    schedule.add('wheel', tick);
  }, { passive: false, signal });
  scroll.addEventListener('scroll', () => { paused = true; clearTimeout(idle); idle = setTimeout(() => { paused = false; }, idleMs); }, { passive: true, signal });
  scroll.addEventListener('pointerdown', stop, { passive: true, signal });
  scroll.addEventListener('keydown', event => { if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) stop(); }, { signal });
  document.addEventListener('relatum:career-scroll-feel', event => { prefs = { ...defaults, ...event.detail }; if (!prefs.inertia) stop(); }, { signal });
  document.addEventListener('relatum:career-scroll-idle', event => { idleMs = Math.max(20,Math.min(160,event.detail.ms)); }, { signal });
  return { measure, stop, get isScrolling(){return paused;}, get revealPaused() { return prefs.pauseReveal && paused; }, destroy() { stop(); clearTimeout(idle); ro.disconnect(); abort.abort(); } };
}
export function animateNumbers(host, schedule, pause) {
  const finishes=[];
  const nodes=host.matches('[data-career-number]:not([data-counted])')?[host]:host.querySelectorAll('[data-career-number]:not([data-counted])');
  for (const node of nodes) {
    node.dataset.counted = '1';
    const target = Number(node.dataset.careerNumber), render = node._format;
    if (!render || matchMedia('(prefers-reduced-motion: reduce)').matches) continue;
    // Reserve the final text's width and keep one stable text node.
    const reserve = document.createElement('span'); reserve.className = 'career-number-reserve'; reserve.textContent = render(target);
    const value = document.createElement('span'); value.className = 'career-number-value'; const text = document.createTextNode(render(0)); value.append(text); node.replaceChildren(reserve,value);
    finishes.push(()=>{schedule.remove(node);text.data=render(target);});
    let elapsed = 0, last = 0;
    schedule.add(node, now => { if (pause()) { last=now; return true; } elapsed += last ? Math.min(40,now-last) : 0; last=now;
      const progress = Math.min(1,elapsed/720); text.data = render(target*(1-Math.pow(1-progress,4)));
      return progress < 1;
    });
  }
  return ()=>finishes.forEach(finish=>finish());
}
