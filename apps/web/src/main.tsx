import { configureBrowserValidation } from "@emend/contract/browser";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { rememberPairingSecret } from "./lib/pairing-secret.ts";
import "./styles.css";

configureBrowserValidation();
function capturePairingSecret() {
  if (!/^\/pair\/?$/i.test(location.pathname) || !location.hash) return;
  const secret = location.hash.slice(1);
  history.replaceState(null, "", "/pair");
  rememberPairingSecret(secret);
}
window.addEventListener("hashchange", capturePairingSecret);
window.addEventListener("popstate", capturePairingSecret);
capturePairingSecret();

const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");

const { App } = await import("./App.tsx");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
