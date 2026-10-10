/**
 * Browser-side Navi protocol types, declared as a global augmentation.
 * The shape mirrors the exported NaviAPI in ./index.d.ts; keep the two in sync.
 */
export {};

export interface NaviAction {
  target_id: string;
  role: string;
  name: string;
  state: { is_visible: boolean; is_enabled: boolean; is_in_viewport: boolean; is_occluded: boolean };
  /** CSS pixel bounding box in the target's own document viewport by default. */
  coordinates: { x: number; y: number; width: number; height: number };
  suggested_action: string;
}

export interface NaviActionMap { version: string; state_version: number; reset: boolean; truncated: boolean; actions: NaviAction[] }
export interface NaviDifferentialMap extends Omit<NaviActionMap, 'actions'> { actions: (NaviAction | { target_id: string; removed: true })[] }

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
  /** Cursor is document-scoped; reset:true replaces the client's cache. */
  actions(options: { limit?: number; viewportOnly?: boolean; coordinateSpace?: 'local' | 'top'; since_version: number }): Promise<NaviDifferentialMap>;
  actions(options?: { limit?: number; viewportOnly?: boolean; coordinateSpace?: 'local' | 'top' }): Promise<NaviActionMap>;
  execute(targetId: string, actionType: string, payload?: { text?: string; value?: string }): Promise<
    { target_id: string; action: string; dispatched: true } |
    { success: false; reason: 'untrusted_gesture_required'; dispatched: false }
  >;
  stats(): { tagged: number; scanned: number; roots: number; indexed: number; pending: number; ticks: number; maxTickMs: number; overBudgetTicks: number; initialMs: number; tickSamplesMs: number[] };
  stop(): void;
}

declare global {
  interface Window { Navi?: NaviAPI }
}
