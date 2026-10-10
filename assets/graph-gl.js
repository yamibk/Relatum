// 图谱 WebGL 渲染后端（WebGL2 实例化）。
// 只负责把「几何」批量画到 GPU：节点(圆 / 圆角方块，SDF 抗锯齿描边) + 连线(带宽度线段)。
// 文字 / 光晕 / 聚合扇形不在这里——它们交给上层的 2D 叠加层（中文无法做位图字体图集，
// 且文字不该进每帧热路径）。缩放 / 平移只改一个仿射矩阵，几乎零成本，这是丝滑的来源。
//
// 数据契约（避免每帧分配）：上层直接往 renderer.nodeData / renderer.edgeData 这两个
// Float32Array 里按 stride 写，然后调 draw(nodeCount, edgeCount, camera)。
//   node stride = 14: [cx,cy, r, fr,fg,fb,fa, sr,sg,sb,sa, strokeW, shape(0圆/1方), scale]
//   edge stride = 9 : [x1,y1, x2,y2, r,g,b,a, width]   颜色均为直通 alpha(0..1)。
(function (global) {
  'use strict';

  const NODE_STRIDE = 14;
  const EDGE_STRIDE = 9;

  const NODE_VS = `#version 300 es
  layout(location=0) in vec2 aCorner;     // 基础四边形 [-1..1]
  layout(location=1) in vec2 aCenter;     // 世界坐标
  layout(location=2) in float aRadius;    // 世界单位
  layout(location=3) in vec4 aFill;
  layout(location=4) in vec4 aStroke;
  layout(location=5) in float aStrokeW;
  layout(location=6) in float aShape;     // 0 圆 / 1 圆角方块
  layout(location=7) in float aScale;     // 悬停缩放
  uniform vec4 uXform;   // clip = (a*x+b, c*y+d)
  uniform float uAA;     // 抗锯齿带宽（世界单位）
  out vec2 vLocal; out vec4 vFill; out vec4 vStroke;
  out float vRadius; out float vStrokeW; out float vShape; out float vAA;
  void main(){
    float rad = (aRadius + aStrokeW * 0.5 + uAA) * aScale;
    vec2 world = aCenter + aCorner * rad;
    gl_Position = vec4(uXform.x * world.x + uXform.y, uXform.z * world.y + uXform.w, 0.0, 1.0);
    vLocal = aCorner * rad;
    vFill = aFill; vStroke = aStroke;
    vRadius = aRadius * aScale; vStrokeW = aStrokeW * aScale; vShape = aShape; vAA = uAA;
  }`;

  const NODE_FS = `#version 300 es
  precision highp float;
  in vec2 vLocal; in vec4 vFill; in vec4 vStroke;
  in float vRadius; in float vStrokeW; in float vShape; in float vAA;
  out vec4 frag;
  float sdCircle(vec2 p, float r){ return length(p) - r; }
  float sdRoundBox(vec2 p, float b, float r){ vec2 q = abs(p) - vec2(b) + r; return min(max(q.x,q.y),0.0) + length(max(q,0.0)) - r; }
  void main(){
    float d;
    if (vShape > 0.5) {
      float hb = vRadius * 0.875;              // index 方块边长 = r*1.75 → 半边 0.875r
      d = sdRoundBox(vLocal, hb, max(2.5, vRadius * 0.32));
    } else {
      d = sdCircle(vLocal, vRadius);
    }
    float aa = max(vAA, 1e-4);
    float inside = 1.0 - smoothstep(-aa, aa, d);
    float ring = 1.0 - smoothstep(vStrokeW * 0.5 - aa, vStrokeW * 0.5 + aa, abs(d));
    float strokeA = ring * vStroke.a;
    vec3 rgb = mix(vFill.rgb, vStroke.rgb, strokeA);
    float alpha = max(vFill.a * inside, strokeA);
    if (alpha < 0.0008) discard;
    frag = vec4(rgb * alpha, alpha);           // 预乘 alpha 输出
  }`;

  const EDGE_VS = `#version 300 es
  layout(location=0) in vec2 aCorner;   // x∈[0,1] 沿线，y∈[-1,1] 横向
  layout(location=1) in vec2 aP1;
  layout(location=2) in vec2 aP2;
  layout(location=3) in vec4 aColor;
  layout(location=4) in float aWidth;
  uniform vec4 uXform;
  out vec4 vColor;
  void main(){
    vec2 dir = aP2 - aP1; float len = length(dir);
    vec2 t = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
    vec2 n = vec2(-t.y, t.x);
    vec2 world = mix(aP1, aP2, aCorner.x) + n * (aWidth * 0.5) * aCorner.y;
    gl_Position = vec4(uXform.x * world.x + uXform.y, uXform.z * world.y + uXform.w, 0.0, 1.0);
    vColor = aColor;
  }`;

  const EDGE_FS = `#version 300 es
  precision highp float;
  in vec4 vColor; out vec4 frag;
  void main(){ frag = vec4(vColor.rgb * vColor.a, vColor.a); }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader: ' + log);
    }
    return sh;
  }
  function link(gl, vsSrc, fsSrc) {
    const p = gl.createProgram();
    let vs = null;
    let fs = null;
    try {
      vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
      fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
      gl.attachShader(p, vs); gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('link: ' + gl.getProgramInfoLog(p));
      }
      return p;
    } catch (err) {
      // 驱动拒绝某个 shader 时上层会回落 Canvas2D；这里也要收掉
      // 已经创建的半成品 GPU 对象，避免每次重建图谱都泄漏一组资源。
      gl.deleteProgram(p);
      throw err;
    } finally {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
    }
  }

  function create(canvas) {
    let gl;
    try {
      gl = canvas.getContext('webgl2', {
        antialias: true, alpha: true, premultipliedAlpha: true,
        depth: false, stencil: false,
      });
    } catch (e) { gl = null; }
    if (!gl) return null;

    let nodeProgram = null;
    let edgeProgram = null;
    try {
      nodeProgram = link(gl, NODE_VS, NODE_FS);
      edgeProgram = link(gl, EDGE_VS, EDGE_FS);
    } catch (e) {
      // 第二套程序失败时，第一套已链接的 program 也要释放。
      // 返回 null 由 graph-engine 透明切回 Canvas2D。
      if (nodeProgram) gl.deleteProgram(nodeProgram);
      if (edgeProgram) gl.deleteProgram(edgeProgram);
      return null;
    }
    const uNodeXform = gl.getUniformLocation(nodeProgram, 'uXform');
    const uNodeAA = gl.getUniformLocation(nodeProgram, 'uAA');
    const uEdgeXform = gl.getUniformLocation(edgeProgram, 'uXform');

    // 基础四边形（节点用 [-1..1]，连线用 [0..1]×[-1..1]）
    const nodeQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nodeQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const edgeQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);

    // 实例数据缓冲；相机帧复用已有实例，数据或外观变化才上传。
    const nodeInstBuf = gl.createBuffer();
    const edgeInstBuf = gl.createBuffer();

    const nodeVAO = gl.createVertexArray();
    gl.bindVertexArray(nodeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, nodeQuad);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, nodeInstBuf);
    const NS = NODE_STRIDE * 4;
    const nodeAttribs = [[1, 2, 0], [2, 1, 8], [3, 4, 12], [4, 4, 28], [5, 1, 44], [6, 1, 48], [7, 1, 52]];
    nodeAttribs.forEach(function (a) {
      gl.enableVertexAttribArray(a[0]);
      gl.vertexAttribPointer(a[0], a[1], gl.FLOAT, false, NS, a[2]);
      gl.vertexAttribDivisor(a[0], 1);
    });
    gl.bindVertexArray(null);

    const edgeVAO = gl.createVertexArray();
    gl.bindVertexArray(edgeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeQuad);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeInstBuf);
    const ES = EDGE_STRIDE * 4;
    const edgeAttribs = [[1, 2, 0], [2, 2, 8], [3, 4, 16], [4, 1, 32]];
    edgeAttribs.forEach(function (a) {
      gl.enableVertexAttribArray(a[0]);
      gl.vertexAttribPointer(a[0], a[1], gl.FLOAT, false, ES, a[2]);
      gl.vertexAttribDivisor(a[0], 1);
    });
    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // 预乘 alpha
    gl.clearColor(0, 0, 0, 0);

    const api = {
      gl: gl,
      nodeData: new Float32Array(NODE_STRIDE * 256),
      edgeData: new Float32Array(EDGE_STRIDE * 256),
      nodeCap: 256,
      edgeCap: 256,
    };

    api.ensureCapacity = function (nNodes, nEdges) {
      if (nNodes > api.nodeCap) {
        api.nodeCap = Math.max(nNodes, api.nodeCap * 2);
        api.nodeData = new Float32Array(NODE_STRIDE * api.nodeCap);
      }
      if (nEdges > api.edgeCap) {
        api.edgeCap = Math.max(nEdges, api.edgeCap * 2);
        api.edgeData = new Float32Array(EDGE_STRIDE * api.edgeCap);
      }
    };

    let uploadedNodeCount = -1;
    let uploadedEdgeCount = -1;
    // uploads 可分别复用节点/连线；省略时保留直接调用者的全量上传语义。
    // 尺寸、相机矩阵与抗锯齿带宽始终更新，不改变世界单位半径/线宽。
    api.draw = function (nodeCount, edgeCount, camera, uploads) {
      const w = Math.max(1, Math.round(camera.cssW * camera.dpr));
      const h = Math.max(1, Math.round(camera.cssH * camera.dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const xf = camera.xform;

      if (edgeCount > 0) {
        gl.useProgram(edgeProgram);
        gl.uniform4f(uEdgeXform, xf[0], xf[1], xf[2], xf[3]);
        gl.bindBuffer(gl.ARRAY_BUFFER, edgeInstBuf);
        if (!uploads || uploads.edges !== false || uploadedEdgeCount !== edgeCount) {
          gl.bufferData(gl.ARRAY_BUFFER, api.edgeData.subarray(0, edgeCount * EDGE_STRIDE), gl.DYNAMIC_DRAW);
          uploadedEdgeCount = edgeCount;
        }
        gl.bindVertexArray(edgeVAO);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, edgeCount);
      }
      if (nodeCount > 0) {
        gl.useProgram(nodeProgram);
        gl.uniform4f(uNodeXform, xf[0], xf[1], xf[2], xf[3]);
        gl.uniform1f(uNodeAA, camera.aaWorld);
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeInstBuf);
        if (!uploads || uploads.nodes !== false || uploadedNodeCount !== nodeCount) {
          gl.bufferData(gl.ARRAY_BUFFER, api.nodeData.subarray(0, nodeCount * NODE_STRIDE), gl.DYNAMIC_DRAW);
          uploadedNodeCount = nodeCount;
        }
        gl.bindVertexArray(nodeVAO);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodeCount);
      }
      gl.bindVertexArray(null);
    };

    api.destroy = function () {
      try {
        gl.deleteProgram(nodeProgram); gl.deleteProgram(edgeProgram);
        gl.deleteBuffer(nodeQuad); gl.deleteBuffer(edgeQuad);
        gl.deleteBuffer(nodeInstBuf); gl.deleteBuffer(edgeInstBuf);
        gl.deleteVertexArray(nodeVAO); gl.deleteVertexArray(edgeVAO);
      } catch (e) {}
    };

    api.NODE_STRIDE = NODE_STRIDE;
    api.EDGE_STRIDE = EDGE_STRIDE;
    return api;
  }

  global.GraphGL = { create: create, NODE_STRIDE: NODE_STRIDE, EDGE_STRIDE: EDGE_STRIDE };
})(window);
