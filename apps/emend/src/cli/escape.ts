/** Keep untrusted paths and references visible on one terminal line. */
export function escapeReference(value: string): string {
  return Array.from(value, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 ||
      (code >= 127 && code <= 159) ||
      /[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u206f\ufeff]/u.test(char)
      ? `\\u{${code.toString(16)}}`
      : char;
  }).join("");
}
