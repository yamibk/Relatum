// Note sidebar policy; interaction is shared with global settings.
(function () {
  'use strict';
  window.RelatumNoteSidebarSettings = Object.freeze({ create(options) {
    return window.RelatumSettingsOrderList.create({ ...options,
      key: 'canvas:noteSidebarPages:v1',
      ids: ['notebooks', 'outline', 'canvas', 'guide', 'links', 'ai'],
      names: { notebooks: ['笔记本', 'Notebooks'], outline: ['大纲', 'Outline'], canvas: ['画布', 'Canvas'], guide: ['引导', 'Guide'], links: ['链接', 'Links'], ai: ['AI', 'AI'] },
    });
  } });
})();
