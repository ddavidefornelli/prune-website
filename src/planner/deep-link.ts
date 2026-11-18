/**
 * Reminder emails and notifications link to /?start=next: open the planner and
 * start the next planned task. Read once and removed from the address bar, so
 * a reload or a shared link never starts a timer again.
 */
export function takeStartLink(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get("start") !== "next") return false;
  params.delete("start");
  const query = params.toString();
  history.replaceState(
    history.state,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
  return true;
}
