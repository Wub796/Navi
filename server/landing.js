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

const STYLE = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 3rem 1.25rem 4rem;
      font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #f6f7f9;
      color: #16181d;
    }
    main { max-width: 52rem; margin: 0 auto; }
    .badge {
      display: inline-block;
      font: 600 .72rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: .09em;
      text-transform: uppercase;
      color: #3f4653;
      background: #e8ebef;
      border-radius: 999px;
      padding: .35rem .6rem;
      margin-bottom: 1rem;
    }
    h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 .6rem; letter-spacing: -.02em; }
    h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; margin: 0 0 .7rem; }
    p { margin: 0 0 1rem; }
    .lede { font-size: 1.05rem; color: #4b515c; margin-bottom: 1.5rem; max-width: 44rem; }
    .muted { color: #6b7280; font-size: .9rem; margin: .7rem 0 0; }
    section, .card {
      background: #fff;
      border: 1px solid #e3e6eb;
      border-radius: 12px;
      padding: 1.1rem 1.25rem;
      margin: 0 0 1.25rem;
      /* The endpoint table keeps its paths whole, so on a narrow viewport the card
         scrolls instead of breaking the path across two lines. */
      overflow-x: auto;
    }
    .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); margin: 0 0 1.25rem; }
    .grid section { margin: 0; }
    code, pre { font: 13.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    td code { white-space: nowrap; }
    pre {
      margin: 0;
      overflow-wrap: anywhere;
      padding: .9rem 1rem;
      background: #f2f4f7;
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
      background: #2f6fed;
      border-radius: 10px;
      padding: .75rem 1.15rem;
    }
    .cta:focus-visible, .cta:hover { background: #245bd0; }
    table { width: 100%; border-collapse: collapse; font-size: .92rem; }
    th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid #e9ecf1; }
    th { font-weight: 600; color: #6b7280; font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; }
    tr:last-child td { border-bottom: 0; }
    td code { font-size: .86rem; }
    .method { font-weight: 650; font-size: .78rem; letter-spacing: .04em; color: #2f6fed; }
    footer { color: #6b7280; font-size: .875rem; margin-top: 2rem; }
    a { color: #2f6fed; }
    @media (prefers-color-scheme: dark) {
      body { background: #0f1115; color: #e6e8ec; }
      .lede, footer, .muted { color: #9aa2af; }
      section, .card { background: #161920; border-color: #262b34; }
      .badge { background: #222834; color: #b6becb; }
      pre { background: #0b0d11; }
      h2, th { color: #9aa2af; }
      th, td { border-bottom-color: #262b34; }
      a { color: #7aa2ff; }
      .cta { background: #3b78f0; color: #fff; }
    }
`;

/** @param {string} method @param {string} path @param {string} detail */
const row = (method, path, detail) => `        <tr><td><span class="method">${method}</span></td><td><code>${escapeHtml(path)}</code></td><td>${detail}</td></tr>`;

/**
 * The landing document.
 *
 * Every interpolated value is escaped: the loader URL and the sitemap URL are
 * derived from the request origin, and the Payment Link comes from configuration,
 * so none of them is allowed to close an attribute or open an element.
 * @param {{loaderUrl?: string, sitemapUrl?: string, paymentLinkUrl?: unknown}} [input]
 * @returns {string}
 */
export function renderLandingPage(input = {}) {
  const loader = escapeHtml(input.loaderUrl ?? '/v1/loader.js');
  const sitemap = escapeHtml(input.sitemapUrl ?? '/v1/sitemap/update');
  const paymentLink = httpsLink(input.paymentLinkUrl);
  const embed = `<script src="${loader}"\n        data-key="navi_live_YOUR_KEY"><\/script>`;
  const publish = `curl -X POST ${sitemap} \\
  -H "Authorization: Bearer $NAVI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://app.example.com","actions":[{"role":"button","name":"Checkout"}]}'`;

  const tier = paymentLink
    ? `  <section class="card">
    <h2>Pro tier</h2>
    <p>Post-sitemap ingestion, per-tenant origin allow-listing and the hosted loader, billed through Stripe. Cancel any time.</p>
    <a class="cta" href="${escapeHtml(paymentLink)}">Subscribe &amp; Get API Key &rarr;</a>
    <p class="muted">Checkout is hosted by Stripe; the API key is shown once on the success page and never again.</p>
  </section>`
    : `  <section class="card">
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
<title>Navi Interaction Bridge</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <span class="badge">navi-edge</span>
  <h1>Deterministic action maps for browser agents</h1>
  <p class="lede">
    Navi turns a rendered page into a stable, addressable action map — roles, names, positions and settle state —
    so an agent can act on intent instead of guessing at selectors. The edge service hosts the loader and the
    authenticated sitemap endpoint; the protocol and the MCP server run in your own process.
  </p>

  <div class="grid">
    <section>
      <h2>Install</h2>
      <pre><code>npm i navi-interaction-bridge</code></pre>
      <p class="muted">Node 22+, no runtime dependencies. Includes the agent CLI and the MCP server.</p>
    </section>
    <section>
      <h2>Embed the loader</h2>
      <pre><code>${escapeHtml(embed)}</code></pre>
      <p class="muted">The loader is served from this origin; the key is issued to your tenant.</p>
    </section>
  </div>

  <section>
    <h2>Publish a sitemap</h2>
    <p>Point the crawler at a page and POST the resulting map to the hosted endpoint. Writes are one transaction: the
      origin decision, the quota charge and the map land together, or none of them do.</p>
    <pre><code>${escapeHtml(publish)}</code></pre>
  </section>

${tier}

  <section>
    <h2>Endpoints</h2>
    <table>
      <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
      <tbody>
${[
  row('POST', '/v1/sitemap/update', 'Authenticated sitemap write; charges the tenant quota window'),
  row('POST', '/v1/billing/webhook', 'Stripe webhook; provisions and suspends tenants'),
  row('GET', '/v1/billing/session', 'One-time checkout claim, as JSON'),
  row('GET', '/v1/billing/success', 'The page that shows a claimed key once'),
  row('GET', '/healthz', 'Liveness, unauthenticated'),
].join('\n')}
      </tbody>
    </table>
  </section>

  <footer>
    Navi protocol 0.3.0 · <a href="https://github.com/Wub796/Navi">github.com/Wub796/Navi</a> ·
    <code>AGPL-3.0-or-later</code>
  </footer>
</main>
</body>
</html>
`;
}
