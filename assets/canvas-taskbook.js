// Taskbook V2 zero-DOM data layer.
// The Taskbook is a library. Top-level tasks live in canvas.taskbook.roots;
// optional task-root nodes and task-workflow edges are only canvas projections.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.RelatumCanvasTaskbooks = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
  'use strict';

  const VERSION = 2;
  const ROOT_NODE_KIND = 'task-root';
  const WORKFLOW_ROLE = 'task-workflow';
  const LEGACY_ROOT_KIND = 'taskbook';
  const LEGACY_WORKFLOW_ROLE = 'taskbook-workflow';
  const TASK_KINDS = new Set(['card', 'preview']);
  const MAX_TITLE_LENGTH = 160;
  const MAX_SESSIONS = 5000;

  function text(value) {
    return String(value == null ? '' : value);
  }

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function iso(value, fallback) {
    const raw = text(value).trim();
    return /^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw : fallback;
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function makeId(prefix) {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return prefix + '-' + global.crypto.randomUUID();
    }
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function isTaskRootNode(node) {
    return !!node && node.kind === ROOT_NODE_KIND && !!text(node.taskRootId).trim();
  }

  function isLegacyTaskbookNode(node) {
    return !!node && node.kind === LEGACY_ROOT_KIND;
  }

  function isTaskNode(node) {
    return !!node && TASK_KINDS.has(node.kind);
  }

  function isWorkflowEdge(edge) {
    return !!edge && edge.role === WORKFLOW_ROLE && !!text(edge.taskRootId).trim();
  }

  function isLegacyWorkflowEdge(edge) {
    return !!edge && edge.role === LEGACY_WORKFLOW_ROLE;
  }

  function normalizeSession(raw, fallbackNow) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const durationMs = Math.max(0, Math.round(finite(raw.durationMs, 0)));
    if (!durationMs) return null;
    const startedAt = iso(raw.startedAt, fallbackNow);
    return {
      id: text(raw.id).trim() || makeId('task-segment'),
      nodeId: text(raw.nodeId).trim(),
      taskTitle: text(raw.taskTitle).trim().slice(0, 200),
      durationMs: Math.min(durationMs, 24 * 60 * 60 * 1000),
      startedAt: startedAt,
      endedAt: iso(raw.endedAt, startedAt),
      focusLogged: raw.focusLogged === true,
    };
  }

  function normalizeActiveSession(raw, fallbackNow) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const startedAt = iso(raw.startedAt, fallbackNow);
    return {
      id: text(raw.id).trim() || makeId('task-segment'),
      nodeId: text(raw.nodeId).trim(),
      taskTitle: text(raw.taskTitle).trim().slice(0, 200),
      elapsedMs: Math.max(0, Math.round(finite(raw.elapsedMs, 0))),
      startedAt: startedAt,
      checkpointAt: iso(raw.checkpointAt, startedAt),
    };
  }

  function normalizeMember(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const nodeId = text(raw.nodeId).trim();
    if (!nodeId) return null;
    const parentNodeId = text(raw.parentNodeId).trim();
    return {
      nodeId: nodeId,
      parentNodeId: parentNodeId || null,
      order: Math.max(0, Math.round(finite(raw.order, 0))),
    };
  }

  function normalizeRoot(raw, fallbackNow, fallbackOrder) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const stamp = iso(raw.createdAt, fallbackNow);
    const sessions = [];
    const sessionIds = new Set();
    (Array.isArray(raw.sessions) ? raw.sessions : []).forEach(function (entry) {
      const session = normalizeSession(entry, fallbackNow);
      if (!session || sessionIds.has(session.id)) return;
      sessionIds.add(session.id);
      sessions.push(session);
    });
    const root = {
      id: text(raw.id).trim() || makeId('task-root'),
      title: text(raw.title).trim().slice(0, MAX_TITLE_LENGTH) || '未命名任务',
      body: text(raw.body),
      completed: raw.completed === true,
      order: Math.max(0, Math.round(finite(raw.order, fallbackOrder || 0))),
      members: (Array.isArray(raw.members) ? raw.members : []).map(normalizeMember).filter(Boolean),
      sessions: sessions.slice(-MAX_SESSIONS),
      createdAt: stamp,
      updatedAt: iso(raw.updatedAt, stamp),
    };
    const canvasNodeId = text(raw.canvasNodeId).trim();
    if (canvasNodeId) root.canvasNodeId = canvasNodeId;
    if (raw.hiddenCanvasPosition && typeof raw.hiddenCanvasPosition === 'object'
        && Number.isFinite(Number(raw.hiddenCanvasPosition.x))
        && Number.isFinite(Number(raw.hiddenCanvasPosition.y))) {
      root.hiddenCanvasPosition = {
        x: Math.round(Number(raw.hiddenCanvasPosition.x)),
        y: Math.round(Number(raw.hiddenCanvasPosition.y)),
      };
    }
    const active = normalizeActiveSession(raw.activeSession, fallbackNow);
    if (active) root.activeSession = active;
    return root;
  }

  function createRoot(input, now) {
    const source = input && typeof input === 'object' ? input : {};
    const stamp = iso(now, new Date().toISOString());
    return normalizeRoot({
      id: source.id || makeId('task-root'),
      title: source.title || '未命名任务',
      body: source.body || '',
      completed: source.completed === true,
      order: finite(source.order, 0),
      members: [],
      sessions: [],
      createdAt: stamp,
      updatedAt: stamp,
    }, stamp, 0);
  }

  function createProjection(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      id: text(source.id).trim() || makeId('node'),
      kind: ROOT_NODE_KIND,
      taskRootId: text(source.taskRootId).trim(),
      x: finite(source.x, 0),
      y: finite(source.y, 0),
    };
  }

  function createWorkflowEdge(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      id: text(source.id).trim() || makeId('edge'),
      from: text(source.from).trim(),
      to: text(source.to).trim(),
      text: '',
      role: WORKFLOW_ROLE,
      taskRootId: text(source.taskRootId).trim(),
      workflowOrder: Math.max(0, Math.round(finite(source.workflowOrder, 0))),
      curve: 'branch',
      color: '#737373',
      width: 1.5,
      lineStyle: 'solid',
      arrow: 'end',
    };
  }

  function sortedRoots(data) {
    const book = data && data.taskbook;
    return (book && Array.isArray(book.roots) ? book.roots : []).slice().sort(function (a, b) {
      return finite(a.order, 0) - finite(b.order, 0)
        || text(a.createdAt).localeCompare(text(b.createdAt))
        || text(a.id).localeCompare(text(b.id));
    });
  }

  function findRoot(data, rootId) {
    const id = text(rootId).trim();
    return sortedRoots(data).find(function (root) { return root.id === id; }) || null;
  }

  function memberMap(root) {
    const map = new Map();
    (root && Array.isArray(root.members) ? root.members : []).forEach(function (member) {
      map.set(member.nodeId, member);
    });
    return map;
  }

  function normalizeMembers(root, nodeById, globallyOwned) {
    const accepted = [];
    const seen = new Set();
    (root.members || []).slice().sort(function (a, b) {
      return finite(a.order, 0) - finite(b.order, 0);
    }).forEach(function (member) {
      const normalized = normalizeMember(member);
      if (!normalized || seen.has(normalized.nodeId)) return;
      const node = nodeById.get(normalized.nodeId);
      if (!isTaskNode(node) || globallyOwned.has(normalized.nodeId)) return;
      seen.add(normalized.nodeId);
      globallyOwned.add(normalized.nodeId);
      accepted.push(normalized);
    });
    const acceptedIds = new Set(accepted.map(function (member) { return member.nodeId; }));
    accepted.forEach(function (member) {
      if (member.parentNodeId === member.nodeId || !acceptedIds.has(member.parentNodeId)) {
        member.parentNodeId = null;
      }
    });
    // Break malformed cycles deterministically by promoting the first repeated node to the root.
    const byId = new Map(accepted.map(function (member) { return [member.nodeId, member]; }));
    accepted.forEach(function (member) {
      const visited = new Set([member.nodeId]);
      let cursor = member;
      while (cursor && cursor.parentNodeId) {
        if (visited.has(cursor.parentNodeId)) {
          member.parentNodeId = null;
          break;
        }
        visited.add(cursor.parentNodeId);
        cursor = byId.get(cursor.parentNodeId);
      }
    });
    const groups = new Map();
    accepted.forEach(function (member) {
      const key = member.parentNodeId || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(member);
    });
    groups.forEach(function (members) {
      members.sort(function (a, b) { return a.order - b.order || a.nodeId.localeCompare(b.nodeId); });
      members.forEach(function (member, index) { member.order = index; });
    });
    root.members = accepted;
  }

  function rebuildWorkflowEdges(canvas) {
    const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
    const nodeById = new Map(nodes.map(function (node) { return [text(node.id), node]; }));
    const existing = new Map();
    (Array.isArray(canvas.edges) ? canvas.edges : []).forEach(function (edge) {
      if (!isWorkflowEdge(edge)) return;
      existing.set(text(edge.taskRootId) + '\n' + text(edge.from) + '\n' + text(edge.to), edge);
    });
    const ordinary = (Array.isArray(canvas.edges) ? canvas.edges : []).filter(function (edge) {
      return !isWorkflowEdge(edge) && !isLegacyWorkflowEdge(edge);
    });
    const workflow = [];
    sortedRoots(canvas).forEach(function (root) {
      const projection = root.canvasNodeId && nodeById.get(root.canvasNodeId);
      const members = (root.members || []).slice().sort(function (a, b) {
        return (a.parentNodeId || '').localeCompare(b.parentNodeId || '')
          || a.order - b.order;
      });
      members.forEach(function (member) {
        const from = member.parentNodeId || (isTaskRootNode(projection) ? projection.id : '');
        if (!from || !nodeById.has(from) || !nodeById.has(member.nodeId)) return;
        const key = root.id + '\n' + from + '\n' + member.nodeId;
        const old = existing.get(key);
        workflow.push(createWorkflowEdge({
          id: old && old.id,
          taskRootId: root.id,
          from: from,
          to: member.nodeId,
          workflowOrder: member.order,
        }));
      });
    });
    canvas.edges = ordinary.concat(workflow);
    return canvas;
  }

  function buildModel(data, rootId) {
    const root = findRoot(data, rootId);
    const nodes = Array.isArray(data && data.nodes) ? data.nodes : [];
    const nodeById = new Map(nodes.map(function (node) { return [text(node.id), node]; }));
    if (!root) {
      return {
        ok: false, root: null, errors: ['missing-root'], roots: [], tasks: [],
        leaves: [], completedTaskIds: new Set(), doneLeaves: 0, totalLeaves: 0,
        progress: 0, nextTaskId: null,
      };
    }
    const errors = [];
    const members = memberMap(root);
    const children = new Map();
    const parent = new Map();
    (root.members || []).forEach(function (member) {
      if (!nodeById.has(member.nodeId)) {
        errors.push('missing-node:' + member.nodeId);
        return;
      }
      const parentId = member.parentNodeId || '';
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(member.nodeId);
      parent.set(member.nodeId, member.parentNodeId || null);
    });
    children.forEach(function (ids) {
      ids.sort(function (a, b) {
        return finite(members.get(a) && members.get(a).order, 0)
          - finite(members.get(b) && members.get(b).order, 0);
      });
    });
    const roots = (children.get('') || []).slice();
    const tasks = [];
    const leaves = [];
    const visited = new Set();
    const active = new Set();
    let maxDepth = 0;
    function walk(nodeId, depth) {
      if (active.has(nodeId)) {
        errors.push('cycle:' + nodeId);
        return;
      }
      if (visited.has(nodeId)) return;
      active.add(nodeId);
      visited.add(nodeId);
      maxDepth = Math.max(maxDepth, depth);
      tasks.push(nodeId);
      const kids = children.get(nodeId) || [];
      if (!kids.length) leaves.push(nodeId);
      else kids.forEach(function (childId) { walk(childId, depth + 1); });
      active.delete(nodeId);
    }
    roots.forEach(function (nodeId) { walk(nodeId, 1); });
    (root.members || []).forEach(function (member) {
      if (!visited.has(member.nodeId)) errors.push('orphan:' + member.nodeId);
    });
    const rootIsLeaf = tasks.length === 0;
    const doneLeaves = rootIsLeaf
      ? (root.completed ? 1 : 0)
      : leaves.filter(function (nodeId) {
        const node = nodeById.get(nodeId);
        return !!(node && node.strike);
      }).length;
    const totalLeaves = rootIsLeaf ? 1 : leaves.length;
    const nextTaskId = rootIsLeaf
      ? (root.completed ? null : root.id)
      : (leaves.find(function (nodeId) {
        const node = nodeById.get(nodeId);
        return node && !node.strike;
      }) || null);
    const completedTaskIds = new Set();
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      const nodeId = tasks[i];
      const kids = children.get(nodeId) || [];
      const done = kids.length
        ? kids.every(function (childId) { return completedTaskIds.has(childId); })
        : !!(nodeById.get(nodeId) && nodeById.get(nodeId).strike);
      if (done) completedTaskIds.add(nodeId);
    }
    const actualMs = (root.sessions || []).reduce(function (sum, session) {
      return sum + Math.max(0, finite(session.durationMs, 0));
    }, 0) + Math.max(0, finite(root.activeSession && root.activeSession.elapsedMs, 0));
    return {
      ok: errors.length === 0,
      root: root,
      errors: errors,
      roots: roots,
      tasks: tasks,
      taskSet: new Set(tasks),
      leaves: leaves,
      completedTaskIds: completedTaskIds,
      doneLeaves: doneLeaves,
      totalLeaves: totalLeaves,
      progress: totalLeaves ? doneLeaves / totalLeaves : 0,
      nextTaskId: nextTaskId,
      maxDepth: maxDepth,
      children: children,
      parent: parent,
      members: members,
      nodeById: nodeById,
      actualMs: actualMs,
      completed: totalLeaves > 0 && doneLeaves === totalLeaves,
    };
  }

  function synchronizeCompletion(data) {
    sortedRoots(data).forEach(function (root) {
      const model = buildModel(data, root.id);
      if (model.tasks.length) root.completed = model.completed;
    });
    return data;
  }

  function normalizeCanvas(data) {
    const source = data && typeof data === 'object' ? data : {};
    const canvas = deepClone(source);
    const now = new Date().toISOString();
    canvas.nodes = (Array.isArray(canvas.nodes) ? canvas.nodes : []).filter(function (node) {
      return !isLegacyTaskbookNode(node);
    });
    canvas.edges = (Array.isArray(canvas.edges) ? canvas.edges : []).filter(function (edge) {
      return !isLegacyWorkflowEdge(edge);
    });
    const rawBook = canvas.taskbook && canvas.taskbook.version === VERSION ? canvas.taskbook : null;
    if (!rawBook) {
      delete canvas.taskbook;
      canvas.nodes = canvas.nodes.filter(function (node) { return !isTaskRootNode(node); });
      return rebuildWorkflowEdges(canvas);
    }
    const roots = [];
    const rootIds = new Set();
    (Array.isArray(rawBook.roots) ? rawBook.roots : []).forEach(function (entry, index) {
      const root = normalizeRoot(entry, now, index);
      if (!root || rootIds.has(root.id)) return;
      rootIds.add(root.id);
      roots.push(root);
    });
    roots.sort(function (a, b) { return a.order - b.order; });
    roots.forEach(function (root, index) { root.order = index; });
    const nodeById = new Map(canvas.nodes.map(function (node) { return [text(node.id), node]; }));
    const globallyOwned = new Set();
    roots.forEach(function (root) {
      normalizeMembers(root, nodeById, globallyOwned);
      const projection = root.canvasNodeId && nodeById.get(root.canvasNodeId);
      if (!isTaskRootNode(projection) || projection.taskRootId !== root.id) delete root.canvasNodeId;
    });
    const validProjectionIds = new Set(roots.map(function (root) { return root.canvasNodeId; }).filter(Boolean));
    canvas.nodes = canvas.nodes.filter(function (node) {
      return !isTaskRootNode(node) || validProjectionIds.has(node.id);
    });
    if (roots.length) canvas.taskbook = { version: VERSION, roots: roots };
    else delete canvas.taskbook;
    synchronizeCompletion(canvas);
    return rebuildWorkflowEdges(canvas);
  }

  function buildOwnershipIndex(data) {
    const roots = sortedRoots(data);
    const rootById = new Map();
    const owners = new Map();
    const projectionOwners = new Map();
    roots.forEach(function (root) {
      rootById.set(root.id, root);
      if (root.canvasNodeId) projectionOwners.set(root.canvasNodeId, root.id);
      (root.members || []).forEach(function (member) {
        owners.set(member.nodeId, root.id);
      });
    });
    return { roots: roots, rootById: rootById, owners: owners, projectionOwners: projectionOwners };
  }

  function owningTaskbookId(data, nodeId) {
    return buildOwnershipIndex(data).owners.get(text(nodeId).trim()) || null;
  }

  function projectionRootId(data, nodeId) {
    return buildOwnershipIndex(data).projectionOwners.get(text(nodeId).trim()) || null;
  }

  function canAttach(data, rootId, parentNodeId, nodeId) {
    const index = buildOwnershipIndex(data);
    const root = index.rootById.get(text(rootId).trim());
    const childId = text(nodeId).trim();
    const parentId = text(parentNodeId).trim() || null;
    const nodes = new Map((data.nodes || []).map(function (node) { return [text(node.id), node]; }));
    if (!root) return { ok: false, reason: 'missing-root' };
    if (!isTaskNode(nodes.get(childId))) return { ok: false, reason: 'invalid-task-kind' };
    if (index.owners.has(childId)) return { ok: false, reason: 'owned' };
    if (parentId && index.owners.get(parentId) !== root.id) {
      return { ok: false, reason: 'parent-not-managed' };
    }
    if (parentId === childId) return { ok: false, reason: 'self-link' };
    return { ok: true, rootId: root.id, parentNodeId: parentId, nodeId: childId };
  }

  function resolveConnection(data, firstId, secondId) {
    const index = buildOwnershipIndex(data);
    const a = text(firstId).trim();
    const b = text(secondId).trim();
    const rootA = index.projectionOwners.get(a) || null;
    const rootB = index.projectionOwners.get(b) || null;
    const ownerA = index.owners.get(a) || null;
    const ownerB = index.owners.get(b) || null;
    if (rootA && !ownerB && !rootB) return canAttach(data, rootA, null, b);
    if (rootB && !ownerA && !rootA) return canAttach(data, rootB, null, a);
    if (ownerA && !ownerB && !rootB) return canAttach(data, ownerA, a, b);
    if (ownerB && !ownerA && !rootA) return canAttach(data, ownerB, b, a);
    return { ok: false, ordinary: true, reason: 'ordinary' };
  }

  function resolveConnectionBatch(data, firstIds, secondId, preferredFirstId) {
    const targetId = text(secondId).trim();
    const seen = new Set();
    const candidates = (Array.isArray(firstIds) ? firstIds : [firstIds]).reduce(function (out, value) {
      const firstId = text(value).trim();
      if (!firstId || firstId === targetId || seen.has(firstId)) return out;
      seen.add(firstId);
      out.push({ firstId: firstId, workflow: resolveConnection(data, firstId, targetId) });
      return out;
    }, []);
    const workflows = candidates.filter(function (item) {
      return item.workflow && item.workflow.ok;
    });
    if (!workflows.length) {
      return {
        workflows: [],
        ordinaryFirstIds: candidates.map(function (item) { return item.firstId; }),
      };
    }

    const first = workflows[0].workflow;
    const nodeIds = new Set(workflows.map(function (item) { return item.workflow.nodeId; }));
    const oneSharedParent = workflows.every(function (item) {
      return item.workflow.rootId === first.rootId
        && (item.workflow.parentNodeId || null) === (first.parentNodeId || null);
    });
    if (workflows.length === candidates.length
        && nodeIds.size === workflows.length
        && oneSharedParent) {
      return { workflows: workflows, ordinaryFirstIds: [] };
    }

    const preferredId = text(preferredFirstId).trim();
    const preferred = workflows.find(function (item) { return item.firstId === preferredId; })
      || workflows[0];
    return { workflows: [preferred], ordinaryFirstIds: [] };
  }

  function attachMember(data, rootId, parentNodeId, nodeId, beforeId) {
    const check = canAttach(data, rootId, parentNodeId, nodeId);
    if (!check.ok) return check;
    const root = findRoot(data, rootId);
    const siblings = root.members.filter(function (member) {
      return (member.parentNodeId || null) === (check.parentNodeId || null);
    }).sort(function (a, b) { return a.order - b.order; });
    let order = siblings.length;
    const beforeIndex = siblings.findIndex(function (member) { return member.nodeId === beforeId; });
    if (beforeIndex >= 0) order = beforeIndex;
    siblings.forEach(function (member) {
      if (member.order >= order) member.order += 1;
    });
    root.members.push({
      nodeId: check.nodeId,
      parentNodeId: check.parentNodeId,
      order: order,
    });
    root.completed = false;
    root.updatedAt = new Date().toISOString();
    rebuildWorkflowEdges(data);
    synchronizeCompletion(data);
    return { ok: true, rootId: root.id, nodeId: check.nodeId };
  }

  function subtreeIds(data, rootId, nodeId) {
    const model = buildModel(data, rootId);
    if (!model.taskSet.has(nodeId)) return [];
    const ids = [];
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop();
      if (ids.includes(id)) continue;
      ids.push(id);
      (model.children.get(id) || []).slice().reverse().forEach(function (child) { stack.push(child); });
    }
    return ids;
  }

  function moveMember(data, rootId, nodeId, nextParentNodeId, beforeId) {
    const root = findRoot(data, rootId);
    if (!root) return { ok: false, reason: 'missing-root' };
    const moving = root.members.find(function (member) { return member.nodeId === nodeId; });
    if (!moving) return { ok: false, reason: 'missing-task' };
    const parentId = text(nextParentNodeId).trim() || null;
    const descendants = new Set(subtreeIds(data, rootId, nodeId));
    if (parentId && descendants.has(parentId)) return { ok: false, reason: 'cycle' };
    if (parentId && !root.members.some(function (member) { return member.nodeId === parentId; })) {
      return { ok: false, reason: 'parent-not-managed' };
    }
    root.members = root.members.filter(function (member) { return member.nodeId !== nodeId; });
    root.members.forEach(function (member) {
      if ((member.parentNodeId || null) === (moving.parentNodeId || null) && member.order > moving.order) {
        member.order -= 1;
      }
    });
    const siblings = root.members.filter(function (member) {
      return (member.parentNodeId || null) === parentId;
    }).sort(function (a, b) { return a.order - b.order; });
    let order = siblings.length;
    const beforeIndex = siblings.findIndex(function (member) { return member.nodeId === beforeId; });
    if (beforeIndex >= 0) order = beforeIndex;
    siblings.forEach(function (member) {
      if (member.order >= order) member.order += 1;
    });
    moving.parentNodeId = parentId;
    moving.order = order;
    root.members.push(moving);
    root.updatedAt = new Date().toISOString();
    rebuildWorkflowEdges(data);
    synchronizeCompletion(data);
    return { ok: true };
  }

  function releaseRoot(data, rootId) {
    const root = findRoot(data, rootId);
    if (!root) return { ok: false, reason: 'missing-root' };
    const nodeIds = new Set((root.members || []).map(function (member) { return member.nodeId; }));
    const projectionId = root.canvasNodeId || '';
    data.nodes = (data.nodes || []).filter(function (node) { return node.id !== projectionId; });
    data.edges = (data.edges || []).reduce(function (out, edge) {
      if (!isWorkflowEdge(edge) || edge.taskRootId !== root.id) {
        out.push(edge);
        return out;
      }
      if (edge.from === projectionId) return out;
      const ordinary = Object.assign({}, edge);
      delete ordinary.role;
      delete ordinary.taskRootId;
      delete ordinary.workflowOrder;
      out.push(ordinary);
      return out;
    }, []);
    data.taskbook.roots = data.taskbook.roots.filter(function (candidate) { return candidate.id !== root.id; });
    if (!data.taskbook.roots.length) delete data.taskbook;
    return { ok: true, releasedNodeIds: Array.from(nodeIds), projectionNodeId: projectionId || null };
  }

  function archiveNodeHeight(node) {
    const bodyHeight = Math.max(0, finite(node && node.bodyHeight, 0));
    return Math.max(86, Math.min(260, bodyHeight ? bodyHeight + 64 : 104));
  }

  function archiveClock(milliseconds) {
    const total = Math.max(0, Math.floor(finite(milliseconds, 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pair = function (value) { return String(value).padStart(2, '0'); };
    return hours ? hours + ':' + pair(minutes) + ':' + pair(seconds)
      : pair(minutes) + ':' + pair(seconds);
  }

  function prepareArchive(data, rootId, options) {
    const source = data && typeof data === 'object' ? data : {};
    const canvas = deepClone(source);
    const model = buildModel(canvas, rootId);
    if (!model.root) return { ok: false, reason: 'missing-root' };
    if (!model.ok) return { ok: false, reason: 'invalid-tree', errors: model.errors.slice() };
    if (!model.completed) return { ok: false, reason: 'not-complete' };

    const root = model.root;
    const retainSnapshot = !options || options.retainSnapshot !== false;
    const nodeById = new Map((canvas.nodes || []).map(function (node) {
      return [text(node && node.id), node];
    }));
    const projection = root.canvasNodeId ? nodeById.get(root.canvasNodeId) : null;
    const memberIds = (root.members || []).map(function (member) { return member.nodeId; });
    const removedIds = new Set(memberIds);
    if (projection) removedIds.add(projection.id);

    let originX = finite(options && options.originX, 0);
    let originY = finite(options && options.originY, 0);
    if (projection) {
      originX = finite(projection.x, originX);
      originY = finite(projection.y, originY);
    } else if (memberIds.length) {
      const members = memberIds.map(function (id) { return nodeById.get(id); }).filter(Boolean);
      originX = Math.min.apply(null, members.map(function (node) { return finite(node.x, 0); })) - 280;
      originY = Math.min.apply(null, members.map(function (node) { return finite(node.y, 0); }));
    }

    canvas.nodes = (canvas.nodes || []).filter(function (node) {
      return !removedIds.has(text(node && node.id));
    }).map(function (node) {
      if (!Array.isArray(node.groupMemberIds)) return node;
      node.groupMemberIds = node.groupMemberIds.filter(function (id) { return !removedIds.has(text(id)); });
      if (!node.groupMemberIds.length) delete node.groupMemberIds;
      return node;
    });
    canvas.edges = (canvas.edges || []).filter(function (edge) {
      return !removedIds.has(text(edge && edge.from)) && !removedIds.has(text(edge && edge.to));
    });

    if (canvas.taskbook && Array.isArray(canvas.taskbook.roots)) {
      canvas.taskbook.roots = canvas.taskbook.roots.filter(function (candidate) {
        return candidate.id !== root.id;
      });
      canvas.taskbook.roots.forEach(function (candidate, index) { candidate.order = index; });
      if (!canvas.taskbook.roots.length) delete canvas.taskbook;
    }

    let snapshotRootNodeId = null;
    const copiedNodeIds = [];
    if (retainSnapshot) {
      const idMap = new Map();
      const archiveLabel = text(options && options.archiveLabel).trim() || 'Archived';
      const taskCountLabel = text(options && options.taskCountLabel).trim() || 'Tasks';
      const durationLabel = text(options && options.durationLabel).trim() || 'Time';
      const archiveSummary = archiveLabel + '\n'
        + taskCountLabel + ' ' + model.totalLeaves + ' / ' + model.totalLeaves
        + ' · ' + durationLabel + ' ' + archiveClock(model.actualMs);
      const rootNotes = text(root.body);
      const archiveBody = archiveSummary + (rootNotes.trim() ? '\n\n' + rootNotes : '');
      const rootCopy = {
        id: makeId('node'),
        kind: 'card',
        text: root.title,
        body: archiveBody,
        x: Math.round(originX),
        y: Math.round(originY),
        width: 176,
        radius: 14,
        bgColor: '#f2f4ef',
        borderColor: '#667169',
        archiveCover: true,
        textMarks: root.title ? [{
          start: 0,
          end: root.title.length,
          bold: true,
        }] : [],
        bodyMarks: [{
          start: 0,
          end: archiveLabel.length,
          color: 'green',
          bold: true,
        }, {
          start: archiveLabel.length + 1,
          end: archiveSummary.length,
          color: 'gray',
        }],
      };
      if (!rootCopy.textMarks.length) delete rootCopy.textMarks;
      snapshotRootNodeId = rootCopy.id;
      copiedNodeIds.push(rootCopy.id);
      idMap.set(root.id, rootCopy.id);

      model.tasks.forEach(function (nodeId) {
        const original = nodeById.get(nodeId);
        if (!original) return;
        const copy = deepClone(original);
        copy.id = makeId('node');
        copy.strike = true;
        delete copy.taskRootId;
        delete copy.taskbookId;
        delete copy.activeSession;
        delete copy.groupMemberIds;
        idMap.set(nodeId, copy.id);
        copiedNodeIds.push(copy.id);
        canvas.nodes.push(copy);
      });
      canvas.nodes.push(rootCopy);

      const depth = new Map([[root.id, 0]]);
      const children = new Map([[root.id, []]]);
      model.tasks.forEach(function (nodeId) {
        const parentId = model.parent.get(nodeId) || root.id;
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(nodeId);
      });
      function markDepth(parentId) {
        (children.get(parentId) || []).forEach(function (nodeId) {
          depth.set(nodeId, (depth.get(parentId) || 0) + 1);
          markDepth(nodeId);
        });
      }
      markDepth(root.id);

      const centerY = new Map();
      let cursorY = originY;
      function placeVertical(nodeId) {
        const kids = children.get(nodeId) || [];
        if (!kids.length) {
          const original = nodeId === root.id ? rootCopy : nodeById.get(nodeId);
          const height = archiveNodeHeight(original);
          const center = cursorY + height / 2;
          cursorY += height + 34;
          centerY.set(nodeId, center);
          return center;
        }
        const values = kids.map(placeVertical);
        const center = (values[0] + values[values.length - 1]) / 2;
        centerY.set(nodeId, center);
        return center;
      }
      placeVertical(root.id);
      const rootCenter = centerY.get(root.id) || originY + archiveNodeHeight(rootCopy) / 2;
      const yShift = originY + archiveNodeHeight(rootCopy) / 2 - rootCenter;
      rootCopy.y = Math.round((centerY.get(root.id) || rootCenter) + yShift - archiveNodeHeight(rootCopy) / 2);
      model.tasks.forEach(function (nodeId) {
        const copyId = idMap.get(nodeId);
        const copy = canvas.nodes.find(function (node) { return node.id === copyId; });
        if (!copy) return;
        const level = depth.get(nodeId) || 1;
        copy.x = Math.round(originX + level * 300);
        copy.y = Math.round((centerY.get(nodeId) || originY) + yShift - archiveNodeHeight(copy) / 2);
      });

      (children.get(root.id) || []).forEach(function (nodeId, index) {
        canvas.edges.push(createWorkflowEdge({
          id: makeId('edge'),
          from: rootCopy.id,
          to: idMap.get(nodeId),
          taskRootId: '',
          workflowOrder: index,
        }));
      });
      model.tasks.forEach(function (parentId) {
        (children.get(parentId) || []).forEach(function (nodeId, index) {
          canvas.edges.push(createWorkflowEdge({
            id: makeId('edge'),
            from: idMap.get(parentId),
            to: idMap.get(nodeId),
            taskRootId: '',
            workflowOrder: index,
          }));
        });
      });
      canvas.edges.forEach(function (edge) {
        if (!copiedNodeIds.includes(edge.from) || !copiedNodeIds.includes(edge.to)) return;
        delete edge.role;
        delete edge.taskRootId;
        delete edge.workflowOrder;
      });
    }

    canvas.updatedAt = new Date().toISOString();
    return {
      ok: true,
      data: canvas,
      archive: {
        rootId: root.id,
        title: root.title,
        leafCount: model.totalLeaves,
        durationMs: model.actualMs,
        removedNodeIds: Array.from(removedIds),
        copiedNodeIds: copiedNodeIds,
        snapshotRootNodeId: snapshotRootNodeId,
      },
    };
  }

  function formatDuration(milliseconds) {
    const total = Math.max(0, Math.floor(finite(milliseconds, 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours && minutes) return hours + 'h ' + minutes + 'm';
    if (hours) return hours + 'h';
    return minutes + 'm';
  }

  return {
    VERSION: VERSION,
    ROOT_NODE_KIND: ROOT_NODE_KIND,
    WORKFLOW_ROLE: WORKFLOW_ROLE,
    isTaskRootNode: isTaskRootNode,
    isTaskNode: isTaskNode,
    isWorkflowEdge: isWorkflowEdge,
    normalizeSession: normalizeSession,
    normalizeActiveSession: normalizeActiveSession,
    normalizeRoot: normalizeRoot,
    normalizeCanvas: normalizeCanvas,
    createRoot: createRoot,
    createProjection: createProjection,
    createWorkflowEdge: createWorkflowEdge,
    rebuildWorkflowEdges: rebuildWorkflowEdges,
    buildOwnershipIndex: buildOwnershipIndex,
    buildModel: buildModel,
    findRoot: findRoot,
    sortedRoots: sortedRoots,
    canAttach: canAttach,
    resolveConnection: resolveConnection,
    resolveConnectionBatch: resolveConnectionBatch,
    attachMember: attachMember,
    moveMember: moveMember,
    subtreeIds: subtreeIds,
    releaseRoot: releaseRoot,
    prepareArchive: prepareArchive,
    owningTaskbookId: owningTaskbookId,
    projectionRootId: projectionRootId,
    synchronizeCompletion: synchronizeCompletion,
    formatDuration: formatDuration,
    makeId: makeId,
    deepClone: deepClone,
  };
});
