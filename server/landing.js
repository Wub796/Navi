// The public landing page served at the edge root (`GET /` on `navi-edge`).
//
// A deployed Worker that answers `404 {"error":"Not found"}` at its own root tells a
// visiting developer nothing about what the service is or how to call it, and the
// ingestion endpoint is authenticated, so the root is the only place a stranger can
// learn the shape of the API. The page is therefore static HTML with no script: it
// carries no credential, no analytics and no runtime, which is what lets its CSP stay
// at `default-src 'none'` with only the inline stylesheet allowed.
//
// The composition is modelled after two studio sites that show one object and very
// little else — igloo.inc's monochrome sculpture in fog and buttermax.net's black
// field with a single yellow mark. The translation keeps the content a buyer needs
// (model, economics, pricing, API) but sequences it as an editorial page rather than
// a dashboard: a full-viewport hero around a floating three-plane monogram, hairline
// sections, and oversized Helvetica display type.
//
// The page's interactivity is all browser form state: the 3D camera and target
// inspector on the stage, the integration tabs, the savings calculator, and the FAQ's
// native `<details>` are the only behaviours, and every one of them works with
// scripts disabled and under `default-src 'none'`.

import { escapeHtml } from './billing-success.js';
import { CALCULATOR_STYLE, renderSavingsCalculator } from './landing-calculator.js';
import { INSPECTOR_STYLE } from './landing-inspector.js';
import { renderLandingStage, STAGE_STYLE } from './landing-stage.js';
import { LANDING_STYLE } from './landing-styles.js';
import { TIERS } from './pricing.js';

/**
 * Headers the landing page is served with.
 *
 * `no-store` because the page embeds the deployment's Payment Link, which is
 * configuration rather than content; `frame-ancestors` is not in the CSP because
 * `X-Frame-Options: DENY` covers the framing and the policy is kept to the two
 * directives the page actually needs.
 */
export const LANDING_PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * A Payment Link is only rendered when it is an absolute `https:` URL with no
 * embedded credentials. A misconfigured environment (`http:`, `javascript:`, a
 * relative path) is treated as unset, so the page downgrades to the self-hosted
 * quickstart instead of publishing a link that cannot work or one that is a
 * redirect to somewhere else.
 * @param {unknown} value
 * @returns {string | null}
 */
function httpsLink(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** @type {Record<string, readonly string[]>} */
const TIER_FEATURES = Object.freeze({
  community: [
    'Full DOM + closed Shadow DOM action maps',
    'Local SQLite WAL or JSONL audit store',
    'Stdio & SSE MCP server (5 agent tools)',
    'AGPL-3.0-or-later open-source license',
  ],
  starter: [
    'Hosted edge loader & sitemap ingestion',
    'Per-tenant allowed_origins enforcement',
    'Instant post-checkout API key claim',
    'Atomic 30-day rolling quota window',
  ],
  pro: [
    '5× Starter ingestion capacity (50k/mo)',
    'Commercial license — AGPL-3.0 exemption',
    'Proprietary & closed-source SaaS embed',
    'Multi-origin allow-lists & zero-downtime key stability',
  ],
  enterprise: [
    '250,000 events / 30 days at the edge',
    'Commercial self-hosted Docker & air-gapped license',
    'Hardened seccomp + namespace Chromium containers',
    'Prometheus metrics & containment audit trail',
  ],
});

/** @param {string} method @param {string} path @param {string} detail */
const row = (method, path, detail) => `        <tr><td><span class="method">${method}</span></td><td><code>${escapeHtml(path)}</code></td><td>${detail}</td></tr>`;

/** `$29` from 2900. Every tier is sold in whole dollars.
 * @param {number} cents @returns {string} */
const priceLabel = cents => `$${cents / 100}`;

/**
 * One column of the pricing grid.
 * @param {import('./pricing.js').Tier} tier @param {string | null} link
 * @returns {string}
 */
function renderTier(tier, link) {
  const quota = tier.maxEventsPerWindow === null
    ? 'Unmetered · Self-hosted'
    : `${tier.maxEventsPerWindow.toLocaleString('en-US')} events / 30 days`;
  const featured = tier.id === 'pro';
  const ribbon = featured ? '\n      <span class="tier-ribbon">Most popular · AGPL exempt</span>' : '';
  const features = (TIER_FEATURES[tier.id] ?? [])
    .map(item => `        <li>${escapeHtml(item)}</li>`)
    .join('\n');
  const action = link
    ? `<a class="cta" href="${escapeHtml(link)}">Subscribe &rarr;</a>`
    : tier.priceCents === 0
      ? '<p class="unavailable">Free forever · AGPL-3.0</p>'
      : '<p class="unavailable">Not configured on this deployment</p>';
  return `    <section class="tier${featured ? ' featured' : ''}">${ribbon}
      <h3>${escapeHtml(tier.name)}</h3>
      <p class="price">${priceLabel(tier.priceCents)}<span>/mo</span></p>
      <p class="quota">${quota}</p>
      <p class="summary">${escapeHtml(tier.summary)}</p>
      <ul class="tier-features">
${features}
      </ul>
      ${action}
    </section>`;
}

/**
 * Render the public landing document.
 * @param {{loaderUrl?: string, sitemapUrl?: string, paymentLinkUrl?: unknown,
 *   paymentLinks?: {starter?: unknown, pro?: unknown, enterprise?: unknown}}} [input]
 * @returns {string}
 */
export function renderLandingPage(input = {}) {
  const loader = escapeHtml(input.loaderUrl ?? '/v1/loader.js');
  const sitemap = escapeHtml(input.sitemapUrl ?? '/v1/sitemap/update');
  const links = /** @type {Record<string, string | null>} */ ({
    starter: httpsLink(input.paymentLinks?.starter),
    pro: httpsLink(input.paymentLinks?.pro ?? input.paymentLinkUrl),
    enterprise: httpsLink(input.paymentLinks?.enterprise),
  });
  const purchasing = Boolean(links.starter || links.pro || links.enterprise);
  const embed = `<script src="${loader}"\n        data-key="navi_live_YOUR_KEY"><\/script>\n<script defer src="/app.js"><\/script>`;
  const publish = `curl -X POST ${sitemap} \\
  -H "Authorization: Bearer $NAVI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://app.example.com","actions":[{"role":"button","name":"Checkout"}]}'`;
  const mcpSnippet = `# Install the zero-dependency kit & launch stdio or SSE MCP
npm i navi-interaction-bridge
npx navi-mcp
# Or run the hardened self-hosted container with SQLite WAL:
docker compose -f deploy/docker-compose.prod.yml up -d`;

  const rawDomExample = `<div class="sc-92x-btn" onclick="run()">
  <span class="icon-wrap"><svg>...</svg></span>
  <!-- 4,200 nodes of nested layout noise -->
</div>
// Agent guesses selector ".sc-92x-btn" -> breaks on next deploy`;

  const actionMapExample = `{
  "version": "0.3.0",
  "url": "https://app.example.com/checkout",
  "actions": [{
    "target_id": "checkout-submit",
    "role": "button",
    "name": "Complete Order ($107.00)",
    "action": "click",
    "visible": true,
    "enabled": true,
    "inViewport": true
  }]
}`;

  const pricing = `  <section id="pricing">
    <h2>06 — Pricing</h2>
    <p class="section-title">Predictable 30-day quotas. Zero-integration checkout.</p>
    <p class="section-sub">Pay via Stripe Payment Link, claim your <code>navi_live_…</code> credential on the one-time redirect page, and start indexing immediately.</p>
    <div class="tiers">
${TIERS.map(tier => renderTier(tier, links[tier.id] ?? null)).join('\n')}
    </div>
    <p class="muted">Checkout is hosted by Stripe; the tenant key is shown once on the success page and never again. Every paid plan is metered over a 30-day window.</p>
  </section>`;

  const quickstart = purchasing ? '' : `  <section class="card">
    <h2>Self-hosted quickstart</h2>
    <p>This deployment has no Payment Link configured, so there is no self-serve checkout here. Run the same service yourself, or ask the operator for a tenant key.</p>
    <pre><code>npm i navi-interaction-bridge
npm run serve -- --port 3000
navi-mcp --transport sse</code></pre>
  </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="description" content="Navi is the AI browser agent SDK and Model Context Protocol (MCP) browser bridge turning live DOM and closed Shadow DOM into token-efficient JSON action maps.">
<link rel="canonical" href="https://navi-edge.sysctl.workers.dev/">
<meta property="og:title" content="Navi — AI Browser Agent SDK &amp; Deterministic MCP Bridge">
<meta property="og:description" content="Navi is the AI browser agent SDK and Model Context Protocol (MCP) browser bridge turning live DOM and closed Shadow DOM into token-efficient JSON action maps.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://navi-edge.sysctl.workers.dev/">
<meta property="og:site_name" content="Navi Interaction Bridge">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Navi — AI Browser Agent SDK &amp; Deterministic MCP Bridge">
<meta name="twitter:description" content="Navi is the AI browser agent SDK and Model Context Protocol (MCP) browser bridge turning live DOM and closed Shadow DOM into token-efficient JSON action maps.">
<title>Navi — AI Browser Agent SDK &amp; Deterministic MCP Bridge</title>
<style>${LANDING_STYLE}${STAGE_STYLE}${INSPECTOR_STYLE}${CALCULATOR_STYLE}</style>
</head>
<body>
<main>
  <header class="topbar">
    <a class="brand" href="/">
      <span class="brand-mark">N</span>
      <span>navi</span>
    </a>
    <nav class="topnav" aria-label="Primary">
      <a href="#stage">Model</a>
      <a href="#architecture">Architecture</a>
      <a href="#quickstart">Integration</a>
      <a href="#savings">Economics</a>
      <a href="#pricing">Pricing</a>
      <a href="#api">API</a>
      <a href="#faq">FAQ</a>
      <a href="https://github.com/Wub796/Navi">GitHub</a>
      <a class="nav-key" href="#pricing">Get key &nearr;</a>
    </nav>
  </header>

  <section class="hero">
    <div class="hero-copy">
      <p class="kicker">AI browser agent SDK · protocol 0.3.0</p>
      <h1>Navi — Deterministic<br>action maps for<br><em>browser agents.</em></h1>
      <p class="lede">
        Stop feeding 50,000 tokens of brittle DOM markup into LLM planners. Navi is the Model Context Protocol (MCP) browser bridge that compiles live pages — including closed Shadow DOM and same-origin iframes — into a deterministic DOM to JSON action map for LLM agents, providing a token-efficient alternative to Playwright MCP and screenshot VLMs.
      </p>
      <div class="hero-actions">
        <a class="cta" href="#pricing">Get an API key &rarr;</a>
        <a class="btn-secondary" href="#stage">See the model &darr;</a>
        <a class="btn-secondary" href="https://github.com/Wub796/Navi">Source &amp; benchmarks</a>
      </div>
      <div class="badge-row">
        <span class="badge accent">navi-edge · 0.3.0</span>
        <span class="badge">MCP 2025-11-25</span>
        <span class="badge">Sigstore OIDC</span>
        <span class="badge">zero-JS CSP</span>
      </div>
    </div>

    <div class="hero-object" aria-hidden="true">
      <span class="orbit"></span>
      <div class="object-stack">
        <span class="slab slab-1" data-label="01 / DOM"></span>
        <span class="slab slab-2" data-label="02 / MESH"></span>
        <span class="slab slab-3" data-label="03 / MAP"></span>
      </div>
    </div>

    <div class="hero-stats" role="region" aria-label="Verified protocol specifications">
      <div class="stat">
        <p class="stat-value">5.9 kB gzip</p>
        <p class="stat-label">SDK bundle · 14,929 B raw · SHA-384 SRI</p>
      </div>
      <div class="stat">
        <p class="stat-value">689 B</p>
        <p class="stat-label">Tenant embed loader · auto-discovery</p>
      </div>
      <div class="stat">
        <p class="stat-value">254 tests</p>
        <p class="stat-label">Chromium · Postgres · MCP verification</p>
      </div>
      <div class="stat">
        <p class="stat-value">Sigstore OIDC</p>
        <p class="stat-label">Provenance · 10 / 10 verified TCR</p>
      </div>
    </div>
  </section>

  <div class="shell">

${renderLandingStage()}

  <div id="why-navi" class="compare">
    <section class="bad-card">
      <h2>Without Navi · Raw HTML &amp; Screenshot VLMs</h2>
      <span class="pill bad">Without Navi · Raw DOM scraping</span>
      <h3 class="img">Fragile selectors &amp; blind sleeps</h3>
      <p>Agents burn context windows on obfuscated CSS classes, miss controls inside closed Shadow roots, and click before hydration settles.</p>
      <pre><code>${escapeHtml(rawDomExample)}</code></pre>
    </section>
    <section class="good-card">
      <h2>With Navi · Deterministic Web Agent Automation</h2>
      <span class="pill good">With Navi · Deterministic protocol</span>
      <h3 class="img">Semantic targets &amp; settlement receipts</h3>
      <p>Every interactive element is hashed with MurmurHash3, checked for occlusion and viewport presence, and executed with a two-frame settlement guarantee.</p>
      <pre><code>${escapeHtml(actionMapExample)}</code></pre>
    </section>
  </div>

  <section id="architecture">
    <h2>02 — Architecture: How Navi Converts Live DOM Trees into Deterministic MCP Action Maps</h2>
    <p class="section-title">From live Browser DOM to MCP Agent in one atomic pipeline</p>
    <p class="section-sub">Inline SVG and pure CSS <code>@keyframes</code> under <code>default-src 'none'</code> — zero client-side JavaScript.</p>
    <svg class="pipeline-svg" viewBox="0 0 880 128" role="img" aria-label="Data flow from Browser DOM to Cloudflare Edge, Supabase Atomic RPC, and MCP Agent">
      <line class="flow-line" x1="195" y1="64" x2="245" y2="64" />
      <line class="flow-line" x1="425" y1="64" x2="475" y2="64" />
      <line class="flow-line" x1="655" y1="64" x2="705" y2="64" />
      <rect class="flow-node" x="15" y="22" width="180" height="84" rx="2" />
      <circle class="flow-dot" cx="34" cy="44" r="4.5" />
      <text class="flow-title" x="46" y="48">1. Browser DOM</text>
      <text class="flow-sub" x="30" y="68">TreeWalker &le; 2 ms slice</text>
      <text class="flow-sub" x="30" y="86">Closed Shadow + iframes</text>
      <rect class="flow-node-accent" x="245" y="22" width="180" height="84" rx="2" />
      <text class="flow-title" x="262" y="48">2. Cloudflare Edge</text>
      <text class="flow-sub" x="262" y="68">navi-edge Worker</text>
      <text class="flow-sub" x="262" y="86">Bearer + Origin verify</text>
      <rect class="flow-node-accent" x="475" y="22" width="180" height="84" rx="2" />
      <text class="flow-title" x="492" y="48">3. Supabase RPC</text>
      <text class="flow-sub" x="492" y="68">consume_site_quota()</text>
      <text class="flow-sub" x="492" y="86">Single-tx lock + store</text>
      <rect class="flow-node" x="705" y="22" width="160" height="84" rx="2" />
      <circle class="flow-dot" cx="724" cy="44" r="4.5" />
      <text class="flow-title" x="736" y="48">4. MCP Agent</text>
      <text class="flow-sub" x="720" y="68">navi-mcp stdio / SSE</text>
      <text class="flow-sub" x="720" y="86">Guarded native action</text>
    </svg>
    <div class="pillars">
      <section>
        <h2>01 · In-page runtime</h2>
        <h3>Closed Shadow DOM automation &amp; PII redaction</h3>
        <p>A sub-millisecond TreeWalker DOM crawler (&le; 2 ms slice) hooks <code>attachShadow</code> before app scripts run and enforces browser PII redaction for AI agents.</p>
        <ul class="pillar-list">
          <li>Zero field values ever serialized into the action map</li>
          <li>MurmurHash3 target IDs with center-point occlusion checks</li>
        </ul>
      </section>
      <section>
        <h2>02 · Guarded MCP server</h2>
        <h3>Hosted MCP SSE server &amp; SSRF containment</h3>
        <p>Ships <code>navi-mcp</code> over stdio and authenticated SSE for deterministic web agent automation with strict network egress controls.</p>
        <ul class="pillar-list">
          <li>5 MCP tools with mutation and navigation settlement receipts</li>
          <li>Refuses loopback, RFC 1918, cloud metadata IPs, and DNS rebinding</li>
        </ul>
      </section>
      <section>
        <h2>03 · Atomic edge ingestion</h2>
        <h3>Single-RPC quota &amp; map transactions</h3>
        <p>Every sitemap write and Stripe webhook executes inside one transactional database RPC — row-locked quota metering and origin allow-lists never drift.</p>
        <ul class="pillar-list">
          <li>Constant-time HMAC-SHA256 webhook verification (300s window)</li>
          <li>Dual-backend parity across Cloudflare Edge and SQLite WAL</li>
        </ul>
      </section>
    </div>
  </section>

  <section id="quickstart">
    <h2>03 — Integration: 689 B Loader, Hosted Edge API &amp; Self-Hosted Docker MCP Server</h2>
    <p class="section-title">Drop-in browser loader, edge ingestion API, or local MCP host</p>
    <p class="section-sub">Switch tabs below — pure CSS radio state that works with scripts disabled.</p>
    <div class="tabs">
      <input class="tab-radio" type="radio" name="integration-tab" id="tab-loader" checked>
      <label class="tab-label" for="tab-loader">1 · Browser Script Loader</label>
      <input class="tab-radio" type="radio" name="integration-tab" id="tab-edge">
      <label class="tab-label" for="tab-edge">2 · Edge API (POST /v1/sitemap/update)</label>
      <input class="tab-radio" type="radio" name="integration-tab" id="tab-mcp">
      <label class="tab-label" for="tab-mcp">3 · MCP Server &amp; Docker Host</label>

      <div class="tab-panel" id="panel-loader">
        <h3>1 · Embed the 689 B Subresource-Integrity Loader</h3>
        <pre><code>${escapeHtml(embed)}</code></pre>
        <p class="muted">Load before application scripts to capture closed Shadow roots. Injects <code>&lt;meta name="agent-bridge"&gt;</code> for automatic agent discovery and queues <code>window.Navi</code> calls until the 14,929 B bundle executes.</p>
      </div>
      <div class="tab-panel" id="panel-edge">
        <h3>2 · Publish DOM to JSON Action Maps to the Hosted Edge API</h3>
        <pre><code>${escapeHtml(publish)}</code></pre>
        <p class="muted">Point your crawler at a rendered page and POST the semantic map to the edge. Origin validation, 30-day quota metering, and map persistence commit in one atomic PostgreSQL transaction.</p>
      </div>
      <div class="tab-panel" id="panel-mcp">
        <h3>3 · Run the Self-Hosted Docker MCP Server (Stdio or SSE)</h3>
        <pre><code>${escapeHtml(mcpSnippet)}</code></pre>
        <p class="muted">Node 22+, zero runtime dependencies. Exposes <code>navi_navigate</code>, <code>navi_get_actions</code>, <code>navi_execute_action</code>, <code>navi_assert_state</code>, and <code>navi_set_session</code>.</p>
      </div>
    </div>
  </section>

  <section>
    <h2>04 — Provisioning</h2>
    <p class="section-title">How self-serve provisioning works</p>
    <p class="section-sub">3-step instant Stripe Checkout to a one-time API key claim, built for standard Payment Links with zero custom webhook code on your end.</p>
    <div class="steps-3">
      <div class="step">
        <span class="step-num">Step 1 · Stripe Checkout</span>
        <h3>Select a commercial plan</h3>
        <p>Complete checkout on a hosted Stripe Payment Link. Stripe signs a <code>checkout.session.completed</code> event and delivers it to <code>/v1/billing/webhook</code>.</p>
      </div>
      <div class="step">
        <span class="step-num">Step 2 · /v1/billing/webhook</span>
        <h3>Atomic tenant &amp; quota minting</h3>
        <p>The edge verifies the HMAC-SHA256 signature within a 300s replay window, derives <code>tenant_cus_…</code>, infers your 30-day quota from billed cents, and mints a 256-bit key in one RPC.</p>
      </div>
      <div class="step">
        <span class="step-num">Step 3 · /v1/billing/success</span>
        <h3>One-time browser key claim</h3>
        <p>Stripe redirects your browser to <code>/v1/billing/success?session_id=cs_…</code>, which atomically deletes the 15-minute claim row and reveals your <code>navi_live_…</code> credential once.</p>
      </div>
    </div>
  </section>

${renderSavingsCalculator()}

${pricing}

${quickstart}

  <section id="api">
    <h2>07 — API</h2>
    <p class="section-title">Five public surfaces</p>
    <table>
      <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
      <tbody>
${[
  row('POST', '/v1/sitemap/update', 'Authenticated sitemap write; verifies origin allow-list and charges the tenant quota window'),
  row('POST', '/v1/billing/webhook', 'Stripe webhook; verifies HMAC-SHA256 signature, provisions, upgrades and suspends tenants'),
  row('GET', '/v1/billing/session', 'One-time post-checkout API-key claim, returned as JSON (Cache-Control: no-store)'),
  row('GET', '/v1/billing/success', 'Browser onboarding page that consumes the one-time claim and reveals the key once'),
  row('GET', '/healthz', 'Liveness probe, unauthenticated and storage-free'),
].join('\n')}
      </tbody>
    </table>
  </section>

  <section id="faq">
    <h2>08 — Questions</h2>
    <p class="section-title">Operational FAQ</p>
    <div class="faq">
      <details class="faq-item">
        <summary>How does client-side PII redaction and closed Shadow DOM piercing work?</summary>
        <p>The sub-millisecond TreeWalker DOM crawler hooks <code>Element.prototype.attachShadow</code> at document start for closed Shadow DOM automation while pinning native DOM prototypes against tampering. Browser PII redaction for AI agents is enforced structurally: input values, passwords, and payment tokens are never read or serialized into the JSON action map.</p>
      </details>
      <details class="faq-item">
        <summary>Why use DOM action maps instead of VLM screenshots or raw HTML scraping?</summary>
        <p>Navi is a token-efficient alternative to Playwright MCP and screenshot VLMs: instead of sending 45,000 tokens of brittle markup or slow vision frames, agents receive a ~650-token deterministic DOM to JSON action map. Every action returns a cryptographic settlement receipt after verifying visibility, viewport intersection, and center-point hit testing.</p>
      </details>
      <details class="faq-item">
        <summary>Why does Pro include a commercial license?</summary>
        <p>The Community edition is licensed under <code>AGPL-3.0-or-later</code>, which requires network services to offer their Corresponding Source. Active Pro and Enterprise subscriptions grant a commercial exemption for proprietary SaaS and internal deployments.</p>
      </details>
      <details class="faq-item">
        <summary>Will upgrading my plan rotate my embedded API key?</summary>
        <p>No. Keys are minted once on initial provisioning. A subsequent <code>customer.subscription.updated</code> event updates your 30-day quota ceiling in place while preserving your live <code>navi_live_…</code> credential and origin allow-list.</p>
      </details>
      <details class="faq-item">
        <summary>What happens when a quota window is exceeded or canceled?</summary>
        <p>Ingestion responds with <code>HTTP 429 {"error":"Quota exceeded"}</code> plus <code>Retry-After</code> and <code>X-Quota-Limit</code> headers — never <code>401 Unauthorized</code> — so your monitoring can distinguish plan exhaustion from a bad credential.</p>
      </details>
      <details class="faq-item">
        <summary><span>Why does this page ship with <code>default-src 'none'</code>?</span></summary>
        <p>Every public surface on <code>navi-edge</code> runs zero JavaScript, zero trackers, and zero external fonts. Keeping the root and onboarding pages script-free eliminates XSS exfiltration vectors by construction.</p>
      </details>
    </div>
  </section>

  </div>
</main>

<footer>
  <div class="footer-meta">
    <span>Navi protocol 0.3.0 · MCP 2025-11-25 · <a href="https://github.com/Wub796/Navi">github.com/Wub796/Navi</a></span>
    <span>AGPL-3.0-or-later · commercial exemption on Pro &amp; Enterprise</span>
  </div>
  <span class="footer-mark" aria-hidden="true">navi</span>
</footer>
</body>
</html>
`;
}
