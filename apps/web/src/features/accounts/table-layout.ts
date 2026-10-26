/**
 * The Accounts table's row-actions column (Edit, Disconnect): pinned to the table's right edge, so a wide row (the
 * "Session expired · re-connect" badge, the analytics controls) scrolls under it instead of pushing it out of view.
 * The background keeps the cells that scroll underneath from showing through.
 */
export const ACTIONS_COLUMN = 'sticky right-0 bg-background';
