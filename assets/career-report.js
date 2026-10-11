// Lazy entry for the start workspace; warmup prepares data only.
(function () {
  'use strict';
  let loading=null, report=null;
  function load() {
    if(!loading)loading=import('./career/lifecycle.js').then(module=>module.createCareer(value=>{report=value;})).catch(error=>{loading=null;throw error;});
    return loading;
  }
  window.RelatumCareerReport=Object.freeze({
    activate:()=>load().then(r=>r.activate()),preload:()=>load().then(r=>r.preload()),
    generate:()=>load().then(r=>r.generate()),get report(){return report;}
  });
})();
