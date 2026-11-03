import { afterEach, beforeEach, vi } from "vitest";
import { Channel, Events, Locks } from "./events.ts";

let restoreLocks = () => {};
beforeEach(() => {
  // Some web tests deliberately use the Node environment instead of happy-dom.
  if (typeof window === "undefined") return;
  Events.opened = [];
  Channel.opened = [];
  vi.stubGlobal("EventSource", Events);
  vi.stubGlobal("BroadcastChannel", Channel);
  const browser = navigator;
  const previous = Object.getOwnPropertyDescriptor(browser, "locks");
  Object.defineProperty(browser, "locks", { value: new Locks(), configurable: true });
  restoreLocks = () => {
    if (previous) Object.defineProperty(browser, "locks", previous);
    else Reflect.deleteProperty(browser, "locks");
  };
});
afterEach(() => {
  restoreLocks();
  vi.unstubAllGlobals();
});
