import { useSyncExternalStore } from "react";

/** What the update store knows about the installed app. */
export type AppUpdateState =
  | "unsupported"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "updating"
  | "reload-needed"
  | "error";
export interface AppUpdateSnapshot {
  readonly state: AppUpdateState;
  /** A short reason, only in the `error` state. */
  readonly reason: string | null;
  /** When the last check finished without an error, in epoch milliseconds. */
  readonly checkedAt: number | null;
}

interface WorkerLike {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
}
interface RegistrationLike {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  update(): Promise<unknown>;
  addEventListener(type: "updatefound", listener: () => void): void;
}
interface ContainerLike {
  readonly controller: unknown;
  register(url: string): Promise<RegistrationLike>;
  addEventListener(type: "controllerchange", listener: () => void): void;
}
/** The browser pieces the store uses. Tests supply fakes for all of them. */
export interface AppUpdateDeps {
  production: boolean;
  serviceWorker: ContainerLike | undefined;
  reload(): void;
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  document: {
    readonly visibilityState: string;
    addEventListener(type: "visibilitychange", listener: () => void): void;
  };
  window: { addEventListener(type: "pageshow", listener: (event: { persisted?: boolean }) => void): void };
}

/** A returning tab checks again only after this long. */
export const RETURN_CHECK_INTERVAL_MS = 60_000;
/** "Updating…" ends after this long if the new worker never takes over. */
export const INSTALL_TIMEOUT_MS = 15_000;
/** A check waiting on a worker that stays "installing" ends after this long. */
export const SETTLE_TIMEOUT_MS = 30_000;
const quietStates: readonly AppUpdateState[] = ["available", "updating", "reload-needed"];

function reasonOf(error: unknown) {
  const text = error instanceof Error ? error.message.split("\n")[0]?.trim() : "";
  if (!text) return "the check failed";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * Owns the service worker registration. A waiting worker is installed only when the reviewer asks;
 * nothing here reloads the page by itself except the reload that finishes a requested install.
 */
export function createAppUpdate(resolveDeps: () => AppUpdateDeps) {
  let snapshot: AppUpdateSnapshot = { state: "idle", reason: null, checkedAt: null };
  const listeners = new Set<() => void>();
  let deps: AppUpdateDeps | undefined;
  let container: ContainerLike | undefined;
  let registration: RegistrationLike | undefined;
  let started = false;
  /** Whether a worker controlled this page, now or at start. */
  let hadController = false;
  /** The controller this page last knew, to notice a swap that sent no event (frozen pages). */
  let knownController: unknown = null;
  let installRequested = false;
  let installTimer: unknown;
  let reloaded = false;
  let lastCheckStarted: number | null = null;
  let inflight: Promise<void> | undefined;
  let inflightManual = false;
  /** A check finished while a new worker was still installing; it ends when that worker settles. */
  let settling = false;
  let settleTimer: unknown;
  const watched = new WeakSet<WorkerLike>();

  function set(next: Partial<AppUpdateSnapshot>) {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  }
  function environment() {
    deps ??= resolveDeps();
    return deps;
  }
  function isQuiet() {
    return quietStates.includes(snapshot.state);
  }
  /** A waiting worker is an update only for a page that a worker already controls. */
  function hasUpdate() {
    return !!registration?.waiting && !!container?.controller;
  }
  function evaluate() {
    if (hasUpdate() && !isQuiet()) set({ state: "available", reason: null });
  }
  function installInProgress() {
    const worker = registration?.installing;
    return !!container?.controller && !!worker && worker.state !== "installed" && worker.state !== "redundant";
  }
  function stopSettleTimer() {
    if (settleTimer !== undefined) environment().clearTimeout(settleTimer);
    settleTimer = undefined;
  }
  function finishCheck() {
    settling = false;
    stopSettleTimer();
    const checkedAt = environment().now();
    if (isQuiet()) set({ checkedAt });
    else set({ checkedAt, state: hasUpdate() ? "available" : "current", reason: null });
  }
  function resolveSettling() {
    if (settling && !installInProgress()) finishCheck();
  }
  function watch(worker: WorkerLike) {
    if (watched.has(worker)) return;
    watched.add(worker);
    const onState = () => {
      if (worker.state === "installed") {
        evaluate();
        resolveSettling();
      } else if (worker.state === "redundant") resolveSettling();
    };
    worker.addEventListener("statechange", onState);
    onState();
  }
  function check(manual: boolean): Promise<void> {
    if (inflight) {
      inflightManual ||= manual;
      if (manual && !isQuiet() && snapshot.state !== "checking") set({ state: "checking", reason: null });
      return inflight;
    }
    const current = registration;
    if (!current) return Promise.resolve();
    lastCheckStarted = environment().now();
    inflightManual = manual;
    settling = false;
    stopSettleTimer();
    if (manual && !isQuiet()) set({ state: "checking", reason: null });
    const run: Promise<void> = (async () => {
      try {
        await current.update();
        if (!isQuiet() && installInProgress()) {
          settling = true;
          settleTimer = environment().setTimeout(() => {
            settleTimer = undefined;
            if (settling) finishCheck();
          }, SETTLE_TIMEOUT_MS);
          return;
        }
        finishCheck();
      } catch (error) {
        // A background check fails silently; only the reviewer's own check shows the error.
        if (inflightManual && !isQuiet()) set({ state: "error", reason: reasonOf(error) });
        else if (snapshot.state === "checking") set({ state: "idle", reason: null });
      }
    })().finally(() => {
      if (inflight === run) inflight = undefined;
    });
    inflight = run;
    return run;
  }
  /** The controller changed with no event, for example in a page that was frozen or in bfcache. */
  function noticeSwappedController() {
    const controller = container?.controller;
    if (!controller || !knownController || controller === knownController || installRequested) return;
    knownController = controller;
    if (snapshot.state !== "reload-needed") set({ state: "reload-needed", reason: null });
  }
  function onReturn() {
    noticeSwappedController();
    const now = environment().now();
    if (lastCheckStarted !== null && now - lastCheckStarted < RETURN_CHECK_INTERVAL_MS) return;
    void check(false);
  }
  function stopInstallTimer() {
    if (installTimer !== undefined) environment().clearTimeout(installTimer);
    installTimer = undefined;
  }
  function onControllerChange() {
    const controller = container?.controller ?? null;
    if (installRequested) {
      // This tab asked for the update; the new worker now controls it. Reload once.
      stopInstallTimer();
      knownController = controller;
      hadController = true;
      if (!reloaded) {
        reloaded = true;
        environment().reload();
      }
      return;
    }
    const foreign = hadController;
    hadController = true;
    knownController = controller;
    // Another window installed an update, so this page still runs the old code. The first
    // install claiming a page that had no worker is not an update.
    if (foreign && snapshot.state !== "reload-needed") set({ state: "reload-needed", reason: null });
  }
  function installFailed(waiting: WorkerLike | undefined, reason: string) {
    installRequested = false;
    stopInstallTimer();
    const newer = registration?.waiting;
    if (newer && newer !== waiting && container?.controller) set({ state: "available", reason: null });
    else set({ state: "error", reason });
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    /** Register the worker and check for an update. Safe to call more than once. */
    start() {
      if (started) return;
      started = true;
      try {
        const env = environment();
        if (!env.production || !env.serviceWorker) {
          set({ state: "unsupported" });
          return;
        }
        const active = env.serviceWorker;
        container = active;
        hadController = !!active.controller;
        knownController = active.controller ?? null;
        active.addEventListener("controllerchange", onControllerChange);
        env.document.addEventListener("visibilitychange", () => {
          if (env.document.visibilityState === "visible") onReturn();
        });
        env.window.addEventListener("pageshow", (event) => {
          if (event.persisted) onReturn();
        });
        active
          .register("/sw.js")
          .then((found) => {
            registration = found;
            found.addEventListener("updatefound", () => {
              if (found.installing) watch(found.installing);
            });
            // An install may already be running when register() resolves.
            if (found.installing) watch(found.installing);
            evaluate();
            return check(false);
          })
          .catch(() => {
            // Network or browser policy may prevent installation; the online app remains usable.
            set({ state: "error", reason: "the update worker could not be registered" });
          });
      } catch {
        set({ state: "error", reason: "the update worker could not be registered" });
      }
    },
    /** Check now, for the reviewer's button. */
    checkForUpdate: () => check(true),
    /** Ask the waiting worker to take over. The page reloads once it controls this tab. */
    installUpdate() {
      const waiting = registration?.waiting;
      if (snapshot.state !== "available" || !waiting) return;
      installRequested = true;
      set({ state: "updating", reason: null });
      waiting.addEventListener("statechange", () => {
        if (waiting.state === "redundant" && snapshot.state === "updating")
          installFailed(waiting, "the update could not be installed");
      });
      try {
        waiting.postMessage({ type: "SKIP_WAITING" });
      } catch {
        installFailed(waiting, "the update could not be started");
        return;
      }
      stopInstallTimer();
      installTimer = environment().setTimeout(() => {
        installTimer = undefined;
        if (snapshot.state !== "updating") return;
        // A later controllerchange then counts as another window's install and asks for a reload.
        installRequested = false;
        if (hasUpdate()) set({ state: "available", reason: null });
        else set({ state: "error", reason: "the update did not finish" });
      }, INSTALL_TIMEOUT_MS);
    },
    /** Reload to run the code that another window installed. */
    reloadNow() {
      environment().reload();
    },
  };
}
export type AppUpdate = ReturnType<typeof createAppUpdate>;

export const appUpdate: AppUpdate = createAppUpdate(() => ({
  production: import.meta.env.PROD,
  serviceWorker: "serviceWorker" in navigator ? (navigator.serviceWorker as unknown as ContainerLike) : undefined,
  reload: () => location.reload(),
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  document,
  window,
}));

export function useAppUpdate(): AppUpdateSnapshot {
  return useSyncExternalStore(appUpdate.subscribe, appUpdate.getSnapshot);
}

function entryScriptUrl() {
  return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? "";
}
/** The content hash in the running entry script's file name (`/assets/app-<hash>.js`), or null. */
export function buildTag(url: string = entryScriptUrl()): string | null {
  return /\/assets\/[\w.]+-([\w-]{6,})\.js(?:[?#]|$)/.exec(url)?.[1] ?? null;
}
