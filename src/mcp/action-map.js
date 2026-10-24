/**
 * Planner observations omit driver coordinates; execution still checks the full map.
 * @param {import('../adapter.js').NaviActionMap | import('../adapter.js').NaviDifferentialMap} map
 */
export function compactActionMap(map) {
  return {
    ...map,
    format: 'compact',
    actions: map.actions.map(action => {
      if ('removed' in action) return action;
      const blockedBy = [];
      if (!action.state.is_visible) blockedBy.push('hidden');
      if (!action.state.is_enabled) blockedBy.push('disabled');
      if (!action.state.is_in_viewport) blockedBy.push('offscreen');
      if (action.state.is_occluded) blockedBy.push('occluded');
      return {
        target_id: action.target_id,
        role: action.role,
        name: action.name,
        action: action.suggested_action,
        available: blockedBy.length === 0,
        ...(blockedBy.length ? { blocked_by: blockedBy } : {})
      };
    })
  };
}
