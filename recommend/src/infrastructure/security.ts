export function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function hash(s: string) {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  );
}
export async function jsonFetch<T>(
  url: string,
  init: RequestInit = {},
  timeout = 18000,
): Promise<T> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(new URL(url).hostname + " HTTP " + r.status);
  return r.json() as Promise<T>;
}
