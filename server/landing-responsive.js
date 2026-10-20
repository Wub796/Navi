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

/** Narrow-viewport reflow for the grids the base sheet lays out in columns. */
const RESPONSIVE_STYLE = `
    @media (max-width: 1080px) {
      .tiers { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .tiers > section:nth-child(2) { border-right: 0; }
      .tiers > section:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
    }
    @media (max-width: 860px) {
      .hero { grid-template-columns: 1fr; align-items: start; min-height: auto; padding-top: 2.5rem; }
      .hero-object { order: -1; min-height: 17rem; }
      .hero-copy { padding-bottom: 1.5rem; }
      .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 2rem; }
      .stat:nth-child(2) { border-right: 0; }
      .compare { grid-template-columns: 1fr; }
      .compare > section { border-right: 0; border-bottom: 1px solid var(--line); }
      .pillars, .steps-3 { grid-template-columns: 1fr; }
      .pillars > section, .step { border-right: 0; border-bottom: 1px solid var(--line); padding: 1.4rem 0; }
      .pillars > section:last-child, .step:last-child { border-bottom: 0; }
      .tiers { grid-template-columns: 1fr; }
      .tiers > section { border-right: 0; border-bottom: 1px solid var(--line); min-height: 0; }
      .tiers > section:last-child { border-bottom: 0; }
      .savings-grid { grid-template-columns: 1fr; }
    }
`;

/** The motion-related overrides, kept beside the reflow they belong with. */
const REDUCED_MOTION_STYLE = `
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      body::before, .orbit, .kicker::before, .flow-line, .flow-dot, .hero-object, .object-stack { animation: none; }
      *, *::before, *::after { transition-duration: .01ms !important; }
      .topbar { backdrop-filter: none; }
    }
`;

/** The responsive and reduced-motion sheets, concatenated after the base style. */
export const LANDING_RESPONSIVE_STYLE = RESPONSIVE_STYLE + REDUCED_MOTION_STYLE;
