import { START_LINK } from "./constants.ts";

/**
 * Reminder emails and notifications link to /?start=next: open the planner and
 * start the next planned task.
 */
export class StartLink {
  /**
   * Whether this page was opened from such a link. Read once and removed from
   * the address bar, so a reload or a shared link never starts a timer again.
   */
  static take(): boolean {
    const params = new URLSearchParams(window.location.search);
    if (params.get(START_LINK.param) !== START_LINK.value) return false;
    params.delete(START_LINK.param);
    const query = params.toString();
    history.replaceState(
      history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    return true;
  }
}
