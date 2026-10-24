// The landing page's motion layer.
//
// Three rules shape this sheet, because the page it decorates is served under
// `default-src 'none'` and carries no script at all:
//
// 1. **The static page is the finished page.** Every keyframe animates *from* an
//    offset state *to* the state the base sheet already paints, never the other way
//    round, so an element whose animation does not run at all (no scroll-timeline
//    support, reduced motion, a print stylesheet) is already in place rather than
//    stuck invisible. Only an entrance that has begun and not yet advanced shows the
//    offset state, and that is a single frame of a live renderer.
// 2. **Nothing here starts without a guard.** The entrance is wrapped in
//    `prefers-reduced-motion: no-preference`; the scroll-driven work additionally
//    sits inside `@supports (animation-timeline: view())`, so a browser without
//    scroll timelines renders the same page it rendered before this file existed.
// 3. **Motion uses `translate`/`scale`, not `transform`.** The hero sculpture and
//    the stage already own `transform` (3D rotation, preserve-3d, camera presets).
//    The independent transform properties compose with those instead of overwriting
//    them, which is what keeps the camera presets working while the page scrolls.
//
// Timing follows the brief rather than the genre: the references are editorial
// studio sites, so reveals are slow, linear and small — 2rem of travel, a hairline
// that draws itself, a diagram that wipes in left to right. No springs, no bounce,
// and no animation repeats on scroll back up beyond what the timeline records.
//
// Like every string this page emits, the template is a literal with no
// interpolation, because a stylesheet that can interpolate a value can interpolate
// a `</style>`.

/** Scroll-linked reveals, hover micro-interactions and the hero entrance. */
export const LANDING_MOTION_STYLE = `
    /* ---------- motion: keyframes ---------- */
    @keyframes heroIn {
      from { opacity: 0; translate: 0 1.1rem; }
      to { opacity: 1; translate: 0 0; }
    }
    @keyframes objectIn {
      from { opacity: 0; translate: 0 1.8rem; scale: .94; }
      to { opacity: 1; translate: 0 0; scale: 1; }
    }
    @keyframes riseIn {
      from { opacity: 0; translate: 0 2rem; }
      to { opacity: 1; translate: 0 0; }
    }
    @keyframes bendIn {
      0% { opacity: 0; translate: 0 2rem -2rem; rotate: 1 0 0 7deg; scale: .975; }
      65% { opacity: 1; translate: 0 .25rem -.25rem; rotate: 1 0 0 -1.2deg; scale: .998; }
      100% { opacity: 1; translate: 0 0 0; rotate: 1 0 0 0deg; scale: 1; }
    }
    @keyframes stageGridDrift {
      from { translate: 0 2.4rem; }
      to { translate: 0 -2.4rem; }
    }
    @keyframes ruleIn {
      from { scale: 0 1; }
      to { scale: 1 1; }
    }
    @keyframes wipeIn {
      from { clip-path: inset(0 100% 0 0); }
      to { clip-path: inset(0 0 0 0); }
    }
    @keyframes markRise {
      from { opacity: 0; translate: 0 5rem; }
      to { opacity: 1; translate: 0 0; }
    }
    @keyframes progressGrow {
      from { scale: 0 1; }
      to { scale: 1 1; }
    }
    @keyframes topbarRule {
      from { box-shadow: 0 1px 0 rgba(242, 240, 234, 0); }
      to { box-shadow: 0 1px 0 rgba(242, 240, 234, .34); }
    }
    @keyframes floorDrift {
      from { translate: 0 0; }
      to { translate: 0 -7rem; }
    }
    @keyframes panelIn {
      from { opacity: 0; translate: 0 .6rem; }
      to { opacity: 1; translate: 0 0; }
    }

    /* ---------- motion: entrance ---------- */
    /* The fold assembles once, top to bottom, then holds. Reading order is the
       stagger order so the eye is led rather than distracted. */
    @media (prefers-reduced-motion: no-preference) {
      .hero-copy > .kicker { animation: heroIn .8s var(--ease) .05s both; }
      .hero-copy > h1 { animation: heroIn .9s var(--ease) .12s both; }
      .hero-copy > .lede { animation: heroIn .9s var(--ease) .2s both; }
      .hero-copy > .hero-actions { animation: heroIn .9s var(--ease) .28s both; }
      .hero-copy > .badge-row { animation: heroIn .9s var(--ease) .36s both; }
      .hero-object { animation: objectIn 1.15s var(--ease) .15s both; }
      .hero-stats { animation: heroIn 1s var(--ease) .44s both; }
      .faq-item[open] p { animation: panelIn .3s var(--ease) both; }
      .tab-panel { animation: panelIn .34s var(--ease) both; }
    }

    /* ---------- motion: scroll-driven ---------- */
    /* Nothing below runs without animation-timeline support. Every range ends at the
       element's own entry rather than at an arbitrary depth of the viewport, so a
       block is fully composed by the moment it has finished entering the fold - an
       element the reader can already see is never still half-transparent. */
    @supports ((animation-timeline: view()) and (animation-range: entry)) {
      @media (prefers-reduced-motion: no-preference) {
        .compare,
        .pillars,
        .steps-3,
        .tiers { perspective: 1100px; }

        /* #api is excluded from the inner reveals below: it is overflow-x: auto,
           which makes it a scroll container of its own, and a view timeline resolves
           against the nearest one. An animated child would be measured against a
           scrollport that never scrolls and would sit frozen mid-animation. The
           section as a block is revealed instead. */
        .shell > section:not(#api) > .section-title,
        .shell > section:not(#api) > .section-sub { animation: riseIn linear both; animation-timeline: view(); animation-range: entry 0% entry 92%; }
        .shell > section:not(#api) > .section-sub { animation-range: entry 0% entry 100%; }

        .compare > section,
        .pillars > section,
        .steps-3 > .step,
        .tiers > section {
          transform-origin: 50% 100%;
          animation: bendIn linear both;
          animation-timeline: view();
          animation-range: entry 0% entry 100%;
        }
        .compare > section:first-child { animation-range: entry 0% entry 92%; }
        .compare > section:last-child { animation-range: entry 4% entry 100%; }

        /* The eyebrow rule draws itself out of the left edge. It scales, it does
           not grow, so the h2's flex line never reflows while it animates. */
        .shell > section:not(#api) > h2::after,
        .compare > section > h2::after,
        .pillars > section > h2::after,
        .card > h2::after {
          transform-origin: left center;
          animation: ruleIn linear both;
          animation-timeline: view();
          animation-range: entry 0% entry 62%;
        }

        #api,
        .stage-shell,
        .tabs,
        .calc,
        .faq-item { animation: riseIn linear both; animation-timeline: view(); animation-range: entry 0% entry 94%; }

        /* Named view-timeline on the 3D showcase synchronises the stage floor plane
           with scroll progress while keeping pointer events pass-through. */
        .showcase { view-timeline: --stage-view block; }
        .stage-viewport::before {
          animation: stageGridDrift linear both;
          animation-timeline: --stage-view;
          animation-range: entry 0% exit 100%;
        }

        /* Columns and steps share a row, so they enter together; the later range
           start is what turns four simultaneous reveals into one cascade. */
        .tiers > section:nth-child(2),
        .pillars > section:nth-child(2),
        .steps-3 > .step:nth-child(2) { animation-range: entry 6% entry 100%; }
        .tiers > section:nth-child(3),
        .pillars > section:nth-child(3),
        .steps-3 > .step:nth-child(3) { animation-range: entry 12% entry 100%; }
        .tiers > section:nth-child(4) { animation-range: entry 18% entry 100%; }
        .faq-item:nth-child(3n+2) { animation-range: entry 4% entry 100%; }
        .faq-item:nth-child(3n+3) { animation-range: entry 8% entry 100%; }

        /* The diagram is drawn rather than faded: a left-to-right wipe reveals the
           hairline frame and the four nodes in the order the pipeline runs. */
        .pipeline-svg {
          animation: riseIn linear both, wipeIn linear both;
          animation-timeline: view(), view();
          animation-range: entry 0% entry 100%;
        }

        /* Page-scale cues. body::before is the fixed pass-through 3D depth plane
           (z-index: 40, pointer-events: none); body::after is the scroll progress
           hairline; the topbar gains its rule once the page has moved. */
        body::before {
          content: "";
          position: fixed;
          inset: 0 0 -7rem;
          z-index: 40;
          pointer-events: none;
          background:
            repeating-linear-gradient(180deg, rgba(255, 214, 0, .016) 0 1px, transparent 1px 64px),
            radial-gradient(110% 70% at 50% 0%, transparent 68%, rgba(8, 8, 8, .38) 100%);
          animation: floorDrift linear both;
          animation-timeline: scroll(root block);
        }
        body::after {
          content: "";
          position: fixed;
          inset: 0 0 auto;
          height: 2px;
          z-index: 60;
          background: linear-gradient(90deg, var(--accent), rgba(255, 214, 0, .3));
          transform-origin: 0 50%;
          animation: progressGrow linear both;
          animation-timeline: scroll(root block);
          pointer-events: none;
        }
        .topbar {
          animation: topbarRule linear both;
          animation-timeline: scroll(root block);
          animation-range: 0 240px;
        }
        .hero::after {
          animation: floorDrift linear both;
          animation-timeline: scroll(root block);
          animation-range: 0 100vh;
        }
        /* The footer clips its oversized wordmark with overflow: hidden, which makes
           it a scroll container, and a view timeline resolved inside it never advances.
           It is the last block on the page, so root scroll progress describes it just
           as well: the mark rises over the final stretch of the document. */
        footer {
          animation: markRise linear both;
          animation-timeline: scroll(root block);
          animation-range: 90% 100%;
        }
      }
    }

    /* ---------- motion: hover & state ---------- */
    /* Pointer affordances are transitions on the surviving base rules, so they are
       silent under a reduced-motion preference through the global duration override. */

    /* A dark sheen travels across the accent fill; it is what makes the primary
       action read as pressable on a page with no shadow language. */
    .cta { position: relative; overflow: hidden; }
    .cta::after {
      content: "";
      position: absolute;
      inset: -40% -30%;
      background: linear-gradient(100deg, transparent 38%, rgba(16, 16, 16, .16) 50%, transparent 62%);
      translate: -150% 0;
      pointer-events: none;
      transition: translate .7s var(--ease);
    }
    .cta:hover::after,
    .cta:focus-visible::after { translate: 150% 0; }

    .brand-mark { transition: rotate .4s var(--ease), scale .4s var(--ease); }
    .brand:hover .brand-mark,
    .brand:focus-visible .brand-mark { rotate: -7deg; scale: 1.06; }

    .topnav a { position: relative; }
    .topnav a::after {
      content: "";
      position: absolute;
      left: .2rem;
      right: .2rem;
      bottom: .3rem;
      height: 1px;
      background: currentColor;
      transform-origin: left center;
      scale: 0 1;
      transition: scale .3s var(--ease);
    }
    .topnav a:hover::after,
    .topnav a:focus-visible::after { scale: 1 1; }

    .tier { transition: background .35s ease; }
    .tier .price { transition: color .3s ease; }
    .tier:hover .price { color: var(--accent); }
    .tier:not(.featured):hover { background: linear-gradient(180deg, rgba(242, 240, 234, .035), transparent 55%); }
    .tier.featured:hover { background: linear-gradient(180deg, rgba(255, 214, 0, .1), transparent 46%); }

    .step h3,
    .pillars h3 { transition: color .25s ease; }
    .step:hover h3,
    .pillars > section:hover h3 { color: var(--accent); }
    .step .step-num { transition: translate .3s var(--ease); }
    .step:hover .step-num { translate: .3rem 0; }

    .faq-item summary { transition: color .2s ease; }
    .faq-item summary:hover { color: var(--accent); }

    tbody td { transition: background .2s ease; }
    tbody tr:hover td { background: rgba(242, 240, 234, .03); }

    /* A printed page has one viewport and no scroll position, so a scroll-driven
       reveal would freeze below-fold sections in their hidden state on paper. */
    @media (prefers-reduced-motion: reduce), print {
      *,
      *::before,
      *::after {
        animation: none !important;
        translate: none !important;
        rotate: none !important;
        scale: none !important;
      }
    }
`;
