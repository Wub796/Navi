// The interactive 3D stage and the unit-economics calculator.
//
// Both are pure CSS state machines: radios and checkboxes are the only inputs, and
// every visible change is a `:checked` selector. That is the constraint the page is
// built around — `default-src 'none'` forbids a single line of JavaScript, so
// "interactive" has to mean the browser's own form state.
//
// The stage keeps its stylesheet beside its markup rather than in the page-wide
// design system, because the 3D engine is the part most likely to change and the
// base page should not have to move with it.

/** Styles scoped to the stage, the inspector and the calculator. */
export const STAGE_STYLE = `
    .showcase { padding: 1.1rem 1.3rem 1.4rem; }
    .stage-shell {
      display: grid;
      grid-template-columns: minmax(0, 1.32fr) minmax(17rem, .88fr);
      gap: 1rem;
      align-items: start;
    }
    @media (max-width: 920px) {
      .stage-shell { grid-template-columns: 1fr; }
    }
    .stage-radio {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }
    .stage-toolbar {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      gap: .6rem;
      align-items: center;
      justify-content: space-between;
    }
    .seg {
      display: inline-flex;
      flex-wrap: wrap;
      gap: .3rem;
      padding: .28rem;
      border-radius: 999px;
      background: rgba(5, 8, 13, .8);
      border: 1px solid var(--border);
    }
    .seg-label {
      cursor: pointer;
      user-select: none;
      font: 650 .72rem/1 var(--mono);
      padding: .5rem .78rem;
      border-radius: 999px;
      color: var(--text-secondary);
      border: 1px solid transparent;
      transition: color .18s, background .18s, border-color .18s;
    }
    .seg-label:hover { color: var(--text); background: rgba(255, 255, 255, .05); }
    #cam-iso:checked ~ .stage-toolbar label[for="cam-iso"],
    #cam-front:checked ~ .stage-toolbar label[for="cam-front"],
    #cam-matrix:checked ~ .stage-toolbar label[for="cam-matrix"] {
      color: #04121a;
      background: linear-gradient(135deg, var(--neon), #7dd3fc);
      border-color: transparent;
      box-shadow: 0 8px 22px -10px rgba(34, 211, 238, .9);
    }
    #cam-iso:focus-visible ~ .stage-toolbar label[for="cam-iso"],
    #cam-front:focus-visible ~ .stage-toolbar label[for="cam-front"],
    #cam-matrix:focus-visible ~ .stage-toolbar label[for="cam-matrix"],
    #toggle-explode:focus-visible ~ .stage-toolbar label[for="toggle-explode"],
    #toggle-xray:focus-visible ~ .stage-toolbar label[for="toggle-xray"] {
      outline: 2px solid var(--neon);
      outline-offset: 2px;
    }
    #toggle-explode:checked ~ .stage-toolbar label[for="toggle-explode"],
    #toggle-xray:checked ~ .stage-toolbar label[for="toggle-xray"] {
      color: var(--neon);
      background: var(--neon-soft);
      border-color: rgba(34, 211, 238, .45);
    }
    .stage-viewport {
      position: relative;
      height: 470px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background:
        radial-gradient(120% 90% at 50% 0%, rgba(76, 134, 255, .16), transparent 62%),
        linear-gradient(180deg, rgba(8, 11, 18, .97), rgba(3, 5, 9, .99));
      overflow: hidden;
      perspective: 1200px;
      perspective-origin: 50% 42%;
      contain: paint;
    }
    .stage-viewport::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 58%;
      width: 34rem;
      height: 34rem;
      margin: -17rem 0 0 -17rem;
      background: radial-gradient(circle, rgba(34, 211, 238, .18), transparent 62%);
      filter: blur(6px);
      pointer-events: none;
    }
    .stage-3d {
      position: absolute;
      inset: 0;
      transform-style: preserve-3d;
      --depth: 1;
      --z1: 0px;
      --z2: 70px;
      --z3: 140px;
      transform: rotateX(54deg) rotateZ(-36deg) scale(.72);
      transition: transform 900ms var(--ease-spatial);
      will-change: transform;
    }
    #cam-front:checked ~ .stage-viewport .stage-3d {
      transform: rotateX(0deg) rotateZ(0deg) scale(.9);
      --z1: 0px;
      --z2: 5px;
      --z3: 10px;
    }
    #cam-matrix:checked ~ .stage-viewport .stage-3d {
      transform: rotateX(72deg) rotateZ(0deg) scale(.74);
      --z1: 0px;
      --z2: 44px;
      --z3: 88px;
    }
    #toggle-explode:checked ~ .stage-viewport .stage-3d { --depth: 1.85; }
    .stage-tilt {
      position: absolute;
      inset: 0;
      transform-style: preserve-3d;
      transition: transform 460ms var(--ease-spatial);
      will-change: transform;
    }
    /* The 3x3 tilt sensor: each cell is a real hover target that nudges the whole
       scene, which is what makes the stack feel like an object and not a picture. */
    .tilt-pad {
      position: absolute;
      right: .7rem;
      bottom: .7rem;
      display: grid;
      grid-template-columns: repeat(3, 1.15rem);
      grid-template-rows: repeat(3, 1.15rem);
      gap: .18rem;
      z-index: 9;
    }
    .pad-cell {
      border-radius: 4px;
      background: rgba(126, 148, 188, .16);
      border: 1px solid rgba(126, 148, 188, .22);
      transition: background .16s, box-shadow .16s;
    }
    .pad-cell:hover { background: var(--neon); box-shadow: 0 0 12px rgba(34, 211, 238, .8); }
    .stage-shell:has(.pad-1:hover) .stage-tilt { transform: rotateX(7deg) rotateY(-9deg); }
    .stage-shell:has(.pad-2:hover) .stage-tilt { transform: rotateX(8deg); }
    .stage-shell:has(.pad-3:hover) .stage-tilt { transform: rotateX(7deg) rotateY(9deg); }
    .stage-shell:has(.pad-4:hover) .stage-tilt { transform: rotateY(-10deg); }
    .stage-shell:has(.pad-5:hover) .stage-tilt { transform: scale(1.02); }
    .stage-shell:has(.pad-6:hover) .stage-tilt { transform: rotateY(10deg); }
    .stage-shell:has(.pad-7:hover) .stage-tilt { transform: rotateX(-7deg) rotateY(-9deg); }
    .stage-shell:has(.pad-8:hover) .stage-tilt { transform: rotateX(-8deg); }
    .stage-shell:has(.pad-9:hover) .stage-tilt { transform: rotateX(-7deg) rotateY(9deg); }
    .plane {
      position: absolute;
      left: 50%;
      top: 56%;
      width: 19.5rem;
      height: 19.5rem;
      margin: -9.75rem 0 0 -9.75rem;
      transform-style: preserve-3d;
      border-radius: 14px;
      border: 1px solid rgba(126, 148, 188, .22);
      background: linear-gradient(160deg, rgba(21, 29, 42, .96), rgba(8, 12, 19, .97));
      box-shadow: 0 44px 90px -44px #000, inset 0 1px 0 rgba(255, 255, 255, .05);
      padding: .7rem .8rem;
      transition: transform 760ms var(--ease-spatial), opacity .4s, filter .4s, box-shadow .4s;
    }
    .plane-1 { z-index: 1; transform: translateZ(calc(var(--z1) * var(--depth))); }
    .plane-2 {
      z-index: 2;
      background: rgba(34, 211, 238, .035);
      border-color: rgba(34, 211, 238, .4);
      box-shadow: inset 0 0 50px rgba(34, 211, 238, .1);
      transform: translateZ(calc(var(--z2) * var(--depth)));
    }
    .plane-3 {
      z-index: 3;
      background: transparent;
      border-color: rgba(76, 134, 255, .45);
      box-shadow: none;
      transform: translateZ(calc(var(--z3) * var(--depth)));
    }
    #toggle-xray:checked ~ .stage-viewport .plane-1 {
      opacity: .4;
      filter: saturate(.5);
      transform: translateZ(calc(var(--z1) * var(--depth) - 14px));
    }
    #toggle-xray:checked ~ .stage-viewport .plane-2 {
      border-color: var(--neon);
      opacity: .82;
      box-shadow: inset 0 0 70px rgba(34, 211, 238, .18), 0 0 46px -14px rgba(34, 211, 238, .7);
    }
    .plane-tag {
      display: block;
      font: 650 .56rem/1.4 var(--mono);
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: .5rem;
    }
    .plane-tag.neon { color: var(--neon); }
    .plane-tag.accent { color: var(--accent-hover); }
    .mock-card {
      border-radius: 10px;
      border: 1px solid var(--border);
      background: rgba(4, 7, 12, .92);
      overflow: hidden;
    }
    .mock-bar {
      display: flex;
      align-items: center;
      gap: .3rem;
      padding: .4rem .5rem;
      background: rgba(255, 255, 255, .03);
      border-bottom: 1px solid var(--border);
    }
    .mock-dot { width: .44rem; height: .44rem; border-radius: 50%; background: #334155; }
    .mock-dot.r { background: #7f1d1d; }
    .mock-dot.y { background: #78350f; }
    .mock-dot.g { background: #14532d; }
    .mock-url { margin-left: .35rem; font: .58rem/1 var(--mono); color: var(--muted); }
    .mock-body { padding: .65rem .7rem .7rem; }
    .mock-title { font-size: .74rem; font-weight: 700; margin: 0 0 .45rem; letter-spacing: .01em; }
    .mock-line {
      display: flex;
      justify-content: space-between;
      gap: .5rem;
      font: .62rem/1.6 var(--mono);
      color: var(--text-secondary);
      margin: 0 0 .5rem;
    }
    .mock-line strong { color: var(--text); }
    .mock-field { display: block; cursor: pointer; margin-bottom: .5rem; }
    .mock-label { display: block; font: .55rem/1.6 var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .07em; }
    .mock-input {
      display: block;
      position: relative;
      font: .62rem/1.5 var(--mono);
      color: var(--text-secondary);
      background: rgba(255, 255, 255, .035);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: .32rem .42rem;
      transition: border-color .2s, box-shadow .2s;
    }
    .mask-badge {
      position: absolute;
      right: .25rem;
      top: -.62rem;
      font: 700 .5rem/1 var(--mono);
      letter-spacing: .06em;
      color: var(--bad);
      background: var(--bad-soft);
      border: 1px solid rgba(251, 113, 133, .4);
      border-radius: 4px;
      padding: .2rem .3rem;
    }
    .mock-shadow {
      position: relative;
      border: 1px dashed rgba(34, 211, 238, .4);
      border-radius: 8px;
      padding: .6rem .45rem .45rem;
      margin-bottom: .5rem;
    }
    .mock-shadow-tag {
      position: absolute;
      top: -.55rem;
      left: .35rem;
      font: 650 .5rem/1 var(--mono);
      color: var(--neon);
      background: #0a1018;
      padding: .15rem .3rem;
      border-radius: 4px;
    }
    .mock-btn {
      display: block;
      cursor: pointer;
      text-align: center;
      font: 700 .64rem/1 var(--mono);
      border-radius: 7px;
      padding: .5rem .6rem;
      color: var(--text);
      background: rgba(255, 255, 255, .05);
      border: 1px solid var(--border-strong);
      transition: transform .22s var(--ease-spatial), box-shadow .22s, border-color .2s;
    }
    .mock-btn.primary {
      color: #fff;
      background: linear-gradient(135deg, var(--accent), #3f6fe0);
      border-color: transparent;
    }
    .mock-pager {
      display: flex;
      align-items: center;
      gap: .35rem;
      font: .58rem/1 var(--mono);
      color: var(--muted);
      margin-top: .55rem;
    }
    .mock-pager .pager-next { margin-left: auto; color: var(--neon); }
    .mesh-grid {
      position: absolute;
      inset: .55rem;
      background-image:
        linear-gradient(rgba(34, 211, 238, .14) 1px, transparent 1px),
        linear-gradient(90deg, rgba(34, 211, 238, .14) 1px, transparent 1px);
      background-size: 22px 22px;
      border-radius: 8px;
      pointer-events: none;
      mask-image: radial-gradient(80% 80% at 50% 50%, #000 30%, transparent 100%);
    }
    .wire {
      position: absolute;
      border: 1.5px solid rgba(34, 211, 238, .85);
      border-radius: 6px;
      box-shadow: 0 0 16px -2px rgba(34, 211, 238, .55), inset 0 0 14px rgba(34, 211, 238, .1);
      transition: transform .22s var(--ease-spatial), box-shadow .22s, border-color .2s;
    }
    .wire i {
      position: absolute;
      top: -.62rem;
      left: 0;
      font: 650 .46rem/1 var(--mono);
      font-style: normal;
      color: var(--neon);
      background: #081018;
      padding: .14rem .24rem;
      border-radius: 3px;
      white-space: nowrap;
    }
    .wire-cta { left: 8%; right: 8%; bottom: 26%; height: 15%; }
    .wire-shadow { left: 12%; right: 30%; bottom: 46%; height: 11%; }
    .wire-pii { left: 8%; right: 8%; top: 33%; height: 10%; }
    .wire-pager { left: 8%; right: 30%; bottom: 8%; height: 8%; }
    .redact-mask {
      position: absolute;
      left: 8%;
      right: 8%;
      top: 33%;
      height: 10%;
      background: repeating-linear-gradient(115deg, rgba(251, 113, 133, .34) 0 6px, rgba(251, 113, 133, .08) 6px 12px);
      border-radius: 6px;
      pointer-events: none;
    }
    .budget {
      position: absolute;
      right: .7rem;
      top: .7rem;
      font: 700 .52rem/1 var(--mono);
      color: var(--good);
      background: var(--good-soft);
      border: 1px solid rgba(52, 211, 153, .35);
      border-radius: 999px;
      padding: .24rem .4rem;
    }
    .strut {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 1px;
      height: calc(var(--z3) * var(--depth));
      background: linear-gradient(to top, transparent, rgba(34, 211, 238, .75));
      transform: rotateX(-90deg);
      transform-origin: bottom center;
      pointer-events: none;
    }
    .hud {
      position: absolute;
      font: .52rem/1.6 var(--mono);
      color: var(--text);
      background: rgba(6, 11, 19, .92);
      border: 1px solid rgba(76, 134, 255, .5);
      border-radius: 7px;
      padding: .34rem .45rem;
      box-shadow: 0 0 26px -8px rgba(76, 134, 255, .8);
      white-space: nowrap;
    }
    .hud code { font-size: .52rem; color: var(--neon); }
    .hud span { display: block; color: var(--muted); }
    .hud-1 { left: 4%; top: 24%; }
    .hud-2 { right: 2%; top: 47%; }
    .hud-3 { left: 8%; bottom: 12%; }
    .beam {
      position: absolute;
      bottom: -46px;
      width: 2px;
      height: 46px;
      background: linear-gradient(to bottom, rgba(34, 211, 238, .95), transparent);
      box-shadow: 0 0 12px rgba(34, 211, 238, .9);
      animation: pulseDot 2.1s ease-in-out infinite;
      pointer-events: none;
    }
    .beam-1 { left: 24%; }
    .beam-2 { left: 52%; animation-delay: .4s; }
    .beam-3 { left: 78%; animation-delay: .8s; }
    /* Linked target state: pin a radio or hover a control and the same element is
       elevated on every plane while its receipt takes the inspector. */
    #inspect-cta:checked ~ .stage-viewport .t-cta,
    #inspect-shadow:checked ~ .stage-viewport .t-shadow,
    #inspect-pii:checked ~ .stage-viewport .t-pii,
    #inspect-pager:checked ~ .stage-viewport .t-pager,
    .stage-viewport .t-cta:hover,
    .stage-viewport .t-shadow:hover,
    .stage-viewport .t-pii:hover,
    .stage-viewport .t-pager:hover {
      transform: translateZ(28px);
      border-color: var(--neon);
      box-shadow: 0 0 0 2px var(--neon), 0 0 34px -4px rgba(34, 211, 238, .85);
    }
    #inspect-cta:checked ~ .stage-viewport .wire-cta,
    #inspect-shadow:checked ~ .stage-viewport .wire-shadow,
    #inspect-pii:checked ~ .stage-viewport .wire-pii,
    #inspect-pager:checked ~ .stage-viewport .wire-pager {
      border-color: var(--good);
      box-shadow: 0 0 0 2px var(--good), 0 0 30px -4px rgba(52, 211, 153, .8);
      transform: translateZ(18px);
    }
    .inspector {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: linear-gradient(170deg, rgba(9, 14, 22, .94), rgba(4, 6, 11, .97));
      padding: .9rem .95rem 1rem;
      min-height: 470px;
      backdrop-filter: blur(16px);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .05);
    }
    .inspector-head {
      font: 700 .64rem/1.5 var(--mono);
      letter-spacing: .09em;
      text-transform: uppercase;
      color: var(--neon);
      padding-bottom: .55rem;
      margin-bottom: .55rem;
      border-bottom: 1px solid var(--border);
    }
    .inspector-sub { font: .6rem/1.6 var(--mono); color: var(--muted); margin: 0 0 .6rem; }
    .inspect-panel { display: none; }
    .stage-shell:has([id="inspect-cta"]:checked) .panel-cta,
    .stage-shell:has([id="inspect-shadow"]:checked) .panel-shadow,
    .stage-shell:has([id="inspect-pii"]:checked) .panel-pii,
    .stage-shell:has([id="inspect-pager"]:checked) .panel-pager {
      display: block;
      animation: hudRise .3s var(--ease-spatial) both;
    }
    .stage-shell:has(.t-cta:hover, .wire-cta:hover) .inspect-panel,
    .stage-shell:has(.t-shadow:hover, .wire-shadow:hover) .inspect-panel,
    .stage-shell:has(.t-pii:hover, .wire-pii:hover) .inspect-panel,
    .stage-shell:has(.t-pager:hover, .wire-pager:hover) .inspect-panel { display: none; }
    .stage-shell:has(.t-cta:hover, .wire-cta:hover) .panel-cta,
    .stage-shell:has(.t-shadow:hover, .wire-shadow:hover) .panel-shadow,
    .stage-shell:has(.t-pii:hover, .wire-pii:hover) .panel-pii,
    .stage-shell:has(.t-pager:hover, .wire-pager:hover) .panel-pager { display: block; }
    .inspect-title { font-size: .86rem; margin: 0 0 .1rem; }
    .inspect-meta { font: .58rem/1.6 var(--mono); color: var(--muted); margin: 0 0 .55rem; }
    .inspect-json {
      font: .56rem/1.62 var(--mono);
      color: var(--text-secondary);
      background: rgba(2, 5, 9, .9);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: .6rem .65rem;
      margin: 0 0 .55rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .inspect-json b { color: var(--neon); font-weight: 600; }
    .inspect-call {
      font: .56rem/1.7 var(--mono);
      color: var(--good);
      background: rgba(52, 211, 153, .07);
      border: 1px solid rgba(52, 211, 153, .3);
      border-radius: 8px;
      padding: .45rem .55rem;
      margin: 0;
      overflow-wrap: anywhere;
    }
    .inspect-hint { font: .56rem/1.6 var(--mono); color: var(--muted); margin: .5rem 0 0; }
    .stage-hint { font: .62rem/1.6 var(--mono); color: var(--muted); margin: .75rem 0 0; grid-column: 1 / -1; }
    .calc { margin-top: .25rem; }
    .calc-switch { display: inline-flex; flex-wrap: wrap; gap: .3rem; padding: .28rem; border-radius: 999px; background: rgba(5, 8, 13, .8); border: 1px solid var(--border); margin-bottom: 1rem; }
    #vol-1k:checked ~ .calc-switch label[for="vol-1k"],
    #vol-50k:checked ~ .calc-switch label[for="vol-50k"],
    #vol-250k:checked ~ .calc-switch label[for="vol-250k"] {
      color: #04121a;
      background: linear-gradient(135deg, var(--neon), #7dd3fc);
      border-color: transparent;
    }
    #vol-1k:focus-visible ~ .calc-switch label[for="vol-1k"],
    #vol-50k:focus-visible ~ .calc-switch label[for="vol-50k"],
    #vol-250k:focus-visible ~ .calc-switch label[for="vol-250k"] { outline: 2px solid var(--neon); outline-offset: 2px; }
    .calc-panel { display: none; }
    #vol-1k:checked ~ #calc-1k,
    #vol-50k:checked ~ #calc-50k,
    #vol-250k:checked ~ #calc-250k { display: block; animation: hudRise .3s var(--ease-spatial) both; }
    .calc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .9rem; }
    .calc-col { border: 1px solid var(--border); border-radius: 12px; padding: .95rem 1rem; background: rgba(5, 8, 13, .72); }
    .calc-col.good { border-color: rgba(52, 211, 153, .38); box-shadow: inset 0 0 60px rgba(52, 211, 153, .07); }
    .calc-line { display: flex; justify-content: space-between; gap: 1rem; font: .74rem/1.8 var(--mono); color: var(--text-secondary); margin: 0; }
    .calc-line strong { color: var(--text); font-weight: 650; }
    .calc-total { font: 750 1.55rem/1.2 var(--mono); margin: .6rem 0 0; color: var(--text); }
    .calc-total span { display: block; font: 500 .66rem/1.6 var(--mono); color: var(--muted); margin-top: .25rem; }
    .calc-save { font: 700 .78rem/1.5 var(--mono); color: var(--good); margin: .55rem 0 0; }
    .calc-note { font-size: .78rem; color: var(--muted); margin: .55rem 0 0; }
    .calc-foot { font-size: .78rem; color: var(--muted); margin: 1rem 0 0; max-width: 52rem; }
    @media (prefers-reduced-motion: reduce) {
      .stage-tilt, .plane, .stage-3d, .wire, .mock-btn, .seg-label { transition: none; }
      .beam, .stage-viewport::before { animation: none; }
    }
`;

/** The four simulated controls the inspector can pin, in reading order. */
const TARGETS = [
  {
    id: 'inspect-cta',
    panel: 'panel-cta',
    label: 'Primary Checkout CTA',
    json: `{
  "target_id": "act_pay_01",
  "role": "button",
  "name": "Complete order",
  "bbox": [412, 288, 140, 44],
  "fingerprint": "6b1f9a4c",
  "state": { "visible": true, "enabled": true, "inViewport": true },
  "root": "host"
}`,
    call: `navi_act({ target: "act_pay_01" })
→ { "settled": true, "elapsedMs": 1.7, "sha384": "8f3c…c19a" }`,
  },
  {
    id: 'inspect-shadow',
    panel: 'panel-shadow',
    label: 'Closed Shadow DOM Button',
    json: `{
  "target_id": "act_shadow_02",
  "role": "button",
  "name": "Pay $49.00",
  "bbox": [286, 340, 120, 38],
  "fingerprint": "d42e07b1",
  "root": "#shadow-root (closed)",
  "pierceDepth": 1,
  "state": { "visible": true, "enabled": true, "inViewport": true }
}`,
    call: `navi_act({ target: "act_shadow_02" })
→ { "settled": true, "elapsedMs": 1.9, "sha384": "41ad…7e02" }`,
  },
  {
    id: 'inspect-pii',
    panel: 'panel-pii',
    label: 'Redacted PII Card Input',
    json: `{
  "target_id": "act_pii_03",
  "role": "textbox",
  "name": "Card number",
  "bbox": [188, 214, 320, 36],
  "fingerprint": "a90c5d33",
  "value": "[REDACTED]",
  "redaction": { "rule": "payment-card", "masked": true },
  "state": { "visible": true, "enabled": true, "inViewport": true }
}`,
    call: `navi_get_actions({ scope: "act_pii_03" })
→ value is [REDACTED] before it ever leaves the page`,
  },
  {
    id: 'inspect-pager',
    panel: 'panel-pager',
    label: 'Async Pagination Trigger',
    json: `{
  "target_id": "act_pager_04",
  "role": "button",
  "name": "Next",
  "bbox": [504, 512, 64, 32],
  "fingerprint": "2f81b6de",
  "async": { "settle": "mutation", "budgetMs": 2 },
  "state": { "visible": true, "enabled": true, "inViewport": false }
}`,
    call: `navi_act({ target: "act_pager_04", wait: "mutation_settle" })
→ { "settled": true, "mutations": 3, "sha384": "c7be…90f3" }`,
  },
];

/**
 * The interactive stage: three camera presets, two depth toggles, a 3x3 tilt
 * sensor, four pinnable targets and the receipt inspector they drive.
 * @returns {string}
 */
export function renderLandingStage() {
  const targetRadios = TARGETS.map((target, index) => `      <input class="stage-radio" type="radio" name="inspect-node" id="${target.id}"${index === 0 ? ' checked' : ''}>`).join('\n');
  const panels = TARGETS.map(target => `        <article class="inspect-panel ${target.panel}">
          <h3 class="inspect-title">${target.label}</h3>
          <p class="inspect-meta">deterministic fingerprint · sha384 settlement receipt</p>
          <pre class="inspect-json">${target.json}</pre>
          <pre class="inspect-call">${target.call}</pre>
        </article>`).join('\n');
  return `  <section id="stage" class="showcase">
    <h2>Live spatial preview · zero JavaScript</h2>
    <p class="section-title">The page, the mesh, and the action map — as three planes of one object</p>
    <p class="section-sub">Every control below is an <code>&lt;input&gt;</code>. Camera presets rotate the scene, the depth toggles separate the stack, and pinning a control on Plane 1 switches the receipt inspector beside it. The whole stage is CSS <code>transform-style: preserve-3d</code> under <code>default-src 'none'</code>.</p>

    <div class="stage-shell">
      <input class="stage-radio" type="radio" name="camera-view" id="cam-iso" checked>
      <input class="stage-radio" type="radio" name="camera-view" id="cam-front">
      <input class="stage-radio" type="radio" name="camera-view" id="cam-matrix">
      <input class="stage-radio" type="checkbox" id="toggle-explode">
      <input class="stage-radio" type="checkbox" id="toggle-xray">
${targetRadios}

      <div class="stage-toolbar">
        <div class="seg" role="group" aria-label="3D camera preset">
          <label class="seg-label" for="cam-iso">Isometric Exploded</label>
          <label class="seg-label" for="cam-front">Front UI Surface</label>
          <label class="seg-label" for="cam-matrix">Agent Matrix Overhead</label>
        </div>
        <div class="seg" role="group" aria-label="3D layer toggles">
          <label class="seg-label" for="toggle-explode">Explode Z-Layers</label>
          <label class="seg-label" for="toggle-xray">X-Ray Shadow DOM</label>
        </div>
      </div>

      <div class="stage-viewport" role="img" aria-label="Three-plane 3D model of a checkout page, its Navi redaction mesh, and its deterministic action map">
        <div class="stage-3d">
          <div class="stage-tilt">

            <div class="plane plane-1">
              <span class="plane-tag">Plane 1 · raw host DOM + closed shadow root · translateZ(0px)</span>
              <div class="mock-card">
                <div class="mock-bar">
                  <span class="mock-dot r"></span><span class="mock-dot y"></span><span class="mock-dot g"></span>
                  <span class="mock-url">app.example.com/checkout</span>
                </div>
                <div class="mock-body">
                  <p class="mock-title">Order summary</p>
                  <div class="mock-line"><span>Pro plan · monthly</span><strong>$49.00</strong></div>
                  <label class="t-pii mock-field" for="inspect-pii">
                    <span class="mock-label">Card number</span>
                    <span class="mock-input">•••• •••• •••• 4242<span class="mask-badge">[REDACTED]</span></span>
                  </label>
                  <div class="mock-shadow">
                    <span class="mock-shadow-tag">#shadow-root (closed)</span>
                    <label class="t-shadow mock-btn" for="inspect-shadow">Pay $49.00</label>
                  </div>
                  <label class="t-cta mock-btn primary" for="inspect-cta">Complete order</label>
                  <div class="mock-pager t-pager" id="pager-row">
                    <span>Rows 1–20</span>
                    <label class="pager-next" for="inspect-pager">Next &rsaquo;</label>
                  </div>
                </div>
              </div>
            </div>

            <div class="plane plane-2">
              <span class="plane-tag neon">Plane 2 · Navi TreeWalker &amp; redaction mesh · translateZ(70px)</span>
              <div class="mesh-grid"></div>
              <span class="budget">&le; 2 ms slice</span>
              <span class="wire wire-cta"><i>act_pay_01</i></span>
              <span class="wire wire-shadow"><i>act_shadow_02</i></span>
              <span class="wire wire-pii"></span>
              <span class="redact-mask"></span>
              <span class="wire wire-pager"><i>act_pager_04</i></span>
              <span class="strut" aria-hidden="true"></span>
            </div>

            <div class="plane plane-3">
              <span class="plane-tag accent">Plane 3 · deterministic 0.3.0 action map · translateZ(140px)</span>
              <span class="hud hud-1"><code>target_id: "act_pay_01"</code><span>role: "button"</span></span>
              <span class="hud hud-2"><code>bbox: [412, 288, 140, 44]</code><span>sha384 receipt</span></span>
              <span class="hud hud-3"><code>root: "closed"</code><span>pierceDepth: 1</span></span>
              <span class="beam beam-1" aria-hidden="true"></span>
              <span class="beam beam-2" aria-hidden="true"></span>
              <span class="beam beam-3" aria-hidden="true"></span>
            </div>

          </div>
        </div>
        <div class="tilt-pad" aria-hidden="true">
          <span class="pad-cell pad-1"></span><span class="pad-cell pad-2"></span><span class="pad-cell pad-3"></span>
          <span class="pad-cell pad-4"></span><span class="pad-cell pad-5"></span><span class="pad-cell pad-6"></span>
          <span class="pad-cell pad-7"></span><span class="pad-cell pad-8"></span><span class="pad-cell pad-9"></span>
        </div>
      </div>

      <div class="inspector">
        <div class="inspector-head">Live 0.3.0 action-map &amp; settlement receipt inspector</div>
        <p class="inspector-sub">Pinned target · the exact payload the agent reads</p>
${panels}
        <p class="inspect-hint">Hover any control on the stage, or click it to pin it. Reset with Front UI Surface to see the same element collapsed into a normal viewport.</p>
      </div>

      <p class="stage-hint">Camera presets: <code>rotateX(54deg) rotateZ(-36deg)</code> exploded · <code>rotateX(0deg)</code> front · <code>rotateX(72deg)</code> overhead. Depth is <code>translateZ(0 / 70 / 140px)</code>, doubled by Explode Z-Layers.</p>
    </div>
  </section>`;
}
