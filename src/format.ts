/**
 * Absolute local timestamps for message rows: `3:25 PM` by default (12-hour),
 * `14:32` when hour12 is false. Older than today prefixed as before.
 */
export function formatMessageTime(ts: number, now: number = Date.now(), hour12 = true): string {
  const d = new Date(ts);
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const time = hour12
    ? `${d.getHours() % 12 || 12}:${minutes} ${d.getHours() < 12 ? "AM" : "PM"}`
    : `${String(d.getHours()).padStart(2, "0")}:${minutes}`;
  const startOf = (t: number): number => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const dayDiff = Math.round((startOf(now) - startOf(ts)) / 86_400_000);
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `Yesterday ${time}`;
  if (dayDiff < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
