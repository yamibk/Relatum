// A single notebook's CPU layout. Main thread grants each batch only while idle.
'use strict';
importScripts('graph-engine.js');
let task = null;
self.onmessage = function (event) {
  const message = event.data;
  try {
    if (message.type === 'prepare') {
      task = { id: message.id, nodes: message.nodes, edges: message.edges,
        solver: GraphEngine.createLayout({ nodes: message.nodes, edges: message.edges,
          config: message.config,
          getGravity: node => node.degree >= 6 ? .022 : node.degree >= 3 ? .009 : node.degree ? .005 : .0035 }) };
      self.postMessage({ id: task.id, type: 'ready' });
    } else if (message.type === 'step' && task?.id === message.id) {
      const end = performance.now() + 4;
      do { task.solver.step(); } while (!task.solver.settled && performance.now() < end);
      if (task.solver.settled) {
        self.postMessage({ id: task.id, type: 'done', positions: task.nodes.map(node => [node.x, node.y]) });
        task = null;
      } else self.postMessage({ id: task.id, type: 'ready' });
    }
  } catch (_) {
    self.postMessage({ id: message.id, type: 'error' }); task = null;
  }
};
