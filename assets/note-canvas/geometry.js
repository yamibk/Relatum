// Port of canvas.js sideOfExit/bezierBetween/smoothD and 512-unit edge grid.
// Independent fork: do not import CanvasModule or document-wide editor state.
(function () {
  'use strict';
  const GRID = 512;
  const S = window.RelatumNoteCanvasStyle;
  function exit(rect, target, side) {
    const cx=rect.w/2, cy=rect.h/2;
    const fixed={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]}[side];
    let dx=fixed?fixed[0]:target.x-rect.x-cx,dy=fixed?fixed[1]:target.y-rect.y-cy;
    if(!dx&&!dy) dx=1;
    const limit=Math.min(dx?cx/Math.abs(dx):Infinity,dy?cy/Math.abs(dy):Infinity);
    let low=0,high=limit;
    for(let i=0;i<24;i++) { const mid=(low+high)/2;
      if(S.contains(rect.shape||'rounded-rect',rect.w,rect.h,rect.r||0,cx+dx*mid,cy+dy*mid)) low=mid;else high=mid; }
    const horizontal=Math.abs(dx/rect.w)>=Math.abs(dy/rect.h);
    return {x:rect.x+cx+dx*high,y:rect.y+cy+dy*high,nx:horizontal?Math.sign(dx):0,ny:horizontal?0:Math.sign(dy)};
  }
  function pointAt(item, fraction) {
    const samples=item.samples, wanted=item.length*Math.max(0,Math.min(1,fraction));
    let low=1,high=samples.length-1;
    while(low<high) {const mid=(low+high)>>1;if(samples[mid].length<wanted) low=mid+1;else high=mid;}
    const a=samples[low-1],b=samples[low],t=(wanted-a.length)/Math.max(.0001,b.length-a.length);
    return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
  }
  function arrow(item, start, size) {
    const samples=item.samples, tip=start?samples[0]:samples.at(-1), near=start?samples[1]:samples.at(-2);
    const angle=Math.atan2(tip.y-near.y,tip.x-near.x);
    return [tip,{x:tip.x-Math.cos(angle-.45)*size,y:tip.y-Math.sin(angle-.45)*size},
      {x:tip.x-Math.cos(angle+.45)*size,y:tip.y-Math.sin(angle+.45)*size}];
  }
  function build(edge, source, target) {
    const style=S.values('edge',edge), bends=edge.waypoints||[];
    const s=exit(source,bends[0]||{x:target.x+target.w/2,y:target.y+target.h/2},style.fromSide);
    const t=exit(target,bends.at(-1)||{x:source.x+source.w/2,y:source.y+source.h/2},style.toSide);
    let points=[s,...bends,t];
    if(style.curve==='smooth'&&points.length===2) {
      points=s.nx?[s,{x:(s.x+t.x)/2,y:s.y},{x:(s.x+t.x)/2,y:t.y},t]
        :[s,{x:s.x,y:(s.y+t.y)/2},{x:t.x,y:(s.y+t.y)/2},t];
    }
    const segments=[],controls=[s];
    let d=`M ${s.x} ${s.y}`,last=s;
    const line=p=>{if(Math.hypot(p.x-last.x,p.y-last.y)<.00001) return;segments.push({a:last,b:p});controls.push(p);d+=` L ${p.x} ${p.y}`;last=p;};
    const cubic=(c1,c2,p)=>{segments.push({a:last,c1,c2,b:p});controls.push(c1,c2,p);d+=` C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p.x} ${p.y}`;last=p;};
    if(style.curve==='elbow'||style.curve==='rounded-elbow') {
      const distance=Math.hypot(t.x-s.x,t.y-s.y),offset=Math.max(20,Math.min(distance*.18,80));
      const start={x:s.x+s.nx*offset,y:s.y+s.ny*offset},end={x:t.x+t.nx*offset,y:t.y+t.ny*offset};
      const anchors=[start,...bends,end],routed=[s,start];
      anchors.slice(1).forEach((p,i)=>{
        const a=anchors[i],horizontal=i===0?s.nx!==0:Math.abs(p.x-a.x)>=Math.abs(p.y-a.y);
        if(horizontal) {const x=(a.x+p.x)/2;routed.push({x,y:a.y},{x,y:p.y});}
        else {const y=(a.y+p.y)/2;routed.push({x:a.x,y},{x:p.x,y});}
        routed.push(p);
      });
      routed.push(t);
      points=routed.filter((p,i)=>!i||Math.hypot(p.x-routed[i-1].x,p.y-routed[i-1].y)>.00001);
      for(let i=1;i<points.length-1;i++) {
        const a=points[i-1],b=points[i],c=points[i+1],la=Math.hypot(b.x-a.x,b.y-a.y),lb=Math.hypot(c.x-b.x,c.y-b.y);
        const r=style.curve==='rounded-elbow'?Math.min(style.cornerRadius,la/2,lb/2):0;
        if(!r) {line(b);continue;}
        const before={x:b.x+(a.x-b.x)*r/la,y:b.y+(a.y-b.y)*r/la},after={x:b.x+(c.x-b.x)*r/lb,y:b.y+(c.y-b.y)*r/lb};
        line(before);cubic({x:before.x+(b.x-before.x)*2/3,y:before.y+(b.y-before.y)*2/3},
          {x:after.x+(b.x-after.x)*2/3,y:after.y+(b.y-after.y)*2/3},after);
      }line(t);
    } else if(style.curve==='straight') points.slice(1).forEach(line);
    else if(points.length===2) {
      const distance=Math.hypot(t.x-s.x,t.y-s.y),offset=Math.max(30,Math.min(distance*.4,120));
      if(style.curve==='smooth') {
        const dx=(t.x-s.x)/3,dy=(t.y-s.y)/3;
        cubic({x:s.x+dx,y:s.y+dy},{x:t.x-dx,y:t.y-dy},t);
      } else cubic({x:s.x+s.nx*offset,y:s.y+s.ny*offset},{x:t.x+t.nx*offset,y:t.y+t.ny*offset},t);
    } else for(let i=0;i<points.length-1;i++) {
      const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2;
      const tension=style.curve==='smooth'?1/6:1/4,offset=Math.max(20,Math.min(Math.hypot(p2.x-p1.x,p2.y-p1.y)*.4,120));
      cubic(i===0?{x:s.x+s.nx*offset,y:s.y+s.ny*offset}:{x:p1.x+(p2.x-p0.x)*tension,y:p1.y+(p2.y-p0.y)*tension},
        i===points.length-2?{x:t.x+t.nx*offset,y:t.y+t.ny*offset}:{x:p2.x-(p3.x-p1.x)*tension,y:p2.y-(p3.y-p1.y)*tension},p2);
    }
    if(!segments.length) line({x:t.x+.001,y:t.y});
    const samples=[{x:s.x,y:s.y,length:0}];let length=0;
    segments.forEach(segment=>{
      const steps=segment.c1?24:1;
      for(let i=1;i<=steps;i++) {
        const u=i/steps,v=1-u,a=segment.a,b=segment.b;
        const p=segment.c1?{x:v*v*v*a.x+3*v*v*u*segment.c1.x+3*v*u*u*segment.c2.x+u*u*u*b.x,
          y:v*v*v*a.y+3*v*v*u*segment.c1.y+3*v*u*u*segment.c2.y+u*u*u*b.y}:{x:b.x,y:b.y};
        const previous=samples.at(-1);length+=Math.hypot(p.x-previous.x,p.y-previous.y);samples.push({...p,length});
      }
    });
    const bounds={left:Math.min(...controls.map(p=>p.x)),right:Math.max(...controls.map(p=>p.x)),
      top:Math.min(...controls.map(p=>p.y)),bottom:Math.max(...controls.map(p=>p.y))};
    const item={d,path:typeof Path2D==='function'?new Path2D(d):null,bounds,samples,length,points:controls};
    item.midpoint=pointAt(item,.5);return item;
  }
  class SpatialGrid {
    constructor() { this.buckets = new Map(); this.keys = new Map(); this.large = new Set(); }
    remove(id) {
      (this.keys.get(id) || []).forEach(key => { const bucket = this.buckets.get(key); bucket.delete(id); if (!bucket.size) this.buckets.delete(key); });
      this.keys.delete(id); this.large.delete(id);
    }
    insert(id, bounds) {
      this.remove(id);
      const x0 = Math.floor(bounds.left / GRID), x1 = Math.floor(bounds.right / GRID);
      const y0 = Math.floor(bounds.top / GRID), y1 = Math.floor(bounds.bottom / GRID);
      if (![x0, x1, y0, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { this.large.add(id); return; }
      const keys = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = x + ':' + y;
        if (!this.buckets.has(key)) this.buckets.set(key, new Set());
        this.buckets.get(key).add(id); keys.push(key);
      }
      this.keys.set(id, keys);
    }
    query(bounds) {
      const result = new Set(this.large);
      const x0 = Math.floor(bounds.left / GRID), x1 = Math.floor(bounds.right / GRID);
      const y0 = Math.floor(bounds.top / GRID), y1 = Math.floor(bounds.bottom / GRID);
      if (![x0, x1, y0, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { this.keys.forEach((_, id) => result.add(id)); return result; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const bucket = this.buckets.get(x + ':' + y); if (bucket) bucket.forEach(id => result.add(id));
      }
      return result;
    }
    clear() { this.buckets.clear(); this.keys.clear(); this.large.clear(); }
  }
  window.RelatumNoteCanvasGeometry = Object.freeze({ build, exit, pointAt, arrow, SpatialGrid });
})();
