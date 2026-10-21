// The landing page's token-and-latency calculator.
//
// The arithmetic happens at render time and the browser only switches between three
// baked panels with a radio, because a page whose CSP is `default-src 'none'` cannot
// compute anything. Keeping it apart from the 3D stage is also what keeps both
// modules under the structural ceiling: the stage is markup and a state machine, this
// is a small table of numbers and the prose that has to travel with them.

/**
 * One benchmark comparison, baked per volume. Costs assume $3.00 per million input
 * tokens and a single crawl per page per day over a 30-day month, so `45,000` tokens
 * per page at 1,000 pages/day is 1.35 billion tokens and $4,050.
 */
const VOLUMES = [
  {
    id: 'vol-1k',
    panel: 'calc-1k',
    label: '1,000 pages/day',
    rawTokens: '1.35B',
    rawCost: '$4,050',
    naviTokens: '19.5M',
    naviCost: '$58.50',
    saving: '$3,991.50',
    plan: 'Pro · $49 / mo',
  },
  {
    id: 'vol-50k',
    panel: 'calc-50k',
    label: '50,000 pages/day',
    rawTokens: '67.5B',
    rawCost: '$202,500',
    naviTokens: '975M',
    naviCost: '$2,925',
    saving: '$199,575',
    plan: 'Pro · $49 / mo',
  },
  {
    id: 'vol-250k',
    panel: 'calc-250k',
    label: '250,000 pages/day',
    rawTokens: '337.5B',
    rawCost: '$1,012,500',
    naviTokens: '4.875B',
    naviCost: '$14,625',
    saving: '$997,875',
    plan: 'Enterprise · $199 / mo',
  },
];

/**
 * The token-and-latency calculator: a radio per volume, two columns per panel.
 * @returns {string}
 */
export function renderSavingsCalculator() {
  const radios = VOLUMES.map((volume, index) => `      <input class="stage-radio" type="radio" name="calc-volume" id="${volume.id}"${index === 0 ? ' checked' : ''}>`).join('\n');
  const labels = VOLUMES.map(volume => `        <label class="seg-label" for="${volume.id}">${volume.label}</label>`).join('\n');
  const panels = VOLUMES.map(volume => `      <div class="calc-panel" id="${volume.panel}">
        <div class="calc-grid">
          <div class="calc-col">
            <span class="pill bad">Raw HTML / screenshot VLM</span>
            <p class="calc-line"><span>Context per page</span><strong>~45,000 tokens</strong></p>
            <p class="calc-line"><span>Agent latency per page</span><strong>~1,800 ms</strong></p>
            <p class="calc-line"><span>Monthly input tokens</span><strong>${volume.rawTokens}</strong></p>
            <p class="calc-total">${volume.rawCost}<span>per month at $3.00 / 1M input tokens</span></p>
            <p class="calc-note">Obfuscated class names, screenshot OCR, retries when hydration races the click.</p>
          </div>
          <div class="calc-col good">
            <span class="pill good">Navi 0.3.0 action map</span>
            <p class="calc-line"><span>Context per page</span><strong>~650 tokens</strong></p>
            <p class="calc-line"><span>Slice + settle budget</span><strong>&le; 2 ms</strong></p>
            <p class="calc-line"><span>Monthly input tokens</span><strong>${volume.naviTokens}</strong></p>
            <p class="calc-total">${volume.naviCost}<span>LLM cost beside ${volume.plan}</span></p>
            <p class="calc-save">Save ${volume.saving} / month · 98.6% fewer tokens</p>
            <p class="calc-note">Deterministic <code>target_id</code>s, guarded execution and a sha384 settlement receipt per action.</p>
          </div>
        </div>
      </div>`).join('\n');
  return `  <section id="savings" class="showcase">
    <h2>Interactive unit economics</h2>
    <p class="section-title">What a page of context costs, at your volume</p>
    <p class="section-sub">Pick a crawl volume. The left column is what a raw-DOM or screenshot planner pays in tokens and latency; the right is the same page as a Navi action map. Pure CSS radio state — no script, no chart library.</p>
    <div class="calc">
${radios}
      <div class="calc-switch" role="group" aria-label="Daily crawl volume">
${labels}
      </div>
${panels}
    </div>
    <p class="calc-foot">Illustrative arithmetic, not a provider invoice: 45,000 tokens and 1,800 ms per page for raw HTML or screenshot planning, 650 tokens and a two-millisecond slice budget for a Navi map, $3.00 per million input tokens, one crawl per page per day over 30 days. The plan named beside each total is this deployment's list price; the commercial quotas are metered per 30-day window, and a volume above a plan's window is quoted by Enterprise.</p>
  </section>`;
}

// The savings calculator's sheet, beside the panels it dresses. Split from
// `landing-stage.js` for the same ceiling; selectors here dress only the markup
// `renderSavingsCalculator` emits above.

/** Styles scoped to the savings calculator. */
export const CALCULATOR_STYLE = `
    .calc { margin-top: .5rem; font-variant-numeric: tabular-nums; }
    .calc-switch {
      display: flex;
      flex-wrap: wrap;
      gap: 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      margin-bottom: 2.2rem;
    }
    #vol-1k:checked ~ .calc-switch label[for="vol-1k"],
    #vol-50k:checked ~ .calc-switch label[for="vol-50k"],
    #vol-250k:checked ~ .calc-switch label[for="vol-250k"] {
      color: var(--accent-ink);
      background: var(--accent);
    }
    #vol-1k:focus-visible ~ .calc-switch label[for="vol-1k"],
    #vol-50k:focus-visible ~ .calc-switch label[for="vol-50k"],
    #vol-250k:focus-visible ~ .calc-switch label[for="vol-250k"] { outline: 2px solid #ffd600; outline-offset: 2px; }
    .calc .seg-label {
      padding: 1rem 1.3rem;
      border-bottom: 0;
      border-right: 1px solid var(--line);
    }
    .calc .seg-label:last-child { border-right: 0; }
    .calc-panel { display: none; }
    #vol-1k:checked ~ #calc-1k,
    #vol-50k:checked ~ #calc-50k,
    #vol-250k:checked ~ #calc-250k { display: block; animation: hudRise .3s var(--ease) both; }
    .calc-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .calc-col { padding: 1.6rem 1.6rem 1.8rem 0; border-right: 1px solid var(--line); }
    .calc-col:last-child { border-right: 0; padding-right: 0; padding-left: 1.6rem; }
    .calc-line { display: flex; justify-content: space-between; gap: 1rem; font: 400 .72rem/2 var(--mono); color: var(--muted); margin: 0; }
    .calc-line strong { color: var(--fg); font-weight: 500; }
    .calc-total { font-size: clamp(2.2rem, 3.4vw, 3.4rem); font-weight: 600; letter-spacing: -.055em; line-height: 1; margin: 1rem 0 .4rem; color: var(--fg); }
    .calc-total span { display: block; font: 400 .56rem/1.6 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-top: .5rem; }
    .calc-total em { font-style: normal; }
    .calc-col.good .calc-total { color: var(--accent); }
    .calc-save { font: 500 .7rem/1.6 var(--mono); letter-spacing: .06em; color: var(--accent); margin: .6rem 0 0; }
    .calc-note { font-size: .82rem; line-height: 1.55; color: var(--muted); margin: .7rem 0 0; max-width: 30rem; }
    .calc-foot { font-size: .78rem; line-height: 1.7; color: var(--muted); margin: 1.4rem 0 0; max-width: 56rem; }
    @media (max-width: 760px) {
      .calc-grid { grid-template-columns: 1fr; }
      .calc-col { border-right: 0; border-bottom: 1px solid var(--line); padding-right: 0; }
      .calc-col:last-child { border-bottom: 0; padding-left: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .seg-label { transition: none; }
    }
`;
