import { can, type Action, type Role } from "@ffgp/shared";

/** Actions still allowed when a cloud garage is read-only (its subscription ended). */
const READ_ONLY_ACTIONS: ReadonlySet<Action> = new Set<Action>(["reports.view", "costs.view"]);

/** Whether the role may see the screen for this action (unchanged by read-only: "see and print everything"). */
export const visible = (role: Role, action: Action): boolean => can(role, action);

/** Whether the role may do this action now; a read-only garage can't change anything. */
export const allowed = (role: Role, action: Action, readOnly: boolean): boolean =>
  can(role, action) && (!readOnly || READ_ONLY_ACTIONS.has(action));
