import { chromium as legacy } from 'playwright-ax';
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

const iterations = 20;
const origin = process.env.NAVI_BENCHMARK_URL || 'http://127.0.0.1:4173';
const timeoutMs = 30000;
/** @param {Promise<any>} promise */
async function bounded(promise) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Benchmark operation timed out')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
/** @param {number[]} values @param {number} quantile */
function percentile(values, quantile) { return [...values].sort((a,b) => a-b)[Math.ceil(values.length * quantile)-1]; }
/** @param {unknown} payload */
function footprint(payload) {
  const json = JSON.stringify(payload);
  return { bytes: Buffer.byteLength(json, 'utf8'), characters: json.length, estimatedTokens: Math.ceil(json.length / 4) };
}
/** @param {number[]} values */
function mean(values) { return values.reduce((sum,value)=>sum+value,0)/values.length; }
/** @param {unknown} condition @param {string} message */
function assert(condition, message) { if (!condition) throw new Error(message); }

// Same browser posture as Navi's own launch paths: without chromiumSandbox the
// Playwright default appends --no-sandbox, which would compare a weaker browser.
const browser = await legacy.launch({ executablePath: chromium.executablePath(), headless: true, chromiumSandbox: true });
/** @type {any[]} */
const fixtures = [];
/** @type {any[]} */
const shadowTrials = [];
const sdk = await readFile('dist/navi.min.js','utf8');

/** @param {import('playwright-ax').Page} page @param {number} size */
async function setup(page, size) {
  const response = await page.goto(origin, { waitUntil: 'load' });
  assert(response?.status() === 200, 'Local demo unavailable');
  await page.evaluate(size => {
    if (!window.Navi) throw new Error('Missing demo SDK');
    window.Navi.stop(); Reflect.deleteProperty(window, 'Navi');
    document.head.querySelectorAll('style').forEach(el => el.remove());
    document.body.innerHTML = '<style>body{margin:8px;font:14px sans-serif}main{display:grid;grid-template-columns:repeat(10,1fr);gap:4px}button,span{height:28px}button{font:inherit}</style><main id="fixture">' +
      Array.from({length:size-1},(_,i)=>i%10===0 ? `<button data-agent-target="action-${i}">Action ${i}</button>` : `<span>Product detail ${i}: material, sizing and availability information</span>`).join('') + '</main><div id="bench-open" style="position:fixed;top:20px;right:20px;z-index:5"></div><div id="bench-closed" style="position:fixed;top:70px;right:20px;z-index:5"></div>';
  }, size);
  await page.evaluate(source => {
    (0,eval)(source);
    for (const [id,mode,target,label] of [['bench-open','open','nested-open','Nested open action'],['bench-closed','closed','nested-closed','Nested closed action']]) {
      const host = document.getElementById(id);
      if (!host) throw new Error('Missing fixture host');
      const root = host.attachShadow({mode: /** @type {'open'|'closed'} */ (mode)});
      const nested = document.createElement('div'); root.append(nested);
      const leaf = nested.attachShadow({mode: /** @type {'open'|'closed'} */ (mode)});
      const button = document.createElement('button'); button.textContent=label;button.setAttribute('data-agent-target',target);
      button.style.cssText='height:32px;padding:4px 12px'; leaf.append(button);
      button.addEventListener('click',()=>document.body.setAttribute('data-last-action',target));
    }
  },sdk);
}

/** @param {any} node @param {string} name @returns {boolean} */
function hasName(node, name) {
  return !!node && ((node.role === 'button' && node.name === name) || node.children?.some((/** @type {any} */ child)=>hasName(child,name)));
}

try {
  const demo = await browser.newPage({viewport:{width:1360,height:1200}});
  await demo.goto(origin,{waitUntil:'load'});
  await bounded(demo.evaluate(()=>window.Navi?.ready()));
  // Do not benchmark the demo's own action-map output as duplicated static content.
  await demo.evaluate(()=>{ document.getElementById('map')?.replaceChildren();document.getElementById('stats')?.replaceChildren(); });
  await bounded(demo.evaluate(()=>window.Navi?.ready()));
  const demoFixture = await measure(demo,'Local demo',8);
  // Probe every fixture, including the demo page: the gate requires a recorded
  // traversal for each one, and an unprobed fixture must never pass by omission.
  demoFixture.traversal = await traversalProbe(demo);
  await demo.close();
  for (const size of [2000,10000]) {
    const page = await browser.newPage({viewport:{width:1360,height:900}});
    await setup(page,size);
    await bounded(page.evaluate(()=>window.Navi?.ready()));
    await page.evaluate(async()=>{ await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame); });
    const fixture = await measure(page,`${size.toLocaleString('en-US')} elements`,size/10+2);
    fixture.traversal = await traversalProbe(page);
    fixture.coldCompletionMs = [];
    for (let i=0;i<iterations;i++) {
      const cold=await browser.newPage({viewport:{width:1360,height:900}});
      // Prepare without installing Navi so cold measurement includes injection/indexing.
      await cold.goto(origin,{waitUntil:'load'});
      await cold.evaluate(size=>{
        window.Navi?.stop();Reflect.deleteProperty(window,'Navi');document.head.querySelectorAll('style').forEach(el=>el.remove());
        document.body.innerHTML='<main>'+Array.from({length:size-1},(_,j)=>j%10===0?`<button data-agent-target="cold-${j}">Action ${j}</button>`:`<span>Product detail ${j}: sizing and availability</span>`).join('')+'</main>';
      },size);
      await cold.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
      const start=performance.now();
      const snapshot=await bounded(cold.evaluate(async source=>{ (0,eval)(source);if(!window.Navi)throw new Error('SDK missing');return window.Navi.actions({limit:5000}); },sdk));
      assert(!snapshot.truncated && snapshot.actions.length===size/10,'Cold map incomplete');
      fixture.coldCompletionMs.push(performance.now()-start);
      await cold.close();
    }
    if(size===2000) await reliability(page);
    await page.close();
  }
  const sizes=JSON.parse(await readFile('reports/build.json','utf8'));
  const metadata={recordedAt:new Date().toISOString(),iterations,origin,browser:browser.version(),legacyPlaywright:JSON.parse(await readFile('node_modules/playwright-ax/package.json','utf8')).version,
    currentPlaywright:JSON.parse(await readFile('node_modules/@playwright/test/package.json','utf8')).version,node:process.version,
    hardware:{cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,os:`${os.platform()} ${os.release()} ${os.arch()}`},sizes};
  const report={metadata,fixtures,shadowTrials};
  await mkdir('reports',{recursive:true});
  await writeFile('reports/benchmark-comparison.json',JSON.stringify(report,null,2)+'\n');
  const table=rows();
  console.log('\n'+table+'\n');
  let markdown='# Navi v0.2 vs Playwright accessibility · measured comparison\n\n'+
    `Recorded ${metadata.recordedAt}. ${iterations} iterations per method/fixture, Chromium ${metadata.browser}, ${metadata.hardware.cpu}, ${metadata.hardware.os}, Node ${metadata.node}.\n\n`+
    `**API compatibility:** current Playwright ${metadata.currentPlaywright} removed page.accessibility. The benchmark uses pinned playwright-core ${metadata.legacyPlaywright} via a dev-only alias and the current installed Chromium executable for both methods. It calls the actual legacy snapshot API; this is not a claim to reproduce current Playwright MCP's locator.ariaSnapshot format.\n\n`+table+'\n\n## Token footprint results\n\n';
  for(const fixture of fixtures){
    const full=fixture.methods.find((/** @type {any} */m)=>m.id==='ax-full');const filtered=fixture.methods.find((/** @type {any} */m)=>m.id==='ax-filtered');
    for(const id of ['navi-viewport','navi-full']){
      const navi=fixture.methods.find((/** @type {any} */m)=>m.id===id);
      markdown+=`- **${fixture.name} / ${navi.name}**: token reduction vs full AX **${((1-navi.meanTokens/full.meanTokens)*100).toFixed(2)}%**; vs filtered AX **${((1-navi.meanTokens/filtered.meanTokens)*100).toFixed(2)}%**. Negative means Navi costs more.\n`;
    }
  }
  markdown+='\n## Cold completion (indexing + full dictionary)\n\n';
  for(const fixture of fixtures.filter(f=>f.coldCompletionMs))markdown+=`- ${fixture.name}: p50 **${percentile(fixture.coldCompletionMs,.5).toFixed(2)}ms**, p95 **${percentile(fixture.coldCompletionMs,.95).toFixed(2)}ms** (${iterations} fresh fixtures, injection + indexing + full map; main fixture only, no added shadow controls).\n`;
  markdown+='\n## Traversal long-task probe\n\n'+
    'Long Tasks measured inside the page while Navi re-scans the settled fixture and builds the full action map (`refresh()` + `actions({limit:5000})`). The Long Tasks API reports only tasks above 50ms. Fixture construction is excluded as test scaffolding; tasks observed while the page is idle after the traversal are listed separately and are not part of any gate.\n\n'+
    '| Fixture | Traversal ms | Controls mapped | Long tasks >50ms | Idle-window long tasks |\n|---|---:|---:|---:|---:|\n';
  for(const fixture of fixtures.filter(/** @type {any} */ f=>f.traversal)){
    const t=fixture.traversal;
    markdown+=t.supported
      ? `| ${fixture.name} | ${t.elapsedMs.toFixed(2)} | ${t.actions} | ${t.longTasksMs.length} | ${t.postTraversalLongTasksMs.length} |\n`
      : `| ${fixture.name} | n/a | n/a | unavailable${t.error?` (${t.error})`:''} | n/a |\n`;
  }
  markdown+='\n## Nested shadow discovery + execution\n\n| Method | Root | Discovered | Verified action success |\n|---|---|---:|---:|\n';
  for(const trial of shadowTrials)markdown+=`| ${trial.method} | ${trial.root} | ${trial.discovered}/${iterations} | ${trial.succeeded}/${iterations} (${(trial.succeeded/iterations*100).toFixed(0)}%) |\n`;
  markdown+='\n## Methodology and trade-offs\n\n'+
    `- **Run-to-run variance is significant.** Wall-clock figures depend on host load and garbage collection; comparing two separate runs of this script has shifted p50 values by several hundred milliseconds on the largest fixture. Trust the within-run comparison (same process, alternating order) over cross-run differences, and re-run rather than comparing an old report to a new one. Small windows must be represented by less than 10 of the 20 iterations before being treated as meaningful; the small demo window is shown partly to make that limitation visible.\n`+
    '- Default CLI target is the live local demo. Controlled fixtures are installed on that same origin with exactly 2,000/10,000 elements in main (10% buttons), descriptive static spans, and two nested shadow controls. The local demo is separately measured; its rendered map text is cleared to avoid counting duplicate diagnostic JSON as page content.\n'+
    '- Warmups precede 20 timed iterations; method order alternates forward/reverse. Timers include awaited browser API transport and scheduler idle waits but exclude subsequent JSON serialization for footprint. Warm Navi indexing is complete before query timings; cold completion is reported separately. All full maps assert exact counts, and truncation is rejected.\n'+
    '- Full AX uses snapshot({interestingOnly:false}); filtered AX uses snapshot() default. Viewport-only Navi is a subset, not equivalent full-page information: it scans indexed references but computes rich state only for intersecting controls. Full Navi includes disabled/offscreen controls, state and coordinates; AX includes document semantics/text and can contain input values. Fixtures contain no personal data.\n'+
    '- Payload size is UTF-8 serialized JSON bytes (table KB uses 1,000 bytes). Estimated tokens are ceil(JSON string characters/4), not real tokenizer usage. Payload footprints/timings are saved per run. Signed reductions are reported even when Navi is worse; no positive-gain assertion or 10× claim.\n'+
    '- Shadow success is separate from discovery timing: AX name/role tree discovery followed by native getByRole click versus Navi dictionary discovery followed by execute. Both verify a resettable business counter. Browser AX can see closed-root buttons even when Playwright locators cannot pierce closed roots; that limitation belongs to this execution adapter, not accessibility discovery itself. No LLM planner, vision model, network checkout or agent token generation is measured.\n'+
    '- The traversal long-task probe is a separate gate input: `npm run benchmark` records it per fixture and `node scripts/ci-gates.mjs --benchmark` fails if any traversal produces a task over 50ms or if the 2,000-node viewport classification p95 exceeds 25ms. A missing probe, or a browser without the Long Tasks API, fails the gate rather than passing it.\n'+
    '- The fallback adapter is covered by regression tests for explicit trusted-only click/input, frame top-coordinate conversion, certified no-dispatch errors, occlusion refusal and unknown-error no-retry. Native fallback does not magically infer ignored synthetic actions or reconcile business success.\n'+
    '- These local static-fixture results depend on layout, viewport, text density and hardware. Sparse or filtered AX can be more compact. Rich action maps trade extra bytes/time for explicit state, coordinates and direct execution; they are not inherently zero-token or universally faster.\n\n'+
    '## Reproduce\n\n```sh\nnpm ci --no-audit --no-fund\nnpx playwright install chromium\nnpm run build\nnpm run dev -- --host 127.0.0.1 --port 4173\n# In a second terminal:\nnpm run benchmark\n```\n\nSet NAVI_BENCHMARK_URL only for another authorized local demo origin. The script fails if the demo is unavailable; it does not publish or create a server.\n\n[Raw measurements](benchmark-comparison.json) · [Adapter guide](../docs/AGENT-INTEGRATION.md)\n';
  await writeFile('reports/BENCHMARK.md',markdown);
  console.log('Saved reports/BENCHMARK.md and reports/benchmark-comparison.json');
} finally { await browser.close(); }

/** @param {import('playwright-ax').Page} page @param {string} fixtureName @param {number} expectedActions */
async function measure(page,fixtureName,expectedActions){
  const methods=[
    {id:'ax-full',name:'AX full snapshot',run:()=>page.accessibility.snapshot({interestingOnly:false})},
    {id:'ax-filtered',name:'AX default filtered',run:()=>page.accessibility.snapshot()},
    {id:'navi-viewport',name:'Navi viewport map',run:()=>page.evaluate(()=>window.Navi?.actions({limit:5000,viewportOnly:true}))},
    {id:'navi-full',name:'Navi full map',run:()=>page.evaluate(()=>window.Navi?.actions({limit:5000}))}
  ];
  const samples=new Map(methods.map(m=>[m.id,/** @type {any[]} */([])]));
  for(const method of methods)await bounded(method.run());
  for(let iteration=0;iteration<iterations;iteration++)for(const method of iteration%2?[...methods].reverse():methods){
    const start=performance.now();const payload=await bounded(method.run());const latencyMs=performance.now()-start;
    assert(payload,'Missing payload');
    if(method.id.startsWith('navi')){
      const map=/** @type {Awaited<ReturnType<import('../types/navi.js').NaviAPI['actions']>>} */(payload);
      assert(!map.truncated,'Truncated map');if(method.id==='navi-full')assert(map.actions.length===expectedActions,'Incomplete full Navi map');
      else assert(map.actions.every(a=>a.state.is_in_viewport),'Viewport filter failed');
    }
    samples.get(method.id)?.push({iteration,latencyMs,...footprint(payload)});
  }
  const fixture={name:fixtureName,methods:methods.map(method=>{
    const list=samples.get(method.id)||[];return{id:method.id,name:method.name,meanBytes:mean(list.map(s=>s.bytes)),meanTokens:mean(list.map(s=>s.estimatedTokens)),p50Ms:percentile(list.map(s=>s.latencyMs),.5),p95Ms:percentile(list.map(s=>s.latencyMs),.95),samples:list};
  }),traversal:/** @type {any} */(undefined),coldCompletionMs:/** @type {number[] | undefined} */(undefined)};
  fixtures.push(fixture);console.log(`Measured ${fixtureName}`);return fixture;
}
/**
 * Measures Long Tasks caused by Navi traversing an already-settled fixture.
 *
 * Three attribution choices keep this honest: the observer starts after fixture
 * construction, so scaffolding is not counted as SDK work; only small metrics
 * cross the process boundary, so Playwright's own serialization of a large
 * action map cannot be mistaken for traversal cost; and the idle window after
 * the traversal is recorded separately rather than folded into the gate.
 * The Long Tasks API only emits entries above 50ms by definition.
 * @param {import('playwright-ax').Page} page
 */
async function traversalProbe(page){
  try{
    return await bounded(page.evaluate(async()=>{
      const navi=window.Navi;
      if(!navi)throw new Error('Missing Navi SDK');
      if(!PerformanceObserver.supportedEntryTypes.includes('longtask'))return{supported:false,elapsedMs:0,actions:0,truncated:false,longTasksMs:[],postTraversalLongTasksMs:[]};
      /** @type {number[]} */
      const longTasksMs=[];
      const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())longTasksMs.push(entry.duration);});
      observer.observe({type:'longtask'});
      observer.takeRecords();
      const start=performance.now();
      await navi.refresh();
      const map=await navi.actions({limit:5000});
      const actions=map.actions.length,truncated=map.truncated;
      const elapsedMs=performance.now()-start;
      // Entries for completed tasks are already queued, so this close-out is the
      // traversal window only.
      const duringTraversal=[...longTasksMs];
      longTasksMs.length=0;
      await new Promise(resolve=>setTimeout(resolve,120));
      for(const entry of observer.takeRecords())longTasksMs.push(entry.duration);
      observer.disconnect();
      return{supported:true,elapsedMs,actions,truncated,longTasksMs:duringTraversal,postTraversalLongTasksMs:[...longTasksMs]};
    }));
  }catch(error){
    return{supported:false,elapsedMs:0,actions:0,truncated:false,longTasksMs:[],postTraversalLongTasksMs:[],error:error instanceof Error?error.message:String(error)};
  }
}

/** @param {import('playwright-ax').Page} page */
async function reliability(page){
  for(const method of ['AX full snapshot','Navi execute'])for(const root of ['open','closed']){
    const target=`nested-${root}`,label=`Nested ${root} action`;
    let discovered=0,succeeded=0;
    const failures=[];
    for(let i=0;i<iterations;i++){
      await page.evaluate(()=>document.body.removeAttribute('data-last-action'));
      if(method==='AX full snapshot'){
        const snapshot=await page.accessibility.snapshot({interestingOnly:false});
        if(!hasName(snapshot,label)){failures.push('Not discovered');continue;}discovered++;
        const locator=page.getByRole('button',{name:label,exact:true});
        if(await locator.count()!==1){failures.push('Discovered but native role locator cannot resolve uniquely');continue;}
        await locator.click({timeout:2000});
      }else{
        const snapshot=await bounded(page.evaluate(()=>window.Navi?.actions({limit:5000})));
        if(snapshot?.actions.filter((/** @type {any} */a)=>a.target_id===target).length!==1){failures.push('Not discovered uniquely');continue;}discovered++;
        await bounded(page.evaluate(target=>window.Navi?.execute(target,'click'),target));
      }
      if(await page.evaluate(()=>document.body.getAttribute('data-last-action'))===target)succeeded++;else failures.push('Outcome missing');
    }
    shadowTrials.push({method,root,discovered,succeeded,failures});
  }
}
function rows(){
  let table='| Fixture | Method | Payload KB | Est. tokens | p50 ms | p95 ms | Nested open / closed success |\n|---|---|---:|---:|---:|---:|---|\n';
  for(const fixture of fixtures)for(const method of fixture.methods){
    const navi=method.id.startsWith('navi');
    const trials=shadowTrials.filter(t=>t.method===(navi?'Navi execute':'AX full snapshot'));
    const success=trials.map(t=>`${t.root} ${(t.succeeded/iterations*100).toFixed(0)}%`).join(' / ');
    table+=`| ${fixture.name} | ${method.name} | ${(method.meanBytes/1000).toFixed(2)} | ${method.meanTokens.toFixed(0)} | ${method.p50Ms.toFixed(2)} | ${method.p95Ms.toFixed(2)} | ${success}* |\n`;
  }
  return table+'\n*Separate nested-shadow fixture trials, not measured independently for every latency row.';
}
