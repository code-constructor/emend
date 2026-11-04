import { expect, test } from "vitest";
import { checkedText, relativeTime, snoozeChoices, wakeHasPassed, wakeTime } from "./time.ts";

test("wakeTime uses the date whenever the weekday alone would be ambiguous", () => {
  const monday = new Date(2026, 10, 9, 10, 0).getTime();
  // Next Monday shares today's weekday: the date names it.
  expect(wakeTime(new Date(2026, 10, 16, 9, 0), monday)).toMatch(/Nov.*16/);
  // The same day later, and a day within the week, keep the weekday form.
  expect(wakeTime(new Date(2026, 10, 9, 13, 0), monday)).toMatch(/^Mon,? 13:00$/);
  expect(wakeTime(new Date(2026, 10, 12, 9, 0), monday)).toMatch(/^Thu,? 09:00$/);
  // Six days out is already the date, even on a different weekday.
  expect(wakeTime(new Date(2026, 10, 15, 10, 0), monday)).toMatch(/Nov.*15/);
  expect(wakeTime(new Date(2026, 10, 15, 9, 59), monday)).toMatch(/^Sun,? 09:59$/);
  // Late evening "Later today" crosses midnight and shows the real weekday.
  expect(wakeTime(new Date(2026, 10, 5, 1, 30), new Date(2026, 10, 4, 22, 30).getTime())).toMatch(/^Thu,? 01:30$/);
});

test("wakeHasPassed is true at and after the wake time only", () => {
  const iso = "2026-11-05T09:00:00.000Z";
  const at = Date.parse(iso);
  expect(wakeHasPassed(iso, at - 1)).toBe(false);
  expect(wakeHasPassed(iso, at)).toBe(true);
  expect(wakeHasPassed("nope", at)).toBe(false);
});

test("Tomorrow morning at 02:00 means 09:00 the same calendar day; Next week on Monday 10:00 is a week out", () => {
  const night = snoozeChoices(new Date(2026, 10, 5, 2, 0));
  const tomorrow = night.find((choice) => choice.id === "tomorrow");
  expect(tomorrow && "until" in tomorrow ? tomorrow.until.getTime() : 0).toBe(new Date(2026, 10, 5, 9, 0).getTime());
  const fiveAm = snoozeChoices(new Date(2026, 10, 5, 5, 0)).find((choice) => choice.id === "tomorrow");
  expect(fiveAm && "until" in fiveAm ? fiveAm.until.getTime() : 0).toBe(new Date(2026, 10, 6, 9, 0).getTime());
  const monday = snoozeChoices(new Date(2026, 10, 9, 10, 0)).find((choice) => choice.id === "week");
  expect(monday && "until" in monday ? monday.until.getTime() : 0).toBe(new Date(2026, 10, 16, 9, 0).getTime());
});

test("wakeTime shows the weekday and 24-hour time within a week, the date beyond it", () => {
  const now = new Date(2026, 10, 4, 22, 30).getTime();
  expect(wakeTime(new Date(2026, 10, 5, 9, 0), now)).toMatch(/^Thu,? 09:00$/);
  expect(wakeTime(new Date(2026, 10, 12, 9, 0), now)).toMatch(/Nov/);
  expect(wakeTime("not a date", now)).toBe("");
});

const at = (...parts: number[]) => new Date(2026, ...(parts as [number, number, number?, number?])).getTime();
test.each([
  {
    when: "a Wednesday evening",
    now: new Date(2026, 10, 4, 22, 30),
    later: at(10, 5, 1, 30),
    tomorrow: at(10, 5, 9),
    week: at(10, 9, 9),
  },
  {
    when: "a Monday",
    now: new Date(2026, 10, 9, 10, 0),
    later: at(10, 9, 13, 0),
    tomorrow: at(10, 10, 9),
    week: at(10, 16, 9),
  },
  {
    when: "a Sunday",
    now: new Date(2026, 10, 8, 23, 59),
    later: at(10, 9, 2, 59),
    tomorrow: at(10, 9, 9),
    week: at(10, 9, 9),
  },
  {
    when: "a month end",
    now: new Date(2026, 9, 31, 12, 0),
    later: at(9, 31, 15, 0),
    tomorrow: at(10, 1, 9),
    week: at(10, 2, 9),
  },
])("snoozeChoices on $when", ({ now, later, tomorrow, week }) => {
  const choices = snoozeChoices(now);
  expect(choices.map((choice) => choice.label)).toEqual([
    "Until it changes",
    "Later today",
    "Tomorrow morning",
    "Next week",
  ]);
  expect(choices.map((choice) => ("until" in choice ? choice.until.getTime() : null))).toEqual([
    null,
    later,
    tomorrow,
    week,
  ]);
});

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
