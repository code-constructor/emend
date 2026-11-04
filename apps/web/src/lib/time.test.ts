import { expect, test } from "vitest";
import { checkedText, relativeTime } from "./time.ts";

const iso = "2026-01-05T12:00:00.000Z";
const then = Date.parse(iso);
test.each([
  [-60, "now"],
  [0, "now"],
  [30, "now"],
  [59, "now"],
  [60, "1m"],
  [59 * 60, "59m"],
  [60 * 60, "1h"],
  [24 * 60 * 60 - 1, "23h"],
  [24 * 60 * 60, new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(iso))],
  [7 * 24 * 60 * 60 - 1, new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(iso))],
  [7 * 24 * 60 * 60, new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso))],
  [30 * 24 * 60 * 60, new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso))],
])("relativeTime at %s seconds returns %s", (seconds, expected) => {
  expect(relativeTime(iso, then + Number(seconds) * 1000)).toBe(expected);
});

test.each(["not a timestamp", "", "2026-99-99T00:00:00.000Z"])("relativeTime hides an invalid date: %s", (invalid) => {
  expect(relativeTime(invalid, then)).toBe("");
  expect(checkedText(invalid, then)).toBe("");
});

test.each([
  [-5, "Checked just now."],
  [59, "Checked just now."],
  [60, "Checked 1m ago."],
  [59 * 60, "Checked 59m ago."],
  [60 * 60, "Checked 1h ago."],
  [24 * 60 * 60 - 1, "Checked 23h ago."],
  [24 * 60 * 60, `Checked on ${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(iso))}.`],
  [
    8 * 24 * 60 * 60,
    `Checked on ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso))}.`,
  ],
])("checkedText at %s seconds returns %s", (seconds, expected) => {
  expect(checkedText(iso, then + Number(seconds) * 1000)).toBe(expected);
});
