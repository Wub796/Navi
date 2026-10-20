// The landing page's design system.
//
// Modelled after two studio sites that say almost nothing and show one object:
// igloo.inc (an icy monochrome sculpture in fog) and buttermax.net (`#101010`,
// `#ffd600`, Helvetica, one centred mark). The translation is deliberate rather
// than decorative: near-black paper, bone ink, a single sodium-yellow accent,
// oversized Helvetica display type, hairline rules instead of cards, and enormous
// negative space. There is no webfont: `default-src 'none'` forbids one, and the
// reference sites' Helvetica is a system face anyway, so the type stack is the
// browser's own grotesque.
//
// Nothing here is generated: it is a template literal with no interpolation,
// because a stylesheet that can interpolate a value can interpolate a `</style>`.
//
// The narrow-viewport and reduced-motion overrides live in
// `landing-responsive.js`, the masthead/hero sheet in `landing-hero.js`; both are
// concatenated onto this sheet by the importer.

import { LANDING_HERO_STYLE } from './landing-hero.js';
import { LANDING_RESPONSIVE_STYLE } from './landing-responsive.js';

export const LANDING_STYLE = `
    :root {
      color-scheme: dark;
      --bg: #0b0b0b;
      --bg-deep: #070707;
      --surface: #111110;
      --surface-2: #161614;
      --paper: #f2f0ea;
      --fg: #f2f0ea;
      --fg-soft: #c8c6bf;
      --muted: #8d8c85;
      --line: rgba(242, 240, 234, .16);
      --line-strong: rgba(242, 240, 234, .34);
      --accent: #ffd600;
      --accent-ink: #101010;
      --accent-soft: rgba(255, 214, 0, .12);
      --good: #b7f171;
      --bad: #ff6a55;
      --display: "Helvetica Neue", Helvetica, Arial, "Inter", ui-sans-serif, system-ui, sans-serif;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      --ease: cubic-bezier(0.16, 1, 0.3, 1);
      --pad: clamp(1.25rem, 4vw, 4.5rem);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      padding: 0;
      font: 16px/1.6 var(--display);
      background:
        radial-gradient(1100px 640px at 50% -10%, rgba(242, 240, 234, .09), transparent 60%),
        radial-gradient(700px 460px at 82% 6%, rgba(255, 214, 0, .05), transparent 62%),
        var(--bg);
      color: var(--fg);
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }
    /* A horizon line and a slow grid: the room the object stands in, borrowed
       from igloo's fog and buttermax's empty black. */
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background-image:
        linear-gradient(rgba(242, 240, 234, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(242, 240, 234, .035) 1px, transparent 1px);
      background-size: 96px 96px;
      mask-image: radial-gradient(90% 70% at 50% 42%, #000 0%, transparent 78%);
      animation: gridDrift 32s linear infinite;
      pointer-events: none;
      z-index: 0;
    }
    main { position: relative; z-index: 1; }
    .shell { width: 100%; max-width: 100rem; margin: 0 auto; padding: 0 var(--pad); }
    @keyframes gridDrift {
      from { background-position: 0 0, 0 0; }
      to { background-position: 0 96px, 96px 0; }
    }
    @keyframes flowDash { to { stroke-dashoffset: -28; } }
    @keyframes pulseDot { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
    @keyframes hudRise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes objectTurn {
      0%, 100% { transform: rotateX(9deg) rotateY(-28deg); }
      50% { transform: rotateX(9deg) rotateY(28deg); }
    }
    @keyframes objectFloat {
      0%, 100% { transform: translateY(-8px); }
      50% { transform: translateY(10px); }
    }
    /* ---------- masthead ---------- */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 40;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1.5rem;
      flex-wrap: wrap;
      padding: .9rem var(--pad);
      border-bottom: 1px solid var(--line);
      background: rgba(11, 11, 11, .9);
      backdrop-filter: blur(18px);
    }
    .brand {
      display: inline-flex;
      align-items: baseline;
      gap: .6rem;
      color: var(--fg);
      text-decoration: none;
      font-weight: 700;
      font-size: 1.05rem;
      letter-spacing: -.04em;
      text-transform: lowercase;
    }
    .brand-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.5rem;
      height: 1.5rem;
      border-radius: 50%;
      background: var(--accent);
      color: var(--accent-ink);
      font: 800 .8rem/1 var(--display);
      letter-spacing: -.06em;
    }
    .topnav {
      display: flex;
      align-items: center;
      gap: 1.6rem;
      flex-wrap: wrap;
      font: 500 .68rem/1 var(--mono);
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    .topnav a { color: var(--muted); text-decoration: none; transition: color .18s; }
    .topnav a:hover, .topnav a:focus-visible { color: var(--accent); }
    .topnav .nav-key { color: var(--accent); }
    /* ---------- sections ---------- */
    section, .card {
      padding: clamp(3rem, 6vw, 5.5rem) 0;
      margin: 0;
      border-top: 1px solid var(--line);
      background: transparent;
    }
    .topbar + .hero { border-top: 0; }
    h2 {
      display: flex;
      align-items: center;
      gap: .75rem;
      font: 500 .64rem/1 var(--mono);
      letter-spacing: .2em;
      text-transform: uppercase;
      color: var(--accent);
      margin: 0 0 1.4rem;
    }
    h2::after {
      content: "";
      flex: 1;
      height: 1px;
      background: var(--line);
    }
    .section-title {
      font-size: clamp(1.8rem, 3.6vw, 3.3rem);
      line-height: 1.02;
      letter-spacing: -.05em;
      font-weight: 700;
      color: var(--fg);
      margin: 0 0 1rem;
      max-width: 26ch;
      text-transform: none;
      font-family: var(--display);
    }
    .section-sub {
      color: var(--fg-soft);
      font-size: 1rem;
      line-height: 1.6;
      max-width: 38rem;
      margin: 0 0 2.5rem;
    }
    p { margin: 0 0 1rem; }
    .muted { color: var(--muted); font-size: .86rem; margin: .9rem 0 0; }
    .badge-row { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: 1.4rem; }
    .badge {
      display: inline-block;
      font: 500 .6rem/1 var(--mono);
      letter-spacing: .14em;
      text-transform: uppercase;
      color: var(--muted);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: .42rem .7rem;
    }
    .badge.accent { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
    /* ---------- before / after ---------- */
    .compare {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin: 0;
      border-top: 1px solid var(--line);
    }
    .compare > section {
      border-top: 0;
      border-right: 1px solid var(--line);
      padding: clamp(2rem, 5vw, 4rem) clamp(1.25rem, 3vw, 3rem);
    }
    .compare > section:last-child { border-right: 0; }
    .compare h2 { color: var(--muted); }
    .compare .good-card h2 { color: var(--accent); }
    .compare .img { font-size: clamp(1.35rem, 2.1vw, 1.9rem); line-height: 1.08; letter-spacing: -.04em; margin: 0 0 1rem; }
    .compare p { font-size: .9rem; color: var(--fg-soft); max-width: 30rem; }
    .pill {
      display: inline-block;
      font: 500 .6rem/1 var(--mono);
      letter-spacing: .16em;
      text-transform: uppercase;
      padding: 0;
      margin-bottom: 1rem;
      color: var(--muted);
    }
    .pill.bad { color: var(--bad); }
    .pill.good { color: var(--accent); }
    pre {
      margin: 0;
      overflow-wrap: anywhere;
      padding: 1.1rem 1.2rem;
      background: var(--bg-deep);
      border: 1px solid var(--line);
      border-radius: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    code, pre { font: 12.5px/1.7 var(--mono); }
    code { color: var(--fg-soft); }
    .muted code { overflow-wrap: anywhere; }
    /* ---------- pipeline ---------- */
    .pipeline-svg {
      display: block;
      width: 100%;
      height: auto;
      margin: .5rem 0 3rem;
      background: transparent;
      border: 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      padding: 1.5rem 0;
    }
    .flow-line { stroke: var(--accent); stroke-width: 1.4; stroke-dasharray: 6 7; animation: flowDash 1.8s linear infinite; opacity: .8; }
    .flow-node { fill: transparent; stroke: var(--line-strong); stroke-width: 1; }
    .flow-node-accent { fill: rgba(255, 214, 0, .05); stroke: rgba(255, 214, 0, .6); stroke-width: 1; }
    .flow-title { fill: var(--fg); font: 600 12px var(--mono); letter-spacing: .04em; }
    .flow-sub { fill: var(--muted); font: 400 10.5px var(--mono); }
    .flow-dot { fill: var(--accent); animation: pulseDot 2.2s ease-in-out infinite; }
    .pillars {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0;
      border-top: 1px solid var(--line);
    }
    .pillars > section {
      border: 0;
      border-right: 1px solid var(--line);
      padding: 1.6rem 1.6rem 0 0;
      margin: 0;
    }
    .pillars > section:last-child { border-right: 0; padding-right: 0; }
    .pillars h2 { margin-bottom: .9rem; }
    .pillars h3 { margin: 0 0 .5rem; font-size: 1.1rem; letter-spacing: -.03em; font-weight: 600; }
    .pillars p { margin: 0 0 .65rem; font-size: .86rem; color: var(--muted); }
    .pillar-list { list-style: none; padding: 0; margin: 0; font-size: .82rem; color: var(--fg-soft); }
    .pillar-list li { margin: 0 0 .35rem; padding-left: .95rem; position: relative; }
    .pillar-list li::before { content: "\\2014"; position: absolute; left: 0; color: var(--accent); }
    /* ---------- tabs ---------- */
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .tab-radio {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }
    .tab-label {
      cursor: pointer;
      user-select: none;
      font: 500 .66rem/1 var(--mono);
      letter-spacing: .13em;
      text-transform: uppercase;
      padding: 1.1rem 1.4rem;
      color: var(--muted);
      border-right: 1px solid var(--line);
      transition: color .18s, background .18s;
    }
    .tab-label:hover { color: var(--fg); }
    #tab-loader:checked ~ label[for="tab-loader"],
    #tab-edge:checked ~ label[for="tab-edge"],
    #tab-mcp:checked ~ label[for="tab-mcp"] {
      color: var(--accent-ink);
      background: var(--accent);
    }
    #tab-loader:focus-visible ~ label[for="tab-loader"],
    #tab-edge:focus-visible ~ label[for="tab-edge"],
    #tab-mcp:focus-visible ~ label[for="tab-mcp"] { outline: 2px solid var(--accent); outline-offset: -3px; }
    .tab-panel { display: none; width: 100%; order: 99; padding: 1.6rem 0 0; }
    #tab-loader:checked ~ #panel-loader,
    #tab-edge:checked ~ #panel-edge,
    #tab-mcp:checked ~ #panel-mcp { display: block; }
    /* ---------- steps ---------- */
    .steps-3 {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0;
      border-top: 1px solid var(--line);
      margin-top: .5rem;
    }
    .step {
      border: 0;
      border-right: 1px solid var(--line);
      padding: 1.6rem 1.6rem 0 0;
      margin: 0;
      background: transparent;
    }
    .step:last-child { border-right: 0; padding-right: 0; }
    .step-num {
      display: block;
      font: 500 .6rem/1 var(--mono);
      letter-spacing: .16em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 1.4rem;
    }
    .step h3 { margin: 0 0 .5rem; font-size: 1.15rem; letter-spacing: -.03em; font-weight: 600; }
    .step p { margin: 0; font-size: .87rem; color: var(--muted); }
    /* ---------- pricing ---------- */
    .tiers {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .tiers > section {
      display: flex;
      flex-direction: column;
      padding: 3.4rem 1.4rem 1.6rem 0;
      border: 0;
      border-right: 1px solid var(--line);
      margin: 0;
      position: relative;
      min-height: 30rem;
    }
    .tiers > section:last-child { border-right: 0; }
    .tier.featured { background: linear-gradient(180deg, rgba(255, 214, 0, .06), transparent 40%); }
    /* Out of flow, on a row every column reserves, so the four plan names sit on
       one baseline whether or not a column carries a ribbon. */
    .tier-ribbon {
      position: absolute;
      top: 1.6rem;
      left: 0;
      font: 600 .56rem/1 var(--mono);
      letter-spacing: .14em;
      text-transform: uppercase;
      color: var(--accent-ink);
      background: var(--accent);
      padding: .4rem .55rem;
    }
    .tier h3 {
      margin: 0 0 1rem;
      font: 500 .68rem/1 var(--mono);
      letter-spacing: .16em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .tier.featured h3 { color: var(--accent); }
    .tier .price {
      font-size: clamp(2.6rem, 3.6vw, 3.6rem);
      font-weight: 600;
      letter-spacing: -.06em;
      line-height: 1;
      margin: 0;
    }
    .tier .price span { font: 400 .62rem/1 var(--mono); letter-spacing: .1em; color: var(--muted); margin-left: .35rem; text-transform: uppercase; }
    .tier .quota { font: 400 .62rem/1.7 var(--mono); letter-spacing: .04em; color: var(--fg-soft); margin: .7rem 0 1rem; text-transform: uppercase; }
    .tier .summary { font-size: .85rem; line-height: 1.5; color: var(--muted); margin: 0 0 1.4rem; }
    .tier-features {
      list-style: none;
      padding: 1.1rem 0 0;
      margin: 0 0 1.6rem;
      font-size: .8rem;
      line-height: 1.5;
      color: var(--fg-soft);
      border-top: 1px solid var(--line);
    }
    .tier-features li { margin: 0 0 .55rem; padding-left: 1rem; position: relative; }
    .tier-features li::before { content: "\\2014"; position: absolute; left: 0; color: var(--accent); }
    .tier .cta { margin-top: auto; justify-content: center; }
    .tier .unavailable {
      margin: auto 0 0;
      font: 500 .6rem/1.5 var(--mono);
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--muted);
      border-top: 1px solid var(--line);
      padding-top: .95rem;
    }
    /* ---------- api table ---------- */
    table { width: 100%; border-collapse: collapse; font-size: .86rem; }
    th, td { text-align: left; padding: .95rem .8rem .95rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { font: 500 .58rem/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); padding-bottom: .7rem; }
    tr:last-child td { border-bottom: 0; }
    td code { font-size: .78rem; color: var(--fg); white-space: nowrap; }
    td:last-child { color: var(--muted); }
    .method { font: 600 .6rem/1 var(--mono); letter-spacing: .12em; color: var(--accent); }
    /* ---------- faq ---------- */
    .faq { border-top: 1px solid var(--line); }
    .faq-item { border-bottom: 1px solid var(--line); }
    .faq-item summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1.5rem;
      padding: 1.35rem 0;
      font-size: clamp(1.05rem, 1.6vw, 1.35rem);
      font-weight: 500;
      letter-spacing: -.025em;
    }
    .faq-item summary::-webkit-details-marker { display: none; }
    .faq-item summary::after {
      content: "+";
      font: 300 1.4rem/1 var(--mono);
      color: var(--accent);
      transition: transform .25s var(--ease);
    }
    .faq-item[open] summary::after { transform: rotate(45deg); }
    .faq-item p {
      margin: 0;
      padding: 0 3rem 1.5rem 0;
      font-size: .88rem;
      color: var(--muted);
      max-width: 46rem;
    }
    /* ---------- footer ---------- */
    #api { overflow-x: auto; }
    footer {
      position: relative;
      overflow: hidden;
      border-top: 1px solid var(--line);
      padding: 2rem var(--pad) 0;
      color: var(--muted);
      font: 500 .6rem/1.8 var(--mono);
      letter-spacing: .1em;
      text-transform: uppercase;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 1rem;
    }
    .footer-meta { display: flex; justify-content: space-between; gap: 1rem 2rem; flex-wrap: wrap; }
    .footer-mark {
      display: block;
      font-size: clamp(7rem, 26vw, 25rem);
      line-height: .72;
      font-weight: 700;
      letter-spacing: -.08em;
      color: transparent;
      -webkit-text-stroke: 1px rgba(242, 240, 234, .2);
      text-align: center;
      margin: 4rem -2vw -1.4vw;
      pointer-events: none;
      user-select: none;
    }
    a { color: var(--accent); }

` + LANDING_HERO_STYLE + LANDING_RESPONSIVE_STYLE;
