// The landing page's masthead and hero.
//
// Split from `landing-styles.js` so every `server/*.js` stays under the 650-line
// ceiling the release gate enforces. This is the full-viewport opening: the sticky
// top bar, the oversized display headline, the interactive three-plane monogram, and
// the four verified-stat cells that close the fold. Selectors here target only
// markup the hero emits and nothing else on the page may class itself `slab-*` or
// `stat-*`.
//
// Like every string this page emits, the template is a literal with no
// interpolation, because a stylesheet that can interpolate a value can interpolate
// a `</style>`.

/** Styles scoped to the masthead and hero. */
export const LANDING_HERO_STYLE = `
    /* ---------- hero ---------- */
    .hero {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr);
      align-items: center;
      gap: clamp(1.5rem, 4vw, 4rem);
      min-height: calc(100svh - 3.4rem);
      padding: clamp(1.5rem, 3.5vh, 3rem) var(--pad) 0;
      border-bottom: 1px solid var(--line);
      overflow: hidden;
    }
    .hero::after {
      content: "";
      position: absolute;
      left: 50%;
      bottom: -40%;
      width: 120vw;
      height: 70%;
      transform: translateX(-50%) perspective(700px) rotateX(66deg);
      background-image:
        linear-gradient(rgba(242, 240, 234, .09) 1px, transparent 1px),
        linear-gradient(90deg, rgba(242, 240, 234, .09) 1px, transparent 1px);
      background-size: 72px 72px;
      mask-image: linear-gradient(to top, #000, transparent 78%);
      opacity: .55;
      pointer-events: none;
    }
    .hero-copy { position: relative; z-index: 2; padding-bottom: clamp(1rem, 2.5vh, 2rem); }
    .kicker {
      display: inline-flex;
      align-items: center;
      gap: .6rem;
      font: 500 .66rem/1 var(--mono);
      letter-spacing: .2em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0 0 1.4rem;
      font-variant-numeric: tabular-nums;
    }
    .kicker::before {
      content: "";
      width: .45rem;
      height: .45rem;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 .9rem var(--accent);
      animation: pulseDot 2.6s ease-in-out infinite;
    }
    h1 {
      font-size: clamp(2.4rem, 6.2vw, 6.4rem);
      line-height: .92;
      font-weight: 700;
      letter-spacing: -.06em;
      margin: 0 0 1.4rem;
      max-width: 14ch;
      text-wrap: balance;
    }
    h1 em {
      font-style: normal;
      color: var(--accent);
      display: block;
    }
    .lede {
      font-size: clamp(.95rem, 1.1vw, 1.04rem);
      line-height: 1.55;
      color: var(--fg-soft);
      max-width: 34rem;
      margin: 0 0 1.7rem;
      font-variant-numeric: tabular-nums;
    }
    .hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem 1.5rem; margin-bottom: 1.8rem; }
    .cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      min-width: 44px;
      gap: .5rem;
      font: 600 .74rem/1 var(--mono);
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--accent-ink);
      background: var(--accent);
      border: 1px solid var(--accent);
      border-radius: 2px;
      padding: .95rem 1.25rem;
      text-decoration: none;
      touch-action: manipulation;
      transition: background .18s, color .18s, transform .24s var(--ease);
    }
    .cta:hover { background: #fff0a0; transform: translateY(-2px); }
    .cta:focus-visible { background: #fff0a0; outline: 2px solid #ffd600; outline-offset: 2px; }
    .btn-secondary {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      min-width: 44px;
      gap: .45rem;
      font: 500 .74rem/1 var(--mono);
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--fg);
      text-decoration: none;
      padding: .75rem .35rem;
      border-bottom: 1px solid var(--line-strong);
      touch-action: manipulation;
      transition: color .18s, border-color .18s;
    }
    .btn-secondary:hover { color: var(--accent); border-color: var(--accent); }
    .btn-secondary:focus-visible { color: var(--accent); border-color: var(--accent); outline: 2px solid #ffd600; outline-offset: 2px; }
    .hero-object {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: .85rem;
      min-height: clamp(21rem, 46vh, 31rem);
      padding: .5rem 0 1rem;
    }
    .hero-radio {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
      opacity: 0;
      pointer-events: none;
    }
    .hero-scene {
      position: relative;
      display: grid;
      place-items: center;
      width: 100%;
      min-height: clamp(15rem, 32vh, 22rem);
      perspective: 1100px;
      animation: objectFloat 14s ease-in-out infinite;
    }
    .hero-tilt {
      position: relative;
      display: grid;
      place-items: center;
      transform-style: preserve-3d;
      transition: transform 260ms var(--ease);
    }
    .hero-tilt-pad {
      position: absolute;
      inset: 0;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: repeat(3, 1fr);
      z-index: 6;
    }
    .hpad { touch-action: manipulation; }
    .hero-object:has(.hpad-1:is(:hover, :active)) .hero-tilt { transform: rotateX(10deg) rotateY(-12deg); }
    .hero-object:has(.hpad-2:is(:hover, :active)) .hero-tilt { transform: rotateX(12deg); }
    .hero-object:has(.hpad-3:is(:hover, :active)) .hero-tilt { transform: rotateX(10deg) rotateY(12deg); }
    .hero-object:has(.hpad-4:is(:hover, :active)) .hero-tilt { transform: rotateY(-14deg); }
    .hero-object:has(.hpad-5:is(:hover, :active)) .hero-tilt { transform: scale(1.04); }
    .hero-object:has(.hpad-6:is(:hover, :active)) .hero-tilt { transform: rotateY(14deg); }
    .hero-object:has(.hpad-7:is(:hover, :active)) .hero-tilt { transform: rotateX(-10deg) rotateY(-12deg); }
    .hero-object:has(.hpad-8:is(:hover, :active)) .hero-tilt { transform: rotateX(-12deg); }
    .hero-object:has(.hpad-9:is(:hover, :active)) .hero-tilt { transform: rotateX(-10deg) rotateY(12deg); }
    .object-stack {
      position: relative;
      width: clamp(10.5rem, 17vw, 16rem);
      height: clamp(13.5rem, 22vw, 20.5rem);
      --hero-z1: 0px;
      --hero-z2: 70px;
      --hero-z3: 140px;
      transform-style: preserve-3d;
      transform: rotateX(11deg) rotateY(-28deg);
      animation: objectTurn 26s ease-in-out infinite;
      transition: transform 300ms var(--ease);
    }
    .slab {
      position: absolute;
      inset: 0;
      display: flex;
      padding: .6rem .7rem;
      border: 1px solid var(--line-strong);
      background: linear-gradient(155deg, rgba(242, 240, 234, .07), rgba(11, 11, 11, .84));
      transform-style: preserve-3d;
      transition: transform 280ms var(--ease), opacity 240ms var(--ease), border-color 240ms var(--ease), box-shadow 240ms var(--ease);
    }
    /* One label block per plane, anchored top, middle and bottom of the stack.
       The three slabs overlap in projection, so a shared corner puts all three
       labels on the same few pixels at 320px; the stagger is what keeps them
       legible without shrinking the sculpture. */
    .slab-label { display: block; max-width: 100%; }
    .slab-1 .slab-label { align-self: flex-start; }
    .slab-2 .slab-label { align-self: center; }
    .slab-3 .slab-label { align-self: flex-end; }
    .slab-meta {
      display: block;
      font: 600 .56rem/1.4 var(--mono);
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--fg-soft);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .slab-spec {
      display: block;
      font: 400 .52rem/1.5 var(--mono);
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .slab::before {
      content: "";
      position: absolute;
      inset: .4rem;
      border-top: 1px solid var(--line);
      border-left: 1px solid var(--line);
      pointer-events: none;
    }
    .slab-1 { transform: translateZ(var(--hero-z1)); }
    .slab-2 { transform: translateZ(var(--hero-z2)); border-color: rgba(255, 214, 0, .4); }
    .slab-3 { transform: translateZ(var(--hero-z3)); border-color: rgba(255, 214, 0, .78); }
    .slab-3 .slab-meta, .slab-3 .slab-spec { color: var(--accent); }
    #hero-plane-1:checked ~ .hero-scene .object-stack,
    #hero-plane-2:checked ~ .hero-scene .object-stack,
    #hero-plane-3:checked ~ .hero-scene .object-stack {
      animation: none;
      transform: rotateX(8deg) rotateY(-18deg);
    }
    #hero-plane-1:checked ~ .hero-scene .slab-1 {
      transform: translateZ(110px) scale(1.05);
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), 0 24px 60px -16px rgba(255, 214, 0, .45);
    }
    #hero-plane-1:checked ~ .hero-scene .slab-2,
    #hero-plane-1:checked ~ .hero-scene .slab-3 { opacity: .2; transform: translateZ(-20px) scale(.92); }
    #hero-plane-2:checked ~ .hero-scene .slab-2 {
      transform: translateZ(120px) scale(1.05);
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), 0 24px 60px -16px rgba(255, 214, 0, .5);
    }
    #hero-plane-2:checked ~ .hero-scene .slab-1,
    #hero-plane-2:checked ~ .hero-scene .slab-3 { opacity: .2; transform: translateZ(-16px) scale(.92); }
    #hero-plane-3:checked ~ .hero-scene .slab-3 {
      transform: translateZ(140px) scale(1.05);
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), 0 24px 60px -16px rgba(255, 214, 0, .55);
    }
    #hero-plane-3:checked ~ .hero-scene .slab-1,
    #hero-plane-3:checked ~ .hero-scene .slab-2 { opacity: .2; transform: translateZ(-16px) scale(.92); }
    .hero-controls {
      position: relative;
      z-index: 7;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: .35rem;
      max-width: 100%;
    }
    /* Inline-block, not inline-flex: a flex container turns each text run and each
       <code> into its own item and drops the whitespace between them, which printed
       "5.9 kBTREEWALKER". */
    .hero-chip {
      display: inline-block;
      min-height: 32px;
      min-width: 32px;
      padding: .42rem .65rem;
      font: 500 .58rem/1.2 var(--mono);
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--fg-soft);
      background: rgba(17, 17, 16, .92);
      border: 1px solid var(--line-strong);
      cursor: pointer;
      user-select: none;
      touch-action: manipulation;
      font-variant-numeric: tabular-nums;
      transition: color 180ms, background 180ms, border-color 180ms, transform 180ms var(--ease);
    }
    .hero-chip code { font-size: .58rem; color: inherit; }
    .hero-chip:hover { color: var(--fg); border-color: var(--accent); }
    #hero-plane-all:checked ~ .hero-controls label[for="hero-plane-all"],
    #hero-plane-1:checked ~ .hero-controls label[for="hero-plane-1"],
    #hero-plane-2:checked ~ .hero-controls label[for="hero-plane-2"],
    #hero-plane-3:checked ~ .hero-controls label[for="hero-plane-3"] {
      color: var(--accent-ink);
      background: var(--accent);
      border-color: var(--accent);
    }
    #hero-plane-all:focus-visible ~ .hero-controls label[for="hero-plane-all"],
    #hero-plane-1:focus-visible ~ .hero-controls label[for="hero-plane-1"],
    #hero-plane-2:focus-visible ~ .hero-controls label[for="hero-plane-2"],
    #hero-plane-3:focus-visible ~ .hero-controls label[for="hero-plane-3"] {
      outline: 2px solid #ffd600;
      outline-offset: 2px;
    }
    .hero-hud-bar {
      position: relative;
      z-index: 7;
      width: 100%;
      max-width: 28rem;
      border: 1px solid var(--line);
      background: rgba(7, 7, 7, .92);
      padding: .55rem .75rem;
      font: 400 .6rem/1.55 var(--mono);
      color: var(--fg-soft);
      font-variant-numeric: tabular-nums;
    }
    .hero-callout { display: none; margin: 0; }
    .hero-callout strong { color: var(--accent); font-weight: 600; }
    #hero-plane-all:checked ~ .hero-hud-bar .hero-callout-all,
    #hero-plane-1:checked ~ .hero-hud-bar .hero-callout-1,
    #hero-plane-2:checked ~ .hero-hud-bar .hero-callout-2,
    #hero-plane-3:checked ~ .hero-hud-bar .hero-callout-3 { display: block; }
    .orbit {
      position: absolute;
      width: clamp(15rem, 68vw, 25rem);
      height: clamp(15rem, 68vw, 25rem);
      border: 1px dashed rgba(242, 240, 234, .18);
      border-radius: 50%;
      transform: rotateX(74deg);
      pointer-events: none;
    }
    .orbit::after {
      content: "";
      position: absolute;
      top: 50%;
      left: -3px;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 .8rem var(--accent);
    }
    .hero-stats {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0;
      margin-top: clamp(1.2rem, 3vh, 2.2rem);
      border-top: 1px solid var(--line);
    }
    .stat {
      padding: .95rem 1.2rem .95rem 0;
      border-right: 1px solid var(--line);
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
    .stat:last-child { border-right: 0; }
    .stat-value {
      font-size: clamp(1.15rem, 1.6vw, 1.5rem);
      font-weight: 600;
      letter-spacing: -.03em;
      margin: 0 0 .3rem;
      color: var(--fg);
      font-variant-numeric: tabular-nums;
    }
    .stat-label {
      font: 500 .6rem/1.5 var(--mono);
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
`;

/**
 * Render the interactive 3-plane 3D hero monogram with pure-CSS layer isolation
 * and a 3x3 pointer/touch tilt grid.
 * @returns {string}
 */
export function renderHeroMonogram() {
  return `    <div class="hero-object" role="region" aria-label="Interactive 3D three-plane protocol monogram">
      <input class="hero-radio" type="radio" name="hero-plane" id="hero-plane-all" checked>
      <input class="hero-radio" type="radio" name="hero-plane" id="hero-plane-1">
      <input class="hero-radio" type="radio" name="hero-plane" id="hero-plane-2">
      <input class="hero-radio" type="radio" name="hero-plane" id="hero-plane-3">

      <div class="hero-scene">
        <span class="orbit" aria-hidden="true"></span>
        <div class="hero-tilt">
          <div class="object-stack">
            <span class="slab slab-1">
              <span class="slab-label">
                <span class="slab-meta">01 · Host DOM</span>
                <span class="slab-spec">shadow root · iframes</span>
              </span>
            </span>
            <span class="slab slab-2">
              <span class="slab-label">
                <span class="slab-meta">02 · 5.9 kB mesh</span>
                <span class="slab-spec">&le; 2 ms slice · PII mask</span>
              </span>
            </span>
            <span class="slab slab-3">
              <span class="slab-label">
                <span class="slab-meta">03 · 0.3.0 map</span>
                <span class="slab-spec">OpenAPI 3.1 · sha384</span>
              </span>
            </span>
          </div>
        </div>
        <div class="hero-tilt-pad" aria-hidden="true">
          <span class="hpad hpad-1"></span><span class="hpad hpad-2"></span><span class="hpad hpad-3"></span>
          <span class="hpad hpad-4"></span><span class="hpad hpad-5"></span><span class="hpad hpad-6"></span>
          <span class="hpad hpad-7"></span><span class="hpad hpad-8"></span><span class="hpad hpad-9"></span>
        </div>
      </div>

      <div class="hero-controls" role="group" aria-label="Hero 3D layer isolation">
        <label class="hero-chip" for="hero-plane-all">All 3 Planes</label>
        <label class="hero-chip" for="hero-plane-1">Plane 01 · Raw DOM &amp; Shadow Root</label>
        <label class="hero-chip" for="hero-plane-2">Plane 02 · <code>5.9 kB</code> TreeWalker &amp; Redaction Mesh</label>
        <label class="hero-chip" for="hero-plane-3">Plane 03 · <code>0.3.0</code> Action Map &amp; OpenAPI <code>3.1</code></label>
      </div>

      <div class="hero-hud-bar" aria-live="polite">
        <p class="hero-callout hero-callout-all"><strong>All 3 Planes · preserve-3d stack</strong> — Select any plane above or tilt the sculpture to inspect Z-depth translation from live DOM to typed MCP &amp; OpenAPI 3.1 workflows.</p>
        <p class="hero-callout hero-callout-1"><strong>Plane 01 · translateZ(0px)</strong> — Hooks <code>Element.prototype.attachShadow</code> at document start and traverses open/closed Shadow DOM plus same-origin iframes.</p>
        <p class="hero-callout hero-callout-2"><strong>Plane 02 · translateZ(64px)</strong> — <code>5.9 kB</code> gzipped crawler slices traversal into &le; 2 ms frames while redacting sensitive field values before serialization.</p>
        <p class="hero-callout hero-callout-3"><strong>Plane 03 · translateZ(128px)</strong> — Emits deterministic <code>0.3.0</code> action maps, self-healing <code>resolveTarget</code> descriptors, and <code>GET /v1/sitemap/openapi.json</code> schemas.</p>
      </div>
    </div>`;
}
