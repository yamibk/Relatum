// Study Goal Tree V4: typed primary route links plus secondary prerequisites.
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
  function progressForTask(task) {
    if (!task) return 0;
    if (task.status === 'done') return 1;
    var progress = task.progress && typeof task.progress === 'object' ? task.progress : {};
    var target = Math.max(0, number(progress.target));
    return target ? Math.max(0, Math.min(1, number(progress.current) / target)) : 0;
  }
  function milestonesForTask(task) {
    var progress = task && task.progress && typeof task.progress === 'object' ? task.progress : {};
    return (Array.isArray(progress.milestones) ? progress.milestones : []).filter(function (item) {
      return item && text(item.id).trim() && number(item.at) > 0;
    }).map(function (item) {
      return { id: text(item.id), name: text(item.name).trim() || '任务点', at: number(item.at) };
    }).sort(function (a, b) { return a.at - b.at || a.id.localeCompare(b.id); });
  }
  function milestonePlacementId(nodeId, milestoneId) {
    return 'milestone::' + text(nodeId) + '::' + text(milestoneId);
  }
  function triggerKey(trigger) {
    return trigger && trigger.kind === 'milestone'
      ? 'milestone:' + text(trigger.milestoneId) : 'complete';
  }
  function sortedLinks(items) {
    return (items || []).slice().sort(function (a, b) {
      return number(a.order) - number(b.order) || text(a.id).localeCompare(text(b.id));
    });
  }
  function cloneLink(link) {
    var copy = Object.assign({}, link);
    if (link && link.trigger) copy.trigger = Object.assign({}, link.trigger);
    return copy;
  }

  function normalizeTree(value, tasks) {
    var tree = value && typeof value === 'object' ? value : {};
    if (tree.version !== 2) throw new Error('目标树版本不兼容');
    var byTask = new Map((tasks || []).map(function (task) { return [text(task.id), task]; }));
    var nodes = [], nodeIds = new Set(), taskIds = new Set();
    (Array.isArray(tree.nodes) ? tree.nodes : []).forEach(function (raw) {
      if (!raw || typeof raw !== 'object') throw new Error('目标树节点格式不正确');
      var id = text(raw.id).trim(), kind = text(raw.kind);
      if (!id || nodeIds.has(id) || !['branch', 'task'].includes(kind)) throw new Error('目标树节点无效');
      var node = { id: id, kind: kind };
      if (kind === 'branch') {
        node.title = text(raw.title).trim() || '未命名阶段';
        if (text(raw.color).trim()) node.color = text(raw.color).trim();
      } else {
        var taskId = text(raw.taskId).trim();
        if (!taskId || !byTask.has(taskId) || taskIds.has(taskId)) throw new Error('目标树任务无效或重复');
        taskIds.add(taskId); node.taskId = taskId;
      }
      nodeIds.add(id); nodes.push(node);
    });
    var byId = new Map(nodes.map(function (node) { return [node.id, node]; }));
    var links = [], linkIds = new Set(), primaryByTarget = new Map();
    (Array.isArray(tree.links) ? tree.links : []).forEach(function (raw) {
      if (!raw || typeof raw !== 'object') throw new Error('目标树连接格式不正确');
      var id = text(raw.id).trim(), from = text(raw.from).trim() || null, to = text(raw.to).trim();
      var type = text(raw.type), primary = !!raw.primary;
      if (!id || linkIds.has(id) || !byId.has(to) || (from && !byId.has(from)) || from === to) throw new Error('目标树连接引用无效');
      if (!['contains', 'requires'].includes(type)) throw new Error('目标树连接类型无效');
      if (type === 'contains' && from && byId.get(from).kind !== 'branch') throw new Error('只有阶段可以包含节点');
      if (type === 'contains' && !primary) throw new Error('包含连接必须属于主路线');
      if (type === 'requires' && !from) throw new Error('依赖连接缺少来源');
      var link = { id: id, from: from, to: to, type: type, primary: primary };
      if (primary) {
        link.order = Math.max(0, number(raw.order));
        if (!from) link.side = rootSide(raw.side);
        if (primaryByTarget.has(to)) throw new Error('节点存在多条主路线');
        primaryByTarget.set(to, link);
      }
      if (type === 'requires') {
        var trigger = raw.trigger && typeof raw.trigger === 'object' ? raw.trigger : { kind: 'complete' };
        link.trigger = trigger.kind === 'milestone'
          ? { kind: 'milestone', milestoneId: text(trigger.milestoneId) }
          : { kind: 'complete' };
      }
      linkIds.add(id); links.push(link);
    });
    nodes.forEach(function (node) {
      if (!primaryByTarget.has(node.id)) throw new Error('节点没有接入主路线');
    });
    var normalized = {
      version: 2,
      id: text(tree.id),
      title: text(tree.title).trim() || '我的学习路线',
      nodes: nodes,
      links: links,
    };
    if (tree.createdAt) normalized.createdAt = text(tree.createdAt);
    if (tree.updatedAt) normalized.updatedAt = text(tree.updatedAt);
    if (Number.isFinite(Number(tree.order))) normalized.order = Math.max(0, Number(tree.order));
    return normalized;
  }

  function primaryLink(tree, nodeId) {
    return (tree && tree.links || []).find(function (link) {
      return link.primary && link.to === text(nodeId);
    }) || null;
  }
  function primaryChildren(tree) {
    var result = new Map();
    (tree && tree.links || []).forEach(function (link) {
      if (!link.primary) return;
      var key = text(link.from);
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(link);
    });
    result.forEach(function (items) { items.sort(function (a, b) { return number(a.order) - number(b.order) || a.id.localeCompare(b.id); }); });
    return result;
  }
  function subtreeIds(tree, nodeId) {
    var children = primaryChildren(tree), result = new Set();
    (function visit(id) {
      if (!id || result.has(id)) return;
      result.add(id);
      (children.get(id) || []).forEach(function (link) { visit(link.to); });
    })(text(nodeId));
    return result;
  }
  function taskOwner(tree, taskId) {
    var node = (tree && tree.nodes || []).find(function (item) {
      return item.kind === 'task' && text(item.taskId) === text(taskId);
    });
    return node ? { tree: tree, node: node } : null;
  }

  function buildModel(value, tasks) {
    var tree = normalizeTree(value, tasks);
    var byId = new Map(tree.nodes.map(function (node) { return [node.id, node]; }));
    var byTask = new Map((tasks || []).map(function (task) { return [text(task.id), task]; }));
    var primaryByTarget = new Map(), children = new Map(), containsChildren = new Map(), requirements = new Map();
    tree.links.forEach(function (link) {
      if (link.primary) {
        primaryByTarget.set(link.to, link);
        var key = text(link.from);
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(link);
        if (link.type === 'contains' && link.from) {
          if (!containsChildren.has(link.from)) containsChildren.set(link.from, []);
          containsChildren.get(link.from).push(link.to);
        }
      }
      if (link.type === 'requires') {
        if (!requirements.has(link.to)) requirements.set(link.to, []);
        requirements.get(link.to).push(link);
      }
    });
    children.forEach(function (items) { items.sort(function (a, b) { return number(a.order) - number(b.order) || a.id.localeCompare(b.id); }); });

    function combine(values) {
      var count = values.reduce(function (sum, item) { return sum + item.count; }, 0);
      return {
        count: count,
        progress: count ? values.reduce(function (sum, item) { return sum + item.progress * item.count; }, 0) / count : 0,
        complete: count > 0 && values.every(function (item) { return item.complete; }),
      };
    }
    var metrics = new Map();
    function branchMetrics(nodeId, active) {
      if (active.has(nodeId)) return { count: 0, progress: 0, complete: false };
      active.add(nodeId);
      var values = [];
      (containsChildren.get(nodeId) || []).forEach(function (childId) {
        var child = byId.get(childId);
        if (!child) return;
        if (child.kind === 'task') {
          var task = byTask.get(child.taskId), own = {
            count: 1, progress: progressForTask(task), complete: !!task && task.status === 'done',
          };
          metrics.set(child.id, own); values.push(own);
        } else values.push(branchMetrics(child.id, active));
      });
      active.delete(nodeId);
      var aggregate = combine(values); metrics.set(nodeId, aggregate); return aggregate;
    }
    tree.nodes.forEach(function (node) {
      if (node.kind === 'branch' && !metrics.has(node.id)) branchMetrics(node.id, new Set());
      if (node.kind === 'task' && !metrics.has(node.id)) {
        var task = byTask.get(node.taskId);
        metrics.set(node.id, { count: 1, progress: progressForTask(task), complete: !!task && task.status === 'done' });
      }
    });
    var rootValues = tree.nodes.filter(function (node) { return node.kind === 'task'; }).map(function (node) { return metrics.get(node.id); });
    var rootMetrics = combine(rootValues); metrics.set('root', rootMetrics);

    function sourceSatisfied(link) {
      var source = byId.get(link.from);
      if (!source) return false;
      if (source.kind === 'branch') return !!(metrics.get(source.id) || {}).complete;
      var task = byTask.get(source.taskId);
      if (!task) return false;
      if (task.status === 'done') return true;
      if ((link.trigger || {}).kind !== 'milestone') return false;
      var milestone = milestonesForTask(task).find(function (item) { return item.id === link.trigger.milestoneId; });
      return !!milestone && number((task.progress || {}).current) >= milestone.at;
    }
    function sourceTitle(link) {
      var source = byId.get(link.from);
      if (!source) return '未知节点';
      if (source.kind === 'branch') return source.title;
      return (byTask.get(source.taskId) || {}).title || '未命名任务';
    }
    var availability = new Map();
    function availabilityFor(nodeId, active) {
      if (availability.has(nodeId)) return availability.get(nodeId);
      if (active.has(nodeId)) return { available: false, reasons: [{ kind: 'cycle', title: '循环依赖' }] };
      active.add(nodeId);
      var blockers = (requirements.get(nodeId) || []).filter(function (link) { return !sourceSatisfied(link); }).map(function (link) {
        return {
          linkId: link.id,
          kind: (link.trigger || {}).kind === 'milestone' ? 'milestone' : 'complete',
          title: sourceTitle(link),
          milestoneId: (link.trigger || {}).milestoneId || '',
          primary: !!link.primary,
        };
      });
      var incoming = primaryByTarget.get(nodeId);
      if (incoming && incoming.type === 'contains' && incoming.from) {
        var parentState = availabilityFor(incoming.from, active);
        if (!parentState.available) blockers = blockers.concat(parentState.reasons.map(function (reason) {
          return Object.assign({}, reason, { inherited: true });
        }));
      }
      active.delete(nodeId);
      var state = { available: blockers.length === 0, reasons: blockers };
      availability.set(nodeId, state); return state;
    }
    tree.nodes.forEach(function (node) { availabilityFor(node.id, new Set()); });
    return {
      tree: tree, byId: byId, byTask: byTask, primaryByTarget: primaryByTarget,
      children: children, containsChildren: containsChildren, requirements: requirements,
      metrics: metrics, availability: availability, rootMetrics: rootMetrics,
    };
  }

  function scopedTaskNodes(model, nodeId) {
    if (!model) return [];
    if (!nodeId || nodeId === 'root') {
      return model.tree.nodes.filter(function (node) { return node.kind === 'task'; });
    }
    var root = model.byId.get(text(nodeId));
    if (!root) return [];
    if (root.kind === 'task') return [root];
    var result = [], seen = new Set();
    (function visit(id) {
      if (seen.has(id)) return;
      seen.add(id);
      (model.children.get(text(id)) || []).forEach(function (link) {
        if (link.type !== 'contains') return;
        var child = model.byId.get(link.to);
        if (!child) return;
        if (child.kind === 'task') result.push(child);
        else visit(child.id);
      });
    })(root.id);
    return result;
  }

  function progressBreakdown(model, nodeId) {
    var nodes = scopedTaskNodes(model, nodeId);
    var rows = nodes.map(function (node) {
      var task = model.byTask.get(node.taskId) || {};
      var progress = task.progress && typeof task.progress === 'object' ? task.progress : {};
      var current = Math.max(0, number(progress.current));
      var target = Math.max(0, number(progress.target));
      var ratio = progressForTask(task);
      return {
        nodeId: node.id,
        taskId: node.taskId,
        title: text(task.title).trim() || '未命名任务',
        current: current,
        target: target,
        done: task.status === 'done',
        progress: ratio,
        percent: Math.round(ratio * 100),
      };
    });
    var sum = rows.reduce(function (total, row) { return total + row.progress; }, 0);
    return {
      nodeId: nodeId || 'root',
      rows: rows,
      count: rows.length,
      progressSum: sum,
      progress: rows.length ? sum / rows.length : 0,
      percent: Math.round((rows.length ? sum / rows.length : 0) * 100),
      completeCount: rows.filter(function (row) { return row.done; }).length,
    };
  }

  function requirementCount(model, nodeId) {
    return (model && model.requirements.get(text(nodeId)) || []).length;
  }

  function canAddRequirement(model, sourceId, targetId, trigger) {
    sourceId = text(sourceId); targetId = text(targetId);
    var source = model && model.byId.get(sourceId), target = model && model.byId.get(targetId);
    if (!source || !target || sourceId === targetId) return false;
    var cleanedTrigger = trigger && trigger.kind === 'milestone'
      ? { kind: 'milestone', milestoneId: text(trigger.milestoneId) }
      : { kind: 'complete' };
    if (cleanedTrigger.kind === 'milestone') {
      if (source.kind !== 'task') return false;
      var task = model.byTask.get(source.taskId);
      if (!milestonesForTask(task).some(function (item) { return item.id === cleanedTrigger.milestoneId; })) return false;
    }
    var duplicate = (model.requirements.get(targetId) || []).some(function (link) {
      return link.from === sourceId && triggerKey(link.trigger) === triggerKey(cleanedTrigger);
    });
    if (duplicate) return false;

    function containsAncestor(ancestorId, childId) {
      var cursor = childId, seen = new Set();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        var incoming = model.primaryByTarget.get(cursor);
        if (!incoming || incoming.type !== 'contains' || !incoming.from) return false;
        cursor = incoming.from;
        if (cursor === ancestorId) return true;
      }
      return false;
    }
    if (containsAncestor(sourceId, targetId) || containsAncestor(targetId, sourceId)) return false;

    var dependencyChildren = new Map();
    model.tree.links.forEach(function (link) {
      if (link.type !== 'requires') return;
      if (!dependencyChildren.has(link.from)) dependencyChildren.set(link.from, []);
      dependencyChildren.get(link.from).push(link.to);
    });
    var pending = [targetId], visited = new Set();
    while (pending.length) {
      var current = pending.pop();
      if (current === sourceId) return false;
      if (visited.has(current)) continue;
      visited.add(current);
      (dependencyChildren.get(current) || []).forEach(function (next) { pending.push(next); });
    }
    return true;
  }

  function layout(value, tasks, options) {
    options = options || {};
    var model = buildModel(value, tasks), collapsed = options.collapsedIds instanceof Set ? options.collapsedIds : new Set();
    var sizes = options.sizes instanceof Map ? options.sizes : new Map();
    var gapX = number(options.gapX, 92), gapY = number(options.gapY, 30);
    var visualById = new Map(), visualChildren = new Map(), visualParent = new Map(), primaryEdgeByTarget = new Map();
    var rootNode = { id: 'root', kind: 'root', title: model.tree.title };
    visualById.set('root', rootNode); visualChildren.set('root', []);
    model.tree.nodes.forEach(function (node) { visualById.set(node.id, node); visualChildren.set(node.id, []); });

    function includePrimary(sourceId, visualSourceId) {
      sortedLinks(model.children.get(text(sourceId)) || []).forEach(function (link) {
        var node = model.byId.get(link.to);
        if (!node) return;
        visualChildren.get(visualSourceId).push(node.id); visualParent.set(node.id, visualSourceId);
        primaryEdgeByTarget.set(node.id, link);
        if (node.kind === 'branch' && collapsed.has(node.id)) return;
        if (node.kind === 'task') includeTaskChildren(node, link);
        else includePrimary(node.id, node.id);
      });
    }
    function includeTaskChildren(node) {
      var task = model.byTask.get(node.taskId), milestones = milestonesForTask(task), milestoneIds = new Map();
      milestones.forEach(function (milestone) {
        var id = milestonePlacementId(node.id, milestone.id), progress = task && task.progress || {};
        visualById.set(id, {
          id: id, kind: 'milestone', parentNodeId: node.id, taskId: node.taskId,
          milestone: Object.assign({}, milestone, { reached: !!task && (task.status === 'done' || number(progress.current) >= milestone.at) }),
        });
        visualChildren.set(id, []); visualChildren.get(node.id).push(id); visualParent.set(id, node.id);
        milestoneIds.set(milestone.id, id);
      });
      sortedLinks(model.children.get(node.id) || []).forEach(function (link) {
        var target = model.byId.get(link.to), visualSource = node.id;
        if (link.type === 'requires' && (link.trigger || {}).kind === 'milestone') {
          visualSource = milestoneIds.get(link.trigger.milestoneId) || node.id;
        }
        visualChildren.get(visualSource).push(target.id); visualParent.set(target.id, visualSource);
        primaryEdgeByTarget.set(target.id, link);
        if (target.kind === 'branch' && collapsed.has(target.id)) return;
        if (target.kind === 'task') includeTaskChildren(target);
        else includePrimary(target.id, target.id);
      });
    }
    sortedLinks(model.children.get('') || []).forEach(function (link) {
      var node = model.byId.get(link.to);
      visualChildren.get('root').push(node.id); visualParent.set(node.id, 'root'); primaryEdgeByTarget.set(node.id, link);
      if (node.kind === 'branch' && collapsed.has(node.id)) return;
      if (node.kind === 'task') includeTaskChildren(node);
      else includePrimary(node.id, node.id);
    });

    function sizeFor(id, kind) {
      var supplied = sizes.get(id) || {};
      var defaults = kind === 'task' ? { width: 270, height: 92 }
        : kind === 'root' ? { width: 196, height: 72 }
          : kind === 'milestone' ? { width: 132, height: 54 } : { width: 180, height: 72 };
      return { width: Math.max(kind === 'milestone' ? 96 : 120, number(supplied.width, defaults.width)), height: Math.max(kind === 'milestone' ? 44 : 54, number(supplied.height, defaults.height)) };
    }
    var sizeMap = new Map(); visualById.forEach(function (node, id) { sizeMap.set(id, sizeFor(id, node.kind)); });
    var top = visualChildren.get('root') || [];
    var leftTop = top.filter(function (id) { return rootSide((primaryEdgeByTarget.get(id) || {}).side) === 'left'; });
    var rightTop = top.filter(function (id) { return rootSide((primaryEdgeByTarget.get(id) || {}).side) !== 'left'; });
    var centers = new Map([['root', { x: 0, y: 0, side: 'root', depth: 0 }]]);
    function layoutSide(topIds, side) {
      if (!topIds.length) return;
      var nodeSet = new Set(['root']);
      function include(id) { if (nodeSet.has(id)) return; nodeSet.add(id); (visualChildren.get(id) || []).forEach(include); }
      topIds.forEach(include);
      var depths = new Map([['root', 0]]);
      function walk(id, depth) { depths.set(id, depth); (visualChildren.get(id) || []).forEach(function (child) { if (nodeSet.has(child)) walk(child, depth + 1); }); }
      topIds.forEach(function (id) { walk(id, 1); });
      var maxByDepth = [];
      nodeSet.forEach(function (id) { var depth = depths.get(id) || 0; maxByDepth[depth] = Math.max(maxByDepth[depth] || 0, sizeMap.get(id).width); });
      var depthCenter = [], acc = 0;
      maxByDepth.forEach(function (width, depth) { depthCenter[depth] = acc + width / 2; acc += width + gapX; });
      var spread = new Map(), cursor = 0;
      function place(id) {
        var kids = (id === 'root' ? topIds : (visualChildren.get(id) || [])).filter(function (child) { return nodeSet.has(child); });
        if (!kids.length) { var height = sizeMap.get(id).height; spread.set(id, cursor + height / 2); cursor += height + gapY; }
        else { kids.forEach(place); spread.set(id, (spread.get(kids[0]) + spread.get(kids[kids.length - 1])) / 2); }
      }
      place('root'); var rootDepth = depthCenter[0], rootSpread = spread.get('root');
      nodeSet.forEach(function (id) {
        if (id === 'root') return;
        var depth = depths.get(id) || 0;
        centers.set(id, { x: (side === 'left' ? -1 : 1) * (depthCenter[depth] - rootDepth), y: spread.get(id) - rootSpread, side: side, depth: depth });
      });
    }
    layoutSide(rightTop, 'right'); layoutSide(leftTop, 'left');
    var placements = [], visibleIds = new Set();
    visualById.forEach(function (node, id) {
      var center = centers.get(id); if (!center && id !== 'root') return;
      center = center || { x: 0, y: 0, side: 'root', depth: 0 };
      var size = sizeMap.get(id), hiddenCount = 0;
      if (node.kind === 'branch' && collapsed.has(id)) hiddenCount = Math.max(0, subtreeIds(model.tree, id).size - 1);
      placements.push({
        id: id, kind: node.kind, node: node, depth: center.depth, side: center.side,
        x: center.x - size.width / 2, y: center.y, width: size.width, height: size.height,
        metrics: node.kind === 'milestone' ? { count: 0, progress: node.milestone.reached ? 1 : 0, complete: node.milestone.reached } : (model.metrics.get(id) || { count: 0, progress: 0, complete: false }),
        availability: model.availability.get(id) || { available: true, reasons: [] },
        collapsed: node.kind === 'branch' && collapsed.has(id), hiddenCount: hiddenCount,
      }); visibleIds.add(id);
    });
    var edges = [];
    visualParent.forEach(function (from, to) {
      if (!visibleIds.has(from) || !visibleIds.has(to)) return;
      var link = primaryEdgeByTarget.get(to);
      edges.push({ id: link ? link.id : from + '>' + to, from: from, to: to, type: link ? link.type : 'contains', primary: true, trigger: link && link.trigger });
    });
    model.tree.links.forEach(function (link) {
      if (link.primary || link.type !== 'requires' || !visibleIds.has(link.to)) return;
      var from = link.from;
      if ((link.trigger || {}).kind === 'milestone') from = milestonePlacementId(link.from, link.trigger.milestoneId);
      if (visibleIds.has(from)) edges.push({ id: link.id, from: from, to: link.to, type: 'requires', primary: false, trigger: link.trigger });
    });
    var minX = 0, minY = 0, maxX = 0, maxY = 0;
    placements.forEach(function (item) { minX = Math.min(minX, item.x); minY = Math.min(minY, item.y - item.height / 2); maxX = Math.max(maxX, item.x + item.width); maxY = Math.max(maxY, item.y + item.height / 2); });
    var pad = 48;
    placements.forEach(function (item) { item.x += -minX + pad; item.y += -minY + pad; });
    return { model: model, nodes: placements, edges: edges, bounds: { x: 0, y: 0, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 } };
  }

  function canMove(tree, nodeId, sourceId) {
    if (!(tree && tree.nodes || []).some(function (node) { return node.id === nodeId; })) return false;
    if (!sourceId) return true;
    if (!(tree.nodes || []).some(function (node) { return node.id === sourceId; })) return false;
    return !subtreeIds(tree, nodeId).has(sourceId);
  }
  function previewMove(tree, nodeId, primary) {
    if (!primary || !canMove(tree, nodeId, primary.from)) return null;
    var copy = {
      version: 2, id: tree.id, title: tree.title,
      nodes: (tree.nodes || []).map(function (node) { return Object.assign({}, node); }),
      links: (tree.links || []).filter(function (link) { return !(link.primary && link.to === nodeId); }).map(cloneLink),
    };
    var old = primaryLink(tree, nodeId);
    copy.links.push({
      id: old ? old.id : 'preview-link', from: primary.from || null, to: nodeId,
      type: primary.type || 'contains', primary: true, order: number(primary.order, 999999),
      side: primary.from ? undefined : rootSide(primary.side),
      trigger: primary.type === 'requires' ? Object.assign({}, primary.trigger || { kind: 'complete' }) : undefined,
    });
    return copy;
  }
  function topSide(tree, nodeId) {
    var cursor = text(nodeId), seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor); var link = primaryLink(tree, cursor);
      if (!link || !link.from) return rootSide(link && link.side);
      cursor = link.from;
    }
    return 'right';
  }
  function prepareDropContext(layoutValue, tree, nodeId) {
    var source = (tree && tree.nodes || []).find(function (node) { return node.id === nodeId; });
    if (!layoutValue || !source) return { valid: false, excluded: new Set() };
    var incoming = primaryLink(tree, nodeId);
    return {
      valid: true, source: source, nodeId: nodeId, incoming: incoming,
      structuralExcluded: subtreeIds(tree, nodeId),
      byPlacement: new Map(layoutValue.nodes.map(function (item) { return [item.id, item]; })),
    };
  }
  function structureDropCandidate(layoutValue, tree, nodeId, point, hints) {
    hints = hints || {};
    var context = hints.context && hints.context.valid ? hints.context : prepareDropContext(layoutValue, tree, nodeId);
    if (!context.valid || !point) return null;
    var targetId = text(hints.targetId), targetPlacement = context.byPlacement.get(targetId);
    var target = targetId === 'root' ? { id: 'root', kind: 'root' }
      : (tree.nodes || []).find(function (node) { return node.id === targetId; });
    var primary = null;
    if (!target && targetPlacement && targetPlacement.kind === 'milestone') {
      primary = { from: targetPlacement.node.parentNodeId, type: 'requires', trigger: { kind: 'milestone', milestoneId: targetPlacement.node.milestone.id } };
    } else if (target) {
      if (target.kind === 'root') {
        var rootCenter = targetPlacement.x + targetPlacement.width / 2;
        primary = { from: null, type: 'contains', side: point.x < rootCenter ? 'left' : 'right' };
      } else if (target.kind === 'task') primary = { from: target.id, type: 'requires', trigger: { kind: 'complete' } };
      else primary = { from: target.id, type: 'contains' };
    }
    if (primary && !context.structuralExcluded.has(primary.from) && canMove(tree, nodeId, primary.from)) {
      return {
        type: 'reparent', targetId: targetId, primaryLink: primary,
        parentId: primary.from, side: primary.side || null, beforeId: '',
        direction: primary.side || (targetPlacement && targetPlacement.side) || topSide(tree, primary.from),
        depthCoord: targetPlacement ? targetPlacement.x + targetPlacement.width / 2 : point.x,
        slotCoord: targetPlacement ? targetPlacement.y : point.y,
      };
    }
    var incoming = context.incoming;
    if (!incoming) return null;
    var siblings = layoutValue.nodes.filter(function (placement) {
      if (placement.kind === 'milestone' || context.structuralExcluded.has(placement.id)) return false;
      var link = primaryLink(tree, placement.id);
      return link && text(link.from) === text(incoming.from)
        && (!incoming.from ? rootSide(link.side) === rootSide(incoming.side) : true);
    }).sort(function (a, b) { return a.y - b.y; });
    var insertIndex = siblings.length;
    for (var index = 0; index < siblings.length; index += 1) if (point.y < siblings[index].y) { insertIndex = index; break; }
    var beforeId = siblings[insertIndex] ? siblings[insertIndex].id : '';
    var anchor = context.byPlacement.get(nodeId), parentPlacement = context.byPlacement.get(incoming.from || 'root');
    return {
      type: 'insert', targetId: '', beforeId: beforeId,
      primaryLink: Object.assign({}, cloneLink(incoming), { beforeId: beforeId }),
      parentId: incoming.from, side: incoming.side || null, direction: topSide(tree, nodeId),
      horizontal: true,
      depthCoord: anchor ? anchor.x + anchor.width / 2 : point.x,
      slotCoord: siblings.length ? (insertIndex < siblings.length ? siblings[insertIndex].y - siblings[insertIndex].height / 2 - 15 : siblings[siblings.length - 1].y + siblings[siblings.length - 1].height / 2 + 15) : (parentPlacement ? parentPlacement.y : point.y),
    };
  }
  function nextTasks(model) {
    var visualOrder = new Map(), sequence = 0;
    function walk(sourceId) {
      (model.children.get(text(sourceId)) || []).forEach(function (link) {
        if (visualOrder.has(link.to)) return;
        visualOrder.set(link.to, sequence++);
        walk(link.to);
      });
    }
    walk('');
    var candidates = model.tree.nodes.filter(function (node) {
      if (node.kind !== 'task') return false;
      var task = model.byTask.get(node.taskId), state = model.availability.get(node.id);
      return task && task.status !== 'done' && state && state.available;
    });
    return candidates.sort(function (a, b) {
      var taskA = model.byTask.get(a.taskId), taskB = model.byTask.get(b.taskId);
      var startedA = number((taskA.progress || {}).current) > 0 ? 0 : 1;
      var startedB = number((taskB.progress || {}).current) > 0 ? 0 : 1;
      if (startedA !== startedB) return startedA - startedB;
      return number(visualOrder.get(a.id), 999999) - number(visualOrder.get(b.id), 999999) || a.id.localeCompare(b.id);
    });
  }

  return {
    normalizeTree: normalizeTree,
    buildModel: buildModel,
    layout: layout,
    taskOwner: taskOwner,
    primaryLink: primaryLink,
    primaryChildren: primaryChildren,
    subtreeIds: subtreeIds,
    canMove: canMove,
    previewMove: previewMove,
    prepareDropContext: prepareDropContext,
    structureDropCandidate: structureDropCandidate,
    nextTasks: nextTasks,
    scopedTaskNodes: scopedTaskNodes,
    progressBreakdown: progressBreakdown,
    requirementCount: requirementCount,
    canAddRequirement: canAddRequirement,
    progressForTask: progressForTask,
    milestonesForTask: milestonesForTask,
    milestonePlacementId: milestonePlacementId,
    triggerKey: triggerKey,
    rootSide: rootSide,
    topSide: topSide,
  };
});
