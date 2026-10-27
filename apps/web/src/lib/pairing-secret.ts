let pairingSecret: string | undefined;
const listeners = new Set<() => void>();

export function rememberPairingSecret(secret: string) {
  pairingSecret = secret;
  for (const listener of listeners) listener();
}

export function subscribePairingSecret(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function takePairingSecret() {
  const secret = pairingSecret;
  pairingSecret = undefined;
  return secret;
}
