(function(){'use strict';
if(window.RelatumFocusService)return;
const listeners=new Set(); let saving=null;
function hostToast(message) { window.RelatumDailyLoader?.toast(message); }
const DUR_KEY = 'daily:focusDurations';
const SOUND_KEY = 'daily:focusSound';
const NOISE_KEY = 'daily:focusNoise';
const NOISE_VOL_KEY = 'daily:focusNoiseVol';
const NOISE_SRC_URL = '/audio/rain.mp3';
const NOISE_XFADE_SEC = 3;
const NOISE_MAX_GAIN = 0.9;
const NOISE_FADE_OUT_MS = 2000;
const NOISE_PAUSE_CACHE_MS = 30000;
const MODE_KEY = 'daily:focusMode';
const TASK_KEY = 'daily:focusTask';
const KIND_KEY = 'daily:focusTaskKind';
const STATE_KEY = 'daily:focusRuntime';
const RUNTIME_PERSIST_MS = 5000;
const DUR_DEFAULT = { focus: 25, brk: 5, long: 15, rounds: 4 };
const LOG_MIN_SEC = 60;
const goalDraft = { value: "" };
const outcomeDraft = { value: "" };
let durations = loadDurations();
let soundOn = loadSound();
let noiseOn = loadNoiseOn();
let noiseVol = loadNoiseVol();
let noiseNodes = null;
let noisePlaying = false;
let noiseBuffer = null;
let noiseLoading = false;
let noiseLoadController = null;
let noiseLoadVersion = 0;
let noiseStopTimer = 0;
let noiseReleaseTimer = 0;
let mode = loadMode();
let running = false;
let paused = false;
let phase = 'focus';
let remaining = durations.focus * 60;
let elapsed = 0;
let completedFocus = 0;
let ticker = null;
let lastTickAt = 0;
let lastRuntimePersistAt = 0;
let boundTaskId = '';
let boundTaskTitle = '';
let boundKind = '';
let audioCtx = null;
let pendingSession = null;
let expiredRestore = null;
let restorePrompted = false;
function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }
function clampInt(value, lo, hi, fallback) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(lo, Math.min(hi, number)) : fallback;
  }
function toast(message) { hostToast(message); }
async function post(path, body) { const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const json=await response.json(); if(!response.ok||json.ok===false)throw Error(json.error||'保存失败'); document.dispatchEvent(new CustomEvent('canvas:data-changed',{detail:{source:'focus',path}})); return json; }
function loadDurations() {
    try {
      const raw = JSON.parse(localStorage.getItem(DUR_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        return {
          focus: clampInt(raw.focus, 1, 180, DUR_DEFAULT.focus),
          brk: clampInt(raw.brk, 1, 60, DUR_DEFAULT.brk),
          long: clampInt(raw.long, 1, 90, DUR_DEFAULT.long),
          rounds: clampInt(raw.rounds, 2, 12, DUR_DEFAULT.rounds),
        };
      }
    } catch (e) {}
    return Object.assign({}, DUR_DEFAULT);
  }
function loadSound() {
    try { return localStorage.getItem(SOUND_KEY) !== '0'; } catch (e) { return true; }
  }
function loadNoiseOn() {
    try { return localStorage.getItem(NOISE_KEY) === '1'; } catch (e) { return false; }
  }
function loadNoiseVol() {
    try {
      const raw = parseFloat(localStorage.getItem(NOISE_VOL_KEY));
      return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
    } catch (e) { return 0.5; }
  }
function loadMode() {
    try { return localStorage.getItem(MODE_KEY) === 'countup' ? 'countup' : 'pomodoro'; }
    catch (e) { return 'pomodoro'; }
  }
function savePreferences() {
    try {
      localStorage.setItem(DUR_KEY, JSON.stringify(durations));
      localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0');
      localStorage.setItem(NOISE_KEY, noiseOn ? '1' : '0');
      localStorage.setItem(NOISE_VOL_KEY, String(noiseVol));
      localStorage.setItem(MODE_KEY, mode);
      if (boundTaskId) {
        localStorage.setItem(TASK_KEY, boundTaskId);
        localStorage.setItem(KIND_KEY, boundKind || 'daily');
      } else {
        localStorage.removeItem(TASK_KEY);
        localStorage.removeItem(KIND_KEY);
      }
    } catch (e) {}
  }
function persistRuntime() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        version: 1,
        running, paused, mode, phase, remaining, elapsed, completedFocus,
        boundTaskId, boundTaskTitle, boundKind,
        goal: goalDraft ? goalDraft.value : '',
        pendingSession,
        outcome: outcomeDraft ? outcomeDraft.value : '',
        savedAt: Date.now(),
      }));
      lastRuntimePersistAt = Date.now();
    } catch (e) {}
  }
function clearRuntime() {
    try { localStorage.removeItem(STATE_KEY); } catch (e) {}
  }
function restoreRuntime() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || raw.version !== 1 || (!raw.running && !raw.pendingSession)) return;
    mode = raw.mode === 'countup' ? 'countup' : 'pomodoro';
    phase = raw.phase === 'break' ? 'break' : 'focus';
    running = true;
    paused = !!raw.paused;
    remaining = Math.max(0, Number(raw.remaining) || durations.focus * 60);
    elapsed = Math.max(0, Number(raw.elapsed) || 0);
    completedFocus = Math.max(0, Number(raw.completedFocus) || 0);
    boundTaskId = String(raw.boundTaskId || '');
    boundTaskTitle = String(raw.boundTaskTitle || '');
    boundKind = raw.boundKind === 'daily' ? 'daily' : '';
    if (!boundKind) { boundTaskId = ''; boundTaskTitle = ''; }
    if (goalDraft) goalDraft.value = String(raw.goal || '');
    if (raw.pendingSession && Number(raw.pendingSession.durationSec) >= LOG_MIN_SEC) {
      pendingSession = {
        id: String(raw.pendingSession.id || ""), record: raw.pendingSession.record,
        durationSec: Math.round(Number(raw.pendingSession.durationSec)),
        goal: String(raw.pendingSession.goal || ''),
      };
      paused = true;
      if (outcomeDraft) outcomeDraft.value = String(raw.outcome || '');
      return;
    }
    const passed = paused ? 0 : Math.max(0, Math.floor((Date.now() - Number(raw.savedAt || Date.now())) / 1000));
    if (mode === 'countup') {
      elapsed += passed;
    } else if (passed >= remaining) {
      expiredRestore = {
        phase,
        durationSec: phase === 'focus' ? durations.focus * 60 : 0,
      };
      paused = true;
      remaining = 0;
    } else {
      remaining -= passed;
    }
    if (!paused && !expiredRestore) {
      lastTickAt = Date.now();
      startInterval();
    }
  }
function ensureAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return;
    }
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) audioCtx = new AudioContext();
    } catch (e) { audioCtx = null; }
  }
function chime(kind) {
    if (!soundOn || !audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      const notes = kind === 'break' ? [523.25] : [523.25, 783.99];
      notes.forEach((frequency, index) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const startAt = now + index * 0.18;
        osc.type = 'sine';
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(0.14, startAt + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.9);
        osc.connect(gain).connect(audioCtx.destination);
        osc.onended = function () {
          try { osc.disconnect(); } catch (e) {}
          try { gain.disconnect(); } catch (e) {}
        };
        osc.start(startAt);
        osc.stop(startAt + 1);
      });
    } catch (e) {}
  }
function makeSeamlessBuffer(decoded) {
    try {
      const sr = decoded.sampleRate;
      const ch = decoded.numberOfChannels;
      const n = decoded.length;
      let x = Math.floor(NOISE_XFADE_SEC * sr);
      if (x > Math.floor(n / 2)) x = Math.floor(n / 2);
      if (x < 1 || n <= x) return decoded;
      const outLen = n - x;
      const out = audioCtx.createBuffer(ch, outLen, sr);
      for (let c = 0; c < ch; c += 1) {
        const src = decoded.getChannelData(c);
        const dst = out.getChannelData(c);
        for (let i = x; i < outLen; i += 1) dst[i] = src[i];
        // 接缝区：头部淡入 + 尾部淡出（等功率），令循环点两端都平滑衔接
        for (let i = 0; i < x; i += 1) {
          const t = (i + 1) / (x + 1);
          const gIn = Math.sin(t * Math.PI / 2);
          const gOut = Math.cos(t * Math.PI / 2);
          dst[i] = src[i] * gIn + src[outLen + i] * gOut;
        }
      }
      return out;
    } catch (e) { return decoded; }
  }
function startNoiseSource() {
    if (noiseNodes || !audioCtx || !noiseBuffer) return;
    try {
      const source = audioCtx.createBufferSource();
      source.buffer = noiseBuffer;
      source.loop = true;
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(audioCtx.destination);
      source.start();
      noiseNodes = { source, gain };
    } catch (e) { noiseNodes = null; }
  }
function ensureNoiseChain() {
    if (noiseNodes || !audioCtx) return;
    if (noiseBuffer) { startNoiseSource(); return; }
    if (noiseLoading) return;
    noiseLoading = true;
    const version = ++noiseLoadVersion;
    const controller = noiseLoadController = new AbortController();
    fetch(NOISE_SRC_URL, { signal: controller.signal })
      .then((r) => { if (!r.ok) throw new Error('noise ' + r.status); return r.arrayBuffer(); })
      .then((ab) => version === noiseLoadVersion ? audioCtx.decodeAudioData(ab) : null)
      .then((decoded) => {
        // decodeAudioData 不能取消；关闭/离页后的结果不能再保留约 54 MiB PCM 或重启音源。
        if (!decoded || version !== noiseLoadVersion) return;
        noiseBuffer = makeSeamlessBuffer(decoded);
        noiseLoading = false;
        noiseLoadController = null;
        // 解码期间若已切到「应播放」，补建链并淡入
        if (noisePlaying) { startNoiseSource(); rampNoise(noiseTarget()); }
      })
      .catch(() => {
        if (version !== noiseLoadVersion) return;
        noiseLoading = false;
        noiseLoadController = null;
      });
  }
function releaseNoiseBuffer() {
    noiseLoadVersion += 1;
    if (noiseLoadController) noiseLoadController.abort();
    noiseLoadController = null;
    noiseLoading = false;
    noiseBuffer = null;
  }
function stopNoiseSource() {
    const nodes = noiseNodes;
    noiseNodes = null;
    if (!nodes) return;
    try { nodes.source.stop(); } catch (e) {}
    try { nodes.source.disconnect(); } catch (e) {}
    try { nodes.source.buffer = null; } catch (e) {}
    try { nodes.gain.disconnect(); } catch (e) {}
  }
function clearNoiseTimers() {
    window.clearTimeout(noiseStopTimer);
    window.clearTimeout(noiseReleaseTimer);
    noiseStopTimer = noiseReleaseTimer = 0;
  }
function noiseTarget() { return Math.max(0, Math.min(NOISE_MAX_GAIN, noiseVol * NOISE_MAX_GAIN)); }
function rampNoise(target) {
    if (!noiseNodes || !audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      noiseNodes.gain.gain.cancelScheduledValues(now);
      noiseNodes.gain.gain.setTargetAtTime(target, now, 0.4);
    } catch (e) {}
  }
function updateNoise() {
    const shouldPlay = noiseOn && running && !paused && !pendingSession && phase === 'focus';
    if (shouldPlay) {
      clearNoiseTimers();
      noisePlaying = true;
      ensureAudio();
      ensureNoiseChain();
      rampNoise(noiseTarget());
      return;
    }
    if (noisePlaying) rampNoise(0);
    noisePlaying = shouldPlay;
    // 短暂停顿复用 PCM；关闭、完成及休息阶段直接放弃缓存。静音不再无限循环。
    if (!noiseOn || !running || pendingSession || phase !== 'focus') {
      window.clearTimeout(noiseReleaseTimer);
      noiseReleaseTimer = 0;
      releaseNoiseBuffer();
    } else if (!noiseReleaseTimer && (noiseBuffer || noiseLoading)) {
      noiseReleaseTimer = window.setTimeout(() => {
        noiseReleaseTimer = 0;
        if (!noisePlaying) releaseNoiseBuffer();
      }, NOISE_PAUSE_CACHE_MS);
    }
    if (noiseNodes && !noiseStopTimer) {
      noiseStopTimer = window.setTimeout(() => {
        noiseStopTimer = 0;
        if (!noisePlaying) stopNoiseSource();
      }, NOISE_FADE_OUT_MS);
    }
  }
function totalForPhase() {
    if (mode === 'countup') return 0;
    if (phase === 'break') {
      const longBreak = completedFocus > 0 && completedFocus % durations.rounds === 0;
      return (longBreak ? durations.long : durations.brk) * 60;
    }
    return durations.focus * 60;
  }
function startInterval() {
    if (!ticker) ticker = setInterval(onTick, 1000);
  }
function stopInterval() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    lastTickAt = 0;
  }
function onTick() {
    if (paused || !running || pendingSession) return;
    const now = Date.now();
    if (!lastTickAt) { lastTickAt = now; return; }
    const delta = Math.floor((now - lastTickAt) / 1000);
    if (delta < 1) return;
    lastTickAt += delta * 1000;
    if (mode === 'countup') {
      elapsed += delta;
    } else {
      remaining -= delta;
      if (remaining <= 0) {
        remaining = 0;
        endPhase();
        return;
      }
    }
    syncDisplay();
    // savedAt 足以在恢复时补算经过时间；无需每秒做一次同步 localStorage 写入。
    if (now - lastRuntimePersistAt >= RUNTIME_PERSIST_MS) persistRuntime();
  }
function start() {
    ensureAudio();
    if (!running) {
      running = true;
      paused = false;
      phase = 'focus';
      elapsed = 0;
      if (mode === 'pomodoro') remaining = durations.focus * 60;
    } else {
      paused = false;
    }
    lastTickAt = Date.now();
    startInterval();
    syncDisplay();
    persistRuntime();
  }
function pause() {
    onTick();
    stopInterval();
    paused = true;
    lastTickAt = 0;
    syncDisplay();
    persistRuntime();
  }
function reset() {
    stopInterval();
    running = false;
    paused = false;
    phase = 'focus';
    completedFocus = 0;
    remaining = durations.focus * 60;
    elapsed = 0;
    pendingSession = null;
    if (goalDraft) goalDraft.value = '';
    clearRuntime();
    syncDisplay();
  }
function endPhase() {
    if (phase === 'break') {
      chime('break');
      phase = 'focus';
      remaining = durations.focus * 60;
      syncDisplay();
      persistRuntime();
      return;
    }
    chime('focus');
    beginWrapup(mode === 'countup' ? elapsed : durations.focus * 60);
  }
function finishSegment() {
    onTick();
    if (mode === 'countup') {
      if (elapsed >= LOG_MIN_SEC) beginWrapup(elapsed);
      else reset();
      return;
    }
    if (phase === 'break') {
      phase = 'focus';
      remaining = durations.focus * 60;
      syncDisplay();
      persistRuntime();
      return;
    }
    const done = durations.focus * 60 - remaining;
    if (done >= LOG_MIN_SEC) beginWrapup(done);
    else {
      phase = 'break';
      remaining = totalForPhase();
      syncDisplay();
      persistRuntime();
    }
  }
function beginWrapup(durationSec) {
    stopInterval();
    pendingSession = {
      id: 'fs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      durationSec: Math.max(LOG_MIN_SEC, Math.round(durationSec)),
      goal: goalDraft ? goalDraft.value.trim() : '',
    };
    paused = true;
    lastTickAt = 0;
    if (outcomeDraft) outcomeDraft.value = '';
    syncDisplay();
    persistRuntime();
  }
async function saveWrapup(action) {
    if (!pendingSession) return;
    const taskId = boundTaskId;
    const taskTitle = boundTaskTitle;
    const kind = boundKind;
    const durationSec = pendingSession.durationSec;
    const goal = pendingSession.goal;
    const outcome = outcomeDraft ? outcomeDraft.value.trim() : '';
    await logSession(durationSec, goal, outcome);
    if (action === 'done' && taskId && kind === 'daily') {
      try {
        await completeDailyTask(taskId);
        toast('已保存专注记录，并完成今天的「' + taskTitle + '」');
      } catch (error) {
        toast('专注记录已保存，每日任务未更新 · ' + error.message);
      }
    }
    pendingSession = null;
    syncDisplay();
    if (goalDraft) goalDraft.value = '';
    if (action === 'next') {
      if (mode === 'pomodoro') {
        completedFocus += 1;
        phase = 'break';
        remaining = totalForPhase();
      } else {
        elapsed = 0;
        phase = 'focus';
      }
      running = true;
      paused = false;
      lastTickAt = Date.now();
      startInterval();
      syncDisplay();
      persistRuntime();
    } else {
      reset();
    }
  }
function logSession(durationSec, goal, outcome) {
    // 每日任务的分钟另走 /api/daily-add-minutes；taskTitle 仍留作足迹圆点的显示名。
    const kind = boundKind;
    const dailyId = kind === 'daily' ? boundTaskId : '';
    const session = pendingSession.record || (pendingSession.record = {
      id: pendingSession.id || (pendingSession.id = 'fs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
      mode,
      durationSec: Math.round(durationSec),
      taskId: '',
      taskTitle: boundTaskTitle || '',
      goal: String(goal || ''),
      outcome: String(outcome || ''),
      day: todayStr(),
      endedAt: new Date().toISOString(),
    });
    persistRuntime();
    const mins = Math.max(1, Math.round(session.durationSec / 60));
    return post('/api/focus-log', session).then(() => {
      const dailyUpdate = dailyId && window.RelatumFeatureRuntime.enabled('daily.tasks')
        ? post('/api/daily-add-minutes', { id: dailyId, minutes: mins, requestId: session.id }) : Promise.resolve();
      return dailyUpdate.then(() => {
        toast(session.taskTitle ? '专注 ' + mins + ' 分 · ' + session.taskTitle + ' ✦ 已记下' : '专注 ' + mins + ' 分 ✦ 已记下');
        document.dispatchEvent(new CustomEvent('canvas:data-changed', {
          detail: { source: 'focus', path: '/api/focus-log' },
        }));
        return session;
      });
    }).catch((error) => {
      toast('专注记录未保存 · ' + error.message);
      throw error;
    });
  }
function syncDisplay() { updateNoise(); listeners.forEach(fn => fn()); }
function setMode(next) {
    if ((next !== 'pomodoro' && next !== 'countup') || next === mode || running) return;
    mode = next;
    elapsed = 0;
    remaining = durations.focus * 60;
    savePreferences();
    syncDisplay();
  }
function bindTask(id, title, kind) {
    if (running || pendingSession) {
      toast('请先完成或重置当前专注段');
      return false;
    }
    boundTaskId = String(id || '');
    boundTaskTitle = String(title || '');
    boundKind = id && kind === 'daily' ? 'daily' : '';
    if (!boundKind) { boundTaskId = ''; boundTaskTitle = ''; }
    savePreferences();
    return true;
  }
function completeDailyTask(id) { return post('/api/daily-toggle', {id, done:true}); }
function addDailyMinutes(id, minutes) { return post('/api/daily-add-minutes', {id, minutes}); }
function handleExpiredRestore() {
    if (!expiredRestore || restorePrompted) return;
    restorePrompted = true;
    const expired = expiredRestore;
    expiredRestore = null;
    if (expired.phase === 'focus') {
      beginWrapup(expired.durationSec);
    } else {
      phase = 'focus';
      remaining = durations.focus * 60;
      paused = true;
      syncDisplay();
      persistRuntime();
      toast('上次休息已经结束，可以开始下一段');
    }
  }

const api = { loadDurations, loadSound, loadNoiseOn, loadNoiseVol, loadMode, savePreferences, persistRuntime, clearRuntime, restoreRuntime, ensureAudio, chime, makeSeamlessBuffer, startNoiseSource, ensureNoiseChain, releaseNoiseBuffer, stopNoiseSource, clearNoiseTimers, noiseTarget, rampNoise, updateNoise, totalForPhase, startInterval, stopInterval, onTick, start, pause, reset, endPhase, finishSegment, beginWrapup, logSession, setMode, bindTask, handleExpiredRestore,
    finishWrapup(action) { if(!saving) saving = saveWrapup(action).finally(()=>{saving=null;}); return saving; },
    subscribe(fn) { listeners.add(fn); return ()=>listeners.delete(fn); },
    get goal(){return goalDraft.value;}, set goal(value){goalDraft.value=String(value||'');persistRuntime();},
    get outcome(){return outcomeDraft.value;}, set outcome(value){outcomeDraft.value=String(value||'');persistRuntime();},
    get active(){return running||!!pendingSession;},
    releaseIdleAudio() {
      if (!running || paused || pendingSession) {
        clearNoiseTimers(); releaseNoiseBuffer(); stopNoiseSource();
        const context = audioCtx; audioCtx = null;
        context?.close().catch(() => {});
      }
    }
};
Object.defineProperty(api, 'durations', {get(){return durations;},set(value){durations=value;}});
Object.defineProperty(api, 'soundOn', {get(){return soundOn;},set(value){soundOn=value;}});
Object.defineProperty(api, 'noiseOn', {get(){return noiseOn;},set(value){noiseOn=value;}});
Object.defineProperty(api, 'noiseVol', {get(){return noiseVol;},set(value){noiseVol=value;}});
Object.defineProperty(api, 'noiseNodes', {get(){return noiseNodes;},set(value){noiseNodes=value;}});
Object.defineProperty(api, 'noisePlaying', {get(){return noisePlaying;},set(value){noisePlaying=value;}});
Object.defineProperty(api, 'noiseBuffer', {get(){return noiseBuffer;},set(value){noiseBuffer=value;}});
Object.defineProperty(api, 'noiseLoading', {get(){return noiseLoading;},set(value){noiseLoading=value;}});
Object.defineProperty(api, 'noiseLoadController', {get(){return noiseLoadController;},set(value){noiseLoadController=value;}});
Object.defineProperty(api, 'noiseLoadVersion', {get(){return noiseLoadVersion;},set(value){noiseLoadVersion=value;}});
Object.defineProperty(api, 'noiseStopTimer', {get(){return noiseStopTimer;},set(value){noiseStopTimer=value;}});
Object.defineProperty(api, 'noiseReleaseTimer', {get(){return noiseReleaseTimer;},set(value){noiseReleaseTimer=value;}});
Object.defineProperty(api, 'mode', {get(){return mode;},set(value){mode=value;}});
Object.defineProperty(api, 'running', {get(){return running;},set(value){running=value;}});
Object.defineProperty(api, 'paused', {get(){return paused;},set(value){paused=value;}});
Object.defineProperty(api, 'phase', {get(){return phase;},set(value){phase=value;}});
Object.defineProperty(api, 'remaining', {get(){return remaining;},set(value){remaining=value;}});
Object.defineProperty(api, 'elapsed', {get(){return elapsed;},set(value){elapsed=value;}});
Object.defineProperty(api, 'completedFocus', {get(){return completedFocus;},set(value){completedFocus=value;}});
Object.defineProperty(api, 'ticker', {get(){return ticker;},set(value){ticker=value;}});
Object.defineProperty(api, 'lastTickAt', {get(){return lastTickAt;},set(value){lastTickAt=value;}});
Object.defineProperty(api, 'lastRuntimePersistAt', {get(){return lastRuntimePersistAt;},set(value){lastRuntimePersistAt=value;}});
Object.defineProperty(api, 'boundTaskId', {get(){return boundTaskId;},set(value){boundTaskId=value;}});
Object.defineProperty(api, 'boundTaskTitle', {get(){return boundTaskTitle;},set(value){boundTaskTitle=value;}});
Object.defineProperty(api, 'boundKind', {get(){return boundKind;},set(value){boundKind=value;}});
Object.defineProperty(api, 'audioCtx', {get(){return audioCtx;},set(value){audioCtx=value;}});
Object.defineProperty(api, 'pendingSession', {get(){return pendingSession;},set(value){pendingSession=value;}});
Object.defineProperty(api, 'expiredRestore', {get(){return expiredRestore;},set(value){expiredRestore=value;}});
Object.defineProperty(api, 'restorePrompted', {get(){return restorePrompted;},set(value){restorePrompted=value;}});

try { boundTaskId=localStorage.getItem(TASK_KEY)||''; boundKind=boundTaskId?'daily':''; } catch(_) {}
restoreRuntime(); handleExpiredRestore(); updateNoise();
window.addEventListener('pagehide',()=>{persistRuntime();stopInterval();clearNoiseTimers();releaseNoiseBuffer();stopNoiseSource();audioCtx?.suspend().catch(()=>{});});
window.addEventListener('pageshow',e=>{if(e.persisted){restoreRuntime();syncDisplay();}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)onTick();});
window.RelatumFocusService=api;
})();
