/* 学习页与目标树共用的 12 色粉彩色库（单一事实来源）。
 * 目标树「阶段」调色盘与学习任务卡片调色盘都从这里取色，
 * 改色值只改这里，两处渲染保持一致。不写用户数据。 */
(function () {
  'use strict';
  var COLORS = [
    { value: '', label: '默认' },
    { value: '#fce2cc', label: '杏橙' },
    { value: '#e2ece4', label: '薄荷' },
    { value: '#e8ecf2', label: '天空' },
    { value: '#f0dee4', label: '蔷薇' },
    { value: '#ece2ee', label: '丁香' },
    { value: '#f3ecd8', label: '暖金' },
    { value: '#f2d9d6', label: '赤霞' },
    { value: '#def0ec', label: '青瓷' },
    { value: '#dde3f2', label: '雾蓝' },
    { value: '#eaf0dc', label: '新绿' },
    { value: '#f0efe9', label: '月灰' },
  ];
  window.RelatumStudyPalette = Object.freeze({ COLORS: COLORS });
})();
