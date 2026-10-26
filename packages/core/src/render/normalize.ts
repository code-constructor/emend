export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\p{White_Space}]+/gu, " ")
    .trim();
}
