// 镜头册的零 DOM 数据层：
// - 规范化随 .canvas 保存的镜头顺序与相机数据；
// - 创建固定视角 / 跟随选区镜头；
// - 提供不触碰画布历史的更新、删除和排序操作。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.RelatumCanvasScenes = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
  'use strict';

  const VERSION = 1;
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 4;
  const MAX_TITLE_LENGTH = 80;

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

  function uniqueIds(value) {
    const seen = new Set();
    const ids = [];
    (Array.isArray(value) ? value : []).forEach(function (item) {
      const id = text(item).trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    });
    return ids;
  }

  function makeId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return 'scene-' + global.crypto.randomUUID();
    }
    return 'scene-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function normalizeCamera(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      centerX: finite(source.centerX, 0),
      centerY: finite(source.centerY, 0),
      scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, finite(source.scale, 1))),
    };
  }

  function normalizeScene(raw, usedIds, fallbackNow) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const ids = usedIds || new Set();
    let id = text(raw.id).trim();
    if (!id || ids.has(id)) id = makeId();
    ids.add(id);
    const createdAt = iso(raw.createdAt, fallbackNow);
    const kind = raw.kind === 'selection' ? 'selection' : 'camera';
    const scene = {
      id: id,
      title: text(raw.title).trim().slice(0, MAX_TITLE_LENGTH) || '未命名镜头',
      kind: kind,
      camera: normalizeCamera(raw.camera),
      createdAt: createdAt,
      updatedAt: iso(raw.updatedAt, createdAt),
    };
    if (kind === 'selection') {
      scene.anchorNodeIds = uniqueIds(raw.anchorNodeIds);
      scene.anchorGroupIds = uniqueIds(raw.anchorGroupIds);
    }
    return scene;
  }

  function normalizeBook(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const now = new Date().toISOString();
    const usedIds = new Set();
    const scenes = [];
    (Array.isArray(source.scenes) ? source.scenes : []).forEach(function (item) {
      const scene = normalizeScene(item, usedIds, now);
      if (scene) scenes.push(scene);
    });
    return { version: VERSION, scenes: scenes };
  }

  function createScene(input, now) {
    const source = input && typeof input === 'object' ? input : {};
    const stamp = iso(now, new Date().toISOString());
    return normalizeScene({
      id: source.id || makeId(),
      title: source.title,
      kind: source.kind,
      camera: source.camera,
      anchorNodeIds: source.anchorNodeIds,
      anchorGroupIds: source.anchorGroupIds,
      createdAt: stamp,
      updatedAt: stamp,
    }, new Set(), stamp);
  }

  function updateScene(scene, patch, now) {
    if (!scene || typeof scene !== 'object') return null;
    const source = Object.assign({}, scene, patch || {});
    source.id = scene.id;
    source.createdAt = scene.createdAt;
    source.updatedAt = iso(now, new Date().toISOString());
    return normalizeScene(source, new Set(), source.updatedAt);
  }

  function removeScene(book, sceneId) {
    const normalized = normalizeBook(book);
    normalized.scenes = normalized.scenes.filter(function (scene) {
      return scene.id !== sceneId;
    });
    return normalized;
  }

  function reorderScenes(book, orderedIds) {
    const normalized = normalizeBook(book);
    const byId = new Map(normalized.scenes.map(function (scene) { return [scene.id, scene]; }));
    const scenes = [];
    uniqueIds(orderedIds).forEach(function (id) {
      if (!byId.has(id)) return;
      scenes.push(byId.get(id));
      byId.delete(id);
    });
    normalized.scenes.forEach(function (scene) {
      if (byId.has(scene.id)) {
        scenes.push(scene);
        byId.delete(scene.id);
      }
    });
    normalized.scenes = scenes;
    return normalized;
  }

  function cleanMissingReferences(book, validNodeIds, validGroupIds) {
    const normalized = normalizeBook(book);
    const nodes = validNodeIds instanceof Set ? validNodeIds : new Set(validNodeIds || []);
    const groups = validGroupIds instanceof Set ? validGroupIds : new Set(validGroupIds || []);
    normalized.scenes.forEach(function (scene) {
      if (scene.kind !== 'selection') return;
      scene.anchorNodeIds = scene.anchorNodeIds.filter(function (id) { return nodes.has(id); });
      scene.anchorGroupIds = scene.anchorGroupIds.filter(function (id) { return groups.has(id); });
    });
    return normalized;
  }

  return {
    VERSION: VERSION,
    MIN_SCALE: MIN_SCALE,
    MAX_SCALE: MAX_SCALE,
    normalizeCamera: normalizeCamera,
    normalizeScene: normalizeScene,
    normalizeBook: normalizeBook,
    createScene: createScene,
    updateScene: updateScene,
    removeScene: removeScene,
    reorderScenes: reorderScenes,
    cleanMissingReferences: cleanMissingReferences,
  };
});
