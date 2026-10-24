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
// inspector on the stage, the integration tabs, and the FAQ's
// native `<details>` are the only behaviours, and every one of them works with
// scripts disabled and under `default-src 'none'`.
//
// The motion layer is CSS too: `landing-motion.js` is appended last, so the page
// animates on scroll and on hover without gaining a script or a CSP directive.

import { escapeHtml } from './billing-success.js';
import { BENCHMARK_STYLE, renderBenchmarkEvidence } from './landing-calculator.js';
import { renderHeroMonogram } from './landing-hero.js';
import { INSPECTOR_STYLE } from './landing-inspector.js';
import { LANDING_MOTION_STYLE } from './landing-motion.js';
import { renderLandingStage, STAGE_STYLE } from './landing-stage.js';
import { LANDING_STYLE } from './landing-styles.js';
import { TIERS } from './pricing.js';

/**
 * The operational FAQ, as one source of truth for both the visible page and the
 * FAQPage structured data. Keeping two copies would let the markup and the schema
 * disagree while both look correct, which is exactly the failure a search engine
 * penalises and a reader cannot see. `answer` is HTML because the visible copy
 * links the commercial terms and marks code; the JSON-LD is derived from it.
 * @type {readonly {question: string, answer: string}[]}
 */
const FAQ_ENTRIES = Object.freeze([
  { question: 'What can Navi see, and which data leaves the page?', answer: 'Load Navi before application scripts to capture closed shadow roots created afterward. Action maps omit input values, but accessible names, labels, URLs, and page text can still contain sensitive information. This is not a general PII scrubber. The local MCP server returns maps to your agent host; hosted publishing additionally sends the submitted map to the configured endpoint.' },
  { question: 'Are maps backed up, and what does retention cover?', answer: 'Navi does not create backups or guarantee replication or point-in-time recovery. Hosted maps are stored in the configured Supabase project; self-hosted data lives in the configured SQLite or JSONL store, which must be placed on persistent storage to survive container replacement. Persistent storage is not a backup: configure and verify backups in your own Supabase or hosting environment. The self-hosted <code>NAVI_RETENTION_DAYS</code> setting prunes containment-audit violations only; it does not expire stored maps. Navi does not expose a map backup or expiry control.' },
  { question: 'How is this different from Playwright MCP, Stagehand or WebMCP?', answer: 'Navi focuses on structured control discovery and guarded interaction. Evaluate it alongside your existing browser tools using the same workflow and independent outcome check. Use Navi for scoped text reads, common keyboard interactions, and top-document scrolling. Keep your browser driver for screenshots, unsupported shortcuts, and scrolling inside frames or shadow roots. The linked evidence is a local fixture, not a head-to-head evaluation of Playwright MCP, Stagehand, or WebMCP.' },
  { question: 'Why use DOM action maps instead of VLM screenshots or raw HTML scraping?', answer: 'A structured map gives an agent target IDs, roles, accessible names, coordinates, and actionability state. Differential reads can reduce repeated context on changing pages. Map size depends on the page; our checkout fixture used more tokens than its Playwright baseline. Optional settlement reports a requested page condition, is not cryptographically signed, and does not prove a business transaction succeeded.' },
  { question: 'Is page text returned by navi_read_text visibly rendered?', answer: 'The tool reads bounded <code>innerText</code> and reports a visibility flag based on layout, hidden/ARIA-hidden ancestors, and computed display, visibility, and opacity. Hidden elements can still return non-rendered text; the flag is not proof that a human can perceive the content. Treat all returned page text as untrusted.' },
  { question: 'Why does Pro include a commercial license?', answer: 'Community uses <code>AGPL-3.0-or-later</code>. Pro and Enterprise add commercial rights under the <a href="https://github.com/Wub796/Navi/blob/main/COMMERCIAL-TERMS.md">commercial terms</a>: you can embed Navi in products you sell and use it to do work for your own customers. What the licence excludes is passing Navi itself on — reselling it as a browser-automation SDK or hosted service, or shipping a competing fork. Evaluating it without a subscription, including a one-workflow pilot, is permitted.' },
  { question: 'Will upgrading my plan rotate my embedded API key?', answer: 'No. Keys are minted once on initial provisioning. A subsequent <code>customer.subscription.updated</code> event updates your 30-day quota ceiling in place while preserving your live <code>navi_live_…</code> credential and origin allow-list.' },
  { question: 'What happens when a quota window is exceeded or canceled?', answer: 'An edge bundle serve or sitemap write past the shared quota window responds with <code>HTTP 429 {"error":"Quota exceeded"}</code> plus <code>Retry-After</code> and <code>X-Quota-Limit</code> headers — never <code>401 Unauthorized</code> — so your monitoring can distinguish plan exhaustion from a bad credential. Canceled or suspended tenants also receive 429; no bundle bytes are returned. The separate self-hosted telemetry endpoint has its own quota configuration.' },
  { question: 'Why does this page ship with <code>default-src \'none\'</code>?', answer: 'This landing page and the onboarding page load no executable client-side script and no external font. Their Content Security Policy limits resource loading. These choices reduce the attack surface; they do not replace correct escaping, access controls, and security testing.' }
]);

/**
 * Plain text for a schema answer. FAQ answers are authored as HTML for the page,
 * and structured data must carry text: tags would be read literally, and an
 * entity like `&amp;` would reach the index undecoded.
 * @param {string} html
 * @returns {string}
 */
function schemaText(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Machine-readable description of this page: the product and the FAQ.
 *
 * Emitted as a `application/ld+json` data block, which browsers parse and never
 * execute; it is not covered by `script-src` and produces no CSP violation under
 * `default-src 'none'` (verified in Chromium). `<` is escaped inside the JSON so
 * an answer can never close the element early.
 * @param {{links: Record<string, string | null>}} input
 * @returns {string}
 */
function renderStructuredData({ links }) {
  const origin = 'https://navi-edge.sysctl.workers.dev/';
  /** Only tiers this deployment can actually sell carry an offer. */
  const offers = TIERS
    .filter(tier => tier.priceCents > 0 && links[tier.id])
    .map(tier => ({
      '@type': 'Offer',
      name: tier.name,
      price: (tier.priceCents / 100).toFixed(2),
      priceCurrency: 'USD',
      url: links[tier.id],
      category: 'subscription'
    }));
  const graph = [
    {
      '@type': 'SoftwareApplication',
      name: 'Navi',
      url: origin,
      description: 'Browser interaction SDK and Model Context Protocol (MCP) server that maps a page\'s controls to named targets with live actionability checks.',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Node.js 22 or later',
      license: 'https://github.com/Wub796/Navi/blob/main/LICENSING.md',
      ...(offers.length ? { offers } : {})
    },
    {
      '@type': 'FAQPage',
      mainEntity: FAQ_ENTRIES.map(entry => ({
        '@type': 'Question',
        name: schemaText(entry.question),
        acceptedAnswer: { '@type': 'Answer', text: schemaText(entry.answer) }
      }))
    }
  ];
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * Headers the landing page is served with.
 *
 * `no-store` because the page embeds the deployment's Payment Link, which is
 * configuration rather than content; `frame-ancestors` is not in the CSP because
 * `X-Frame-Options: DENY` covers the framing and the policy is kept to the three
 * directives the page actually needs. `img-src 'self'` is the third and it is not
 * optional: the page links its own favicon, and under a bare `default-src 'none'`
 * the browser refuses to load it and logs a violation.
 */
export const LANDING_PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
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
    'Local SQLite WAL or JSONL storage for audit records and maps',
    'Stdio & SSE MCP server (8 agent tools)',
    'AGPL-3.0-or-later open-source license',
  ],
  starter: [
    'Hosted browser bundle and sitemap publishing, each quota-metered',
    'Per-tenant allowed_origins enforcement',
    'Instant post-checkout API key claim',
    'Atomic 30-day quota window',
  ],
  pro: [
    '50,000 quota units / 30 days (bundle serves or sitemap writes)',
    'Commercial license — AGPL-3.0 exemption',
    'Proprietary & closed-source SaaS embed',
    'Origin allow-lists & persistent tenant config',
  ],
  enterprise: [
    '250,000 quota units / 30 days (bundle serves or sitemap writes)',
    'Commercial self-hosted Docker license',
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
    : `${tier.maxEventsPerWindow.toLocaleString('en-US')} quota units / 30 days`;
  const featured = tier.id === 'pro';
  const ribbon = featured ? '\n      <span class="tier-ribbon">Commercial license</span>' : '';
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
  const embed = `<script src="${loader}"\n        data-key="navi_live_YOUR_KEY"\n        data-sri="sha384-YOUR_BUILD_HASH"><\/script>`;
  const publish = `curl -X POST ${sitemap} \\
  -H "Authorization: Bearer $NAVI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Origin: https://app.example.com" \\
  -d '{"url":"https://app.example.com","actions":[{"target_id":"checkout-submit","role":"button","name":"Checkout","action":"click","selector":"#checkout-submit","disabled":false}]}'`;
  const mcpSnippet = `npm i --save-dev navi-interaction-bridge playwright
npx playwright install chromium
# Start stdio MCP (normally launched by your MCP client):
npx -y -p navi-interaction-bridge -p playwright navi-mcp`;
  const openapiSnippet = `curl -sS ${escapeHtml((input.sitemapUrl ?? '/v1/sitemap/update').replace(/\/update$/, '/openapi.json'))} \\
  -H "Authorization: Bearer $NAVI_API_KEY"`;

  const rawDomExample = `<div class="sc-92x-btn" onclick="run()">
  <span class="icon-wrap"><svg>...</svg></span>
  <!-- 4,200 nodes of nested layout noise -->
</div>
// Agent guesses selector ".sc-92x-btn" -> breaks on next deploy`;

  const actionMapExample = `{
  "target_id": "checkout-submit",
  "role": "button",
  "name": "Complete sandbox checkout",
  "suggested_action": "click",
  "state": {
    "is_visible": true, "is_enabled": true,
    "is_in_viewport": true, "is_occluded": false
  },
  "coordinates": { "x": 412, "y": 288, "width": 140, "height": 44 }
}`;

  const pricing = `  <section id="pricing">
    <h2>06 — Pricing</h2>
    <p class="section-title">Optional hosted plans and commercial licensing</p>
    <p class="section-sub">${purchasing ? 'Hosted plans meter browser-bundle serves and accepted sitemap writes together. Choose a plan and claim your API key after checkout; local MCP evaluation remains free.' : 'Hosted checkout is not configured on this deployment. Start locally or contact us about hosted access.'}</p>
    <div class="tiers">
${TIERS.map(tier => renderTier(tier, links[tier.id] ?? null)).join('\n')}
    </div>
    <p class="muted">Checkout is hosted by Stripe; the tenant key is shown once on the success page and never again. Each authorized browser-bundle serve (including a cache revalidation, 304) and each accepted sitemap write consumes one quota unit from the tenant's 30-day window. The quota is shared by those two operations. When the ceiling is reached, further bundle serves and sitemap writes are refused until the window resets or the plan changes; no automatic overage billing is applied.</p>
  </section>`;

  const quickstart = `  <section id="start" class="card">
    <h2>Start here — free local evaluation</h2>
    <p>Use Node 22+ and an MCP-compatible agent. No hosted API key or payment is needed. Community use is covered by the <a href="https://github.com/Wub796/Navi/blob/main/LICENSING.md">AGPL license</a>.</p>
    <h3>1. Install Chromium</h3>
    <pre><code>npx playwright install chromium</code></pre>
    <h3>2. Add Navi to your MCP client configuration</h3>
    <pre><code>{
  "mcpServers": {
    "navi": {
      "command": "npx",
      "args": ["-y", "-p", "navi-interaction-bridge", "-p", "playwright", "navi-mcp"]
    }
  }
}</code></pre>
    <h3>3. Inspect a page</h3>
    <p>Ask your agent: “Open https://example.com with Navi and list the available actions.” It should call <code>navi_navigate</code>, then <code>navi_get_actions</code>. A page with no interactive controls can correctly return an empty map.</p>
    <p><a href="https://github.com/Wub796/Navi#run-from-source">Run the interactive sandbox from source &nearr;</a> · <a href="https://github.com/Wub796/Navi/blob/main/docs/AGENT-INTEGRATION.md">Integration guide &nearr;</a></p>
    <p class="muted">Use <code>navi_read_text</code> for scoped page text and <code>navi_press_key</code> for supported keyboard interactions. Keep your browser driver for screenshots and unsupported controls. Settlement checks page conditions; verify saved records or completed orders separately.</p>
  </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="description" content="Navi is the AI browser agent SDK and Model Context Protocol (MCP) browser bridge turning live DOM and closed Shadow DOM into structured JSON action maps for browser workflow builders.">
<link rel="canonical" href="https://navi-edge.sysctl.workers.dev/">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#0b0b0b">
<meta property="og:title" content="Navi — AI Browser Agent SDK &amp; Deterministic MCP Bridge">
<meta property="og:description" content="Navi is the AI browser agent SDK and Model Context Protocol (MCP) browser bridge turning live DOM and closed Shadow DOM into structured JSON action maps for browser workflow builders.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://navi-edge.sysctl.workers.dev/">
<meta property="og:site_name" content="Navi Interaction Bridge">
<meta property="og:image" content="https://navi-edge.sysctl.workers.dev/logo.svg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Navi — AI Browser Agent SDK &amp; Deterministic MCP Bridge">
<meta name="twitter:description" content="Navi is the AI browser agent SDK and Model Context Protocol (MCP) browser bridge turning live DOM and closed Shadow DOM into structured JSON action maps for browser workflow builders.">
<meta name="twitter:image" content="https://navi-edge.sysctl.workers.dev/logo.svg">
<title>Navi — AI Browser Agent SDK &amp; Deterministic MCP Bridge</title>
<style>${LANDING_STYLE}${STAGE_STYLE}${INSPECTOR_STYLE}${BENCHMARK_STYLE}${LANDING_MOTION_STYLE}</style>
${renderStructuredData({ links })}
</head>
<body>
<main>
  <header class="topbar">
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#0b0b0b"/><rect x="4" y="4" width="56" height="56" rx="9" stroke="#f2f0ea" stroke-opacity=".24" stroke-width="2"/><path d="M14 42L32 51L50 42L32 33L14 42Z" fill="#161614" stroke="#f2f0ea" stroke-opacity=".38" stroke-width="2"/><path d="M14 32L32 41L50 32L32 23L14 32Z" fill="#ffd600" fill-opacity=".14" stroke="#ffd600" stroke-opacity=".6" stroke-width="2"/><path d="M14 22L32 31L50 22L32 13L14 22Z" fill="#ffd600" stroke="#ffd600" stroke-width="2"/><path d="M27 19.5V24.5L35 19.5V24.5" stroke="#101010" stroke-width="2.6" stroke-linecap="square"/><circle cx="49" cy="15" r="3.5" fill="#ffd600"/></svg></span>
      <span>navi</span>
    </a>
    <nav class="topnav" aria-label="Primary">
      <a href="#stage">Model</a>
      <a href="#architecture">Architecture</a>
      <a href="#quickstart">Integration</a>
      <a href="#savings">Evidence</a>
      <a href="#pricing">Pricing</a>
      <a href="#api">API</a>
      <a href="#faq">FAQ</a>
      <a href="https://github.com/Wub796/Navi">GitHub</a>
      <a class="nav-key" href="#start">Try locally &nearr;</a>
    </nav>
  </header>

  <section class="hero">
    <div class="hero-copy">
      <p class="kicker">For teams building browser workflow agents · protocol 0.3.0</p>
      <h1>Navi — Deterministic<br>action maps for<br><em>browser agents.</em></h1>
      <p class="lede">
        Building an agent for browser workflows? Give it named controls, current actionability checks, and optional waits for page changes. Navi adds structured interaction to your existing browser stack, including captured closed Shadow DOM and same-origin frames.
      </p>
      <p class="answer"><strong>What is Navi?</strong> Navi is an open-source (AGPL-3.0) browser interaction SDK and MCP server. It turns a page's controls into named target IDs that an agent can click, type into or select, with a receipt for each action.</p>
      <div class="hero-actions">
        <a class="cta" href="#start">Try locally — free &rarr;</a>
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

${renderHeroMonogram()}

    <div class="hero-stats" role="region" aria-label="Verified protocol specifications">
      <div class="stat">
        <p class="stat-value">5.9 kB gzip</p>
        <p class="stat-label">SDK bundle · 14,929 B raw · SHA-384 digest</p>
      </div>
      <div class="stat">
        <p class="stat-value">689 B</p>
        <p class="stat-label">Tenant embed loader · built-in discovery</p>
      </div>
      <div class="stat">
        <p class="stat-value">Browser suite</p>
        <p class="stat-label">Chromium · MCP · database checks vary by host</p>
      </div>
      <div class="stat">
        <p class="stat-value">10 paired trials</p>
        <p class="stat-label">Local checkout fixture · no LLM planner</p>
      </div>
    </div>
  </section>

  <div class="shell">

${quickstart}

${renderLandingStage()}

  <div id="why-navi" class="compare">
    <section class="bad-card">
      <h2>Without Navi · Raw HTML &amp; Screenshot VLMs</h2>
      <span class="pill bad">Without Navi · Raw DOM scraping</span>
      <h3 class="img">Fragile selectors &amp; blind sleeps</h3>
      <p>Raw DOM and screenshot-based approaches can require extra page context and application-specific targeting; Navi offers structured controls when their roots were captured and reports current actionability before dispatch.</p>
      <pre><code>${escapeHtml(rawDomExample)}</code></pre>
    </section>
    <section class="good-card">
      <h2>With Navi · Deterministic Web Agent Automation</h2>
      <span class="pill good">With Navi · Deterministic protocol</span>
      <h3 class="img">Semantic targets &amp; page-condition waits</h3>
      <p>Indexed controls get target IDs and live visibility, viewport, and occlusion checks. Optional waits report page conditions such as DOM quiet, navigation, or target disappearance; verify the saved result separately.</p>
      <pre><code>${escapeHtml(actionMapExample)}</code></pre>
    </section>
  </div>

  <section id="architecture">        <h2>How does Navi turn a live page into actions an agent can take?</h2>
    <p class="section-title">Start locally; publish maps when you need storage</p>
    <p class="section-sub">The local MCP server talks directly to your browser. Hosted publishing stores maps in the configured Supabase project and shares its quota with browser-bundle serves; local use needs no hosted account. Navi does not create backups or guarantee replication or point-in-time recovery; configure and verify backups in the storage environment you operate.</p>
    <svg class="pipeline-svg" viewBox="0 0 880 128" role="img" aria-label="Optional hosted publishing path from Browser DOM through Edge and storage to a consuming agent">
      <line class="flow-line" x1="195" y1="64" x2="245" y2="64" />
      <line class="flow-line" x1="425" y1="64" x2="475" y2="64" />
      <line class="flow-line" x1="655" y1="64" x2="705" y2="64" />
      <rect class="flow-node" x="15" y="22" width="180" height="84" rx="2" />
      <circle class="flow-dot" cx="34" cy="44" r="4.5" />
      <text class="flow-title" x="46" y="48">1. Browser DOM</text>
      <text class="flow-sub" x="30" y="68">2 ms traversal work target</text>
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
        <h3>Captured closed Shadow DOM and control discovery</h3>
        <p>A TreeWalker crawler targets a 2 ms work slice and hooks <code>attachShadow</code> when Navi loads. It captures closed roots created afterward; load before application scripts. Input values are omitted from maps, but accessible names may still contain sensitive data.</p>
        <ul class="pillar-list">
          <li>Input values are not included in action maps; other text may be sensitive</li>
          <li>MurmurHash3 target IDs with center-point occlusion checks</li>
        </ul>
      </section>
      <section>
        <h2>02 · Guarded MCP server</h2>
        <h3>Local MCP server &amp; network destination checks</h3>
        <p>Ships <code>navi-mcp</code> over stdio and optional bearer-authenticated SSE. URL checks reject loopback, private-network, cloud-metadata destinations, and DNS rebinding; they do not replace deployment egress controls.</p>
        <ul class="pillar-list">
          <li>7 tools include bounded text reading, top-document scrolling, and page-condition waits</li>
          <li>Text, accessible names, URLs and tool instructions remain untrusted input</li>
        </ul>
      </section>
      <section>
        <h2>03 · Atomic edge ingestion</h2>
        <h3>Atomic edge quota and map writes</h3>
        <p>Each hosted sitemap write combines origin checks, quota charging, and map storage in one Supabase transaction. Stripe webhook verification and tenant updates also use a transactional RPC.</p>
        <ul class="pillar-list">
          <li>Timestamped HMAC-SHA256 signature verification within a 300-second window</li>
          <li>Hosted Supabase storage; self-hosted maps and audit records use SQLite WAL or JSONL</li>
        </ul>
      </section>
    </div>
  </section>

  <section id="quickstart">
    <h2>03 — Integration: Local MCP, Browser Loader &amp; Hosted API</h2>
    <p class="section-title">Drop-in browser loader, edge ingestion API, or local MCP host</p>
    <p class="section-sub">Start with local MCP. Use the browser loader when you control the page, or the hosted API to store maps for your application.</p>
    <div class="tabs">
      <input class="tab-radio" type="radio" name="integration-tab" id="tab-loader" checked>
      <label class="tab-label" for="tab-loader">1 · Browser Script Loader</label>
      <input class="tab-radio" type="radio" name="integration-tab" id="tab-edge">
      <label class="tab-label" for="tab-edge">2 · Edge API (POST /v1/sitemap/update)</label>
      <input class="tab-radio" type="radio" name="integration-tab" id="tab-mcp">
      <label class="tab-label" for="tab-mcp">3 · Local MCP Server</label>
      <input class="tab-radio" type="radio" name="integration-tab" id="tab-openapi">
      <label class="tab-label" for="tab-openapi">4 · OpenAPI 3.1 &amp; Workflows</label>

      <div class="tab-panel" id="panel-loader">
        <h3>1 · Embed the 689 B tenant loader</h3>
        <pre><code>${escapeHtml(embed)}</code></pre>
        <p class="muted">Load before application scripts to capture closed Shadow roots. The 689 B loader reads <code>data-key</code> and loads the metered browser bundle. Replace <code>YOUR_BUILD_HASH</code> with the exact SHA-384 from the build output to enable Subresource Integrity; without it, the browser does not verify the bundle before execution. Injects <code>&lt;meta name="agent-bridge"&gt;</code> for automatic agent discovery and queues <code>window.Navi</code> calls until the 14,929 B bundle executes. Each bundle request uses one unit from the shared hosted quota.</p>
      </div>
      <div class="tab-panel" id="panel-edge">
        <h3>2 · Publish DOM to JSON Action Maps to the Hosted Edge API</h3>
        <pre><code>${escapeHtml(publish)}</code></pre>
        <p class="muted">Replace the sample URL and control with your page data. The Origin header and page URL must match an origin allowed for your tenant key. Hosted publishing validates the payload, meters the quota, and stores the map.</p>
      </div>
      <div class="tab-panel" id="panel-mcp">
        <h3>3 · Run the Local MCP Server</h3>
        <pre><code>${escapeHtml(mcpSnippet)}</code></pre>
        <p class="muted">Node 22+ and Playwright with Chromium installed. Exposes <code>navi_navigate</code>, <code>navi_get_actions</code> (optional <code>compact:true</code>), <code>navi_scroll_to</code>, <code>navi_execute_action</code>, <code>navi_read_text</code>, <code>navi_press_key</code>, <code>navi_assert_state</code>, and <code>navi_set_session</code>.</p>
      </div>
      <div class="tab-panel" id="panel-openapi">
        <h3>4 · Synthesize Typed OpenAPI 3.1 Workflows from Stored Sitemaps</h3>
        <pre><code>${openapiSnippet}</code></pre>
        <p class="muted">Compiles the latest stored map into an OpenAPI <code>3.1.0</code> document with typed <code>enum</code>/<code>format</code> parameters, <code>x-navi-risk-level</code> (<code>"read" | "write" | "destructive"</code>), and server-side <code>resolveTarget</code> matching (confidence &ge; <code>0.85</code>). These are generated schemas; executing their operations requires your own workflow runner and outcome checks.</p>
      </div>
    </div>
  </section>

  <section>
    <h2>04 — Provisioning</h2>
    <p class="section-title">How self-serve provisioning works</p>
    <p class="section-sub">3-step Stripe Checkout to a one-time API key claim; availability depends on the deployment's configured Payment Links and webhook.</p>
    <div class="steps-3">
      <div class="step">
        <span class="step-num">Step 1 · Stripe Checkout</span>
        <h3>Select a commercial plan</h3>
        <p>Complete checkout on a hosted Stripe Payment Link. Stripe signs a <code>checkout.session.completed</code> event and delivers it to <code>/v1/billing/webhook</code>.</p>
      </div>
      <div class="step">
        <span class="step-num">Step 2 · /v1/billing/webhook</span>
        <h3>Atomic tenant &amp; quota minting</h3>
        <p>The edge verifies the timestamped HMAC-SHA256 signature within a 300-second tolerance, derives <code>tenant_cus_…</code>, infers your 30-day quota from billed cents, and mints a 256-bit key in a database transaction.</p>
      </div>
      <div class="step">
        <span class="step-num">Step 3 · /v1/billing/success</span>
        <h3>One-time browser key claim</h3>
        <p>Stripe redirects your browser to <code>/v1/billing/success?session_id=cs_…</code>, which atomically deletes the 15-minute claim row and reveals your <code>navi_live_…</code> credential once.</p>
      </div>
    </div>
  </section>

${renderBenchmarkEvidence()}

${pricing}


  <section id="api">
    <h2>07 — API</h2>
    <p class="section-title">Eight public surfaces</p>
    <table>
      <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
      <tbody>
${[
  row('GET', '/v1/loader.js', 'Anonymous, cacheable tenant embed snippet; reads data-key from its own tag'),
  row('GET', '/v1/navi.js?key=…', 'Serves the browser bundle after tenant-key and quota checks; each authorized request consumes one unit'),
  row('POST', '/v1/sitemap/update', 'Authenticated sitemap write; verifies origin allow-list and charges the tenant quota window'),
  row('GET', '/v1/sitemap/openapi.json', 'Authenticated OpenAPI 3.1 workflow compiler; groups stored controls with x-navi-risk-level and resolveTarget metadata'),
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
${FAQ_ENTRIES.map(entry => `      <details class="faq-item">
        <summary>${entry.question}</summary>
        <p>${entry.answer}</p>
      </details>`).join('\n')}
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
