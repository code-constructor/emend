import { AppFrame } from "../components/layout/AppFrame.tsx";

export function DevicesPage() {
  return (
    <AppFrame title="Devices">
      <main className="p-6">
        <h1 className="text-2xl font-semibold">Devices</h1>
        <p className="mt-3 text-neutral-600 dark:text-neutral-400">
          Pair a phone or another browser with <code>emend pair</code> on the hub.
        </p>
      </main>
    </AppFrame>
  );
}
