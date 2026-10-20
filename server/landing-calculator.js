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
