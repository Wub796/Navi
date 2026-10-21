// The landing page's responsive and reduced-motion sheets.
//
// Split from `landing-styles.js` so that every `server/*.js` module stays under the
// 650-line structural ceiling the release gate enforces; the base design system and
// these overrides are one stylesheet and are concatenated in
// `renderLandingPage`. No selector here introduces a new component: each targets a
// class the base sheet already defines, so the two cannot drift apart silently.
//
// Like every string this page emits, the templates are literals with no
// interpolation, because a stylesheet that can interpolate a value can interpolate
// a `</style>`.

/** Narrow-viewport reflow and fluid 3D scaling from 320px to 2560px. */
const RESPONSIVE_STYLE = `
    @media (max-width: 1080px) {
      .tiers { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .tiers > section:nth-child(2) { border-right: 0; }
      .tiers > section:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
    }
    @media (max-width: 860px) {
      .topbar { gap: .75rem 1rem; padding: .75rem var(--pad); }
      .topnav { gap: .35rem .75rem; }
      .topnav a { min-height: 44px; padding: .5rem .35rem; }
      .hero { grid-template-columns: 1fr; align-items: start; min-height: auto; padding-top: 1.75rem; }
      .hero-object { order: -1; min-height: auto; padding-bottom: .5rem; }
      .hero-copy { padding-bottom: 1.25rem; }
      .hero-chip, .seg-label, .pin-chip, .drift-switch, .tab-label, .pager-next {
        min-height: 44px;
        padding-top: .6rem;
        padding-bottom: .6rem;
      }
      .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 1.5rem; }
      .stat:nth-child(2) { border-right: 0; }
      .compare { grid-template-columns: 1fr; }
      .compare > section { border-right: 0; border-bottom: 1px solid var(--line); }
      .pillars, .steps-3 { grid-template-columns: 1fr; }
      .pillars > section, .step { border-right: 0; border-bottom: 1px solid var(--line); padding: 1.4rem 0; }
      .pillars > section:last-child, .step:last-child { border-bottom: 0; }
      .tiers { grid-template-columns: 1fr; }
      .tiers > section { border-right: 0; border-bottom: 1px solid var(--line); min-height: 0; padding-right: 0; }
      .tiers > section:last-child { border-bottom: 0; }
      .savings-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      .hero-stats { grid-template-columns: 1fr; }
      .stat { border-right: 0; border-bottom: 1px solid var(--line); padding-right: 0; }
      .stat:last-child { border-bottom: 0; }
      .object-stack {
        width: clamp(9.5rem, 56vw, 12.5rem);
        height: clamp(12.2rem, 70vw, 15.5rem);
        --hero-z2: 44px;
        --hero-z3: 88px;
      }
      .hero-controls { flex-direction: column; width: 100%; }
      .hero-chip { width: 100%; }
      /* One scrollable control strip instead of nine stacked rows: at 320px the
         wrapped toolbar pushed the canvas below the fold, so the controls and the
         object could not be seen together. The document itself still never scrolls
         sideways; only this strip does. */
      .stage-toolbar {
        flex-wrap: nowrap;
        overflow-x: auto;
        overscroll-behavior-x: contain;
        scrollbar-width: thin;
        padding: .45rem .6rem;
        gap: .5rem;
      }
      .stage-toolbar .seg { flex: 0 0 auto; flex-wrap: nowrap; }
      .stage-toolbar .seg-label { white-space: nowrap; }
      .stage-viewport {
        height: 400px;
        --plane-size: clamp(13.75rem, 78vw, 17.5rem);
      }
      .stage-3d {
        --z2: 46px;
        --z3: 92px;
        transform: rotateX(50deg) rotateZ(-30deg) scale(.78);
      }
      #cam-front:checked ~ .stage-viewport .stage-3d {
        transform: rotateX(0deg) rotateZ(0deg) scale(.92);
      }
      #cam-matrix:checked ~ .stage-viewport .stage-3d {
        transform: rotateX(68deg) rotateZ(0deg) scale(.76);
      }
      .tab-label, .calc .seg-label {
        width: 100%;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
    }
`;

/** The motion-related overrides, kept beside the reflow they belong with. */
const REDUCED_MOTION_STYLE = `
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      body::before, .orbit, .kicker::before, .flow-line, .flow-dot, .hero-object, .hero-scene, .object-stack, .beam { animation: none !important; }
      *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
      .topbar { backdrop-filter: none; }
    }
`;

/** The responsive and reduced-motion sheets, concatenated after the base style. */
export const LANDING_RESPONSIVE_STYLE = RESPONSIVE_STYLE + REDUCED_MOTION_STYLE;
