const ACTIONS = new Set(['click', 'type', 'select']);
const TARGET_FIELDS = new Set(['target_id', 'role', 'name', 'action', 'selector', 'disabled', 'required', 'input_type', 'options']);
const PAYLOAD_FIELDS = new Set(['url', 'actions']);
const MAX_TEXT = 2048;

/** Validate the wire contract shared by the crawler ingestion endpoints. */
/** @param {unknown} input */
export function validateCrawlerPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const payload = /** @type {Record<string, unknown>} */ (input);
  if (Object.keys(payload).some(key => !PAYLOAD_FIELDS.has(key))) return false;
  if (typeof payload.url !== 'string' || !payload.url.trim() || payload.url.length > MAX_TEXT) return false;
  try {
    const url = new URL(payload.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  } catch { return false; }
  if (!Array.isArray(payload.actions) || payload.actions.length > 500) return false;

  return payload.actions.every(action => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
    const target = /** @type {Record<string, unknown>} */ (action);
    if (Object.keys(target).some(key => !TARGET_FIELDS.has(key) || key === 'value')) return false;
    if (['target_id', 'role', 'name', 'selector'].some(key =>
      typeof target[key] !== 'string' || !String(target[key]).trim() || String(target[key]).length > MAX_TEXT,
    )) return false;
    if (typeof target.action !== 'string' || !ACTIONS.has(target.action)) return false;
    if (typeof target.disabled !== 'boolean') return false;
    if (target.required !== undefined && typeof target.required !== 'boolean') return false;
    if (target.input_type !== undefined && (typeof target.input_type !== 'string' || target.input_type.length > 64)) return false;
    if (target.options !== undefined && (!Array.isArray(target.options) || target.options.length > 20 ||
      target.options.some(option => typeof option !== 'string' || option.length > MAX_TEXT))) return false;
    return true;
  });
}
