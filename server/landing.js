// The public landing page served at the edge root (`GET /` on `navi-edge`).
//
// A deployed Worker that answers `404 {"error":"Not found"}` at its own root tells a
// visiting developer nothing about what the service is or how to call it, and the
// ingestion endpoint is authenticated, so the root is the only place a stranger can
// learn the shape of the API. The page is therefore static HTML with no script: it
// carries no credential, no analytics and no runtime, which is what lets its CSP stay
// at `default-src 'none'` with only the inline stylesheet allowed.
//
// It lives under `server/` beside the billing pages for the same reason they do: the
// directory is published in the package, so the Worker and a self-hosted install can
// serve the same document, and the escaping is written once.

import { escapeHtml } from './billing-success.js';
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
 * redirect to somewhere else. The parsed `href` is what gets rendered: the URL
 * parser normalizes quotes and angle brackets that would otherwise need escaping
 * in the attribute.
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

const STYLE = `
    :root {
      color-scheme: light dark;
      --bg: #f6f7f9;
      --surface: #ffffff;
      --surface-alt: #f2f4f7;
      --border: #e3e6eb;
      --border-strong: #cfd5df;
      --text: #16181d;
      --text-secondary: #4b515c;
      --muted: #6b7280;
      --accent: #2f6fed;
      --accent-hover: #245bd0;
      --accent-soft: #eaf1ff;
      --good: #0f766e;
      --good-soft: #e6f7f4;
      --bad: #b42318;
      --bad-soft: #fef3f2;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      padding: 0 1.25rem 4.5rem;
      font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    main { max-width: 64rem; margin: 0 auto; }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
      padding: 1.25rem 0;
      margin-bottom: 1.75rem;
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
      width: 1.85rem;
      height: 1.85rem;
      border-radius: 8px;
      background: var(--accent);
      color: #fff;
      font: 700 .88rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .topnav {
      display: flex;
      align-items: center;
      gap: 1.15rem;
      flex-wrap: wrap;
      font-size: .9rem;
    }
    .topnav a {
      color: var(--text-secondary);
      text-decoration: none;
      font-weight: 550;
    }
    .topnav a:hover, .topnav a:focus-visible { color: var(--accent); }
    .badge-row {
      display: flex;
      flex-wrap: wrap;
      gap: .5rem;
      margin-bottom: 1rem;
    }
    .badge {
      display: inline-block;
      font: 600 .72rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--text-secondary);
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: .38rem .68rem;
    }
    .badge.accent {
      color: var(--accent);
      background: var(--accent-soft);
      border-color: transparent;
    }
    .hero {
      padding: .75rem 0 2rem;
    }
    h1 {
      font-size: clamp(2rem, 4vw, 2.85rem);
      line-height: 1.12;
      margin: 0 0 .85rem;
      letter-spacing: -.03em;
      max-width: 48rem;
    }
    h2 {
      font-size: .78rem;
      text-transform: uppercase;
      letter-spacing: .09em;
      color: var(--muted);
      margin: 0 0 .75rem;
    }
    .section-title {
      font-size: 1.45rem;
      line-height: 1.25;
      letter-spacing: -.02em;
      color: var(--text);
      margin: 0 0 .45rem;
      text-transform: none;
    }
    .section-sub {
      color: var(--text-secondary);
      margin: 0 0 1.25rem;
      max-width: 48rem;
    }
    p { margin: 0 0 1rem; }
    .lede {
      font-size: 1.12rem;
      color: var(--text-secondary);
      margin-bottom: 1.5rem;
      max-width: 48rem;
    }
    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: .75rem;
      align-items: center;
      margin-bottom: 2rem;
    }
    .btn-secondary {
      display: inline-block;
      font-weight: 600;
      text-decoration: none;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      padding: .72rem 1.1rem;
    }
    .btn-secondary:hover, .btn-secondary:focus-visible {
      border-color: var(--accent);
      color: var(--accent);
    }
    .stats {
      display: grid;
      gap: .85rem;
      grid-template-columns: repeat(auto-fit, minmax(11.5rem, 1fr));
      margin: 0 0 2rem;
    }
    .stat {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: .95rem 1.1rem;
      margin: 0;
    }
    .stat-value {
      font: 750 1.35rem/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--text);
      margin: 0 0 .2rem;
    }
    .stat-label {
      font-size: .82rem;
      color: var(--muted);
      margin: 0;
    }
    .muted { color: var(--muted); font-size: .9rem; margin: .7rem 0 0; }
    section, .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem 1.35rem;
      margin: 0 0 1.35rem;
      /* The endpoint table keeps its paths whole, so on a narrow viewport the card
         scrolls instead of breaking the path across two lines. */
      overflow-x: auto;
    }
    .grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
      margin: 0 0 1.35rem;
    }
    .grid section { margin: 0; }
    .compare {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
      margin: 0 0 1.35rem;
    }
    .compare section { margin: 0; }
    .compare .bad-card { border-left: 4px solid var(--bad); }
    .compare .good-card { border-left: 4px solid var(--good); }
    .pill {
      display: inline-block;
      font: 650 .72rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-transform: uppercase;
      letter-spacing: .06em;
      padding: .3rem .55rem;
      border-radius: 6px;
      margin-bottom: .6rem;
    }
    .pill.bad { color: var(--bad); background: var(--bad-soft); }
    .pill.good { color: var(--good); background: var(--good-soft); }
    .pillars {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
      margin: 0 0 1.35rem;
    }
    .pillars section { margin: 0; }
    .pillars h3 { margin: 0 0 .35rem; font-size: 1rem; }
    .pillars p { margin: 0; font-size: .9rem; color: var(--text-secondary); }
    .steps {
      display: grid;
      gap: .9rem;
      grid-template-columns: repeat(auto-fit, minmax(13.5rem, 1fr));
      margin: .75rem 0 0;
    }
    .step {
      background: var(--surface-alt);
      border-radius: 10px;
      padding: .9rem 1rem;
    }
    .step-num {
      display: inline-block;
      font: 700 .75rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--accent);
      background: var(--accent-soft);
      padding: .25rem .5rem;
      border-radius: 999px;
      margin-bottom: .45rem;
    }
    .step h3 { margin: 0 0 .3rem; font-size: .95rem; }
    .step p { margin: 0; font-size: .85rem; color: var(--text-secondary); }
    .tiers {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    }
    .tiers section { margin: 0; display: flex; flex-direction: column; position: relative; }
    .tier.featured {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .tier-ribbon {
      align-self: flex-start;
      font: 700 .68rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--accent);
      background: var(--accent-soft);
      padding: .28rem .55rem;
      border-radius: 999px;
      margin-bottom: .5rem;
    }
    .tier h3 { margin: 0 0 .3rem; font-size: 1.05rem; }
    .tier .price { font-size: 1.85rem; font-weight: 750; letter-spacing: -.02em; margin: 0; }
    .tier .price span { font-size: .82rem; font-weight: 500; color: var(--muted); }
    .tier .quota { font: .78rem/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--text-secondary); margin: .3rem 0 .65rem; }
    .tier .summary { font-size: .88rem; color: var(--text-secondary); margin: 0 0 .8rem; }
    .tier-features {
      list-style: none;
      padding: 0;
      margin: 0 0 1.15rem;
      font-size: .83rem;
      color: var(--text-secondary);
      border-top: 1px solid var(--border);
      padding-top: .75rem;
    }
    .tier-features li {
      margin: 0 0 .4rem;
      padding-left: 1.15rem;
      position: relative;
    }
    .tier-features li::before {
      content: "✓";
      position: absolute;
      left: 0;
      color: var(--good);
      font-weight: 700;
    }
    .tier .cta { margin-top: auto; text-align: center; }
    .tier .unavailable { margin: auto 0 0; font-size: .8rem; color: var(--muted); }
    code, pre { font: 13.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    td code { white-space: nowrap; }
    pre {
      margin: 0;
      overflow-wrap: anywhere;
      padding: .9rem 1rem;
      background: var(--surface-alt);
      border-radius: 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .muted code { overflow-wrap: anywhere; }
    .cta {
      display: inline-block;
      font-weight: 650;
      text-decoration: none;
      color: #fff;
      background: var(--accent);
      border-radius: 10px;
      padding: .75rem 1.15rem;
    }
    .cta:focus-visible, .cta:hover { background: var(--accent-hover); }
    table { width: 100%; border-collapse: collapse; font-size: .92rem; }
    th, td { text-align: left; padding: .55rem .45rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { font-weight: 600; color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; }
    tr:last-child td { border-bottom: 0; }
    td code { font-size: .86rem; }
    .method { font-weight: 650; font-size: .78rem; letter-spacing: .04em; color: var(--accent); }
    .faq-grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr));
    }
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
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0d12;
        --surface: #131720;
        --surface-alt: #0d1017;
        --border: #232936;
        --border-strong: #323b4d;
        --text: #e8ecf2;
        --text-secondary: #9ba3b2;
        --muted: #8892a4;
        --accent: #4c86ff;
        --accent-hover: #3b78f0;
        --accent-soft: #192847;
        --good: #2dd4bf;
        --good-soft: #112e2b;
        --bad: #f87171;
        --bad-soft: #2c1618;
      }
      .cta { color: #fff; }
    }
`;

/** @param {string} method @param {string} path @param {string} detail */
const row = (method, path, detail) => `        <tr><td><span class="method">${method}</span></td><td><code>${escapeHtml(path)}</code></td><td>${detail}</td></tr>`;

/** `$29` from 2900. Every tier is sold in whole dollars.
 * @param {number} cents @returns {string} */
const priceLabel = cents => `$${cents / 100}`;

/**
 * One card of the pricing grid.
 *
 * A paid tier renders its CTA only when that tier's Payment Link is configured;
 * `httpsLink` has already vetted the href, and `escapeHtml` runs over the parsed
 * value so an operator's link cannot become markup.
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
 * The landing document.
 *
 * Every interpolated value is escaped: the loader URL and the sitemap URL are
 * derived from the request origin, and the Payment Link comes from configuration,
 * so none of them is allowed to close an attribute or open an element.
 * @param {{loaderUrl?: string, sitemapUrl?: string, paymentLinkUrl?: unknown,
 *   paymentLinks?: {starter?: unknown, pro?: unknown, enterprise?: unknown}}} [input]
 * @returns {string}
 */
export function renderLandingPage(input = {}) {
  const loader = escapeHtml(input.loaderUrl ?? '/v1/loader.js');
  const sitemap = escapeHtml(input.sitemapUrl ?? '/v1/sitemap/update');
  // `paymentLinkUrl` is the pre-tier name for the Pro link, and still works: a
  // deployment that only ever set it keeps exactly the call to action it had.
  const links = /** @type {Record<string, string | null>} */ ({
    starter: httpsLink(input.paymentLinks?.starter),
    pro: httpsLink(input.paymentLinks?.pro ?? input.paymentLinkUrl),
    enterprise: httpsLink(input.paymentLinks?.enterprise),
  });
  const purchasing = Boolean(links.starter || links.pro || links.enterprise);
  const embed = `<script src="${loader}"\n        data-key="navi_live_YOUR_KEY"><\/script>`;
  const publish = `curl -X POST ${sitemap} \\
  -H "Authorization: Bearer $NAVI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://app.example.com","actions":[{"role":"button","name":"Checkout"}]}'`;

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

  // Every tier is always shown, so a visitor can compare plans even on a
  // deployment that configured only one link. The CTA is the only thing that
  // depends on configuration.
  const pricing = `  <section id="pricing">
    <h2>Commercial plans</h2>
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
<meta name="description" content="Navi Interaction Bridge — deterministic semantic action maps, guarded native execution, and MCP tooling for browser agents.">
<title>Navi Interaction Bridge — Deterministic Action Maps for Browser Agents</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header class="topbar">
    <a class="brand" href="/">
      <span class="brand-mark">N</span>
      <span>Navi Interaction Bridge</span>
    </a>
    <nav class="topnav" aria-label="Primary">
      <a href="#why-navi">Why Navi</a>
      <a href="#architecture">Architecture</a>
      <a href="#quickstart">Quickstart</a>
      <a href="#pricing">Pricing</a>
      <a href="#api">API</a>
      <a href="https://github.com/Wub796/Navi">GitHub</a>
    </nav>
  </header>

  <div class="hero">
    <div class="badge-row">
      <span class="badge accent">navi-edge · protocol 0.3.0</span>
      <span class="badge">MCP 2025-11-25</span>
      <span class="badge">Zero runtime dependencies</span>
    </div>
    <h1>Deterministic action maps for browser agents</h1>
    <p class="lede">
      Stop feeding 50,000 tokens of brittle DOM markup into LLM planners. Navi indexes rendered pages — including closed
      Shadow DOM and same-origin iframes — into compact, addressable semantic targets with guarded native execution and
      settlement receipts.
    </p>
    <div class="hero-actions">
      <a class="cta" href="#pricing">View Plans &amp; Get API Key &rarr;</a>
      <a class="btn-secondary" href="#quickstart">Read 60-Second Quickstart</a>
      <a class="btn-secondary" href="https://github.com/Wub796/Navi">Source &amp; Benchmarks</a>
    </div>

    <div class="stats" role="region" aria-label="Verified protocol specifications">
      <div class="stat">
        <p class="stat-value">14,929 B</p>
        <p class="stat-label">Shipped SDK bundle (&lt;15 KB budget, SHA-384 SRI)</p>
      </div>
      <div class="stat">
        <p class="stat-value">689 B</p>
        <p class="stat-label">Tenant embed loader (&lt;700 B budget, auto-discovery)</p>
      </div>
      <div class="stat">
        <p class="stat-value">&le; 2 ms</p>
        <p class="stat-label">Idle-sliced TreeWalker budget (0 long tasks &gt;50 ms)</p>
      </div>
      <div class="stat">
        <p class="stat-value">10 / 10</p>
        <p class="stat-label">Verified checkout task completion with settlement receipts</p>
      </div>
    </div>
  </div>

  <div id="why-navi" class="compare">
    <section class="bad-card">
      <span class="pill bad">Without Navi · Raw DOM scraping</span>
      <h2>Fragile selectors &amp; blind sleeps</h2>
      <p>Agents burn context windows on obfuscated CSS classes, miss controls inside closed Shadow roots, and click before hydration settles.</p>
      <pre><code>${escapeHtml(rawDomExample)}</code></pre>
    </section>
    <section class="good-card">
      <span class="pill good">With Navi · Deterministic protocol</span>
      <h2>Semantic targets &amp; settlement receipts</h2>
      <p>Every interactive element is hashed with MurmurHash3, checked for occlusion and viewport presence, and executed with a two-frame settlement guarantee.</p>
      <pre><code>${escapeHtml(actionMapExample)}</code></pre>
    </section>
  </div>

  <div id="architecture" class="pillars">
    <section>
      <h2>01 · In-page runtime</h2>
      <h3>Closed Shadow DOM &amp; CSP-safe</h3>
      <p>Hooks <code>attachShadow</code> before app scripts run, pins DOM prototypes against page tampering, and uses zero <code>eval</code> or inline styles so strict enterprise CSPs pass untouched.</p>
    </section>
    <section>
      <h2>02 · Guarded MCP server</h2>
      <h3>5 tools · SSRF &amp; DNS-rebinding guard</h3>
      <p>Ships <code>navi-mcp</code> over stdio and authenticated SSE. Refuses loopback, RFC 1918, link-local, cloud metadata IPs, and DNS rebinding before a browser navigation ever starts.</p>
    </section>
    <section>
      <h2>03 · Atomic edge ingestion</h2>
      <h3>Single-RPC quota &amp; map transactions</h3>
      <p>Every sitemap write and Stripe webhook executes inside one transactional database RPC — row-locked quota metering, origin allow-lists, and 24h replay deduplication never drift apart.</p>
    </section>
  </div>

  <div id="quickstart" class="grid">
    <section>
      <h2>1 · Install the kit</h2>
      <pre><code>npm i navi-interaction-bridge</code></pre>
      <p class="muted">Node 22+, zero runtime dependencies. Ships the browser SDK, Playwright adapter, flow CLI (<code>navi</code>), and MCP server (<code>navi-mcp</code>).</p>
    </section>
    <section>
      <h2>2 · Embed the loader</h2>
      <pre><code>${escapeHtml(embed)}</code></pre>
      <p class="muted">Injects <code>&lt;meta name="agent-bridge"&gt;</code> for automatic agent discovery and queues <code>window.Navi</code> calls until the SRI-verified bundle executes.</p>
    </section>
  </div>

  <section>
    <h2>3 · Publish a sitemap to the edge</h2>
    <p>Point the crawler at a rendered page and POST the resulting map to the hosted endpoint. Writes are one transaction: the
      origin decision, the quota charge and the map land together, or none of them do.</p>
    <pre><code>${escapeHtml(publish)}</code></pre>
  </section>

  <section>
    <h2>How self-serve provisioning works</h2>
    <p class="section-sub">Built for standard Stripe Payment Links with zero custom webhook code required on your end.</p>
    <div class="steps">
      <div class="step">
        <span class="step-num">Step 1</span>
        <h3>Checkout via Stripe</h3>
        <p>Pick a plan below. Stripe processes payment and signs a <code>checkout.session.completed</code> webhook to <code>/v1/billing/webhook</code>.</p>
      </div>
      <div class="step">
        <span class="step-num">Step 2</span>
        <h3>Auto-derived tier &amp; tenant</h3>
        <p>The edge verifies the HMAC-SHA256 signature, derives <code>tenant_cus_…</code>, infers your 30-day quota from the billed amount, and mints a 256-bit key.</p>
      </div>
      <div class="step">
        <span class="step-num">Step 3</span>
        <h3>One-time key claim</h3>
        <p>Your redirect to <code>/v1/billing/success?session_id=cs_…</code> atomically deletes the 15-minute claim row and renders your <code>navi_live_…</code> key once.</p>
      </div>
      <div class="step">
        <span class="step-num">Step 4</span>
        <h3>Upgrades &amp; revocation</h3>
        <p>Subscription upgrades raise your ceiling in place without rotating your embedded key; cancellations set the ceiling to <code>0</code> (HTTP 429).</p>
      </div>
    </div>
  </section>

${pricing}

${quickstart}

  <section id="api">
    <h2>Endpoints</h2>
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

  <section>
    <h2>Operational FAQ</h2>
    <div class="faq-grid">
      <div class="faq-item">
        <h3>Why does Pro include a commercial license?</h3>
        <p>The Community edition is licensed under <code>AGPL-3.0-or-later</code>, which requires network services to offer their Corresponding Source. Active Pro and Enterprise subscriptions grant a commercial exemption for proprietary SaaS and internal deployments.</p>
      </div>
      <div class="faq-item">
        <h3>Will upgrading my plan rotate my embedded API key?</h3>
        <p>No. Keys are minted once on initial provisioning. A subsequent <code>customer.subscription.updated</code> event updates your 30-day quota ceiling in place while preserving your live <code>navi_live_…</code> credential and origin allow-list.</p>
      </div>
      <div class="faq-item">
        <h3>What happens when a quota window is exceeded or canceled?</h3>
        <p>Ingestion responds with <code>HTTP 429 {"error":"Quota exceeded"}</code> plus <code>Retry-After</code> and <code>X-Quota-Limit</code> headers — never <code>401 Unauthorized</code> — so your monitoring can distinguish plan exhaustion from a bad credential.</p>
      </div>
      <div class="faq-item">
        <h3>Why does this page ship with <code>default-src 'none'</code>?</h3>
        <p>Every public surface on <code>navi-edge</code> runs zero JavaScript, zero trackers, and zero external fonts. Keeping the root and onboarding pages script-free eliminates XSS exfiltration vectors by construction.</p>
      </div>
    </div>
  </section>

  <footer>
    <span>Navi protocol 0.3.0 · MCP 2025-11-25 · <a href="https://github.com/Wub796/Navi">github.com/Wub796/Navi</a></span>
    <span>License: <code>AGPL-3.0-or-later</code> (Commercial exemption on Pro &amp; Enterprise)</span>
  </footer>
</main>
</body>
</html>
`;
}
