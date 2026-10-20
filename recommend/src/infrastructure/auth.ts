import type { Env } from "../env";
import { encrypt, hash, jsonFetch, randomToken } from "./security";
export function cookies(request: Request) {
  return Object.fromEntries(
    (request.headers.get("cookie") || "")
      .split(";")
      .map((s) => s.trim().split("=")),
  );
}
export function cookie(name: string, value: string, env: Env, age: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${env.APP_ORIGIN.startsWith("https:") ? "; Secure" : ""}`;
}
function configured(env: Env) {
  if (
    !env.ADMIN_EMAIL ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.TOKEN_ENCRYPTION_KEY
  )
    throw new Error("管理者・Google OAuth・暗号鍵を先に設定してください");
}
export async function login(env: Env) {
  configured(env);
  const state = randomToken(),
    verifier = randomToken();
  await env.DB.prepare(
    "INSERT INTO oauth_states (state_hash,verifier,expires_at) VALUES (?,?,?)",
  )
    .bind(await hash(state), verifier, Date.now() + 10 * 60000)
    .run();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.APP_ORIGIN + "/auth/callback",
    response_type: "code",
    scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: await hash(verifier),
    code_challenge_method: "S256",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: "https://accounts.google.com/o/oauth2/v2/auth?" + params,
      "Set-Cookie": cookie("nero_oauth", state, env, 600),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export async function callback(request: Request, env: Env) {
  configured(env);
  const url = new URL(request.url),
    state = url.searchParams.get("state"),
    code = url.searchParams.get("code");
  if (!state || !code || cookies(request).nero_oauth !== state)
    return new Response("認証を最初からやり直してください", { status: 400 });
  const record = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING verifier",
  )
    .bind(await hash(state), Date.now())
    .first<{ verifier: string }>();
  if (!record)
    return new Response("認証の有効期限が切れました", { status: 400 });
  const tokens = await jsonFetch<{
    access_token: string;
    refresh_token?: string;
    scope: string;
  }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.APP_ORIGIN + "/auth/callback",
      grant_type: "authorization_code",
      code,
      code_verifier: record.verifier,
    }),
  });
  const user = await jsonFetch<{ email: string; email_verified: boolean }>(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: "Bearer " + tokens.access_token } },
  );
  if (
    !user.email_verified ||
    user.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()
  )
    return new Response("管理者アカウントでログインしてください", {
      status: 403,
    });
  if (
    !tokens.scope
      .split(" ")
      .includes("https://www.googleapis.com/auth/gmail.readonly")
  )
    return new Response("Gmail読み取り権限の許可が必要です", { status: 403 });
  if (tokens.refresh_token)
    await env.DB.prepare(
      "INSERT INTO credentials (id,encrypted_token) VALUES ('google',?) ON CONFLICT(id) DO UPDATE SET encrypted_token=excluded.encrypted_token",
    )
      .bind(await encrypt(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY))
      .run();
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash,email,expires_at) VALUES (?,?,?)",
  )
    .bind(
      await hash(token),
      user.email.toLowerCase(),
      Date.now() + 7 * 86400000,
    )
    .run();
  const headers = new Headers({
    Location: env.APP_ORIGIN,
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", cookie("nero_session", token, env, 7 * 86400));
  headers.append("Set-Cookie", cookie("nero_oauth", "", env, 0));
  return new Response(null, { status: 302, headers });
}
export async function authenticated(request: Request, env: Env) {
  const token = cookies(request).nero_session;
  if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token) || !env.ADMIN_EMAIL)
    return false;
  const s = await env.DB.prepare(
    "SELECT email FROM sessions WHERE token_hash=? AND expires_at>?",
  )
    .bind(await hash(token), Date.now())
    .first<{ email: string }>();
  return s?.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
}
export async function logout(request: Request, env: Env) {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
    .bind(await hash(cookies(request).nero_session || ""))
    .run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Set-Cookie": cookie("nero_session", "", env, 0),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
