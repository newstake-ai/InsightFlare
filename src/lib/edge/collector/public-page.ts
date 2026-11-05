import { sanitizeLimitedPayload } from "@/lib/tracker-contract/limited-analytics";
import type { TrackerClientPayload } from "@/lib/tracker-contract/types";

const SITE = "628631a7-ff2f-4f9c-aa11-df2fca9b2acb";

export async function verifiedPublicPage(
  input: TrackerClientPayload,
  secret?: string,
) {
  if (!secret || input.siteId !== SITE || input.hostname !== "newstake.ai")
    return null;
  const token = input.publicPageToken;
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  )
    return null;
  try {
    const decode = (part: string) =>
      Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        decode(parts[1]),
        new TextEncoder().encode(parts[0]),
      ))
    )
      return null;
    const data = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    if (
      data.site !== SITE ||
      data.host !== "newstake.ai" ||
      typeof data.path !== "string" ||
      data.path.length > 512 ||
      typeof data.title !== "string" ||
      !data.title ||
      data.title.length > 200 ||
      !Number.isSafeInteger(data.exp) ||
      data.exp < Date.now() ||
      data.exp > Date.now() + 86400000
    )
      return null;
    if (
      sanitizeLimitedPayload({ siteId: SITE, pathname: data.path }).pathname !==
      input.pathname
    )
      return null;
    return { pathname: data.path, title: data.title };
  } catch {
    return null;
  }
}
