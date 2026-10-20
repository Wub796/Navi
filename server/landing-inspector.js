// The receipt inspector: its pinned targets and the sheet that dresses them.
//
// Split from `landing-stage.js` so every `server/*.js` stays under the 650-line
// ceiling the release gate enforces. The four simulated controls the inspector can
// pin, and the exact JSON the agent reads and the receipt each executes to, are data
// rather than layout — this module holds the table beside the styles that target it
// and nothing else on the page may class itself `inspect-*`.
//
// Like every string this page emits, the templates are literals with no
// interpolation, because a template that can interpolate a value can interpolate a
// `</style>` or a `</pre>`.

/**
 * The four simulated controls the inspector can pin, in reading order.
 * @type {readonly {id: string, panel: string, label: string, json: string, call: string}[]}
 */
export const INSPECTOR_TARGETS = [
  {
    id: 'inspect-cta',
    panel: 'panel-cta',
    label: 'Primary Checkout CTA',
    json: `{
  "target_id": "act_pay_01",
  "role": "button",
  "name": "Complete order",
  "bbox": [412, 288, 140, 44],
  "fingerprint": "6b1f9a4c",
  "state": { "visible": true, "enabled": true, "inViewport": true },
  "root": "host"
}`,
    call: `navi_act({ target: "act_pay_01" })
→ { "settled": true, "elapsedMs": 1.7, "sha384": "8f3c…c19a" }`,
  },
  {
    id: 'inspect-shadow',
    panel: 'panel-shadow',
    label: 'Closed Shadow DOM Button',
    json: `{
  "target_id": "act_shadow_02",
  "role": "button",
  "name": "Pay $49.00",
  "bbox": [286, 340, 120, 38],
  "fingerprint": "d42e07b1",
  "root": "#shadow-root (closed)",
  "pierceDepth": 1,
  "state": { "visible": true, "enabled": true, "inViewport": true }
}`,
    call: `navi_act({ target: "act_shadow_02" })
→ { "settled": true, "elapsedMs": 1.9, "sha384": "41ad…7e02" }`,
  },
  {
    id: 'inspect-pii',
    panel: 'panel-pii',
    label: 'Redacted PII Card Input',
    json: `{
  "target_id": "act_pii_03",
  "role": "textbox",
  "name": "Card number",
  "bbox": [188, 214, 320, 36],
  "fingerprint": "a90c5d33",
  "value": "[REDACTED]",
  "redaction": { "rule": "payment-card", "masked": true },
  "state": { "visible": true, "enabled": true, "inViewport": true }
}`,
    call: `navi_get_actions({ scope: "act_pii_03" })
→ value is [REDACTED] before it ever leaves the page`,
  },
  {
    id: 'inspect-pager',
    panel: 'panel-pager',
    label: 'Async Pagination Trigger',
    json: `{
  "target_id": "act_pager_04",
  "role": "button",
  "name": "Next",
  "bbox": [504, 512, 64, 32],
  "fingerprint": "2f81b6de",
  "async": { "settle": "mutation", "budgetMs": 2 },
  "state": { "visible": true, "enabled": true, "inViewport": false }
}`,
    call: `navi_act({ target: "act_pager_04", wait: "mutation_settle" })
→ { "settled": true, "mutations": 3, "sha384": "c7be…90f3" }`,
  },
];

/**
 * The inspector's hidden panel bodies, one per pinned target. The stage binds them
 * to their radios with `:has()`; the ids must line up with `INSPECTOR_TARGETS`.
 * @returns {string}
 */
export function renderInspectorPanels() {
  return INSPECTOR_TARGETS.map(target => `        <article class="inspect-panel ${target.panel}">
          <h3 class="inspect-title">${target.label}</h3>
          <p class="inspect-meta">deterministic fingerprint · sha384 receipt</p>
          <pre class="inspect-json">${target.json}</pre>
          <pre class="inspect-call">${target.call}</pre>
        </article>`).join('\n');
}

// The receipt inspector's sheet, beside the data it dresses. Selectors here target
// only that markup; nothing else on the page may class itself `inspect-*`.

/** Styles scoped to the receipt inspector. */
export const INSPECTOR_STYLE = `
    .inspector {
      display: flex;
      flex-direction: column;
      padding: 1.1rem 1.2rem 1.2rem;
      background: #080808;
      min-height: 100%;
    }
    .inspector-head {
      font: 600 .58rem/1.5 var(--mono);
      letter-spacing: .16em;
      text-transform: uppercase;
      color: var(--accent);
      padding-bottom: .65rem;
      margin-bottom: .55rem;
      border-bottom: 1px solid var(--line);
    }
    .inspector-sub { font: 400 .56rem/1.6 var(--mono); letter-spacing: .06em; color: var(--muted); margin: 0 0 .9rem; text-transform: uppercase; }
    .inspect-panel { display: none; }
    .stage-shell:has([id="inspect-cta"]:checked) .panel-cta,
    .stage-shell:has([id="inspect-shadow"]:checked) .panel-shadow,
    .stage-shell:has([id="inspect-pii"]:checked) .panel-pii,
    .stage-shell:has([id="inspect-pager"]:checked) .panel-pager {
      display: block;
      animation: hudRise .3s var(--ease) both;
    }
    .stage-shell:has(.t-cta:hover) .inspect-panel,
    .stage-shell:has(.t-shadow:hover) .inspect-panel,
    .stage-shell:has(.t-pii:hover) .inspect-panel,
    .stage-shell:has(.t-pager:hover) .inspect-panel { display: none; }
    .stage-shell:has(.t-cta:hover) .panel-cta,
    .stage-shell:has(.t-shadow:hover) .panel-shadow,
    .stage-shell:has(.t-pii:hover) .panel-pii,
    .stage-shell:has(.t-pager:hover) .panel-pager { display: block; }
    .inspect-title { font-size: 1.02rem; font-weight: 600; letter-spacing: -.03em; margin: 0 0 .15rem; }
    .inspect-meta { font: 400 .54rem/1.6 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 .8rem; }
    .inspect-json {
      font: .6rem/1.7 var(--mono);
      color: var(--fg-soft);
      background: #050505;
      border: 1px solid var(--line);
      padding: .7rem .75rem;
      margin: 0 0 .65rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .inspect-call {
      font: .6rem/1.7 var(--mono);
      color: var(--accent);
      background: var(--accent-soft);
      border: 1px solid rgba(255, 214, 0, .28);
      padding: .5rem .6rem;
      margin: 0;
      overflow-wrap: anywhere;
    }
    .inspect-hint { font: 400 .52rem/1.7 var(--mono); color: var(--muted); margin: .8rem 0 0; }
    .stage-hint {
      grid-column: 1 / -1;
      font: 400 .58rem/1.8 var(--mono);
      letter-spacing: .04em;
      color: var(--muted);
      margin: 0;
      padding: .8rem .75rem;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      grid-column: 1 / -1;
    }
`;
