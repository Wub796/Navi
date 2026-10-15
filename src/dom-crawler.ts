export type CrawlerAction = 'click' | 'type' | 'select';

export interface CrawlerTarget {
  target_id: string;
  role: string;
  name: string;
  action: CrawlerAction;
  selector: string;
  disabled: boolean;
  required?: boolean;
  input_type?: string;
  options?: string[];
}

export interface CrawlerPayload {
  url: string;
  actions: CrawlerTarget[];
}

const MAX_TARGETS = 500;
const MAX_NAME_LENGTH = 160;
const CLICK_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image']);

function accessibleName(element: HTMLElement): string {
  const ariaLabel = element.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;

  const root = element.getRootNode();
  const labelledBy = element.getAttribute('aria-labelledby')
    ?.split(/\s+/)
    .filter(Boolean)
    .map(id => root instanceof Document || root instanceof ShadowRoot
      ? root.getElementById(id)?.textContent?.trim()
      : undefined)
    .filter((part): part is string => Boolean(part))
    .join(' ');
  if (labelledBy) return labelledBy;

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const label = element.labels?.[0]?.textContent?.trim();
    if (label) return label;
  }

  return element.innerText?.trim()
    || element.getAttribute('placeholder')?.trim()
    || element.getAttribute('title')?.trim()
    || element.getAttribute('name')?.trim()
    || element.id
    || element.getAttribute('role')
    || element.localName;
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.getClientRects().length === 0) return false;

  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true'
      || style?.display === 'none' || style?.visibility === 'hidden' || Number(style?.opacity) === 0) {
      return false;
    }
  }

  return true;
}

function uniqueSelector(doc: Document, selector: string): boolean {
  try {
    return doc.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\0/g, '\\fffd ')}"`;
}

function stableClassNames(element: HTMLElement): string[] {
  return Array.from(element.classList).filter(className =>
    className.length <= 64 && !/[a-f0-9]{8,}/i.test(className) && !/^_[A-Za-z0-9_-]{5,}$/.test(className),
  );
}

function selectorFor(element: HTMLElement): string {
  const doc = element.ownerDocument;
  const tag = element.localName;
  for (const [attribute, scoped] of [
    ['data-navi-id', false],
    ['data-testid', false],
    ['name', true],
    ['aria-label', true],
  ] as const) {
    const value = element.getAttribute(attribute);
    if (!value?.trim()) continue;
    const role = attribute === 'aria-label' ? element.getAttribute('role') : null;
    const prefix = `${scoped ? tag : ''}${role ? `[role=${cssString(role)}]` : ''}`;
    const selector = `${prefix}[${attribute}=${cssString(value)}]`;
    if (uniqueSelector(doc, selector)) return selector;
  }

  if (element.id) {
    const byId = `#${CSS.escape(element.id)}`;
    if (uniqueSelector(doc, byId)) return byId;
  }

  const classes = stableClassNames(element);
  if (classes.length) {
    const byClasses = `${tag}${classes.map(className => `.${CSS.escape(className)}`).join('')}`;
    if (uniqueSelector(doc, byClasses)) return byClasses;
  }

  let anchor: HTMLElement | null = doc.body;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (!parent.id) continue;
    const byId = `#${CSS.escape(parent.id)}`;
    if (uniqueSelector(doc, byId)) { anchor = parent; break; }
  }

  const parts: string[] = [];
  for (let current: HTMLElement | null = element; current && current !== anchor; current = current.parentElement) {
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(sibling => sibling.localName === current.localName)
      : [];
    parts.unshift(`${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`);
  }

  const base = anchor?.id ? `#${CSS.escape(anchor.id)}` : 'body';
  return `${base} > ${parts.join(' > ')}`;
}

function targetRole(element: HTMLElement, inputType: string): string {
  const explicitRole = element.getAttribute('role');
  if ((element instanceof HTMLAnchorElement && element.hasAttribute('href')) || explicitRole === 'link') return 'link';
  if (element.isContentEditable) return explicitRole || 'textbox';
  if (explicitRole) return explicitRole;
  if (element instanceof HTMLInputElement) {
    if (inputType === 'checkbox' || inputType === 'radio') return inputType;
    return CLICK_INPUT_TYPES.has(inputType) ? 'button' : 'textbox';
  }
  if (element instanceof HTMLSelectElement) return 'combobox';
  if (element instanceof HTMLTextAreaElement) return 'textbox';
  return 'button';
}

function suggestedAction(element: HTMLElement, inputType: string): CrawlerAction {
  if (element instanceof HTMLSelectElement) return 'select';
  const role = targetRole(element, inputType);
  if (role === 'textbox' || role === 'searchbox' || element.isContentEditable) return 'type';
  return 'click';
}

function selectOptions(element: HTMLSelectElement): string[] {
  return Array.from(element.options)
    .filter(option => !option.disabled && !option.closest('optgroup:disabled'))
    .slice(0, 20)
    .map(option => {
      const label = option.label.trim() || option.textContent?.trim() || option.value;
      return label === option.value ? label : `${label}=${option.value}`;
    });
}

/** Collect visible buttons and form controls from one document in DOM order. */
export function collectTargets(doc: Document = document): CrawlerPayload {
  const candidates = doc.querySelectorAll<HTMLElement>(
    'button, input:not([type="hidden"]), textarea, select, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="textbox"], [role="searchbox"], [role="combobox"], [contenteditable="true"]',
  );
  const actions: CrawlerTarget[] = [];

  for (const element of candidates) {
    if (!isVisible(element)) continue;

    const inputType = element instanceof HTMLInputElement
      ? (element.type || 'text').toLowerCase()
      : '';
    const action = suggestedAction(element, inputType);
    const target: CrawlerTarget = {
      target_id: `t${actions.length}`,
      role: targetRole(element, inputType),
      name: accessibleName(element).replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH),
      action,
      selector: selectorFor(element),
      disabled: element.matches(':disabled') || element.hasAttribute('readonly') || element.getAttribute('aria-disabled') === 'true',
    };

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (element.required) target.required = true;
    }
    if (inputType) target.input_type = inputType;
    if (element instanceof HTMLSelectElement) target.options = selectOptions(element);

    actions.push(target);
    if (actions.length >= MAX_TARGETS) break;
  }

  return { url: doc.location.href, actions };
}

/** Return compact JSON (no whitespace) and never include a control's current value. */
export function crawlPage(doc: Document = document): string {
  return JSON.stringify(collectTargets(doc));
}
