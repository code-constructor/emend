import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useWakeTimer } from "./wake-timer.ts";

const start = new Date("2026-11-04T12:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Probe({ times, onWake }: { times: (string | null)[]; onWake: (passed: string[]) => void }) {
  useWakeTimer(times, onWake);
  return null;
}
const after = (seconds: number) => new Date(start.getTime() + seconds * 1000).toISOString();

test("calls back once when the earliest future wake time passes, then waits for the next", () => {
  const onWake = vi.fn();
  render(<Probe times={[null, after(120), after(60)]} onWake={onWake} />);
  act(() => void vi.advanceTimersByTime(59_000));
  expect(onWake).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(2_000));
  expect(onWake).toHaveBeenCalledOnce();
  expect(onWake).toHaveBeenLastCalledWith([after(60)]);
  act(() => void vi.advanceTimersByTime(60_000));
  expect(onWake).toHaveBeenCalledTimes(2);
  expect(onWake).toHaveBeenLastCalledWith([after(120), after(60)]);
  act(() => void vi.advanceTimersByTime(600_000));
  expect(onWake).toHaveBeenCalledTimes(2);
});

test("schedules nothing for null or long past times", () => {
  const onWake = vi.fn();
  render(<Probe times={[null, after(-3600)]} onWake={onWake} />);
  act(() => void vi.advanceTimersByTime(24 * 3600_000));
  expect(onWake).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("a changed list re-arms the timer, and unmounting clears it", () => {
  const onWake = vi.fn();
  const view = render(<Probe times={[after(600)]} onWake={onWake} />);
  view.rerender(<Probe times={[after(30)]} onWake={onWake} />);
  act(() => void vi.advanceTimersByTime(31_000));
  expect(onWake).toHaveBeenCalledOnce();
  view.rerender(<Probe times={[after(900)]} onWake={onWake} />);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("a wake time beyond the longest timer delay is reached in steps", () => {
  const onWake = vi.fn();
  const far = new Date(start.getTime() + 40 * 24 * 3600_000).toISOString();
  render(<Probe times={[far]} onWake={onWake} />);
  act(() => void vi.advanceTimersByTime(30 * 24 * 3600_000));
  expect(onWake).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(10 * 24 * 3600_000 + 1_000));
  expect(onWake).toHaveBeenCalledOnce();
});
