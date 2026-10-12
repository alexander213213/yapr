import { describe, expect, it } from "vitest";
import { formatMessageTime } from "./format.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("formatMessageTime", () => {
  // Fixed reference: 2026-10-04 15:30 local.
  const now = new Date(2026, 9, 4, 15, 30).getTime();

  it("shows HH:MM for same-day messages in 24-hour mode", () => {
    expect(formatMessageTime(now - 5 * MIN, now, false)).toBe("15:25");
  });

  it("labels yesterday", () => {
    expect(formatMessageTime(now - DAY - 5 * MIN, now, false)).toMatch(/^Yesterday \d\d:\d\d$/);
  });

  it("labels recent days with weekday", () => {
    expect(formatMessageTime(now - 3 * DAY, now, false)).toMatch(/^\w+ \d\d:\d\d$/);
  });

  it("labels older messages with month and day", () => {
    expect(formatMessageTime(now - 30 * DAY, now, false)).toMatch(/^\w+ \d+ \d\d:\d\d$/);
  });

  it("treats future clock-skew as today", () => {
    expect(formatMessageTime(now + DAY, now, false)).toMatch(/^\d\d:\d\d$/);
  });

  it("defaults to 12-hour time", () => {
    expect(formatMessageTime(now - 5 * MIN, now)).toBe("3:25 PM");
    expect(formatMessageTime(now - 5 * MIN, now, true)).toBe("3:25 PM");
  });

  it("renders midnight and noon as 12 AM/PM", () => {
    expect(formatMessageTime(new Date(2026, 9, 4, 0, 5).getTime(), now)).toBe("12:05 AM");
    expect(formatMessageTime(new Date(2026, 9, 4, 12, 0).getTime(), now)).toBe("12:00 PM");
    expect(formatMessageTime(new Date(2026, 9, 4, 9, 5).getTime(), now)).toBe("9:05 AM");
  });

  it("labels yesterday in 12-hour mode", () => {
    expect(formatMessageTime(now - DAY - 5 * MIN, now)).toMatch(/^Yesterday \d{1,2}:\d\d (AM|PM)$/);
  });
});
