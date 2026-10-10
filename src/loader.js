// Navi tenant loader: the snippet a tenant embeds once.
//
//   <script src="https://cdn.example.com/v1/loader.js"
//           data-key="TENANT_KEY"
//           data-sri="sha384-…"></script>
//
// It is configured entirely by attributes on its own script tag, so the embed
// has no build step and no global-JS ordering requirements:
//
//   data-key  the tenant key, sent as ?key= on the bundle request. Absent or
//             wrong keys are refused by the host with 401, which rejects every
//             queued call rather than leaving it pending.
//   data-sri  the published SHA-384 of navi.min.js (dist/sri.txt). The loader
//             appends it as `integrity` and sets `crossorigin="anonymous"` on
//             the injected tag, so the browser verifies the bytes it executes.
//             The 71-byte hash is not baked into this snippet: that alone would
//             push it past the strict <700-byte budget. The exact tag to paste
//             is printed by `npm run build`.
//
// It also publishes the machine-readable instrumentation marker agents look for
// (`<meta name="agent-bridge" content="active">`), so a page that never saw the
// host's `Link: rel="agent-bridge"` response header - a cached document, a nested
// frame, a proxy that strips headers - still declares that it runs Navi. The
// `data-version` value is read from the SDK that actually executed, so the marker
// cannot drift from the protocol the page is running.
//
// The bundle URL is resolved from the loader's own origin (`new URL(...)`) so the
// loader can be served from a CDN while the page runs on the tenant's origin.
//
// Until the bundle executes, `window.Navi` is a proxy that defers every call to
// the real SDK and returns the real result, so `await Navi.actions()` written
// above the SDK behaves the same as after it loads. Nothing here reads cookies,
// storage or page content.
//
// The JSDoc below is load-bearing for `npm run typecheck` only; the minifier
// strips every byte of it.
(function () {
  var tag = /** @type {HTMLScriptElement | null} */ (document.currentScript);
  if (!tag) return;
  var meta = document.createElement('meta');
  meta.name = 'agent-bridge';
  meta.content = 'active';
  meta.dataset.version = (window.Navi && window.Navi.version) || '';
  document.head.appendChild(meta);
  if (window.Navi) return;
  // Settle/reject the load promise. Typed loosely on purpose: they are assigned
  // synchronously by the executor below, and a stricter annotation makes the
  // compiler reject the handler assignment without changing a single runtime byte.
  /** @type {any} */
  var ok;
  /** @type {any} */
  var no;
  var load = new Promise((resolve, reject) => { ok = resolve; no = reject; });
  /**
   * One deferred call: it runs as soon as the bundle has executed, in call order.
   * @param {string} name
   * @returns {(...args: any[]) => any}
   */
  var deferred = name => (...args) => load.then(() => (/** @type {any} */ (window.Navi))[name](...args));
  // The stub advertises `version: '0.0.0'` and `stub: true`, so an integration can
  // tell "not loaded yet" from the real protocol version, and so the SDK knows to
  // install over it instead of refusing to boot (its guard skips a real Navi).
  window.Navi = /** @type {any} */ (new Proxy({ version: '0.0.0', stub: true }, {
    /** @param {Record<string, any>} target @param {string} name @returns {any} */
    get: (target, name) => name in target ? target[name] : deferred(name)
  }));
  var script = document.createElement('script');
  script.async = true;
  script.src = new URL('/v1/navi.js', tag.src) + '?key=' + encodeURIComponent(tag.dataset.key || '');
  script.integrity = tag.dataset.sri || '';
  script.crossOrigin = 'anonymous';
  script.onload = () => { meta.dataset.version = /** @type {any} */ (window.Navi).version; ok(); };
  script.onerror = no;
  // Injected next to this tag rather than into <head>, which is both what the
  // embed reads like and 15 bytes cheaper than a head lookup.
  tag.after(script);
})();
