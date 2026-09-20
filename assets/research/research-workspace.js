(function (global) {
  'use strict';

  const stage = document.querySelector('[data-research-stage]');
  let phase = 'suspended';
  let desiredPhase = 'suspended';
  let runtime = null;
  let runtimePromise = null;
  let disposed = false;

  function setPhase(next) {
    phase = next;
    document.documentElement.dataset.researchPhase = next;
    document.body.dataset.researchPhase = next;
  }

  function loadRuntime() {
    if (runtime) return Promise.resolve(runtime);
    if (runtimePromise) return runtimePromise;
    runtimePromise = import('./research-editor.js')
      .then(async function (module) {
        if (!module || typeof module.createResearchEditor !== 'function') {
          throw new Error('research-editor.js 没有完成初始化');
        }
        runtime = await module.createResearchEditor(stage);
        if (!runtime || typeof runtime.activate !== 'function'
          || typeof runtime.suspend !== 'function' || typeof runtime.dispose !== 'function') {
          throw new Error('研究画布生命周期不可用');
        }
        if (desiredPhase === 'disposed') runtime.dispose();
        else if (desiredPhase === 'active') runtime.activate();
        else runtime.suspend();
        return runtime;
      })
      .catch(function (error) {
        runtimePromise = null;
        throw error;
      });
    return runtimePromise;
  }

  async function activate() {
    if (disposed) return false;
    desiredPhase = 'active';
    const editor = await loadRuntime();
    if (disposed || desiredPhase !== 'active') return false;
    editor.activate();
    if (stage) stage.inert = false;
    setPhase('active');
    return true;
  }

  async function suspend() {
    if (disposed) return true;
    desiredPhase = 'suspended';
    if (runtime) runtime.suspend();
    if (stage) stage.inert = true;
    setPhase('suspended');
    return true;
  }

  function dispose() {
    if (disposed) return true;
    desiredPhase = 'disposed';
    disposed = true;
    if (runtime) runtime.dispose();
    else if (runtimePromise) runtimePromise.then(function (editor) { editor.dispose(); }).catch(function () {});
    if (stage) stage.inert = true;
    setPhase('disposed');
    return true;
  }

  global.RelatumResearchWorkspace = Object.freeze({
    activate: activate,
    suspend: suspend,
    dispose: dispose,
  });

  setPhase('suspended');
  global.addEventListener('pagehide', dispose, { once: true });
})(window);
