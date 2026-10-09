// Navi Protocol: custom in-page tools, not authorization or trusted browser input.
(() => {
  // A tenant loader installs a deferred stub before this bundle arrives; it is not
  // an SDK, so this installs over it and the loader replays the calls that the
  // stub queued. Any other pre-existing Navi is left alone.
  if (window.Navi && !window.Navi.stub) return;
  const version = '0.2.0', attr = 'data-agent-target';
  const native = new Set(['button', 'form', 'select', 'textarea', 'summary']);
  const roles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'combobox', 'textbox']);
  const watched = ['role', 'href', 'type', 'onclick', 'data-navi-action', 'data-navi-key', 'aria-label', 'aria-labelledby', 'name', 'id'];
  // Pin the DOM primitives this SDK depends on, once, in this closure. A host page
  // that later replaces, wraps or freezes these cannot then bend or break target
  // discovery, occlusion checks or execution. Brand-checked natives stay callable
  // on elements from other same-origin realms, so frame documents work unchanged.
  const P = {
    createElement: document.createElement,
    rect: Element.prototype.getBoundingClientRect,
    attachShadow: Element.prototype.attachShadow,
    mutation: MutationObserver,
    intersection: typeof IntersectionObserver === 'function' ? IntersectionObserver : null,
    computed: Window.prototype.getComputedStyle || window.getComputedStyle,
    walker: Document.prototype.createTreeWalker,
    point: Document.prototype.elementFromPoint,
    shadowPoint: typeof ShadowRoot === 'function' ? ShadowRoot.prototype.elementFromPoint : null,
    idle: typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback.bind(window) : null,
    frame: window.requestAnimationFrame.bind(window),
    micro: queueMicrotask.bind(window)
  };
  /** @typedef {Document | ShadowRoot} Root */
  /** @typedef {{step: () => boolean, cancel?: () => void}} Job */
  /** @typedef {{observer: MutationObserver, frame: HTMLIFrameElement | null}} RootState */
  /** @typedef {{prototype: typeof Element.prototype, original: typeof Element.prototype.attachShadow, wrapper: typeof Element.prototype.attachShadow}} Hook */
  /** @type {Map<Root, RootState>} */
  const roots = new Map();
  /** @type {Map<HTMLIFrameElement, () => void>} */
  const frames = new Map();
  /** @type {Map<Document, Hook>} */
  const hooks = new Map();
  /** @type {WeakMap<Element, ShadowRoot>} */
  const captured = new WeakMap();
  /** @type {WeakMap<Element, string>} */
  const generated = new WeakMap();
  /** @type {WeakMap<Element, number>} */
  const positions = new WeakMap();
  /** @type {WeakMap<Element, WeakRef<Element>>} */
  const references = new WeakMap();
  /** @type {Set<WeakRef<Element>>} */
  const index = new Set();
  /** @type {WeakSet<Node>} */
  const walking = new WeakSet();
  /** @type {WeakSet<Node>} */
  const dirty = new WeakSet();
  /** @type {WeakSet<Element>} */
  const deferred = new WeakSet();
  /** @type {Set<Job>} */
  const urgent = new Set(), background = new Set();
  /** @type {Set<{resolve: () => void, reject: (error: Error) => void}>} */
  const waiters = new Set();
  const counters = { tagged: 0, scanned: 0, ticks: 0, maxTickMs: 0, overBudgetTicks: 0, initialMs: 0 };
  /** @type {number[]} */
  const samples = [];
  let stopped = false, busy = false, scheduled = false, handle = 0, frameFallback = false;
  const startTime = performance.now();
  /** @type {IntersectionObserver | null} */
  const intersection = P.intersection ? new P.intersection(entries => {
    let i = 0;
    enqueue({ step: () => {
      const entry = entries[i++];
      if (entry?.isIntersecting && deferred.has(entry.target)) {
        deferred.delete(entry.target);
        intersection?.unobserve(entry.target);
        classify(entry.target);
      }
      return i >= entries.length;
    } }, true);
  }) : null;

  /** @param {string} code @param {string} message */
  function error(code, message) { return Object.assign(new Error(message), { code }); }
  function guard() { if (stopped) throw error('STOPPED', 'Navi has stopped'); }
  /** @param {Job} job @param {boolean} [priority] */
  function enqueue(job, priority = false) {
    if (stopped) { job.cancel?.(); return; }
    (priority ? urgent : background).add(job);
    schedule();
  }
  function schedule() {
    if (scheduled || stopped) return;
    scheduled = true;
    if (P.idle) {
      frameFallback = false;
      handle = P.idle(tick, { timeout: 100 });
    } else {
      frameFallback = true;
      handle = P.frame(() => P.micro(() => tick()));
    }
  }
  /** @param {IdleDeadline} [deadline] */
  function tick(deadline) {
    scheduled = false;
    if (stopped) return;
    const start = performance.now();
    let operations = 0;
    // Small work target leaves headroom for non-preemptible native/GC work.
    while (operations++ < 512 && performance.now() - start < 2 &&
      (!deadline || deadline.didTimeout || deadline.timeRemaining() > 1)) {
      const queue = urgent.size ? urgent : background;
      const job = queue.values().next().value;
      if (!job) break;
      if (job.step()) queue.delete(job);
    }
    const duration = performance.now() - start;
    counters.ticks++;
    counters.maxTickMs = Math.max(counters.maxTickMs, duration);
    if (duration > 6) counters.overBudgetTicks++;
    samples.push(duration);
    if (samples.length > 512) samples.shift();
    if (urgent.size || background.size) schedule();
    else {
      if (!counters.initialMs) counters.initialMs = performance.now() - startTime;
      for (const waiter of waiters) waiter.resolve();
      waiters.clear();
    }
  }
  function ready() {
    guard();
    // Let pending MutationObserver deliveries enqueue work before testing quiescence.
    return Promise.resolve().then(() => new Promise(/** @param {(value?: void) => void} resolve */ (resolve, reject) => {
      if (stopped) reject(error('STOPPED', 'Navi has stopped'));
      else if (urgent.size || background.size || scheduled) waiters.add({ resolve, reject });
      else resolve();
    }));
  }

  /** @param {Element} el */
  function interactive(el) {
    const tag = el.localName;
    return native.has(tag) || (tag === 'a' && el.hasAttribute('href')) ||
      (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() !== 'hidden') ||
      roles.has(el.getAttribute('role') || '') || el.hasAttribute('onclick') || el.hasAttribute('data-navi-action');
  }
  /** @param {Element} el */
  function role(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.localName, type = el.getAttribute('type')?.toLowerCase();
    if (tag === 'input') return type === 'checkbox' || type === 'radio' ? type :
      ['submit', 'button', 'reset', 'image'].includes(type || '') ? 'button' : 'textbox';
    return tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' :
      tag === 'summary' ? 'button' : tag;
  }
  /** @param {Element} el */
  function name(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.slice(0, 256);
    const root = /** @type {Root} */ (el.getRootNode());
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 8);
    const referenced = ids.map(id => root.getElementById?.(id)?.textContent?.slice(0, 128) || '').join(' ').trim();
    if (referenced) return referenced.slice(0, 256);
    const labels = ['input', 'select', 'textarea'].includes(el.localName) ? /** @type {HTMLInputElement} */ (el).labels : null;
    if (labels?.length) return (labels[0].textContent || '').trim().slice(0, 256);
    if (!['form', 'select', 'input', 'textarea'].includes(el.localName)) {
      const walker = P.walker.call(el.ownerDocument, el, 4);
      let text = '', count = 0, node;
      while (count++ < 12 && text.length < 256 && (node = walker.nextNode())) text += ' ' + (node.textContent || '').slice(0, 128);
      if (text.trim()) return text.trim().replace(/\s+/g, ' ').slice(0, 256);
    }
    return (el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || role(el)).slice(0, 256);
  }
  /** @param {string} value */
  function slug(value) {
    return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'action';
  }
  /** MurmurHash3 x86/32 over UTF-8 bytes; deterministic, non-cryptographic.
   * @param {string} text */
  function hash(text) {
    const bytes = new TextEncoder().encode(text);
    let h = 0, i = 0, k = 0;
    const mix = (/** @type {number} */ value) => {
      value = Math.imul(value, 0xcc9e2d51);
      value = (value << 15) | (value >>> 17);
      return Math.imul(value, 0x1b873593);
    };
    for (; i + 3 < bytes.length; i += 4) {
      k = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
      h ^= mix(k); h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }
    k = 0;
    for (let shift = 0; i < bytes.length; i++, shift += 8) k |= bytes[i] << shift;
    if (k) h ^= mix(k);
    h ^= bytes.length;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  /** @param {Element} el */
  function fingerprint(el) {
    const label = name(el), keyOwner = el.closest('[data-navi-key]');
    const key = keyOwner?.getAttribute('data-navi-key');
    let landmark = '', depth = 0;
    let parent = keyOwner?.parentElement || el.parentElement;
    while (parent && depth++ < 32) {
      const id = parent.getAttribute(attr) || parent.id;
      const landmarkRole = parent.getAttribute('role');
      if (id || ['form', 'main', 'nav', 'section'].includes(parent.localName) || landmarkRole === 'dialog') {
        landmark = `${parent.localName}:${id || parent.getAttribute('aria-label') || landmarkRole || ''}`;
        break;
      }
      parent = parent.parentElement;
    }
    const identity = el.getAttribute('data-navi-action') || el.id || el.getAttribute('name');
    const prefix = identity || label;
    // Stable keyed controls omit positional/name drift only when a control ID is available.
    const signature = key != null ? [landmark, key, el.localName, identity || label] :
      [landmark, el.localName, identity || label, positions.get(el) || 1];
    return `${slug(prefix)}-${hash(JSON.stringify(signature))}`;
  }
  /** @param {Element} el */
  function classify(el) {
    if (!el.isConnected || !interactive(el)) return;
    let reference = references.get(el);
    if (!reference) { reference = new WeakRef(el); references.set(el, reference); }
    index.add(reference);
    const previous = generated.get(el), existing = el.getAttribute(attr);
    if (existing != null && existing !== previous) return;
    const target = fingerprint(el);
    if (!previous) counters.tagged++;
    generated.set(el, target);
    if (existing !== target) el.setAttribute(attr, target);
  }

  /** @param {HTMLIFrameElement} frame */
  function frameDocument(frame) { try { return frame.contentDocument; } catch { return null; } }
  /** @param {Root} root @returns {boolean} */
  function alive(root) {
    if (root === document) return true;
    if (root.nodeType === 11) {
      const host = /** @type {ShadowRoot} */ (root).host;
      return host.isConnected && alive(/** @type {Root} */ (host.getRootNode()));
    }
    const frame = roots.get(root)?.frame;
    return !!frame && frame.isConnected && frameDocument(frame) === root && alive(/** @type {Root} */ (frame.getRootNode()));
  }
  /** @param {Document} doc */
  function hook(doc) {
    if (hooks.has(doc)) return;
    const win = doc.defaultView;
    const prototype = /** @type {Window & typeof globalThis | null} */ (win)?.Element.prototype;
    if (!prototype) return;
    const original = typeof prototype.attachShadow === 'function' ? prototype.attachShadow : P.attachShadow;
    /** @this {Element} @param {ShadowRootInit} options */
    function wrapper(options) {
      const root = original.call(this, options);
      if (!stopped) {
        captured.set(this, root);
        // Disconnected hosts are held only by the weak capture table until mounted.
        if (this.isConnected) observe(root, null);
      }
      return root;
    }
    // A frozen, sealed or accessor-only prototype must leave the SDK functional
    // for every other root type rather than throwing out of initialization.
    try {
      prototype.attachShadow = wrapper;
      hooks.set(doc, { prototype, original, wrapper });
    } catch { /* host locked the prototype: open roots and frames still work */ }
  }
  /** @param {Document} doc */
  function unhook(doc) {
    const value = hooks.get(doc);
    if (value && value.prototype.attachShadow === value.wrapper) {
      try { value.prototype.attachShadow = value.original; } catch { /* host locked the prototype */ }
    }
    hooks.delete(doc);
  }
  let cleaning = false;
  function cleanup() {
    if (cleaning || stopped) return;
    cleaning = true;
    const rootIterator = roots.entries(), frameIterator = frames.entries(), hookIterator = hooks.keys(), refs = index.values();
    let phase = 0;
    enqueue({ step: () => {
      if (phase === 0) {
        const entry = rootIterator.next();
        if (entry.done) phase++;
        else if (!alive(entry.value[0])) { entry.value[1].observer.disconnect(); roots.delete(entry.value[0]); }
      } else if (phase === 1) {
        const entry = frameIterator.next();
        if (entry.done) phase++;
        else {
          const [frame, listener] = entry.value;
          if (!frame.isConnected || !alive(/** @type {Root} */ (frame.getRootNode()))) { frame.removeEventListener('load', listener); frames.delete(frame); }
        }
      } else if (phase === 2) {
        const entry = hookIterator.next();
        if (entry.done) phase++;
        else if (entry.value !== document && !roots.has(entry.value)) unhook(entry.value);
      } else {
        const entry = refs.next();
        if (entry.done) { cleaning = false; return true; }
        const el = entry.value.deref();
        if (!el || !el.isConnected || !interactive(el) || !alive(/** @type {Root} */ (el.getRootNode()))) index.delete(entry.value);
      }
      return false;
    } });
  }
  /** @param {Root} root @param {HTMLIFrameElement | null} frame */
  function observe(root, frame) {
    if (stopped || roots.has(root)) return;
    if (root.nodeType === 9) hook(/** @type {Document} */ (root));
    const observer = new P.mutation(records => {
      let i = 0;
      enqueue({ step: () => {
        const record = records[i++];
        if (record) {
          const target = record.target.nodeType === 1 ? /** @type {Element} */ (record.target) : record.target.parentElement;
          // Scan parents for structural/key/name changes; no tag attribute is observed.
          if (target) walk(target);
          else walk(root);
        }
        if (i >= records.length) { cleanup(); return true; }
        return false;
      } }, true);
    });
    roots.set(root, { observer, frame });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: watched });
    walk(root);
  }
  /** @param {Element} el */
  function discover(el) {
    const shadow = captured.get(el) || el.shadowRoot;
    if (shadow) observe(shadow, null);
    if (el.localName !== 'iframe') return;
    const frame = /** @type {HTMLIFrameElement} */ (el);
    if (!frames.has(frame)) {
      const listener = () => { cleanup(); const doc = frameDocument(frame); if (doc) observe(doc, frame); };
      frames.set(frame, listener); frame.addEventListener('load', listener);
    }
    const doc = frameDocument(frame);
    if (doc) observe(doc, frame);
  }
  /** @param {Element | Root} node */
  function walk(node) {
    if (walking.has(node)) { dirty.add(node); return; }
    walking.add(node);      const owner = node.ownerDocument || /** @type {Document} */ (node);
      const walker = P.walker.call(owner, node, 1);
    let first = node.nodeType === 1;
    enqueue({ step: () => {
      if (node.nodeType !== 9 && !node.isConnected) { walking.delete(node); return true; }
      const el = /** @type {Element | null} */ (first ? node : walker.nextNode());
      first = false;
      if (!el) {
        walking.delete(node);
        if (dirty.has(node)) { dirty.delete(node); walk(node); }
        return true;
      }
      counters.scanned++;
      positions.set(el, el.previousElementSibling ? (positions.get(el.previousElementSibling) || 0) + 1 : 1);
      discover(el);
      if (interactive(el)) {
        if (!deferred.has(el)) {
          deferred.add(el); intersection?.observe(el);
          // Separate job: viewport IO entries can overtake this background work.
          enqueue({ step: () => {
            if (deferred.has(el)) { deferred.delete(el); intersection?.unobserve(el); classify(el); }
            return true;
          } });
        }
      }
      return false;
    } });
  }
  function refresh() { guard(); for (const root of roots.keys()) walk(root); cleanup(); return ready(); }

  /** @param {Element} el @returns {Element | null} */
  function composedParent(el) {
    return el.parentElement || (el.getRootNode().nodeType === 11 ? /** @type {ShadowRoot} */ (el.getRootNode()).host : null);
  }
  /** @param {Element} el */
  function state(el) {
    const rect = P.rect.call(el), win = el.ownerDocument.defaultView;
    let visible = el.isConnected && rect.width > 0 && rect.height > 0;
    let enabled = !el.matches(':disabled') && !el.hasAttribute('readonly');
    for (let parent = el, depth = 0; parent && depth++ < 128; parent = /** @type {Element} */ (composedParent(parent))) {
      const style = win ? P.computed.call(win, parent) : null;
      if (parent.hasAttribute('hidden') || parent.getAttribute('aria-hidden') === 'true' || style?.display === 'none' ||
        style?.visibility === 'hidden' || Number(style?.opacity) === 0) visible = false;
      if (parent.hasAttribute('inert') || parent.getAttribute('aria-disabled') === 'true') enabled = false;
    }
    let inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < (win?.innerHeight || 0) && rect.left < (win?.innerWidth || 0);
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    let occluded = visible && inViewport ? !hit(el, x, y) : false;
    let doc = el.ownerDocument, pointX = x, pointY = y;
    while (doc !== document) {
      const frame = roots.get(doc)?.frame;
      if (!frame) { visible = false; break; }
      const frameRect = P.rect.call(frame);
      pointX += frameRect.left + frame.clientLeft; pointY += frameRect.top + frame.clientTop;
      const info = stateFrame(frame, pointX, pointY);
      visible &&= info.visible; enabled &&= info.enabled; inViewport &&= info.inViewport;
      occluded ||= info.occluded;
      doc = frame.ownerDocument;
    }
    return {
      is_visible: visible, is_enabled: enabled, is_in_viewport: inViewport, is_occluded: occluded,
      coordinates: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  }
  /** @param {Element} el @param {number} x @param {number} y */
  function hit(el, x, y) {
    // Check every composed root boundary; Document retargets closed-root hits to hosts.
    let current = el;
    for (let depth = 0; depth < 64; depth++) {
      const root = /** @type {Root} */ (current.getRootNode());
      const top = (root.nodeType === 11 ? P.shadowPoint : P.point)?.call(root, x, y);
      if (!top || !(top === current || current.contains(top))) return false;
      if (root.nodeType !== 11) return true;
      current = /** @type {ShadowRoot} */ (root).host;
    }
    return false;
  }
  /** @param {HTMLIFrameElement} frame @param {number} x @param {number} y */
  function stateFrame(frame, x, y) {
    const rect = P.rect.call(frame), win = frame.ownerDocument.defaultView;
    let visible = rect.width > 0 && rect.height > 0, enabled = true, transformed = false;
    for (let parent = /** @type {Element | null} */ (frame), depth = 0; parent && depth++ < 128; parent = composedParent(parent)) {
      const style = win ? P.computed.call(win, parent) : null;
      if (parent.hasAttribute('hidden') || parent.getAttribute('aria-hidden') === 'true' || style?.visibility === 'hidden' || style?.display === 'none' || Number(style?.opacity) === 0) visible = false;
      if (parent.hasAttribute('inert') || parent.getAttribute('aria-disabled') === 'true') enabled = false;
      if (style?.transform !== 'none') transformed = true;
    }
    const inViewport = x >= 0 && y >= 0 && x < (win?.innerWidth || 0) && y < (win?.innerHeight || 0);
    return { visible, enabled, inViewport, occluded: transformed || !hit(frame, x, y) };
  }
  /** @param {Element} el @param {boolean} [topCoordinates] */
  function describe(el, topCoordinates = false) {
    const info = state(el);
    if (topCoordinates) {
      let doc = el.ownerDocument;
      while (doc !== document) {
        const frame = roots.get(doc)?.frame;
        if (!frame) break;
        const rect = P.rect.call(frame);
        info.coordinates.x += rect.left + frame.clientLeft;
        info.coordinates.y += rect.top + frame.clientTop;
        doc = frame.ownerDocument;
      }
    }
    return {
      target_id: el.getAttribute(attr) || '', role: role(el), name: name(el),
      state: { is_visible: info.is_visible, is_enabled: info.is_enabled, is_in_viewport: info.is_in_viewport, is_occluded: info.is_occluded },
      coordinates: info.coordinates,
      suggested_action: el.localName === 'select' ? 'select' : role(el) === 'textbox' ? 'type' : 'click'
    };
  }
  /** @param {{limit?: number, viewportOnly?: boolean, coordinateSpace?: 'local' | 'top'}} [options] */
  async function actions(options = {}) {
    await ready();
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(5000, Math.floor(options.limit ?? 500))) : 500;
    /** @type {ReturnType<typeof describe>[]} */
    const result = [];
    const iterator = index.values();
    let truncated = false;
    await new Promise((resolve, reject) => enqueue({
      cancel: () => reject(error('STOPPED', 'Navi has stopped')),
      step: () => {
        const entry = iterator.next();
        if (entry.done) { resolve(undefined); return true; }
        const el = entry.value.deref();
        if (el?.isConnected && interactive(el) && alive(/** @type {Root} */ (el.getRootNode()))) {
          if (options.viewportOnly) {
            const rect = P.rect.call(el), win = el.ownerDocument.defaultView;
            if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= (win?.innerHeight || 0) || rect.left >= (win?.innerWidth || 0)) return false;
          }
          const action = describe(el, options.coordinateSpace === 'top');
          if (options.viewportOnly && !action.state.is_in_viewport) return false;
          if (result.length >= limit) { truncated = true; resolve(undefined); return true; }
          result.push(action);
        }
        return false;
      }
    }));
    return { version, truncated, actions: result };
  }
  /** @param {string} target */
  async function resolveTarget(target) {
    await ready();
    const iterator = index.values();
    /** @type {Element | undefined} */
    let found;
    await new Promise((resolve, reject) => enqueue({
      cancel: () => reject(error('STOPPED', 'Navi has stopped')),
      step: () => {
        const entry = iterator.next();
        if (entry.done) { resolve(undefined); return true; }
        const el = entry.value.deref();
        if (el?.isConnected && interactive(el) && alive(/** @type {Root} */ (el.getRootNode())) && el.getAttribute(attr) === target) {
          if (found) { reject(error('AMBIGUOUS', 'Target is not unique')); return true; }
          found = el;
        }
        return false;
      }
    }));
    if (!found) throw error('NOT_FOUND', 'Target does not exist');
    return found;
  }
  async function settle() {
    for (let i = 0; i < 2; i++) await new Promise(resolve => P.frame(resolve));
    await ready();
  }
  /** @param {string} target @param {string} action @param {{text?: string, value?: string}} [payload] */
  async function execute(target, action, payload = {}) {
    guard();
    if (busy) throw error('BUSY', 'Another Navi execution is in flight');
    if (typeof target !== 'string' || !target || target.length > 512 || !['click', 'type', 'select'].includes(action)) throw error('INVALID_ACTION', 'Invalid target or action');
    if (!payload || typeof payload !== 'object' || Object.keys(payload).some(key => key !== (action === 'type' ? 'text' : action === 'select' ? 'value' : ''))) throw error('INVALID_PAYLOAD', 'Unsupported payload');
    busy = true;
    try {
      const el = await resolveTarget(target);
      guard();
      const info = state(el);
      if (!info.is_visible || !info.is_enabled || !info.is_in_viewport || info.is_occluded) throw error('UNAVAILABLE', 'Target is not actionable');
      if (el.getAttribute('data-navi-trusted') === 'true') return {
        success: /** @type {const} */ (false), reason: /** @type {const} */ ('untrusted_gesture_required'), dispatched: /** @type {const} */ (false)
      };
      const win = /** @type {Window & typeof globalThis} */ (el.ownerDocument.defaultView);
      if (action === 'type') {
        if (!['input', 'textarea'].includes(el.localName) || typeof payload.text !== 'string' || payload.text.length > 10000 ||
          (el.localName === 'input' && !['', 'text', 'email', 'search', 'url', 'tel', 'password', 'number'].includes((el.getAttribute('type') || '').toLowerCase()))) throw error('INVALID_PAYLOAD', 'type requires a native text input and bounded text');
        const control = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (el);
        control.focus();
        if (!control.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true, composed: true, cancelable: true }))) throw error('CANCELED', 'Host canceled keydown');
        if (!control.dispatchEvent(new win.InputEvent('beforeinput', { inputType: 'insertText', data: payload.text, bubbles: true, composed: true, cancelable: true }))) throw error('CANCELED', 'Host canceled beforeinput');
        const prototype = el.localName === 'input' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, payload.text);
        control.dispatchEvent(new win.InputEvent('input', { inputType: 'insertText', data: payload.text, bubbles: true, composed: true }));
        control.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
        control.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Unidentified', bubbles: true, composed: true }));
      } else if (action === 'select') {
        if (el.localName !== 'select' || typeof payload.value !== 'string') throw error('INVALID_PAYLOAD', 'select requires a native select and value');
        const select = /** @type {HTMLSelectElement} */ (el);
        const option = Array.from(select.options).find(candidate => candidate.value === payload.value);
        if (!option || option.disabled || option.parentElement?.hasAttribute('disabled')) throw error('INVALID_PAYLOAD', 'Option is missing or disabled');
        select.focus();
        Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')?.set?.call(select, payload.value);
        select.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
        select.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
      } else {
        if (['form', 'input', 'textarea', 'select'].includes(el.localName) && role(el) !== 'button') throw error('INVALID_ACTION', 'Use the control-specific action');
        const control = /** @type {HTMLElement} */ (el);
        control.focus(); control.click();
      }
      await settle();
      return { target_id: target, action, dispatched: /** @type {const} */ (true) };
    } finally { busy = false; }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (scheduled) {
      if (frameFallback) window.cancelAnimationFrame(handle);
      else window.cancelIdleCallback(handle);
    }
    intersection?.disconnect();
    for (const state of roots.values()) state.observer.disconnect();
    for (const [frame, listener] of frames) frame.removeEventListener('load', listener);
    for (const doc of hooks.keys()) unhook(doc);
    for (const job of [...urgent, ...background]) job.cancel?.();
    for (const waiter of waiters) waiter.reject(error('STOPPED', 'Navi has stopped'));
    roots.clear(); frames.clear(); index.clear(); urgent.clear(); background.clear(); waiters.clear();
  }
  window.Navi = {
    version, ready, refresh, actions, execute, stop,
    stats: () => ({ ...counters, roots: roots.size, indexed: index.size, pending: urgent.size + background.size, tickSamplesMs: [...samples] })
  };
  // Hook before application scripts create hidden roots. Indexing itself is deferred.
  observe(document, null);
})();
