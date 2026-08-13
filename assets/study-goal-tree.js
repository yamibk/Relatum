// Study Goal Tree v3: one lightweight route with the original mind-map structure semantics.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RelatumStudyGoalTree = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function text(value) { return String(value == null ? '' : value); }
  function number(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : (fallback || 0);
  }
  function rootSide(value) { return text(value).toLowerCase() === 'left' ? 'left' : 'right'; }
  function milestonesForTask(task) {
    var progress = task && task.progress && typeof task.progress === 'object' ? task.progress : {};
    return (Array.isArray(progress.milestones) ? progress.milestones : []).filter(function (item) {
      return item && text(item.id).trim() && number(item.at) > 0;
    }).map(function (item) {
      return { id: text(item.id), name: text(item.name).trim() || '任务点', at: number(item.at) };
    }).sort(function (a, b) { return a.at - b.at || a.id.localeCompare(b.id); });
  }
  function progressForTask(task) {
    if (!task) return 0;
    if (task.status === 'done') return 1;
    var progress = task.progress && typeof task.progress === 'object' ? task.progress : {};
    var target = Math.max(0, number(progress.target));
    return target ? Math.max(0, Math.min(1, number(progress.current) / target)) : 0;
  }
  function sorted(items) {
    return (items || []).slice().sort(function (a, b) {
      return number(a.order) - number(b.order) || text(a.id).localeCompare(text(b.id));
    });
  }
  function slotKey(value) {
    var slot = value && value.taskSlot ? value.taskSlot : value;
    var kind = slot && text(slot.kind);
    return kind === 'milestone' ? 'milestone:' + text(slot.milestoneId)
      : (kind === 'start' ? 'start' : (kind === 'end' ? 'end' : ''));
  }
  function normalizeSlot(parent, rawSlot, byTask) {
    if (!parent || parent.kind !== 'task') return null;
    var kind = rawSlot && text(rawSlot.kind);
    if (kind === 'start') return { kind: 'start' };
    if (kind === 'milestone') {
      var milestoneId = text(rawSlot.milestoneId).trim();
      var source = byTask.get(parent.taskId);
      if (milestonesForTask(source).some(function (item) { return item.id === milestoneId; })) {
        return { kind: 'milestone', milestoneId: milestoneId };
      }
    }
    return { kind: 'end' };
  }
  function groupKey(node) {
    var parentId = text(node.parentId);
    return parentId ? parentId + '|' + slotKey(node) : 'root|' + rootSide(node.side);
  }
  function normalizeTree(value, tasks) {
    var tree = value && typeof value === 'object' ? value : {};
    var byTask = new Map((tasks || []).map(function (task) { return [text(task.id), task]; }));
    var seenIds = new Set(), seenTasks = new Set(), nodes = [];
    (Array.isArray(tree.nodes) ? tree.nodes : []).forEach(function (raw, index) {
      if (!raw || typeof raw !== 'object') return;
      var kind = text(raw.kind), id = text(raw.id).trim();
      if (!id || seenIds.has(id) || !['branch', 'task'].includes(kind)) return;
      if (kind === 'task') {
        var taskId = text(raw.taskId).trim();
        if (!taskId || !byTask.has(taskId) || seenTasks.has(taskId)) return;
        seenTasks.add(taskId);
      }
      seenIds.add(id);
      var node = {
        id: id,
        kind: kind,
        parentId: text(raw.parentId).trim() || null,
        order: Math.max(0, number(raw.order, index)),
        side: rootSide(raw.side),
      };
      if (kind === 'branch') {
        node.title = text(raw.title).trim() || '未命名分支';
        var branchColor = text(raw.color).trim();
        if (branchColor && branchColor.length <= 7 && branchColor.charAt(0) === '#') node.color = branchColor;
      }
      else {
        node.taskId = text(raw.taskId).trim();
        if (raw.taskSlot && typeof raw.taskSlot === 'object') node.taskSlot = Object.assign({}, raw.taskSlot);
      }
      nodes.push(node);
    });
    var byId = new Map(nodes.map(function (node) { return [node.id, node]; }));
    nodes.forEach(function (node) {
      var parent = byId.get(text(node.parentId));
      var valid = parent && parent.id !== node.id
        && (node.kind === 'branch' ? parent.kind === 'branch' : ['branch', 'task'].includes(parent.kind));
      if (!valid) node.parentId = null;
    });
    nodes.forEach(function (node) {
      var cursor = node, seen = new Set([node.id]), depth = 0;
      while (cursor.parentId) {
        depth += 1;
        if (seen.has(cursor.parentId) || depth > 32) { node.parentId = null; break; }
        seen.add(cursor.parentId);
        cursor = byId.get(cursor.parentId) || {};
      }
    });
    nodes.forEach(function (node) {
      var parent = byId.get(text(node.parentId));
      if (!parent) {
        node.parentId = null;
        node.side = rootSide(node.side);
        delete node.taskSlot;
        return;
      }
      delete node.side;
      var slot = node.kind === 'task' ? normalizeSlot(parent, node.taskSlot, byTask) : null;
      if (slot) node.taskSlot = slot;
      else delete node.taskSlot;
    });
    var groups = new Map();
    nodes.forEach(function (node) {
      var key = groupKey(node);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    });
    groups.forEach(function (items) {
      sorted(items).forEach(function (node, index) { node.order = index; });
    });
    var normalized = { version: 1, title: text(tree.title).trim() || '我的学习路线', nodes: nodes };
    var treeId = text(tree.id).trim();
    if (treeId) normalized.id = treeId;
    return normalized;
  }
  function taskOwner(tree, taskId) {
    var target = text(taskId);
    var node = (tree && tree.nodes || []).find(function (item) {
      return item.kind === 'task' && text(item.taskId) === target;
    });
    return node ? { tree: tree, node: node } : null;
  }
  function subtreeIds(tree, nodeId) {
    var children = new Map(), result = new Set();
    (tree && tree.nodes || []).forEach(function (node) {
      var key = text(node.parentId);
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(node.id);
    });
    function visit(id) {
      if (!id || result.has(id)) return;
      result.add(id);
      (children.get(id) || []).forEach(visit);
    }
    visit(text(nodeId));
    return result;
  }
  function canMove(tree, nodeId, parentId) {
    var node = (tree && tree.nodes || []).find(function (item) { return item.id === nodeId; });
    if (!node) return false;
    if (!parentId) return true;
    var parent = (tree.nodes || []).find(function (item) { return item.id === parentId; });
    if (!parent || subtreeIds(tree, nodeId).has(parentId)) return false;
    return node.kind === 'branch' ? parent.kind === 'branch' : ['branch', 'task'].includes(parent.kind);
  }
  function previewMove(tree, nodeId, parentId, beforeId, taskSlot, side) {
    if (!canMove(tree, nodeId, parentId)) return null;
    var copy = {
      version: 1,
      title: text(tree && tree.title),
      nodes: (tree && tree.nodes || []).map(function (node) {
        var clone = Object.assign({}, node);
        if (node.taskSlot) clone.taskSlot = Object.assign({}, node.taskSlot);
        return clone;
      }),
    };
    var moving = copy.nodes.find(function (node) { return node.id === nodeId; });
    var parent = copy.nodes.find(function (node) { return node.id === text(parentId); });
    if (!moving) return null;
    moving.parentId = text(parentId).trim() || null;
    if (!moving.parentId) {
      moving.side = rootSide(side == null ? moving.side : side);
      delete moving.taskSlot;
    } else {
      delete moving.side;
      var byTask = new Map();
      var normalizedSlot = parent && parent.kind === 'task'
        ? (taskSlot && taskSlot.kind === 'milestone'
          ? { kind: 'milestone', milestoneId: text(taskSlot.milestoneId) }
          : { kind: taskSlot && taskSlot.kind === 'start' ? 'start' : 'end' }) : null;
      if (normalizedSlot) moving.taskSlot = normalizedSlot;
      else delete moving.taskSlot;
    }
    var targetKey = groupKey(moving);
    var siblings = copy.nodes.filter(function (node) {
      return node.id !== moving.id && groupKey(node) === targetKey;
    });
    siblings = sorted(siblings);
    var before = text(beforeId), index = siblings.findIndex(function (node) { return node.id === before; });
    siblings.splice(index < 0 ? siblings.length : index, 0, moving);
    var groups = new Map();
    copy.nodes.forEach(function (node) {
      var key = groupKey(node);
      if (!groups.has(key)) groups.set(key, []);
      if (key !== targetKey || node.id !== moving.id) groups.get(key).push(node);
    });
    groups.set(targetKey, siblings);
    groups.forEach(function (items) {
      sorted(items).forEach(function (node, order) { node.order = order; });
    });
    siblings.forEach(function (node, order) { node.order = order; });
    return copy;
  }
  function topSide(tree, nodeId) {
    var byId = new Map((tree.nodes || []).map(function (node) { return [node.id, node]; }));
    var cursor = byId.get(nodeId), seen = new Set();
    while (cursor && cursor.parentId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId);
    }
    return rootSide(cursor && cursor.side);
  }
  function milestonePlacementId(nodeId, milestoneId) {
    return 'milestone::' + text(nodeId) + '::' + text(milestoneId);
  }
  function buildModel(value, tasks) {
    var tree = normalizeTree(value, tasks);
    var byTask = new Map((tasks || []).map(function (task) { return [text(task.id), task]; }));
    var byId = new Map(tree.nodes.map(function (node) { return [node.id, node]; }));
    var children = new Map();
    tree.nodes.forEach(function (node) {
      var key = text(node.parentId);
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(node);
    });
    children.forEach(function (items, key) {
      var parent = byId.get(key);
      var milestones = parent && parent.kind === 'task' ? milestonesForTask(byTask.get(parent.taskId)) : [];
      var milestoneOrder = new Map(milestones.map(function (item, index) { return [item.id, index]; }));
      items.sort(function (a, b) {
        function rank(node) {
          if (!parent || parent.kind !== 'task') return 0;
          var slot = node.taskSlot || { kind: 'end' };
          if (slot.kind === 'start') return -1;
          if (slot.kind === 'milestone') return milestoneOrder.has(slot.milestoneId) ? milestoneOrder.get(slot.milestoneId) : milestones.length;
          return milestones.length + 1;
        }
        return rank(a) - rank(b) || number(a.order) - number(b.order) || a.id.localeCompare(b.id);
      });
    });
    var metrics = new Map(), subtreeMetrics = new Map();
    function combine(values) {
      var count = values.reduce(function (sum, item) { return sum + item.count; }, 0);
      return {
        count: count,
        progress: count ? values.reduce(function (sum, item) { return sum + item.progress * item.count; }, 0) / count : 0,
        complete: count > 0 && values.every(function (item) { return item.complete; }),
      };
    }
    function collectNode(node, active) {
      if (active.has(node.id)) return { count: 0, progress: 0, complete: false };
      active.add(node.id);
      var values = [];
      if (node.kind === 'task') {
        var task = byTask.get(node.taskId);
        var own = { count: 1, progress: progressForTask(task), complete: !!task && task.status === 'done' };
        metrics.set(node.id, own);
        values.push(own);
      }
      (children.get(node.id) || []).forEach(function (child) { values.push(collectNode(child, active)); });
      active.delete(node.id);
      var aggregate = combine(values);
      subtreeMetrics.set(node.id, aggregate);
      if (node.kind === 'branch') metrics.set(node.id, aggregate);
      return aggregate;
    }
    var topValues = (children.get('') || []).map(function (node) { return collectNode(node, new Set()); });
    var rootMetrics = combine(topValues);
    metrics.set('root', rootMetrics); subtreeMetrics.set('root', rootMetrics);
    var availability = new Map();
    tree.nodes.forEach(function (node) {
      var parent = byId.get(text(node.parentId));
      if (!parent || parent.kind !== 'task') {
        availability.set(node.id, { available: true, reason: '' }); return;
      }
      var task = byTask.get(parent.taskId), slot = node.taskSlot || { kind: 'end' };
      var progress = task && task.progress || {};
      var available = true, reason = '';
      if (slot.kind === 'end') { available = !!task && task.status === 'done'; reason = available ? '' : 'predecessor'; }
      if (slot.kind === 'milestone') {
        var milestone = milestonesForTask(task).find(function (item) { return item.id === slot.milestoneId; });
        available = !!task && (task.status === 'done' || (milestone && number(progress.current) >= milestone.at));
        reason = available ? '' : 'milestone';
      }
      availability.set(node.id, { available: available, reason: reason });
    });
    return {
      tree: tree, byId: byId, byTask: byTask, children: children,
      metrics: metrics, subtreeMetrics: subtreeMetrics, availability: availability, rootMetrics: rootMetrics,
    };
  }
  function layout(value, tasks, options) {
    options = options || {};
    var model = buildModel(value, tasks);
    var sizes = options.sizes instanceof Map ? options.sizes : new Map();
    var gapX = number(options.gapX, 92), gapY = number(options.gapY, 30);
    var visualById = new Map(), visualChildren = new Map(), visualParent = new Map();
    var rootNode = { id: 'root', kind: 'root', title: model.tree.title };
    visualById.set('root', rootNode); visualChildren.set('root', []);
    model.tree.nodes.forEach(function (node) { visualById.set(node.id, node); visualChildren.set(node.id, []); });
    (model.children.get('') || []).forEach(function (node) {
      visualChildren.get('root').push(node.id); visualParent.set(node.id, 'root');
    });
    model.tree.nodes.forEach(function (parent) {
      var direct = model.children.get(parent.id) || [];
      if (parent.kind !== 'task') {
        direct.forEach(function (child) { visualChildren.get(parent.id).push(child.id); visualParent.set(child.id, parent.id); });
        return;
      }
      var source = model.byTask.get(parent.taskId), milestones = milestonesForTask(source);
      var milestoneIds = new Map();
      milestones.forEach(function (milestone) {
        var id = milestonePlacementId(parent.id, milestone.id);
        var progress = source && source.progress || {};
        var virtual = {
          id: id, kind: 'milestone', parentId: parent.id, parentNodeId: parent.id,
          taskId: parent.taskId,
          milestone: Object.assign({}, milestone, { reached: source && (source.status === 'done' || number(progress.current) >= milestone.at) }),
        };
        milestoneIds.set(milestone.id, id);
        visualById.set(id, virtual); visualChildren.set(id, []);
        visualChildren.get(parent.id).push(id); visualParent.set(id, parent.id);
      });
      var start = [], end = [];
      direct.forEach(function (child) {
        var slot = child.taskSlot || { kind: 'end' };
        var milestoneId = slot.kind === 'milestone' && milestoneIds.get(slot.milestoneId);
        if (milestoneId) {
          visualChildren.get(milestoneId).push(child.id); visualParent.set(child.id, milestoneId);
        } else if (slot.kind === 'start') start.push(child);
        else end.push(child);
      });
      start.reverse().forEach(function (child) {
        visualChildren.get(parent.id).unshift(child.id); visualParent.set(child.id, parent.id);
      });
      end.forEach(function (child) { visualChildren.get(parent.id).push(child.id); visualParent.set(child.id, parent.id); });
    });
    function sizeFor(id, kind) {
      var supplied = sizes.get(id) || {};
      var defaults = kind === 'task' ? { width: 270, height: 92 }
        : kind === 'root' ? { width: 196, height: 72 }
          : kind === 'milestone' ? { width: 132, height: 54 } : { width: 180, height: 72 };
      return {
        width: Math.max(kind === 'milestone' ? 96 : 120, number(supplied.width, defaults.width)),
        height: Math.max(kind === 'milestone' ? 44 : 54, number(supplied.height, defaults.height)),
      };
    }
    var sizeMap = new Map();
    visualById.forEach(function (node, id) { sizeMap.set(id, sizeFor(id, node.kind)); });
    var top = visualChildren.get('root') || [];
    var leftTop = top.filter(function (id) { return rootSide(visualById.get(id).side) === 'left'; });
    var rightTop = top.filter(function (id) { return rootSide(visualById.get(id).side) !== 'left'; });
    var centers = new Map([['root', { x: 0, y: 0, side: 'root', depth: 0 }]]);
    function layoutSide(topIds, side) {
      if (!topIds.length) return;
      var nodeSet = new Set(['root']);
      function include(id) { if (nodeSet.has(id)) return; nodeSet.add(id); (visualChildren.get(id) || []).forEach(include); }
      topIds.forEach(include);
      var depths = new Map([['root', 0]]);
      function depthWalk(id, depth) {
        depths.set(id, depth);
        (visualChildren.get(id) || []).forEach(function (childId) { if (nodeSet.has(childId)) depthWalk(childId, depth + 1); });
      }
      topIds.forEach(function (id) { depthWalk(id, 1); });
      var maxByDepth = [];
      nodeSet.forEach(function (id) {
        var depth = depths.get(id) || 0;
        maxByDepth[depth] = Math.max(maxByDepth[depth] || 0, sizeMap.get(id).width);
      });
      var depthCenter = [], acc = 0;
      maxByDepth.forEach(function (width, depth) {
        depthCenter[depth] = acc + width / 2; acc += width + gapX;
      });
      var spread = new Map(), cursor = 0;
      function place(id) {
        var kids = (id === 'root' ? topIds : (visualChildren.get(id) || [])).filter(function (child) { return nodeSet.has(child); });
        if (!kids.length) {
          var height = sizeMap.get(id).height;
          spread.set(id, cursor + height / 2); cursor += height + gapY;
        } else {
          kids.forEach(place);
          spread.set(id, (spread.get(kids[0]) + spread.get(kids[kids.length - 1])) / 2);
        }
      }
      place('root');
      var rootDepth = depthCenter[0], rootSpread = spread.get('root');
      nodeSet.forEach(function (id) {
        if (id === 'root') return;
        var depth = depths.get(id) || 0;
        centers.set(id, {
          x: (side === 'left' ? -1 : 1) * (depthCenter[depth] - rootDepth),
          y: spread.get(id) - rootSpread,
          side: side, depth: depth,
        });
      });
    }
    layoutSide(rightTop, 'right'); layoutSide(leftTop, 'left');
    var placements = [];
    visualById.forEach(function (node, id) {
      var center = centers.get(id) || { x: 0, y: 0, side: 'right', depth: 0 };
      var size = sizeMap.get(id);
      placements.push({
        id: id, kind: node.kind, node: node, depth: center.depth, side: center.side,
        x: center.x - size.width / 2, y: center.y, width: size.width, height: size.height,
        metrics: node.kind === 'milestone'
          ? { count: 0, progress: node.milestone.reached ? 1 : 0, complete: node.milestone.reached }
          : model.metrics.get(id),
        subtreeMetrics: model.subtreeMetrics.get(id),
        availability: model.availability.get(id) || { available: true, reason: '' },
      });
    });
    var edges = [];
    visualParent.forEach(function (parentId, childId) { edges.push({ from: parentId, to: childId }); });
    var minX = Math.min.apply(Math, placements.map(function (item) { return item.x; }).concat([0]));
    var minY = Math.min.apply(Math, placements.map(function (item) { return item.y - item.height / 2; }).concat([0]));
    var offsetX = 44 - minX, offsetY = 44 - minY;
    placements.forEach(function (item) { item.x += offsetX; item.y += offsetY; });
    var width = Math.max.apply(Math, placements.map(function (item) { return item.x + item.width; }).concat([0])) + 44;
    var height = Math.max.apply(Math, placements.map(function (item) { return item.y + item.height / 2; }).concat([0])) + 44;
    return {
      model: model, nodes: placements, edges: edges,
      visualChildren: visualChildren, visualParent: visualParent,
      bounds: { x: 0, y: 0, width: width, height: height },
    };
  }
  function prepareDropContext(layoutValue, tree, nodeId) {
    var source = (tree && tree.nodes || []).find(function (node) { return node.id === nodeId; });
    if (!layoutValue || !source) return { valid: false, excluded: new Set() };
    var excluded = new Set([nodeId]), children = new Map();
    (layoutValue.edges || []).forEach(function (edge) {
      if (!children.has(edge.from)) children.set(edge.from, []);
      children.get(edge.from).push(edge.to);
    });
    (function visit(id) { (children.get(id) || []).forEach(function (child) { if (!excluded.has(child)) { excluded.add(child); visit(child); } }); })(nodeId);
    return {
      valid: true, source: source, nodeId: nodeId,
      parentId: text(source.parentId), taskSlot: source.taskSlot ? Object.assign({}, source.taskSlot) : null,
      side: rootSide(source.side), excluded: excluded,
      structuralExcluded: subtreeIds(tree, nodeId),
      byPlacement: new Map(layoutValue.nodes.map(function (item) { return [item.id, item]; })),
    };
  }
  function structureDropCandidate(layoutValue, tree, nodeId, point, hints) {
    hints = hints || {};
    var context = hints.context && hints.context.valid ? hints.context : prepareDropContext(layoutValue, tree, nodeId);
    if (!context.valid || !point) return null;
    var rowGap = Math.max(8, number(hints.rowGap, 30));
    var levelGap = Math.max(36, number(hints.levelGap, 92));
    var targetId = text(hints.targetId), targetPlacement = context.byPlacement.get(targetId);
    var targetNode = targetId === 'root' ? { id: 'root', kind: 'root' }
      : (tree.nodes || []).find(function (node) { return node.id === targetId; });
    var taskSlot = null;
    if (!targetNode && targetPlacement && targetPlacement.kind === 'milestone') {
      targetNode = (tree.nodes || []).find(function (node) { return node.id === targetPlacement.node.parentNodeId; });
      taskSlot = { kind: 'milestone', milestoneId: targetPlacement.node.milestone.id };
    }
    if (targetNode && targetNode.kind === 'task' && context.source.kind === 'task') {
      var requestedMilestone = text(hints.milestoneId);
      if (requestedMilestone && milestonesForTask((layoutValue.model && layoutValue.model.byTask.get(targetNode.taskId)) || null)
          .some(function (item) { return item.id === requestedMilestone; })) {
        taskSlot = { kind: 'milestone', milestoneId: requestedMilestone };
      }
      if (!taskSlot) taskSlot = { kind: 'end' };
    }
    var actualTargetId = targetNode && targetNode.kind === 'root' ? '' : (targetNode && targetNode.id || '');
    var targetSide = targetNode && targetNode.kind === 'root'
      ? (point.x < (targetPlacement.x + targetPlacement.width / 2) ? 'left' : 'right') : null;
    var canParent = targetNode && (targetNode.kind === 'root' || targetNode.kind === 'branch'
      || (targetNode.kind === 'task' && context.source.kind === 'task'));
    var sameParent = actualTargetId === context.parentId;
    var sameSlot = slotKey(taskSlot) === slotKey(context.taskSlot);
    var sameSide = actualTargetId || targetSide === context.side;
    if (canParent && !context.structuralExcluded.has(actualTargetId) && (!sameParent || !sameSlot || !sameSide)
        && canMove(tree, nodeId, actualTargetId)) {
      return {
        type: 'reparent', targetId: targetId || (actualTargetId || 'root'), parentId: actualTargetId,
        beforeId: '', taskSlot: taskSlot, side: targetSide,
        direction: targetSide || (targetPlacement && targetPlacement.side) || topSide(tree, actualTargetId),
        depthCoord: targetPlacement ? targetPlacement.x + targetPlacement.width / 2 : point.x,
        slotCoord: targetPlacement ? targetPlacement.y : point.y,
      };
    }
    var parentId = context.parentId;
    if (!canMove(tree, nodeId, parentId)) return null;
    var rootPlacement = context.byPlacement.get('root');
    var side = parentId ? topSide(tree, nodeId)
      : (point.x < rootPlacement.x + rootPlacement.width / 2 ? 'left' : 'right');
    var direction = side;
    var visualParentId = parentId || 'root';
    if (parentId && slotKey(context.taskSlot).indexOf('milestone:') === 0) {
      visualParentId = milestonePlacementId(parentId, context.taskSlot.milestoneId);
    }
    var parentPlacement = context.byPlacement.get(visualParentId) || context.byPlacement.get(parentId || 'root');
    var anchorPlacement = context.byPlacement.get(nodeId);
    if (!parentPlacement || !anchorPlacement) return null;
    var parentCenterX = parentPlacement.x + parentPlacement.width / 2;
    if (direction === 'right' && point.x <= parentCenterX + 12) return null;
    if (direction === 'left' && point.x >= parentCenterX - 12) return null;
    var siblings = layoutValue.nodes.filter(function (placement) {
      if (placement.kind === 'milestone' || context.excluded.has(placement.id)) return false;
      var node = placement.node;
      return text(node.parentId) === parentId && slotKey(node) === slotKey(context.taskSlot)
        && (parentId || rootSide(node.side) === side);
    }).sort(function (a, b) { return a.y - b.y; });
    var insertIndex = siblings.length;
    for (var index = 0; index < siblings.length; index += 1) {
      if (point.y < siblings[index].y) { insertIndex = index; break; }
    }
    var order = siblings.map(function (placement) { return placement.id; });
    order.splice(insertIndex, 0, nodeId);
    var ownIndex = order.indexOf(nodeId), beforeId = order[ownIndex + 1] || '';
    var depthCoord, slotCoord;
    if (siblings.length) {
      depthCoord = siblings.reduce(function (sum, placement) { return sum + placement.x + placement.width / 2; }, 0) / siblings.length;
      if (insertIndex === 0) slotCoord = siblings[0].y - siblings[0].height / 2 - rowGap / 2;
      else if (insertIndex === siblings.length) {
        var last = siblings[siblings.length - 1]; slotCoord = last.y + last.height / 2 + rowGap / 2;
      } else {
        var before = siblings[insertIndex - 1], after = siblings[insertIndex];
        slotCoord = ((before.y + before.height / 2) + (after.y - after.height / 2)) / 2;
      }
    } else {
      depthCoord = direction === 'left'
        ? parentPlacement.x - levelGap - anchorPlacement.width / 2
        : parentPlacement.x + parentPlacement.width + levelGap + anchorPlacement.width / 2;
      slotCoord = parentPlacement.y;
    }
    return {
      type: 'insert', targetId: '', parentId: parentId, beforeId: beforeId,
      taskSlot: context.taskSlot ? Object.assign({}, context.taskSlot) : null,
      side: parentId ? null : side, direction: direction, order: order,
      horizontal: true, depthCoord: depthCoord, slotCoord: slotCoord,
    };
  }

  return {
    normalizeTree: normalizeTree,
    taskOwner: taskOwner,
    subtreeIds: subtreeIds,
    canMove: canMove,
    previewMove: previewMove,
    prepareDropContext: prepareDropContext,
    structureDropCandidate: structureDropCandidate,
    buildModel: buildModel,
    layout: layout,
    progressForTask: progressForTask,
    milestonesForTask: milestonesForTask,
    milestonePlacementId: milestonePlacementId,
    slotKey: slotKey,
    rootSide: rootSide,
    topSide: topSide,
  };
});
