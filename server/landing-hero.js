// The landing page's masthead and hero.
//
// Split from `landing-styles.js` so every `server/*.js` stays under the 650-line
// ceiling the release gate enforces. This is the full-viewport opening: the sticky
// top bar, the oversized display headline, the orbiting three-plane monogram, and
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
      font-size: clamp(2.8rem, 6.2vw, 6.4rem);
      line-height: .9;
      font-weight: 700;
      letter-spacing: -.06em;
      margin: 0 0 1.4rem;
      max-width: 14ch;
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
      max-width: 32rem;
      margin: 0 0 1.7rem;
    }
    .hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem 1.5rem; margin-bottom: 1.8rem; }
    .cta {
      display: inline-flex;
      align-items: center;
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
      transition: background .18s, color .18s, transform .3s var(--ease);
    }
    .cta:hover, .cta:focus-visible { background: #fff0a0; transform: translateY(-2px); }
    .btn-secondary {
      display: inline-flex;
      align-items: center;
      gap: .45rem;
      font: 500 .74rem/1 var(--mono);
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--fg);
      text-decoration: none;
      padding: .95rem .2rem;
      border-bottom: 1px solid var(--line-strong);
      transition: color .18s, border-color .18s;
    }
    .btn-secondary:hover, .btn-secondary:focus-visible { color: var(--accent); border-color: var(--accent); }
    .hero-object {
      position: relative;
      z-index: 1;
      display: grid;
      place-items: center;
      min-height: clamp(17rem, 40vh, 28rem);
      perspective: 1100px;
      animation: objectFloat 14s ease-in-out infinite;
    }
    .object-stack {
      position: relative;
      width: clamp(12rem, 18vw, 17rem);
      height: clamp(16rem, 24vw, 22rem);
      transform-style: preserve-3d;
      transform: rotateX(9deg) rotateY(-28deg);
      animation: objectTurn 26s ease-in-out infinite;
    }
    .slab {
      position: absolute;
      inset: 0;
      border: 1px solid var(--line-strong);
      background: linear-gradient(155deg, rgba(242, 240, 234, .055), rgba(242, 240, 234, .006));
      backdrop-filter: blur(3px);
      transform-style: preserve-3d;
    }
    .slab::after {
      content: attr(data-label);
      position: absolute;
      left: .6rem;
      bottom: .5rem;
      font: 500 .56rem/1 var(--mono);
      letter-spacing: .18em;
      color: var(--muted);
    }
    .slab::before {
      content: "";
      position: absolute;
      inset: .55rem;
      border-top: 1px solid var(--line);
      border-left: 1px solid var(--line);
    }
    .slab-1 { transform: translateZ(0); }
    .slab-2 { transform: translateZ(70px); border-color: rgba(255, 214, 0, .32); }
    .slab-3 { transform: translateZ(140px); border-color: rgba(255, 214, 0, .72); }
    .slab-3::after { color: var(--accent); }
    .orbit {
      position: absolute;
      width: 26rem;
      height: 26rem;
      max-width: 86vw;
      max-height: 86vw;
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
    }
    .stat:last-child { border-right: 0; }
    .stat-value {
      font-size: clamp(1.15rem, 1.6vw, 1.5rem);
      font-weight: 600;
      letter-spacing: -.03em;
      margin: 0 0 .3rem;
      color: var(--fg);
    }
    .stat-label {
      font: 500 .58rem/1.5 var(--mono);
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0;
    }
`
