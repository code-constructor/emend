import { DeviceList, type DeviceView } from "@emend/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { change, get } from "../api/client.ts";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { Button } from "../components/ui/Button.tsx";

export function DevicesPage() {
  const client = useQueryClient();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: ({ signal }) => get("/api/v1/devices", DeviceList, signal),
  });
  const revoke = useMutation({
    mutationFn: (device: DeviceView) => change(`/api/v1/devices/${device.id}`, "DELETE"),
    onSuccess: async (_data, device) => {
      if (device.current) {
        client.clear();
        window.location.assign("/pair");
      } else await client.invalidateQueries({ queryKey: ["devices"] });
    },
  });
  return (
    <AppFrame title="Devices">
      <main className="overflow-auto p-6">
        <h1 className="text-2xl font-semibold">Devices</h1>
        <Button asChild className="my-4">
          <Link to="/devices/pair">Pair a device</Link>
        </Button>
        {devices.isPending && <p role="status">Loading devices…</p>}
        {devices.isError && <p role="alert">Could not load devices. Try again.</p>}
        {revoke.isError && <p role="alert">Could not revoke the device. Try again.</p>}
        {devices.data?.items.length === 0 && <p>No paired devices.</p>}
        <ul className="space-y-4">
          {devices.data?.items.map((device) => (
            <li
              key={device.id}
              className="flex flex-wrap items-center gap-4 rounded-md border border-neutral-300 p-4 dark:border-neutral-700"
            >
              <div className="flex-1">
                <p className="font-medium">{device.name}</p>
                {device.current && <p>This browser</p>}
                <p className="text-sm">
                  {device.kind} · Created {new Date(device.createdAt).toLocaleString()}
                </p>
                <p className="text-sm">
                  Last seen: {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "never"}
                </p>
              </div>
              <Button
                disabled={revoke.isPending}
                onClick={() => {
                  if (
                    !device.current ||
                    window.confirm("Revoke this browser? You will need to pair it again to sign in.")
                  )
                    revoke.mutate(device);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </main>
    </AppFrame>
  );
}
