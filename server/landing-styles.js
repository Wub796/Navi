// The landing page's design system, extracted from `landing.js` so the page's
// composition and its stylesheet can each stay under the structural ceiling.
//
// Dark obsidian is the default rather than a `prefers-color-scheme` branch: the
// product is a spatial, three-dimensional argument, and a light page cannot carry
// the depth cues the stage depends on. The palette is still tokenised so a fork can
// re-theme it in one place, and `prefers-reduced-motion` turns off every continuous
// animation while leaving the `:checked` state machines usable.
//
// Nothing here is generated: it is a template literal with no interpolation, because
// a stylesheet that can interpolate a value can interpolate a `</style>`.

export const LANDING_STYLE = `
    :root {
      color-scheme: dark;
      --bg: #06070b;
      --bg-deep: #04050a;
      --surface: rgba(19, 25, 37, .72);
      --surface-solid: #0d121b;
      --surface-alt: rgba(9, 13, 21, .82);
      --border: rgba(126, 148, 188, .16);
      --border-strong: rgba(140, 168, 216, .3);
      --text: #e9eef8;
      --text-secondary: #9dabc2;
      --muted: #74829c;
      --accent: #4c86ff;
      --accent-hover: #6a9bff;
      --accent-soft: rgba(76, 134, 255, .14);
      --neon: #22d3ee;
      --neon-soft: rgba(34, 211, 238, .14);
      --good: #34d399;
      --good-soft: rgba(52, 211, 153, .12);
      --bad: #fb7185;
      --bad-soft: rgba(251, 113, 133, .12);
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      --ease-spatial: cubic-bezier(0.16, 1, 0.3, 1);
      --radius: 14px;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      padding: 0 1.25rem 4.5rem;
      font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background:
        radial-gradient(900px 520px at 50% -12%, rgba(76, 134, 255, .22), transparent 62%),
        radial-gradient(700px 420px at 88% 8%, rgba(34, 211, 238, .12), transparent 60%),
        var(--bg);
      color: var(--text);
      overflow-x: hidden;
    }
    /* The room the page stands in: a fixed perspective floor grid behind every
       section, which is what makes the glass panels read as floating. */
    body::before {
      content: "";
      position: fixed;
      left: -40%;
      right: -40%;
      bottom: -42%;
      height: 118vh;
      background-image:
        linear-gradient(rgba(76, 134, 255, .22) 1px, transparent 1px),
        linear-gradient(90deg, rgba(34, 211, 238, .16) 1px, transparent 1px);
      background-size: 70px 70px, 70px 70px;
      transform: perspective(620px) rotateX(64deg);
      transform-origin: 50% 100%;
      mask-image: linear-gradient(to top, #000 4%, rgba(0, 0, 0, .55) 42%, transparent 88%);
      animation: gridScroll 22s linear infinite;
      pointer-events: none;
      z-index: 0;
    }
    main { position: relative; z-index: 1; max-width: 68rem; margin: 0 auto; }
    @keyframes gridScroll {
      from { background-position: 0 0, 0 0; }
      to { background-position: 0 70px, 70px 0; }
    }
    @keyframes flowDash { to { stroke-dashoffset: -28; } }
    @keyframes pulseDot { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
    @keyframes hudRise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
      padding: 1.4rem 0;
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: .65rem;
      font-weight: 750;
      font-size: 1.05rem;
      letter-spacing: -.01em;
      color: var(--text);
      text-decoration: none;
    }
    .brand-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.9rem;
      height: 1.9rem;
      border-radius: 9px;
      background: linear-gradient(150deg, var(--accent), var(--neon));
      box-shadow: 0 0 22px -4px rgba(76, 134, 255, .8);
      color: #05080f;
      font: 800 .9rem/1 var(--mono);
    }
    .topnav { display: flex; align-items: center; gap: 1.15rem; flex-wrap: wrap; font-size: .9rem; }
    .topnav a { color: var(--text-secondary); text-decoration: none; font-weight: 550; transition: color .18s; }
    .topnav a:hover, .topnav a:focus-visible { color: var(--neon); }
    .badge-row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.15rem; }
    .badge {
      display: inline-block;
      font: 600 .72rem/1 var(--mono);
      letter-spacing: .09em;
      text-transform: uppercase;
      color: var(--text-secondary);
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: .4rem .7rem;
      backdrop-filter: blur(10px);
    }
    .badge.accent { color: var(--neon); background: var(--neon-soft); border-color: rgba(34, 211, 238, .32); }
    .hero { padding: .5rem 0 2rem; }
    h1 {
      font-size: clamp(2.1rem, 4.4vw, 3.1rem);
      line-height: 1.06;
      margin: 0 0 .9rem;
      letter-spacing: -.035em;
      max-width: 46rem;
      background: linear-gradient(120deg, #ffffff 12%, #c7dcff 58%, var(--neon) 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    h2 {
      font-size: .74rem;
      text-transform: uppercase;
      letter-spacing: .12em;
      color: var(--muted);
      margin: 0 0 .75rem;
      font-family: var(--mono);
    }
    .section-title {
      font-size: 1.5rem;
      line-height: 1.22;
      letter-spacing: -.02em;
      color: var(--text);
      margin: 0 0 .45rem;
      text-transform: none;
      font-family: inherit;
    }
    .section-sub { color: var(--text-secondary); margin: 0 0 1.35rem; max-width: 50rem; }
    p { margin: 0 0 1rem; }
    .lede { font-size: 1.1rem; color: var(--text-secondary); margin-bottom: 1.6rem; max-width: 48rem; }
    .hero-actions { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; margin-bottom: 2rem; }
    .btn-secondary {
      display: inline-block;
      font-weight: 600;
      text-decoration: none;
      color: var(--text);
      background: rgba(18, 24, 36, .6);
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      padding: .72rem 1.1rem;
      backdrop-filter: blur(10px);
      transition: border-color .18s, color .18s, transform .18s var(--ease-spatial);
    }
    .btn-secondary:hover, .btn-secondary:focus-visible {
      border-color: var(--neon);
      color: var(--neon);
      transform: translateY(-1px);
    }
    .stats { display: grid; gap: .85rem; grid-template-columns: repeat(auto-fit, minmax(11.5rem, 1fr)); margin: 0 0 1.75rem; }
    .stat {
      background: linear-gradient(160deg, rgba(25, 34, 49, .78), rgba(10, 14, 22, .88));
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: .95rem 1.1rem;
      margin: 0;
      backdrop-filter: blur(16px);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .045);
    }
    .stat-value { font: 750 1.22rem/1.2 var(--mono); color: var(--text); margin: 0 0 .25rem; }
    .stat-value em { font-style: normal; color: var(--neon); }
    .stat-label { font-size: .78rem; color: var(--muted); margin: 0; }
    .muted { color: var(--muted); font-size: .9rem; margin: .7rem 0 0; }
    section, .card {
      background: linear-gradient(165deg, rgba(22, 30, 43, .8), rgba(9, 12, 19, .88));
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.3rem 1.4rem;
      margin: 0 0 1.35rem;
      overflow-x: auto;
      backdrop-filter: blur(16px);
      box-shadow: 0 30px 70px -46px rgba(0, 0, 0, 1), inset 0 1px 0 rgba(255, 255, 255, .05);
    }
    .compare { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); margin: 0 0 1.35rem; }
    .compare section { margin: 0; }
    .compare .bad-card { border-left: 3px solid var(--bad); }
    .compare .good-card { border-left: 3px solid var(--good); }
    .pill {
      display: inline-block;
      font: 650 .7rem/1 var(--mono);
      text-transform: uppercase;
      letter-spacing: .07em;
      padding: .32rem .58rem;
      border-radius: 6px;
      margin-bottom: .65rem;
    }
    .pill.bad { color: var(--bad); background: var(--bad-soft); }
    .pill.good { color: var(--good); background: var(--good-soft); }
    .pipeline-svg {
      display: block;
      width: 100%;
      height: auto;
      margin: .5rem 0 .95rem;
      background: radial-gradient(70% 120% at 50% 0%, rgba(76, 134, 255, .1), transparent 70%), var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: .55rem;
    }
    .flow-line { stroke: var(--neon); stroke-width: 2.25; stroke-dasharray: 8 6; animation: flowDash 1.4s linear infinite; opacity: .85; }
    .flow-node { fill: rgba(13, 18, 27, .95); stroke: var(--border-strong); stroke-width: 1.5; }
    .flow-node-accent { fill: rgba(34, 211, 238, .1); stroke: var(--neon); stroke-width: 1.75; }
    .flow-title { fill: var(--text); font: 700 12px var(--mono); }
    .flow-sub { fill: var(--muted); font: 500 10.5px ui-sans-serif, system-ui, sans-serif; }
    .flow-dot { fill: var(--good); animation: pulseDot 1.8s ease-in-out infinite; }
    .pillars { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); margin: 0 0 1.35rem; }
    .pillars section { margin: 0; }
    .pillars h3 { margin: 0 0 .35rem; font-size: 1rem; }
    .pillars p { margin: 0; font-size: .9rem; color: var(--text-secondary); }
    .tabs { display: flex; flex-wrap: wrap; gap: .45rem; }
    .tab-radio { position: absolute; opacity: 0; pointer-events: none; }
    .tab-label {
      cursor: pointer;
      user-select: none;
      font: 650 .8rem/1.2 var(--mono);
      padding: .58rem .95rem;
      border-radius: 8px;
      background: var(--surface-alt);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      transition: border-color .18s, color .18s, background .18s;
    }
    .tab-label:hover { border-color: var(--neon); color: var(--neon); }
    .tab-panel { display: none; width: 100%; order: 99; padding-top: .8rem; }
    #tab-loader:checked ~ label[for="tab-loader"],
    #tab-edge:checked ~ label[for="tab-edge"],
    #tab-mcp:checked ~ label[for="tab-mcp"] {
      background: linear-gradient(135deg, var(--accent), #3f6fe0);
      color: #fff;
      border-color: transparent;
      box-shadow: 0 10px 26px -12px rgba(76, 134, 255, .9);
    }
    #tab-loader:focus-visible ~ label[for="tab-loader"],
    #tab-edge:focus-visible ~ label[for="tab-edge"],
    #tab-mcp:focus-visible ~ label[for="tab-mcp"] { outline: 2px solid var(--neon); outline-offset: 2px; }
    #tab-loader:checked ~ #panel-loader,
    #tab-edge:checked ~ #panel-edge,
    #tab-mcp:checked ~ #panel-mcp { display: block; }
    .steps-3 { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16.5rem, 1fr)); margin: .75rem 0 0; }
    .step {
      background: linear-gradient(160deg, rgba(24, 32, 46, .72), rgba(8, 11, 18, .85));
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1rem 1.1rem;
      backdrop-filter: blur(14px);
    }
    .step-num {
      display: inline-block;
      font: 700 .72rem/1 var(--mono);
      color: var(--neon);
      background: var(--neon-soft);
      padding: .3rem .58rem;
      border-radius: 999px;
      margin-bottom: .55rem;
    }
    .step h3 { margin: 0 0 .35rem; font-size: .98rem; }
    .step p { margin: 0; font-size: .86rem; color: var(--text-secondary); }
    .tiers { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
    .tiers section { margin: 0; display: flex; flex-direction: column; position: relative; }
    .tier.featured {
      border-color: rgba(76, 134, 255, .6);
      box-shadow: 0 0 0 1px rgba(76, 134, 255, .55), 0 30px 70px -40px rgba(76, 134, 255, .8);
    }
    .tier-ribbon {
      align-self: flex-start;
      font: 700 .66rem/1 var(--mono);
      text-transform: uppercase;
      letter-spacing: .09em;
      color: var(--neon);
      background: var(--neon-soft);
      padding: .3rem .58rem;
      border-radius: 999px;
      margin-bottom: .55rem;
    }
    .tier h3 { margin: 0 0 .3rem; font-size: 1.05rem; }
    .tier .price { font-size: 1.9rem; font-weight: 750; letter-spacing: -.03em; margin: 0; }
    .tier .price span { font-size: .82rem; font-weight: 500; color: var(--muted); }
    .tier .quota { font: .76rem/1.55 var(--mono); color: var(--text-secondary); margin: .3rem 0 .65rem; }
    .tier .summary { font-size: .87rem; color: var(--text-secondary); margin: 0 0 .8rem; }
    .tier-features {
      list-style: none;
      padding: .75rem 0 0;
      margin: 0 0 1.15rem;
      font-size: .82rem;
      color: var(--text-secondary);
      border-top: 1px solid var(--border);
    }
    .tier-features li { margin: 0 0 .4rem; padding-left: 1.15rem; position: relative; }
    .tier-features li::before { content: "\\2713"; position: absolute; left: 0; color: var(--good); font-weight: 700; }
    .tier .cta { margin-top: auto; text-align: center; }
    .tier .unavailable { margin: auto 0 0; font-size: .8rem; color: var(--muted); }
    code, pre { font: 13.5px/1.6 var(--mono); }
    pre {
      margin: 0;
      overflow-wrap: anywhere;
      padding: .9rem 1rem;
      background: rgba(4, 7, 12, .82);
      border: 1px solid var(--border);
      border-radius: 9px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .muted code { overflow-wrap: anywhere; }
    .cta {
      display: inline-block;
      font-weight: 650;
      text-decoration: none;
      color: #fff;
      background: linear-gradient(135deg, var(--accent), #3f6fe0);
      border-radius: 10px;
      padding: .75rem 1.15rem;
      box-shadow: 0 16px 34px -18px rgba(76, 134, 255, .95);
      transition: transform .18s var(--ease-spatial), box-shadow .18s;
    }
    .cta:focus-visible, .cta:hover { transform: translateY(-1px); box-shadow: 0 20px 40px -18px rgba(76, 134, 255, 1); }
    table { width: 100%; border-collapse: collapse; font-size: .92rem; }
    th, td { text-align: left; padding: .55rem .45rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { font-weight: 600; color: var(--muted); font-size: .74rem; text-transform: uppercase; letter-spacing: .08em; }
    tr:last-child td { border-bottom: 0; }
    td code { font-size: .85rem; white-space: nowrap; }
    .method { font-weight: 650; font-size: .76rem; letter-spacing: .05em; color: var(--neon); }
    .faq-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr)); }
    .faq-item h3 { margin: 0 0 .35rem; font-size: .95rem; }
    .faq-item p { margin: 0; font-size: .88rem; color: var(--text-secondary); }
    footer {
      color: var(--muted);
      font-size: .875rem;
      margin-top: 2.5rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: .75rem;
    }
    a { color: var(--accent); }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      body::before, .flow-line, .flow-dot { animation: none; }
      *, *::before, *::after { transition-duration: .01ms !important; }
      .step, .stat, .card, section { backdrop-filter: none; }
    }
    @media (max-width: 640px) {
      body { padding-inline: .9rem; }
      section, .card { padding: 1rem; }
    }
`;
