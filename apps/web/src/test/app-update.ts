import { type Mock, vi } from "vitest";
import type { AppUpdateSnapshot } from "../lib/app-update.ts";

export interface FakeAppUpdate {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AppUpdateSnapshot;
  set(next: Partial<AppUpdateSnapshot>): void;
  start: Mock<() => void>;
  checkForUpdate: Mock<() => Promise<void>>;
  installUpdate: Mock<() => void>;
  reloadNow: Mock<() => void>;
}

/** A hand-driven stand-in for the update store, for component tests. */
export function createFakeAppUpdate(): FakeAppUpdate {
  let snapshot: AppUpdateSnapshot = { state: "idle", reason: null, checkedAt: null };
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    set(next) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
    start: vi.fn(),
    checkForUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn(),
    reloadNow: vi.fn(),
  };
}
