import { PairingCreated } from "@emend/contract";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { encode } from "uqr";
import { post } from "../api/client.ts";
import { AppFrame } from "../components/layout/AppFrame.tsx";

export function PairDevicePage() {
  const pending = useRef<Promise<PairingCreated> | null>(null);
  const [pairing, setPairing] = useState<PairingCreated>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    pending.current ??= post("/api/v1/pairings", { purpose: "device" }, PairingCreated);
    void pending.current.then(
      (value) => {
        if (active) setPairing(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const qr = pairing ? encode(pairing.url, { border: 4 }) : undefined;
  const cells = qr?.data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [{ x, y }] : []))) ?? [];
  return (
    <AppFrame title="Pair a device">
      <main className="overflow-auto p-6">
        <h1 className="text-2xl font-semibold">Pair a device</h1>
        {failed ? (
          <p role="alert">Could not create a pairing. Return to Devices and try again.</p>
        ) : (
          !pairing && <p role="status">Creating pairing…</p>
        )}
        {pairing && qr && (
          <>
            <svg
              role="img"
              aria-label="Pairing QR code"
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              width="256"
              height="256"
              className="my-4 max-w-full"
              shapeRendering="crispEdges"
            >
              <title>Pairing QR code</title>
              <rect width={qr.size} height={qr.size} fill="white" />
              {cells.map((cell) => (
                <rect key={`${cell.x}:${cell.y}`} x={cell.x} y={cell.y} width="1" height="1" fill="black" />
              ))}
            </svg>
            <p className="font-mono text-2xl">{pairing.code}</p>
            <p className="my-3">Valid for 10 minutes, once.</p>
          </>
        )}
        <Link to="/devices" className="text-blue-700 underline dark:text-blue-300">
          Devices
        </Link>
      </main>
    </AppFrame>
  );
}
