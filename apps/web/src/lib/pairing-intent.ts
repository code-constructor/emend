import type { RouterHistory } from "@tanstack/react-router";
import type { MouseEvent } from "react";

export type PairingIntent = { devicesIndex?: number };
let intent: PairingIntent | undefined;

export function requestPairingFromLink(event: MouseEvent<HTMLAnchorElement>, location: RouterHistory["location"]) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    (event.currentTarget.target && event.currentTarget.target !== "_self")
  )
    return;
  intent = {
    devicesIndex: /^\/devices\/?$/.test(location.pathname) ? location.state.__TSR_index : undefined,
  };
}

export function takePairingIntent() {
  const taken = intent;
  intent = undefined;
  return taken;
}
