import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, pair } from "../api/client.ts";
import { Button } from "../components/ui/Button.tsx";
import { subscribePairingSecret, takePairingSecret } from "../lib/pairing-secret.ts";

export function PairPage() {
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(window.location.hostname);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const redeemed = useRef(new Set<string>());
  const redeem = useCallback(
    async (input: { secret: string } | { code: string }) => {
      setBusy(true);
      setError("");
      try {
        await pair(input);
        client.clear();
        await navigate({ to: "/", replace: true });
      } catch (error) {
        setError(
          error instanceof ApiError && error.status === 429
            ? "Too many wrong codes. Wait 10 minutes, then try again."
            : error instanceof ApiError && (error.status === 401 || error.status === 400)
              ? "That code did not work. Check it on the hub and try again."
              : "Could not pair. Check your connection and try again.",
        );
      } finally {
        setBusy(false);
      }
    },
    [client, navigate],
  );
  useEffect(() => {
    const consume = () => {
      const secret = takePairingSecret();
      if (!secret || redeemed.current.has(secret)) return;
      redeemed.current.add(secret);
      void redeem({ secret });
    };
    const unsubscribe = subscribePairingSecret(consume);
    consume();
    return unsubscribe;
  }, [redeem]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <p className="mb-8 text-lg font-semibold tracking-tight">emend</p>
      <h1 className="text-2xl font-semibold tracking-tight">{loopback ? "Sign in" : "Pair a device"}</h1>
      {loopback ? (
        <>
          {busy ? (
            <p role="status" className="mt-6">
              Pairing…
            </p>
          ) : (
            <p className="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
              Run <code>emend</code> in a terminal on the machine that runs emend. It opens this page signed in, or
              prints a one-time link you can open here.
            </p>
          )}
          {error && (
            <p role="alert" className="mt-6 text-sm">
              {error}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
            The app on your home screen pairs once more with a code, even after Safari has paired.
          </p>
          <form
            className="mt-6 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void redeem({ code: code.trim() });
            }}
          >
            <label className="block text-sm font-medium" htmlFor="pairing-code">
              Pairing code
            </label>
            <input
              id="pairing-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              required
              maxLength={9}
              disabled={busy}
              placeholder="XXXX-XXXX"
              className="min-h-12 w-full rounded-md border border-neutral-300 bg-transparent px-3 font-mono text-lg focus-visible:outline-blue-600 dark:border-neutral-700"
            />
            <Button type="submit" disabled={busy} variant="primary" size="lg" fullWidth>
              Pair
            </Button>
            {busy && <p role="status">Pairing…</p>}
            {error && (
              <p role="alert" className="text-sm">
                {error}
              </p>
            )}
          </form>
        </>
      )}
    </main>
  );
}
