import { describe, expect, it } from "vitest";
import { formatMessageTime } from "./format.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("formatMessageTime", () => {
  // Fixed reference: 2026-10-04 15:30 local.
  const now = new Date(2026, 9, 4, 15, 30).getTime();

  it("shows HH:MM for same-day messages", () => {
    expect(formatMessageTime(now - 5 * MIN, now)).toBe("15:25");
  });

  it("labels yesterday", () => {
    expect(formatMessageTime(now - DAY - 5 * MIN, now)).toMatch(/^Yesterday \d\d:\d\d$/);
  });

  it("labels recent days with weekday", () => {
    expect(formatMessageTime(now - 3 * DAY, now)).toMatch(/^\w+ \d\d:\d\d$/);
  });

  it("labels older messages with month and day", () => {
    expect(formatMessageTime(now - 30 * DAY, now)).toMatch(/^\w+ \d+ \d\d:\d\d$/);
  });

  it("treats future clock-skew as today", () => {
    expect(formatMessageTime(now + DAY, now)).toMatch(/^\d\d:\d\d$/);
  });
});
