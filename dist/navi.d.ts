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

export interface NaviAPI {
  version: string;
  ready(): Promise<void>;
  refresh(): Promise<void>;
  actions(options?: { limit?: number; viewportOnly?: boolean; coordinateSpace?: 'local' | 'top' }): Promise<{ version: string; truncated: boolean; actions: NaviAction[] }>;
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
