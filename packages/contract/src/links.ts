import { z } from "zod";

export const LINKS = { perRevision: 8, urlChars: 2048, labelChars: 60 } as const;

// Whitespace, control and format characters (bidi marks, zero-width joiners) never belong in a URL or label.
const unsafeChars = /[\s\p{Cc}\p{Cf}]/u;

function parseHttps(value: string): URL | null {
  if (value.length > LINKS.urlChars || unsafeChars.test(value) || !/^https:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname === "") return null;
    return url;
  } catch {
    return null;
  }
}

/** An absolute https URL without credentials, as the reviewer's browser should open it. */
export const HttpsUrl = z.string().refine((value) => parseHttps(value) !== null, "expected an https URL");

const host = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;
const segment = /^[A-Za-z0-9._-]+$/;

/** `https://host/owner/name`, nothing else: the base for issue links. */
export const RepoUrl = z.string().refine((value) => {
  const url = parseHttps(value);
  if (url === null) return false;
  if (url.search !== "" || url.hash !== "" || url.host !== url.host.toLowerCase()) return false;
  const [authority = "", ...path] = value.slice("https://".length).split("/");
  if (!host.test(authority) || path.length !== 2) return false;
  return (
    path.every((part) => segment.test(part) && part !== "." && part !== "..") && url.pathname === `/${path.join("/")}`
  );
}, "expected https://host/owner/name");
export type RepoUrl = z.infer<typeof RepoUrl>;

export const PublishLink = z.object({
  url: HttpsUrl,
  label: z
    .string()
    .min(1)
    .max(LINKS.labelChars)
    .refine((label) => label.trim() !== "" && !/[\p{Cc}\p{Cf}]/u.test(label), "label must be plain visible text"),
  kind: z.enum(["pr", "issue", "other"]).optional(),
});
export type PublishLink = z.infer<typeof PublishLink>;

export const PublishLinks = z.array(PublishLink).max(LINKS.perRevision);
export type PublishLinks = z.infer<typeof PublishLinks>;

/** The two publish-level fields that ride beside the writeup: in its source blob and its rendered blob. */
export const PublishMeta = z.object({ links: PublishLinks.optional(), repoUrl: RepoUrl.optional() });
export type PublishMeta = z.infer<typeof PublishMeta>;
