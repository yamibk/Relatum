import { createResearchModel } from './research-model.js';
import { createResearchCanvas } from './research-canvas.js';

export function createResearchEditor(stage) {
  if (!stage) throw new Error('研究工作区舞台不存在');
  const model = createResearchModel({ nodes: [], edges: [] });
  const canvas = createResearchCanvas({ stage, model });
  let disposed = false;

  function activate() {
    if (disposed) return false;
    return canvas.activate();
  }

  function suspend() {
    if (disposed) return true;
    return canvas.suspend();
  }

  function dispose() {
    if (disposed) return true;
    disposed = true;
    return canvas.dispose();
  }

  return Object.freeze({ activate, suspend, dispose });
}
