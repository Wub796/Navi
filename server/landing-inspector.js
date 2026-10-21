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
 * @type {readonly {id: string, panel: string, short: string, label: string, json: string, call: string, driftJson: string, openapiJson: string}[]}
 */
export const INSPECTOR_TARGETS = [
  {
    id: 'inspect-cta',
    panel: 'panel-cta',
    short: '01 · Checkout CTA',
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
    driftJson: `resolveTarget({ target_id: "act_pay_01", role: "button", name: "Complete order", action: "click" })
→ {
  "requested_target_id": "act_pay_01",
  "resolved_target_id": "act_pay_v2_9f",
  "healed": true,
  "confidence": 0.97,
  "reason": "healed",
  "weights": { "role": 0.5, "label": 0.3, "action": 0.2, "threshold": ">= 0.85" }
}`,
    openapiJson: `GET /v1/sitemap/openapi.json → workflows[]
{
  "openapi": "3.1.0",
  "path": "/workflows/checkout_1",
  "x-navi-risk-level": "destructive",
  "enum": ["starter", "pro", "enterprise"],
  "format": "email"
}`,
  },
  {
    id: 'inspect-shadow',
    panel: 'panel-shadow',
    short: '02 · Shadow Button',
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
    driftJson: `resolveTarget({ target_id: "act_shadow_02", role: "button", name: "Pay $49.00", action: "click" })
→ {
  "requested_target_id": "act_shadow_02",
  "resolved_target_id": "act_shadow_v2_4c",
  "healed": true,
  "confidence": 0.95,
  "reason": "healed",
  "weights": { "role": 0.5, "label": 0.3, "action": 0.2, "threshold": ">= 0.85" }
}`,
    openapiJson: `GET /v1/sitemap/openapi.json → workflows[]
{
  "openapi": "3.1.0",
  "path": "/workflows/checkout_shadow_1",
  "x-navi-risk-level": "destructive",
  "x-navi-targets": ["act_shadow_v2_4c"]
}`,
  },
  {
    id: 'inspect-pii',
    panel: 'panel-pii',
    short: '03 · Redacted PII',
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
    driftJson: `resolveTarget({ target_id: "act_pii_03", role: "textbox", name: "Card number", action: "fill" })
→ {
  "requested_target_id": "act_pii_03",
  "resolved_target_id": "act_pii_v2_8a",
  "healed": true,
  "confidence": 0.96,
  "reason": "healed",
  "weights": { "role": 0.5, "label": 0.3, "action": 0.2, "threshold": ">= 0.85" }
}`,
    openapiJson: `GET /v1/sitemap/openapi.json → workflows[]
{
  "openapi": "3.1.0",
  "path": "/workflows/checkout_1",
  "x-navi-risk-level": "write",
  "properties": { "card_number": { "type": "string", "format": "password" } }
}`,
  },
  {
    id: 'inspect-pager',
    panel: 'panel-pager',
    short: '04 · Async Pager',
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
    driftJson: `resolveTarget({ target_id: "act_pager_04", role: "button", name: "Next", action: "click" })
→ {
  "requested_target_id": "act_pager_04",
  "resolved_target_id": "act_pager_v2_1d",
  "healed": true,
  "confidence": 0.92,
  "reason": "healed",
  "weights": { "role": 0.5, "label": 0.3, "action": 0.2, "threshold": ">= 0.85" }
}`,
    openapiJson: `GET /v1/sitemap/openapi.json → workflows[]
{
  "openapi": "3.1.0",
  "path": "/workflows/navigate_1",
  "x-navi-risk-level": "read",
  "x-navi-risk-taxonomy": ["read", "write", "destructive"]
}`,
  },
];

/**
 * The inspector's hidden panel bodies, one per pinned target. The stage binds them
 * to their radios with `:has()`; the ids must line up with `INSPECTOR_TARGETS`.
 * @returns {string}
 */
export function renderInspectorPanels() {
  // Indicators, not controls: the stage control itself is the label for its radio,
  // so the chip mirrors the pinned state without becoming a second label for the
  // same input (two labels concatenate into one long accessible name).
  const pins = INSPECTOR_TARGETS.map(target => `          <span class="pin-chip" data-pin="${target.id}">${target.short}</span>`).join('\n');
  const panels = INSPECTOR_TARGETS.map(target => `        <article class="inspect-panel ${target.panel}">
          <h3 class="inspect-title">${target.label}</h3>
          <p class="inspect-meta">deterministic fingerprint · sha384 receipt</p>
          <pre class="inspect-json">${target.json}</pre>
          <pre class="inspect-call">${target.call}</pre>
          <div class="inspect-drift">
            <p class="inspect-drift-head">Self-Healing Drift Recovery (resolveTarget confidence &ge; 0.85 · role 0.5 + label 0.3 + action 0.2)</p>
            <pre class="inspect-json drift-box">${target.driftJson}</pre>
            <p class="inspect-drift-head">Synthesized OpenAPI 3.1 Workflow (GET /v1/sitemap/openapi.json · x-navi-risk-level: "read" | "write" | "destructive")</p>
            <pre class="inspect-call openapi-box">${target.openapiJson}</pre>
          </div>
        </article>`).join('\n');
  return `        <div class="inspect-pins" aria-label="Pinned inspector target">
${pins}
        </div>
        <div class="inspect-mode-bar">
          <span class="drift-switch">UI Deploy Drift &amp; OpenAPI 3.1 Synthesis</span>
        </div>
${panels}`;
}

/** Styles scoped to the receipt inspector. */
export const INSPECTOR_STYLE = `
    .inspector {
      display: flex;
      flex-direction: column;
      padding: 1.1rem 1.2rem 1.2rem;
      background: #080808;
      min-height: 100%;
      font-variant-numeric: tabular-nums;
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
    .inspector-sub { font: 400 .56rem/1.6 var(--mono); letter-spacing: .06em; color: var(--muted); margin: 0 0 .7rem; text-transform: uppercase; }
    .inspect-pins { display: flex; flex-wrap: wrap; gap: .3rem; margin-bottom: .65rem; }
    .pin-chip {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      min-width: 28px;
      padding: .35rem .55rem;
      font: 500 .56rem/1 var(--mono);
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--muted);
      border: 1px solid var(--line);
      user-select: none;
      transition: color .18s, border-color .18s, background .18s;
    }
    #inspect-cta:checked ~ .inspector .pin-chip[data-pin="inspect-cta"],
    #inspect-shadow:checked ~ .inspector .pin-chip[data-pin="inspect-shadow"],
    #inspect-pii:checked ~ .inspector .pin-chip[data-pin="inspect-pii"],
    #inspect-pager:checked ~ .inspector .pin-chip[data-pin="inspect-pager"] {
      color: var(--accent-ink);
      background: var(--accent);
      border-color: var(--accent);
    }
    #inspect-cta:focus-visible ~ .stage-viewport label[for="inspect-cta"],
    #inspect-shadow:focus-visible ~ .stage-viewport label[for="inspect-shadow"],
    #inspect-pii:focus-visible ~ .stage-viewport label[for="inspect-pii"],
    #inspect-pager:focus-visible ~ .stage-viewport label[for="inspect-pager"] {
      outline: 2px solid #ffd600;
      outline-offset: 2px;
    }
    .inspect-mode-bar { margin-bottom: .8rem; }
    /* A readout, not a second control. The toggle itself is one label in the stage
       toolbar; repeating it as a label here gave the checkbox two labels and a
       concatenated accessible name, which is a WCAG 2.5.3 problem rather than a
       convenience. The state still has to be visible beside the healing output. */
    .drift-switch {
      display: inline-flex;
      align-items: center;
      gap: .5rem;
      min-height: 30px;
      min-width: 30px;
      padding: .42rem .65rem;
      font: 600 .56rem/1.2 var(--mono);
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--muted);
      background: rgba(255, 214, 0, .04);
      border: 1px solid var(--line-strong);
      font-variant-numeric: tabular-nums;
      transition: background .18s, color .18s, border-color .18s;
    }
    .drift-switch::after {
      content: "off";
      padding: .16rem .28rem;
      font: 600 .5rem/1 var(--mono);
      letter-spacing: .08em;
      color: var(--muted);
      border: 1px solid var(--line-strong);
    }
    #toggle-ui-drift:checked ~ .inspector .drift-switch {
      color: var(--good);
      border-color: rgba(183, 241, 113, .55);
      background: rgba(183, 241, 113, .08);
    }
    #toggle-ui-drift:checked ~ .inspector .drift-switch::after {
      content: "on";
      color: var(--accent-ink);
      background: var(--good);
      border-color: var(--good);
    }
    .inspect-panel { display: none; }
    .stage-shell:has([id="inspect-cta"]:checked) .panel-cta,
    .stage-shell:has([id="inspect-shadow"]:checked) .panel-shadow,
    .stage-shell:has([id="inspect-pii"]:checked) .panel-pii,
    .stage-shell:has([id="inspect-pager"]:checked) .panel-pager {
      display: block;
      animation: hudRise .26s var(--ease) both;
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
    .inspect-meta { font: 400 .56rem/1.6 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 .65rem; }
    .inspect-json {
      font: .6rem/1.65 var(--mono);
      color: var(--fg-soft);
      background: #050505;
      border: 1px solid var(--line);
      padding: .65rem .7rem;
      margin: 0 0 .55rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }
    .inspect-call {
      font: .6rem/1.65 var(--mono);
      color: var(--accent);
      background: var(--accent-soft);
      border: 1px solid rgba(255, 214, 0, .28);
      padding: .5rem .6rem;
      margin: 0 0 .55rem;
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }
    .inspect-drift {
      display: none;
      margin-top: .55rem;
      padding-top: .55rem;
      border-top: 1px dashed rgba(183, 241, 113, .45);
    }
    #toggle-ui-drift:checked ~ .inspector .inspect-drift {
      display: block;
      animation: hudRise .26s var(--ease) both;
    }
    .inspect-drift-head {
      font: 600 .54rem/1.45 var(--mono);
      letter-spacing: .06em;
      text-transform: uppercase;
      color: var(--good);
      margin: 0 0 .35rem;
    }
    .drift-box { border-color: rgba(183, 241, 113, .4); color: #e2f9c8; }
    .openapi-box { color: var(--fg); background: rgba(255, 214, 0, .07); }
    .inspect-hint { font: 400 .56rem/1.65 var(--mono); color: var(--muted); margin: .5rem 0 0; }
    .stage-hint {
      grid-column: 1 / -1;
      font: 400 .58rem/1.8 var(--mono);
      letter-spacing: .04em;
      color: var(--muted);
      margin: 0;
      padding: .8rem .75rem;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      font-variant-numeric: tabular-nums;
    }
`;
