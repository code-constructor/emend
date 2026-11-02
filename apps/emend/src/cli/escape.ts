function escapeControls(value: string, escaped: (code: number) => string): string {
  return Array.from(value, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 ||
      (code >= 127 && code <= 159) ||
      /[\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u206f\ufeff]/u.test(char)
      ? escaped(code)
      : char;
  }).join("");
}

/** Keep untrusted paths and references visible on one terminal line. */
export function escapeReference(value: string): string {
  return escapeControls(value, (code) => `\\u{${code.toString(16)}}`);
}

/** Escape serialized JSON for a terminal without changing what JSON.parse returns. */
export function escapeJson(json: string): string {
  const shortEscapes: Record<string, string> = { b: "0008", f: "000c", n: "000a", r: "000d", t: "0009" };
  const expanded = json.replace(/\\./gs, (pair) => {
    const code = shortEscapes[pair[1] ?? ""];
    return code ? `\\u${code}` : pair;
  });
  return escapeControls(expanded, (code) => `\\u${code.toString(16).padStart(4, "0")}`);
}
