// Unified Mermaid rendering for every Markdown surface in Relatum.
// Runtime dependency is vendored at assets/vendor/mermaid/ so diagrams work offline.
(function (global) {
  'use strict';

  var initialized = false;
  var readyPromise = null;
  var renderQueue = Promise.resolve();
  var renderSeq = 0;
  var rendererScript = document.currentScript;
  var mermaidScriptUrl = new URL(
    'vendor/mermaid/mermaid.min.js',
    rendererScript && rendererScript.src ? rendererScript.src : document.baseURI
  ).href;

  var CONFIG = {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
    flowchart: {
      htmlLabels: false,
      useMaxWidth: false,
      curve: 'basis',
      nodeSpacing: 44,
      rankSpacing: 62,
      padding: 14
    },
    sequence: {
      useMaxWidth: false,
      diagramMarginX: 36,
      diagramMarginY: 24,
      actorMargin: 60,
      width: 170,
      height: 54,
      boxMargin: 12,
      messageMargin: 36,
      noteMargin: 12
    },
    timeline: {
      useMaxWidth: false,
      diagramMarginX: 28,
      diagramMarginY: 24
    },
    themeVariables: {
      background: '#fffdf9',
      fontSize: '16px',
      primaryColor: '#fff0e9',
      primaryTextColor: '#1f2523',
      primaryBorderColor: '#ec6949',
      secondaryColor: '#e9f8ef',
      secondaryTextColor: '#1f2523',
      secondaryBorderColor: '#35a66f',
      tertiaryColor: '#fff5c7',
      tertiaryTextColor: '#1f2523',
      tertiaryBorderColor: '#d99c21',
      lineColor: '#343b38',
      textColor: '#1f2523',
      mainBkg: '#fff0e9',
      nodeBorder: '#ec6949',
      clusterBkg: '#f7f4ee',
      clusterBorder: '#aaa49a',
      titleColor: '#1f2523',
      edgeLabelBackground: '#fffdf9',
      actorBkg: '#f2eaff',
      actorBorder: '#8759bd',
      actorTextColor: '#1f2523',
      actorLineColor: '#696f6c',
      signalColor: '#343b38',
      signalTextColor: '#1f2523',
      labelBoxBkgColor: '#fffdf9',
      labelBoxBorderColor: '#aaa49a',
      labelTextColor: '#1f2523',
      loopTextColor: '#1f2523',
      noteBkgColor: '#fff5c7',
      noteBorderColor: '#d99c21',
      noteTextColor: '#1f2523',
      activationBkgColor: '#e9f8ef',
      activationBorderColor: '#35a66f',
      sequenceNumberColor: '#ffffff',
      sectionBkgColor: '#f2eaff',
      altSectionBkgColor: '#e8f7f7',
      gridColor: '#bdb8ae',
      todayLineColor: '#ec6949',
      taskBkgColor: '#fff0e9',
      taskBorderColor: '#ec6949',
      taskTextColor: '#1f2523',
      activeTaskBkgColor: '#e9f8ef',
      activeTaskBorderColor: '#35a66f',
      doneTaskBkgColor: '#e8f7f7',
      doneTaskBorderColor: '#288f91',
      critBkgColor: '#fce7ee',
      critBorderColor: '#cf4772',
      pie1: '#ec6949',
      pie2: '#f2b43c',
      pie3: '#35a66f',
      pie4: '#8a60c2',
      pie5: '#2b9ca0',
      pie6: '#cf4772',
      pie7: '#9f7047',
      pie8: '#77833b',
      cScale0: '#ec6949',
      cScale1: '#f2b43c',
      cScale2: '#35a66f',
      cScale3: '#8a60c2',
      cScale4: '#2b9ca0',
      cScale5: '#cf4772',
      cScale6: '#9f7047',
      cScale7: '#77833b',
      cScale8: '#e78446',
      cScale9: '#c86b52',
      cScale10: '#6baf83',
      cScale11: '#b768aa'
    },
    themeCSS: [
      '.flowchart-link,.messageLine0,.messageLine1,.relation{stroke:#343b38!important;stroke-width:2.2px!important}',
      'marker path,.arrowheadPath{fill:#343b38!important;stroke:#343b38!important}',
      '.edgeLabel,.edgeLabel p{background-color:#fffdf9!important;color:#1f2523!important}',
      '.label,.nodeLabel,.messageText,.loopText,.noteText{font-weight:600!important}',
      '.cluster rect{rx:14px!important;ry:14px!important}',
      '.actor,.note{rx:10px!important;ry:10px!important}'
    ].join('\n')
  };

  var DIAGRAM_HEAD = /^(?:---[\s\S]*?---\s*)?(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|requirementDiagram|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|block-beta|packet-beta|architecture-beta|kanban)\b/i;

  function normalizeSource(source, lang) {
    var text = String(source || '').replace(/\r\n?/g, '\n').trim();
    var kind = String(lang || '').trim().toLowerCase();
    if (!text || DIAGRAM_HEAD.test(text)) return text;
    if (kind === 'flowchart' || kind === 'flow') return 'flowchart TD\n' + text;
    if (kind === 'graph') return 'graph TD\n' + text;
    if (kind === 'sequence' || kind === 'sequencediagram') return 'sequenceDiagram\n' + text;
    if (kind === 'timeline') return 'timeline\n' + text;
    if (kind === 'gantt') return 'gantt\n' + text;
    if (kind === 'class' || kind === 'classdiagram') return 'classDiagram\n' + text;
    if (kind === 'state' || kind === 'statediagram') return 'stateDiagram-v2\n' + text;
    if (kind === 'er' || kind === 'erdiagram') return 'erDiagram\n' + text;
    if (kind === 'mindmap') return 'mindmap\n' + text;
    return text;
  }

  function initializeLibrary(resolve, reject) {
    var m = global.mermaid;
    if (!m || typeof m.initialize !== 'function' || typeof m.render !== 'function') {
      reject(new Error('本地 Mermaid 渲染库未能载入'));
      return;
    }
    if (!initialized) {
      try {
        m.initialize(CONFIG);
        initialized = true;
      } catch (err) {
        reject(err);
        return;
      }
    }
    resolve(m);
  }

  // Mermaid 的离线包约 3.34 MiB。只有页面真正出现 Mermaid fence 时才插入脚本，
  // 避免首页和普通画布每次启动都为一个未使用功能支付下载、解析与编译成本。
  function waitForLibrary() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise(function (resolve, reject) {
      if (global.mermaid) {
        initializeLibrary(resolve, reject);
        return;
      }

      var script = document.querySelector('script[data-relatum-mermaid-library]');
      var created = false;
      if (!script) {
        script = document.createElement('script');
        script.src = mermaidScriptUrl;
        script.async = true;
        script.dataset.relatumMermaidLibrary = '1';
        created = true;
      }
      script.addEventListener('load', function () {
        initializeLibrary(resolve, reject);
      }, { once: true });
      script.addEventListener('error', function () {
        reject(new Error('本地 Mermaid 渲染库未能载入'));
      }, { once: true });
      if (created) document.head.appendChild(script);
      else if (global.mermaid) initializeLibrary(resolve, reject);
    });
    return readyPromise;
  }

  function diagramElements(root) {
    if (!root) return [];
    var found = [];
    if (root.matches && root.matches('.mermaid-diagram, .mermaid')) found.push(root);
    if (root.querySelectorAll) {
      var descendants = root.querySelectorAll('.mermaid-diagram, .mermaid');
      for (var i = 0; i < descendants.length; i++) found.push(descendants[i]);
    }
    return found;
  }

  function sourceCarrier(source) {
    var carrier = document.createElement('template');
    carrier.className = 'mermaid-source';
    carrier.content.appendChild(document.createTextNode(source));
    return carrier;
  }

  function sourceFor(el) {
    if (typeof el.__mermaidSource === 'string') return el.__mermaidSource;
    var sourceEl = el.querySelector ? el.querySelector('.mermaid-source') : null;
    var source = sourceEl
      ? (sourceEl.content ? sourceEl.content.textContent : sourceEl.textContent)
      : (el.classList.contains('mermaid') ? el.textContent : '');
    el.__mermaidSource = normalizeSource(source, el.getAttribute('data-mermaid-lang'));
    return el.__mermaidSource;
  }

  function sourceKey(source) {
    var hash = 5381;
    for (var i = 0; i < source.length; i++) hash = ((hash << 5) + hash) ^ source.charCodeAt(i);
    return (hash >>> 0).toString(36) + '-' + source.length;
  }

  function setLoading(el, source) {
    el.classList.remove('is-rendered', 'is-error');
    el.classList.add('mermaid-diagram', 'is-loading');
    el.setAttribute('aria-busy', 'true');
    el.removeAttribute('data-mermaid-rendered');
    el.removeAttribute('data-mermaid-failed');
    el.innerHTML = '';
    el.appendChild(sourceCarrier(source));
    var status = document.createElement('div');
    status.className = 'mermaid-status';
    status.textContent = '正在绘制图表…';
    el.appendChild(status);
  }

  function setError(el, err, source, key) {
    el.classList.remove('is-loading', 'is-rendered');
    el.classList.add('mermaid-diagram', 'is-error');
    el.removeAttribute('aria-busy');
    el.removeAttribute('data-mermaid-rendered');
    el.setAttribute('data-mermaid-failed', key);
    el.innerHTML = '';
    el.appendChild(sourceCarrier(source));

    var box = document.createElement('details');
    box.className = 'mermaid-error';
    var summary = document.createElement('summary');
    summary.textContent = '图表没有画出来，点击查看源码';
    var message = document.createElement('p');
    message.textContent = (err && (err.str || err.message)) ? String(err.str || err.message) : 'Mermaid 语法无法解析';
    var pre = document.createElement('pre');
    pre.textContent = source;
    box.appendChild(summary);
    box.appendChild(message);
    box.appendChild(pre);
    el.appendChild(box);
  }

  function polishSvg(svg) {
    if (!svg) return;
    svg.classList.add('mermaid-svg');
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.removeProperty('max-width');
    svg.setAttribute('role', 'img');
    svg.setAttribute('focusable', 'false');

    var nodes = svg.querySelectorAll('.node.default');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.add('mermaid-palette-' + (i % 6));
    }

    // Mermaid measures before our final font weight/palette CSS is applied. Re-measure the
    // finished drawing so short flowcharts and long Chinese labels never escape the viewBox.
    var content = svg.querySelector('g');
    if (content && typeof content.getBBox === 'function') {
      try {
        var box = content.getBBox();
        if (box && box.width > 0 && box.height > 0) {
          var pad = 24;
          svg.setAttribute('viewBox', [
            box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2
          ].join(' '));
        }
      } catch (e) {}
    }
  }

  // Mermaid 已运行在 strict 模式；这里再对生成物做一层输出边界收紧，避免
  // 后续版本或图表扩展把可执行 HTML、事件属性或外部 URL 带入本地页面。
  function sanitizeSvg(stage) {
    if (!stage) return;
    // Mermaid 11 的 flowchart 标签即使关闭 htmlLabels 仍可能产生
    // foreignObject。只提取其纯文本并转成原生 SVG text，最终 DOM 不保留 HTML。
    stage.querySelectorAll('foreignObject').forEach(function (node) {
      var rawLines = [];
      var paragraphs = node.querySelectorAll('p');
      if (paragraphs.length) {
        for (var p = 0; p < paragraphs.length; p++) rawLines.push(paragraphs[p].textContent || '');
      } else {
        rawLines.push(node.textContent || '');
      }
      var lines = rawLines.map(function (line) { return line.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
      if (!lines.length) {
        node.remove();
        return;
      }
      var x = parseFloat(node.getAttribute('x')) || 0;
      var y = parseFloat(node.getAttribute('y')) || 0;
      var width = parseFloat(node.getAttribute('width')) || 0;
      var height = parseFloat(node.getAttribute('height')) || 0;
      var centerX = x + width / 2;
      var centerY = y + height / 2;
      var text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('class', 'nodeLabel relatum-mermaid-safe-label');
      text.setAttribute('x', String(centerX));
      text.setAttribute('y', String(centerY));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < lines.length; i++) {
        var tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        tspan.setAttribute('x', String(centerX));
        tspan.setAttribute('dy', i === 0 ? String(-(lines.length - 1) * 0.6) + 'em' : '1.2em');
        tspan.textContent = lines[i];
        text.appendChild(tspan);
      }
      if (node.parentNode) node.parentNode.replaceChild(text, node);
    });
    stage.querySelectorAll('script, foreignObject, iframe, object, embed, image, audio, video').forEach(function (node) { node.remove(); });
    stage.querySelectorAll('*').forEach(function (node) {
      Array.from(node.attributes || []).forEach(function (attribute) {
        var name = String(attribute.name || '').toLowerCase();
        var value = String(attribute.value || '').trim();
        if (name.indexOf('on') === 0) node.removeAttribute(attribute.name);
        else if (name === 'src' || name === 'srcset') node.removeAttribute(attribute.name);
        else if (name === 'style' && /(?:url\s*\(|@import|expression\s*\()/i.test(value)) node.removeAttribute(attribute.name);
        else if ((name === 'href' || name === 'xlink:href') && value && value.charAt(0) !== '#') {
          node.removeAttribute(attribute.name);
        }
      });
    });
  }

  function naturalSize(el, svg) {
    if (!svg || !svg.viewBox || !svg.viewBox.baseVal) return;
    var box = svg.viewBox.baseVal;
    if (box.width > 0) el.style.setProperty('--mermaid-natural-width', Math.ceil(box.width) + 'px');
    if (box.height > 0) el.style.setProperty('--mermaid-natural-height', Math.ceil(box.height) + 'px');
  }

  function renderOne(el) {
    if (!el || !el.isConnected) return Promise.resolve();
    var source = sourceFor(el);
    var key = sourceKey(source);
    if (!source) {
      setError(el, new Error('图表源码为空'), source, key);
      return Promise.resolve();
    }
    if ((el.__mermaidRenderedSource === source || el.getAttribute('data-mermaid-rendered') === key)
        && el.classList.contains('is-rendered') && el.querySelector('svg')) {
      return Promise.resolve();
    }
    if (el.getAttribute('data-mermaid-failed') === key && el.classList.contains('is-error')) {
      return Promise.resolve();
    }
    if (el.__mermaidPendingSource === source && el.__mermaidPending) return el.__mermaidPending;

    el.__mermaidPendingSource = source;
    setLoading(el, source);
    var job = renderQueue.catch(function () {}).then(function () {
      return waitForLibrary().then(function (m) {
        if (!el.isConnected) return;
        var id = 'relatum-mermaid-' + Date.now().toString(36) + '-' + (++renderSeq);
        return Promise.resolve(m.render(id, source)).then(function (result) {
          if (!el.isConnected || el.__mermaidPendingSource !== source) return;
          el.innerHTML = '';
          el.appendChild(sourceCarrier(source));
          var stage = document.createElement('div');
          stage.className = 'mermaid-stage';
          stage.innerHTML = result.svg;
          sanitizeSvg(stage);
          el.appendChild(stage);
          var svg = stage.querySelector('svg');
          polishSvg(svg);
          naturalSize(el, svg);
          el.classList.remove('is-loading', 'is-error');
          el.classList.add('is-rendered');
          el.removeAttribute('aria-busy');
          el.removeAttribute('data-mermaid-failed');
          el.setAttribute('data-mermaid-rendered', key);
          el.__mermaidRenderedSource = source;
        }).catch(function (err) {
          var artifact = document.getElementById(id);
          if (artifact && artifact.parentNode) artifact.parentNode.removeChild(artifact);
          if (el.isConnected && el.__mermaidPendingSource === source) setError(el, err, source, key);
        });
      }).catch(function (err) {
        if (el.isConnected && el.__mermaidPendingSource === source) setError(el, err, source, key);
      });
    });
    renderQueue = job;
    el.__mermaidPending = job.then(function () {
      el.__mermaidPending = null;
      el.__mermaidPendingSource = '';
    });
    return el.__mermaidPending;
  }

  function renderAll(root) {
    var elements = diagramElements(root || document);
    var jobs = [];
    for (var i = 0; i < elements.length; i++) {
      // Canvas/AI 会先在脱离文档的节点里生成 Markdown，再于同一调用栈末尾挂入 DOM。
      // 延后一轮 microtask，既不恢复全 body observer，也不会漏掉首次出现的图表。
      jobs.push(elements[i].isConnected
        ? renderOne(elements[i])
        : Promise.resolve(elements[i]).then(renderOne));
    }
    return Promise.all(jobs).then(function () {});
  }

  global.MermaidRenderer = {
    ready: waitForLibrary,
    render: renderOne,
    renderAll: renderAll,
    normalizeSource: normalizeSource
  };
})(window);
