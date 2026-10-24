/**
 * Navi distribution types. Self-contained on purpose: consumers do not need
 * Playwright's types installed for the adapter to typecheck.
 */

export declare const NAVI_PROTOCOL_VERSION: string;
export declare const NAVI_SDK_FILE: string;

export interface NaviBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NaviState {
  is_visible: boolean;
  is_enabled: boolean;
  is_in_viewport: boolean;
  is_occluded: boolean;
}

export interface NaviAction {
  target_id: string;
  role: string;
  name: string;
  state: NaviState;
  /** Bounding box in CSS pixels. Space depends on the requested coordinateSpace. */
  coordinates: NaviBox;
  suggested_action: string;
}

export interface NaviActionMap {
  version: string;
  state_version: number;
  reset: boolean;
  truncated: boolean;
  actions: NaviAction[];
}

export interface NaviDifferentialMap extends Omit<NaviActionMap, 'actions'> {
  actions: (NaviAction | { target_id: string; removed: true })[];
}

/**
 * Browser-side runtime API exposed as `window.Navi` after the SDK loads.
 * Mirrors the global augmentation in navi.d.ts; keep both in sync.
 *
 * `execute` rejects with a typed Navi error (NOT_FOUND, UNAVAILABLE, BUSY,
 * CANCELED, AMBIGUOUS, INVALID_ACTION, INVALID_PAYLOAD, STOPPED) instead of
 * returning a failure object; the adapter converts those into `AdapterResult`.
 */
export interface NaviAPI {
  version: string;
  /**
   * Present only on the tenant loader's deferred stub (`true` while the bundle is
   * still loading). A loaded SDK does not set it, which is also how the bundle
   * knows it may install over a stub instead of refusing to boot.
   */
  stub?: boolean;
  ready(): Promise<void>;
  refresh(): Promise<void>;
  actions(options: { limit?: number; viewportOnly?: boolean; coordinateSpace?: 'local' | 'top'; since_version: number }): Promise<NaviDifferentialMap>;
  actions(options?: { limit?: number; viewportOnly?: boolean; coordinateSpace?: 'local' | 'top' }): Promise<NaviActionMap>;
  execute(targetId: string, actionType: string, payload?: { text?: string; value?: string }): Promise<
    { target_id: string; action: string; dispatched: true } |
    { success: false; reason: 'untrusted_gesture_required'; dispatched: false }
  >;
  stats(): {
    tagged: number;
    scanned: number;
    roots: number;
    indexed: number;
    pending: number;
    ticks: number;
    maxTickMs: number;
    overBudgetTicks: number;
    initialMs: number;
    tickSamplesMs: number[];
  };
  stop(): void;
}

/** Structural subset of a Playwright page used by the adapter. */
export interface NaviPageLike {
  url(): string;
  evaluate<T, A>(pageFunction: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  mouse: { click(x: number, y: number): Promise<void> };
  keyboard: { press(key: string): Promise<void>; insertText(text: string): Promise<void> };
}

export interface NaviAdapterOptions {
  /** Expected in-page protocol version. Defaults to NAVI_PROTOCOL_VERSION. */
  protocolVersion?: string;
  /** Allow native driver fallback for cooperating trusted-input refusals. Default true. */
  fallback?: boolean;
  /** Freshness deadline for fallback discovery in milliseconds. Default 2000. */
  maxFallbackAgeMs?: number;
}

export type AdapterMode = 'synthetic' | 'native-driver';

export interface AdapterResult {
  ok: boolean;
  result?: { target_id?: string; action?: string; dispatched: boolean };
  error?: { code: string; message: string };
  mode?: AdapterMode;
}

export declare class NaviPlaywrightAdapter {
  constructor(page: NaviPageLike, options?: NaviAdapterOptions);
  readonly page: NaviPageLike;
  readonly origin: string;
  readonly protocolVersion: string;
  readonly fallback: boolean;
  readonly maxFallbackAgeMs: number;
  checkOrigin(): void;
  discover(options: { viewportOnly?: boolean; limit?: number; since_version: number }): Promise<NaviDifferentialMap>;
  discover(options?: { viewportOnly?: boolean; limit?: number }): Promise<NaviActionMap>;
  /** Scroll a unique top-document target into view; returns its fresh state. */
  scrollTo(targetId: string): Promise<NaviAction>;
  /** Native keyboard input; optional targetId checks the current top-document focus. */
  pressKey(key: string, targetId?: string): Promise<{ pressed: boolean; key: string; mode: string }>;
  execute(targetId: string, actionType: 'click' | 'type' | 'select' | string, payload?: { text?: string; value?: string }): Promise<AdapterResult>;
}

export declare function naviAdapter(page: NaviPageLike, options?: NaviAdapterOptions): NaviPlaywrightAdapter;

export interface NaviExpectation {
  selector?: string;
  text?: string;
  value?: string;
}

export type NaviFlowStep =
  | { label?: string; target: string; action: 'click' | 'type' | 'select'; text?: string; value?: string; consequential?: boolean; expect?: NaviExpectation }
  | { label?: string; assert: 'text' | 'value' | 'visible' | 'exists' | 'url'; target?: string; selector?: string; equals?: string; contains?: string; matches?: string }
  | { label?: string; wait: number }
  | { label?: string; waitFor: { selector?: string; text?: string; urlIncludes?: string }; timeoutMs?: number };

export interface NaviFlowDocument {
  name?: string;
  url?: string;
  viewport?: { width: number; height: number };
  steps: NaviFlowStep[];
}

export interface NaviStepResult {
  index: number;
  label: string;
  kind: 'action' | 'assert' | 'wait' | 'waitFor';
  ok: boolean;
  durationMs: number;
  mode?: AdapterMode;
  error?: { code: string; message: string };
}

export interface NaviFlowResult {
  ok: boolean;
  steps: NaviStepResult[];
  failedStep?: NaviStepResult;
  durationMs: number;
}

export declare function validateFlow(input: unknown): { ok: true; flow: { name: string; url?: string; steps: unknown[] } } | { ok: false; errors: string[] };

export declare function runFlow(options: {
  adapter: NaviPlaywrightAdapter;
  page: NaviPageLike;
  flow: unknown;
  allowConsequential?: boolean;
  timeoutMs?: number;
  onStep?: (event: NaviStepResult) => void;
}): Promise<NaviFlowResult>;

/** Absolute path of the bundled browser SDK shipped next to this module. */
export declare function naviSdkPath(): string;

/** Inject the browser SDK into an already-navigated page and wait for `window.Navi`. */
export declare function installNavi(page: NaviPageLike & { addScriptTag(options: { path?: string; content?: string }): Promise<unknown>; waitForFunction(fn: () => boolean): Promise<unknown> }, options?: { scriptPath?: string; inline?: boolean }): Promise<string>;

/** Inject if needed, wait for indexing, and return a ready adapter. */
export declare function connectNavi(page: NaviPageLike & { addScriptTag(options: { path?: string; content?: string }): Promise<unknown>; waitForFunction(fn: () => boolean): Promise<unknown> }, options?: NaviAdapterOptions & { scriptPath?: string; inline?: boolean; requireIndexed?: boolean }): Promise<{ adapter: NaviPlaywrightAdapter; sdkPath: string | null }>;
