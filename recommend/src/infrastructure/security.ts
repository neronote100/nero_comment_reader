export const randomToken = () =>
  b64(crypto.getRandomValues(new Uint8Array(32)));
export function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function unb64(s: string) {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
}
export async function hash(s: string) {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  );
}
async function aes(secret: string) {
  const bytes = unb64(secret);
  if (bytes.length !== 32)
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 random bytes (base64url)");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function encrypt(s: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aes(secret),
    new TextEncoder().encode(s),
  );
  return b64(iv) + "." + b64(new Uint8Array(data));
}
export async function decrypt(s: string, secret: string) {
  const [iv, data] = s.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv) },
      await aes(secret),
      unb64(data),
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
