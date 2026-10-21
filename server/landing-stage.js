// The interactive 3D stage and its receipt inspector.
//
// Both are pure CSS state machines: radios and checkboxes are the only inputs, and
// every visible change is a `:checked` selector. That is the constraint the page is
// built around — `default-src 'none'` forbids a single line of JavaScript, so
// "interactive" has to mean the browser's own form state. The inspector's pinned
// targets and their JSON live in `landing-inspector.js`; this module is the layout,
// the styles and the structural wiring they bind to.
//
// The art direction follows the page's references: the host page is a bone-white
// slab floating in a black room, the redaction mesh is a sodium-yellow wireframe,
// and the action map is a terminal of yellow monospace on black. No rounded cards,
// no glass — hairlines and one accent.

import { INSPECTOR_TARGETS, renderInspectorPanels } from './landing-inspector.js';

/** Styles scoped to the 3D stage; the inspector and calculator sheets are their own modules. */
export const STAGE_STYLE = `
    .showcase {
      padding: clamp(3.5rem, 8vw, 7rem) 0;
      border-top: 1px solid var(--line);
    }
    .stage-shell {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(21rem, .78fr);
      gap: 0;
      align-items: stretch;
      border: 1px solid var(--line);
      border-bottom: 0;
    }
    @media (max-width: 980px) {
      .stage-shell { grid-template-columns: 1fr; }
    }
    .stage-radio {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; opacity: 0; pointer-events: none;
    }
    .stage-toolbar {
      grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: .5rem .85rem;
      align-items: center; justify-content: space-between; padding: .55rem .75rem;
      border-bottom: 1px solid var(--line); background: var(--bg);
    }
    .seg { display: inline-flex; flex-wrap: wrap; gap: .25rem; align-items: center; }
    .seg-label {
      display: inline-flex; align-items: center; min-height: 30px; min-width: 30px;
      cursor: pointer; user-select: none; touch-action: manipulation;
      font: 500 .6rem/1.2 var(--mono); letter-spacing: .12em; text-transform: uppercase;
      padding: .45rem .65rem; color: var(--muted); border-bottom: 1px solid transparent;
      font-variant-numeric: tabular-nums; transition: color 180ms, border-color 180ms, background 180ms;
    }
    .seg-label:hover { color: var(--fg); }
    #cam-iso:checked ~ .stage-toolbar label[for="cam-iso"],
    #cam-front:checked ~ .stage-toolbar label[for="cam-front"],
    #cam-matrix:checked ~ .stage-toolbar label[for="cam-matrix"],
    #plane-focus-all:checked ~ .stage-toolbar label[for="plane-focus-all"],
    #plane-focus-1:checked ~ .stage-toolbar label[for="plane-focus-1"],
    #plane-focus-2:checked ~ .stage-toolbar label[for="plane-focus-2"],
    #plane-focus-3:checked ~ .stage-toolbar label[for="plane-focus-3"] {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    #cam-iso:focus-visible ~ .stage-toolbar label[for="cam-iso"],
    #cam-front:focus-visible ~ .stage-toolbar label[for="cam-front"],
    #cam-matrix:focus-visible ~ .stage-toolbar label[for="cam-matrix"],
    #plane-focus-all:focus-visible ~ .stage-toolbar label[for="plane-focus-all"],
    #plane-focus-1:focus-visible ~ .stage-toolbar label[for="plane-focus-1"],
    #plane-focus-2:focus-visible ~ .stage-toolbar label[for="plane-focus-2"],
    #plane-focus-3:focus-visible ~ .stage-toolbar label[for="plane-focus-3"],
    #toggle-explode:focus-visible ~ .stage-toolbar label[for="toggle-explode"],
    #toggle-xray:focus-visible ~ .stage-toolbar label[for="toggle-xray"],
    #toggle-ui-drift:focus-visible ~ .stage-toolbar label[for="toggle-ui-drift"] {
      outline: 2px solid #ffd600;
      outline-offset: 2px;
    }
    #toggle-explode:checked ~ .stage-toolbar label[for="toggle-explode"],
    #toggle-xray:checked ~ .stage-toolbar label[for="toggle-xray"] {
      color: var(--accent-ink);
      background: var(--accent);
      border-bottom-color: var(--accent);
    }
    #toggle-ui-drift:checked ~ .stage-toolbar label[for="toggle-ui-drift"] {
      color: var(--accent-ink);
      background: var(--good);
      border-bottom-color: var(--good);
    }
    .stage-viewport {
      position: relative;
      height: clamp(420px, 62vh, 620px);
      --plane-size: clamp(15rem, 68vw, 26rem);
      background:
        radial-gradient(90% 70% at 50% 12%, rgba(242, 240, 234, .13), transparent 62%),
        linear-gradient(180deg, #101010, #070707);
      overflow: hidden;
      perspective: 1200px;
      perspective-origin: 50% 42%;
      contain: paint;
      border-right: 1px solid var(--line);
    }
    @media (max-width: 980px) {
      .stage-viewport { border-right: 0; border-bottom: 1px solid var(--line); height: clamp(380px, 54vh, 470px); }
    }
    .stage-viewport::before {
      content: "";
      position: absolute;
      left: 50%;
      bottom: -26%;
      width: 130%;
      height: 62%;
      transform: translateX(-50%) perspective(680px) rotateX(66deg);
      background-image:
        linear-gradient(rgba(242, 240, 234, .12) 1px, transparent 1px),
        linear-gradient(90deg, rgba(242, 240, 234, .12) 1px, transparent 1px);
      background-size: 54px 54px;
      mask-image: linear-gradient(to top, #000, transparent 82%);
      opacity: .6;
      pointer-events: none;
    }
    .stage-viewport::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 46%;
      width: 40rem;
      height: 40rem;
      margin: -20rem 0 0 -20rem;
      background: radial-gradient(circle, rgba(255, 214, 0, .1), transparent 60%);
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
      transform: rotateX(54deg) rotateZ(-36deg) scale(.9);
      transition: transform 280ms var(--ease);
      will-change: transform;
    }
    #cam-front:checked ~ .stage-viewport .stage-3d {
      transform: rotateX(0deg) rotateZ(0deg) scale(.96);
      --z1: 0px;
      --z2: 6px;
      --z3: 12px;
    }
    #cam-matrix:checked ~ .stage-viewport .stage-3d {
      transform: rotateX(72deg) rotateZ(0deg) scale(.86);
      --z1: 0px;
      --z2: 44px;
      --z3: 88px;
    }
    #toggle-explode:checked ~ .stage-viewport .stage-3d { --depth: 1.85; }
    .stage-tilt {
      position: absolute; inset: 0; transform-style: preserve-3d;
      transition: transform 260ms var(--ease); will-change: transform;
    }
    .tilt-pad {
      position: absolute; right: .75rem; bottom: .75rem; display: grid;
      grid-template-columns: repeat(3, 24px); grid-template-rows: repeat(3, 24px); gap: 3px; z-index: 9;
    }
    .pad-cell {
      min-width: 24px; min-height: 24px; touch-action: manipulation;
      border: 1px solid rgba(242, 240, 234, .24); transition: background .16s, border-color .16s;
    }
    .pad-cell:hover { background: var(--accent); border-color: var(--accent); }
    .stage-shell:has(.pad-1:is(:hover, :active)) .stage-tilt { transform: rotateX(7deg) rotateY(-9deg); }
    .stage-shell:has(.pad-2:is(:hover, :active)) .stage-tilt { transform: rotateX(8deg); }
    .stage-shell:has(.pad-3:is(:hover, :active)) .stage-tilt { transform: rotateX(7deg) rotateY(9deg); }
    .stage-shell:has(.pad-4:is(:hover, :active)) .stage-tilt { transform: rotateY(-10deg); }
    .stage-shell:has(.pad-5:is(:hover, :active)) .stage-tilt { transform: scale(1.02); }
    .stage-shell:has(.pad-6:is(:hover, :active)) .stage-tilt { transform: rotateY(10deg); }
    .stage-shell:has(.pad-7:is(:hover, :active)) .stage-tilt { transform: rotateX(-7deg) rotateY(-9deg); }
    .stage-shell:has(.pad-8:is(:hover, :active)) .stage-tilt { transform: rotateX(-8deg); }
    .stage-shell:has(.pad-9:is(:hover, :active)) .stage-tilt { transform: rotateX(-7deg) rotateY(9deg); }
    .plane {
      position: absolute;
      left: 50%;
      top: 53%;
      width: var(--plane-size);
      height: var(--plane-size);
      margin: calc(var(--plane-size) * -.5) 0 0 calc(var(--plane-size) * -.5);
      transform-style: preserve-3d;
      border: 1px solid rgba(242, 240, 234, .24);
      background: transparent;
      padding: .75rem .85rem;
      transition: transform 280ms var(--ease), opacity 240ms, filter 240ms, box-shadow 240ms;
    }
    .plane-1 {
      z-index: 1;
      transform: translateZ(calc(var(--z1) * var(--depth)));
      background: var(--paper);
      color: var(--accent-ink);
      border-color: var(--paper);
      box-shadow: 0 60px 110px -50px #000;
    }
    /* The two upper planes paint over the host page, so they must not eat its
       pointer events: without this the mesh swallows every click on the controls
       underneath it and only the radios in the toolbar can pin a target. */
    .plane-2 {
      z-index: 2;
      transform: translateZ(calc(var(--z2) * var(--depth)));
      border-color: rgba(255, 214, 0, .42);
      background: rgba(255, 214, 0, .015);
      pointer-events: none;
    }
    .plane-3 {
      z-index: 3;
      transform: translateZ(calc(var(--z3) * var(--depth)));
      border-color: rgba(255, 214, 0, .7);
      background: transparent;
      pointer-events: none;
    }
    /* The front camera reads through the two upper planes. These dim first; the
       plane-focus block below must be able to override them, so it stays later in
       the sheet rather than losing the opacity fight to a tie. */
    #cam-front:checked ~ .stage-viewport .plane-2 { opacity: .3; }
    #cam-front:checked ~ .stage-viewport .plane-3 { opacity: .5; }
    #plane-focus-1:checked ~ .stage-viewport .plane-1 {
      transform: translateZ(calc(var(--z1) * var(--depth) + 34px)) scale(1.03);
      box-shadow: 0 0 0 2px var(--accent), 0 60px 110px -50px #000;
    }
    #plane-focus-1:checked ~ .stage-viewport .plane-2,
    #plane-focus-1:checked ~ .stage-viewport .plane-3 { opacity: .16; }
    #plane-focus-2:checked ~ .stage-viewport .plane-2 {
      opacity: .96;
      transform: translateZ(calc(var(--z2) * var(--depth) + 32px)) scale(1.03);
      border-color: var(--accent);
      box-shadow: 0 0 70px -16px rgba(255, 214, 0, .65), inset 0 0 60px rgba(255, 214, 0, .08);
    }
    #plane-focus-2:checked ~ .stage-viewport .plane-1 { opacity: .22; filter: saturate(.2); }
    #plane-focus-2:checked ~ .stage-viewport .plane-3 { opacity: .16; }
    #plane-focus-3:checked ~ .stage-viewport .plane-3 {
      opacity: 1;
      transform: translateZ(calc(var(--z3) * var(--depth) + 24px)) scale(1.04);
      border-color: var(--accent);
      box-shadow: 0 0 70px -16px rgba(255, 214, 0, .7), inset 0 0 50px rgba(255, 214, 0, .08);
    }
    #plane-focus-3:checked ~ .stage-viewport .plane-1,
    #plane-focus-3:checked ~ .stage-viewport .plane-2 { opacity: .18; }
    #toggle-xray:checked ~ .stage-viewport .plane-1 {
      opacity: .32;
      filter: saturate(.3);
      transform: translateZ(calc(var(--z1) * var(--depth) - 14px));
    }
    #toggle-xray:checked ~ .stage-viewport .plane-2 {
      opacity: .85;
      border-color: var(--accent);
      box-shadow: 0 0 70px -18px rgba(255, 214, 0, .55), inset 0 0 60px rgba(255, 214, 0, .06);
    }
    .plane-tag {
      position: absolute;
      z-index: 2;
      font: 500 .56rem/1.4 var(--mono);
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--muted);
      pointer-events: none;
      font-variant-numeric: tabular-nums;
    }
    .plane-1 .plane-tag { left: .8rem; top: .65rem; color: #3d3c38; }
    .plane-2 .plane-tag { right: .8rem; top: .65rem; text-align: right; }
    .plane-3 .plane-tag { left: .8rem; bottom: .65rem; }
    .plane-tag.neon { color: var(--accent); }
    .plane-tag.accent { color: var(--accent); }
    #cam-front:checked ~ .stage-viewport .plane-2 .plane-tag,
    #cam-front:checked ~ .stage-viewport .plane-3 .plane-tag,
    #cam-front:checked ~ .stage-viewport .hud,
    #cam-front:checked ~ .stage-viewport .budget,
    #cam-front:checked ~ .stage-viewport .wire { opacity: 0; }
    .mock-card { border: 1px solid rgba(16, 16, 16, .22); background: #fff; margin-top: 1.15rem; }
    .mock-bar {
      display: flex;
      align-items: center;
      gap: .3rem;
      padding: .38rem .5rem;
      background: #ebe8e0;
      border-bottom: 1px solid rgba(16, 16, 16, .14);
    }
    .mock-dot { width: .42rem; height: .42rem; border-radius: 50%; background: #b9b6ae; }
    .mock-dot.r { background: #d8a8a0; }
    .mock-dot.y { background: #ddc98a; }
    .mock-dot.g { background: #a8c7a4; }
    .mock-url { margin-left: .35rem; font: .56rem/1.2 var(--mono); color: #3d3c38; }
    .mock-body { padding: .55rem .65rem .6rem; font-variant-numeric: tabular-nums; }
    .mock-title { font-size: .74rem; font-weight: 700; margin: 0 0 .35rem; letter-spacing: -.01em; color: #101010; }
    .drift-badge {
      display: none;
      font: 600 .5rem/1.3 var(--mono);
      color: #143605;
      background: #d7f7b0;
      border: 1px solid #4d8a1c;
      padding: .2rem .35rem;
      margin-bottom: .35rem;
    }
    #toggle-ui-drift:checked ~ .stage-viewport .drift-badge { display: block; }
    .mock-line {
      display: flex;
      justify-content: space-between;
      gap: .5rem;
      font: .6rem/1.5 var(--mono);
      color: #3d3c38;
      margin: 0 0 .42rem;
    }
    .mock-line strong { color: #101010; }
    .mock-field { display: block; cursor: pointer; margin-bottom: .45rem; min-height: 28px; touch-action: manipulation; }
    .mock-label { display: block; font: 600 .52rem/1.5 var(--mono); color: #3d3c38; text-transform: uppercase; letter-spacing: .08em; }
    .mock-input {
      display: block;
      position: relative;
      font: .6rem/1.45 var(--mono);
      color: #242320;
      background: #fff;
      border: 1px solid rgba(16, 16, 16, .28);
      padding: .28rem .4rem;
      transition: border-color 180ms, box-shadow 180ms;
    }
    .mask-badge {
      position: absolute;
      right: .25rem;
      top: -.55rem;
      font: 700 .48rem/1 var(--mono);
      letter-spacing: .06em;
      color: #69160a;
      background: #ffe1da;
      border: 1px solid rgba(105, 22, 10, .45);
      padding: .16rem .26rem;
    }
    .mock-shadow {
      position: relative;
      border: 1px dashed rgba(16, 16, 16, .45);
      padding: .5rem .42rem .4rem;
      margin-bottom: .45rem;
    }
    .mock-shadow-tag {
      position: absolute;
      top: -.48rem;
      left: .35rem;
      font: 600 .5rem/1 var(--mono);
      color: #101010;
      background: var(--paper);
      padding: .12rem .26rem;
      border: 1px solid rgba(16, 16, 16, .3);
    }
    .mock-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      cursor: pointer;
      touch-action: manipulation;
      text-align: center;
      font: 600 .6rem/1.1 var(--mono);
      letter-spacing: .04em;
      padding: .42rem .55rem;
      color: #101010;
      background: #fff;
      border: 1px solid rgba(16, 16, 16, .4);
      transition: transform 220ms var(--ease), box-shadow 220ms, border-color 200ms;
    }
    .mock-btn.primary { color: var(--paper); background: #101010; border-color: #101010; }
    #toggle-ui-drift:checked ~ .stage-viewport .mock-btn.primary {
      transform: translateX(6px);
      border-color: #3f7a14;
      box-shadow: 0 0 0 2px #b7f171;
    }
    .mock-pager {
      display: flex;
      align-items: center;
      gap: .35rem;
      font: .56rem/1.2 var(--mono);
      color: #3d3c38;
      margin-top: .4rem;
    }
    .mock-pager .pager-next {
      margin-left: auto; display: inline-flex; align-items: center; min-height: 26px; min-width: 44px;
      padding: .15rem .35rem; color: #101010; font-weight: 600; cursor: pointer;
      touch-action: manipulation; text-decoration: underline; text-underline-offset: 2px;
    }
    .mesh-grid {
      position: absolute; inset: .55rem; pointer-events: none;
      background-image:
        linear-gradient(rgba(255, 214, 0, .1) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 214, 0, .1) 1px, transparent 1px);
      background-size: 26px 26px;
      mask-image: radial-gradient(80% 80% at 50% 50%, #000 26%, transparent 100%);
    }
    .wire {
      position: absolute; border: 1px solid rgba(255, 214, 0, .85);
      transition: transform 240ms var(--ease), box-shadow 220ms, border-color 200ms;
    }
    .wire i {
      position: absolute; top: -.6rem; left: -1px; font: 500 .48rem/1 var(--mono);
      font-style: normal; letter-spacing: .04em; color: var(--accent); background: #0b0b0b;
      padding: .14rem .24rem; border: 1px solid rgba(255, 214, 0, .35); white-space: nowrap;
    }
    .wire-cta { left: 7%; right: 7%; bottom: 25%; height: 14%; }
    .wire-shadow { left: 11%; right: 31%; bottom: 45%; height: 10%; }
    .wire-pii { left: 7%; right: 7%; top: 32%; height: 9%; }
    .wire-pager { left: 7%; right: 31%; bottom: 7%; height: 7%; }
    .redact-mask {
      position: absolute;
      left: 7%;
      right: 7%;
      top: 32%;
      height: 9%;
      background: repeating-linear-gradient(115deg, rgba(255, 106, 85, .55) 0 5px, rgba(255, 106, 85, .08) 5px 10px);
      pointer-events: none;
    }
    .budget {
      position: absolute;
      right: .8rem;
      bottom: .65rem;
      font: 600 .52rem/1 var(--mono);
      letter-spacing: .1em;
      color: var(--accent-ink);
      background: var(--accent);
      padding: .24rem .38rem;
      font-variant-numeric: tabular-nums;
    }
    .strut {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 1px;
      height: calc(var(--z3) * var(--depth));
      background: linear-gradient(to top, transparent, rgba(255, 214, 0, .7));
      transform: rotateX(-90deg);
      transform-origin: bottom center;
      pointer-events: none;
    }
    .hud {
      position: absolute;
      font: .52rem/1.6 var(--mono);
      color: var(--accent);
      background: rgba(7, 7, 7, .94);
      border: 1px solid rgba(255, 214, 0, .55);
      padding: .3rem .42rem;
      max-width: 88%;
      font-variant-numeric: tabular-nums;
      transition: transform 240ms var(--ease), border-color 200ms;
    }
    .hud code { font-size: .52rem; color: var(--accent); }
    .hud span { display: block; color: var(--muted); }
    .hud-1 { left: 2%; top: 20%; }
    .hud-2 { right: 2%; top: 45%; }
    .hud-3 { left: 4%; bottom: 11%; }
    #toggle-ui-drift:checked ~ .stage-viewport .hud-1 {
      border-color: var(--good);
      transform: translate3d(6px, -2px, 14px);
    }
    .beam {
      position: absolute;
      bottom: -46px;
      width: 1px;
      height: 46px;
      background: linear-gradient(to bottom, rgba(255, 214, 0, .9), transparent);
      animation: pulseDot 2.1s ease-in-out infinite;
      pointer-events: none;
      transition: transform 240ms var(--ease), background 200ms;
    }
    .beam-1 { left: 24%; }
    .beam-2 { left: 52%; animation-delay: .4s; }
    .beam-3 { left: 78%; animation-delay: .8s; }
    #toggle-ui-drift:checked ~ .stage-viewport .beam {
      transform: translateX(6px) scaleY(1.15);
      background: linear-gradient(to bottom, var(--good), transparent);
    }
    #inspect-cta:checked ~ .stage-viewport .t-cta,
    #inspect-shadow:checked ~ .stage-viewport .t-shadow,
    #inspect-pii:checked ~ .stage-viewport .t-pii,
    #inspect-pager:checked ~ .stage-viewport .t-pager,
    .stage-viewport .t-cta:hover,
    .stage-viewport .t-shadow:hover,
    .stage-viewport .t-pii:hover,
    .stage-viewport .t-pager:hover {
      box-shadow: 0 0 0 2px var(--accent), 0 0 36px -6px rgba(255, 214, 0, .8);
      border-color: var(--accent);
    }
    #inspect-cta:checked ~ .stage-viewport .wire-cta,
    #inspect-shadow:checked ~ .stage-viewport .wire-shadow,
    #inspect-pii:checked ~ .stage-viewport .wire-pii,
    #inspect-pager:checked ~ .stage-viewport .wire-pager {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), 0 0 30px -4px rgba(255, 214, 0, .85);
      transform: translateZ(18px);
    }
    /* The drift simulation is the newest state and must win the border colour over
       the pinned-target highlight, so it comes last: the beam re-locking in green is
       the whole point of the toggle. */
    #toggle-ui-drift:checked ~ .stage-viewport .wire-cta {
      transform: translate3d(6px, -2px, 22px);
      border-color: var(--good);
      box-shadow: 0 0 0 2px var(--good), 0 0 34px -4px rgba(183, 241, 113, .85);
    }
`;

/**
 * The interactive stage: three camera presets, four Z-plane focus modes, three
 * depth/drift toggles, a 3x3 tilt sensor, four pinnable targets and the receipt
 * inspector they drive.
 * @returns {string}
 */
export function renderLandingStage() {
  const targetRadios = INSPECTOR_TARGETS.map((target, index) => `      <input class="stage-radio" type="radio" name="inspect-node" id="${target.id}"${index === 0 ? ' checked' : ''}>`).join('\n');
  const panels = renderInspectorPanels();
  return `  <section id="stage" class="showcase">
    <h2>01 — The model</h2>
    <p class="section-title">The page, the mesh and the action map — three planes of one object</p>
    <p class="section-sub">Every control is an <code>&lt;input&gt;</code>. Camera presets rotate the scene, Z-plane isolation solos individual layers, depth and drift toggles simulate live UI mutations and OpenAPI 3.1 synthesis, and pinning a control switches the receipt inspector beside it. The whole stage is CSS <code>transform-style: preserve-3d</code> under <code>default-src 'none'</code>.</p>

    <div class="stage-shell">
      <input class="stage-radio" type="radio" name="camera-view" id="cam-iso" checked>
      <input class="stage-radio" type="radio" name="camera-view" id="cam-front">
      <input class="stage-radio" type="radio" name="camera-view" id="cam-matrix">
      <input class="stage-radio" type="radio" name="stage-plane" id="plane-focus-all" checked>
      <input class="stage-radio" type="radio" name="stage-plane" id="plane-focus-1">
      <input class="stage-radio" type="radio" name="stage-plane" id="plane-focus-2">
      <input class="stage-radio" type="radio" name="stage-plane" id="plane-focus-3">
      <input class="stage-radio" type="checkbox" id="toggle-explode">
      <input class="stage-radio" type="checkbox" id="toggle-xray">
      <input class="stage-radio" type="checkbox" id="toggle-ui-drift">
${targetRadios}

      <div class="stage-toolbar">
        <div class="seg" role="group" aria-label="3D camera preset">
          <label class="seg-label" for="cam-iso">Isometric Exploded</label>
          <label class="seg-label" for="cam-front">Front UI Surface</label>
          <label class="seg-label" for="cam-matrix">Agent Matrix Overhead</label>
        </div>
        <div class="seg" role="group" aria-label="Z-plane isolation">
          <label class="seg-label" for="plane-focus-all">All Planes</label>
          <label class="seg-label" for="plane-focus-1">Plane 1 · Host Page</label>
          <label class="seg-label" for="plane-focus-2">Plane 2 · Crawler Wireframe</label>
          <label class="seg-label" for="plane-focus-3">Plane 3 · Agent HUD</label>
        </div>
        <div class="seg" role="group" aria-label="3D layer and drift toggles">
          <label class="seg-label" for="toggle-explode">Explode Z-Layers</label>
          <label class="seg-label" for="toggle-xray">X-Ray Shadow DOM</label>
          <label class="seg-label" for="toggle-ui-drift">Simulate UI Deploy Drift</label>
        </div>
      </div>

      <div class="stage-viewport" role="group" aria-label="Three-plane 3D model of a checkout page, its Navi redaction mesh, and its deterministic action map">
        <div class="stage-3d">
          <div class="stage-tilt">

            <div class="plane plane-1">
              <span class="plane-tag">01 · Raw host DOM · closed shadow</span>
              <div class="mock-card">
                <div class="mock-bar">
                  <span class="mock-dot r"></span><span class="mock-dot y"></span><span class="mock-dot g"></span>
                  <span class="mock-url">app.example.com/checkout</span>
                </div>
                <div class="mock-body">
                  <p class="mock-title">Order summary</p>
                  <div class="drift-badge">Deploy drift: #btn-pay &rarr; .css-19x-order (healed: true &ge; 0.85)</div>
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
              <span class="plane-tag neon">02 · Navi mesh · translateZ(70px)</span>
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
              <span class="plane-tag accent">03 · Action map · translateZ(140px)</span>
              <span class="hud hud-1"><code>target_id: "act_pay_01"</code><span>role: "button" · healed &ge; 0.85</span></span>
              <span class="hud hud-2"><code>bbox: [412, 288, 140, 44]</code><span>sha384 receipt · OpenAPI 3.1</span></span>
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
        <div class="inspector-head">Live 0.3.0 action-map, drift healing &amp; OpenAPI 3.1 inspector</div>
        <p class="inspector-sub">Pinned target · exact payload, resolveTarget healing &amp; workflow schema</p>
${panels}
        <p class="inspect-hint">Hover or tap any control on the stage, or select a target pin above. Toggle UI Deploy Drift to inspect deterministic target healing and OpenAPI 3.1 workflow synthesis.</p>
      </div>

      <p class="stage-hint">Camera presets: <code>rotateX(54deg) rotateZ(-36deg)</code> exploded · <code>rotateX(0deg)</code> front · <code>rotateX(72deg)</code> overhead. Depth is <code>translateZ(0 / 70 / 140px)</code>, doubled by Explode Z-Layers.</p>
    </div>
  </section>`;
}
