import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { D1Repository } from "../src/infrastructure/repository";
import type { Env } from "../src/env";
import type { Article, Member } from "../src/domain";
export function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0001_library.sql", import.meta.url),
      "utf8",
    ),
  );
  function prepare(sql: string) {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        args = values;
        return this;
      },
      async first<T>() {
        return (sqlite.prepare(sql).get(...(args as never[])) as T) || null;
      },
      async all<T>() {
        return {
          success: true,
          results: sqlite.prepare(sql).all(...(args as never[])) as T[],
        };
      },
      async run() {
        return {
          success: true,
          meta: sqlite.prepare(sql).run(...(args as never[])),
        };
      },
    };
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
  return { db, repo: new D1Repository(db), sqlite };
}
export function member(id = "writer", overrides: Partial<Member> = {}): Member {
  return {
    id: "note:" + id,
    name: id,
    note_username: id,
    profile_url: "https://note.com/" + id,
    account_url: "https://note.com/" + id,
    discord_name: "",
    tags: "[]",
    priority: 0,
    status: "active",
    received_at: "2026-01-01T00:00:00.000Z",
    joined_at: "2026-01-01T00:00:00.000Z",
    last_event_at: "2026-01-01T00:00:00.000Z",
    last_status_at: "2026-01-01T00:00:00.000Z",
    last_introduced_at: null,
    plan: "",
    synced_at: null,
    sync_error: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
export function article(
  id = "n123456789abc",
  overrides: Partial<Article> = {},
): Article {
  return {
    id,
    member_id: "note:writer",
    title: "記事タイトル",
    url: "https://note.com/writer/n/" + id,
    published_at: new Date().toISOString(),
    likes: 10,
    comments: 2,
    tags: "[]",
    thumbnail: "",
    body: "読者との出会いを大切にしています。",
    body_hash: "body-v1",
    body_status: "public",
    collected_at: new Date().toISOString(),
    participated: 0,
    favorite: 0,
    available: 1,
    ...overrides,
  };
}
export async function siteEnv(db: D1Database) {
  const env: Env = {
    DB: db,
    APP_ORIGIN: "https://library.test",
    NOTE_OWNER: "nero_notelover",
    MEMBERSHIP_NAME: "王子の城下町",
    GMAIL_FROM: "noreply@note.com",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    OPENAI_MODEL: "test-model",
    AUTO_AI_LIMIT: "6",
  };
  const request = (
    path: string,
    data?: unknown,
    options: { origin?: string; cookie?: string; method?: string } = {},
  ) =>
    new Request(env.APP_ORIGIN + path, {
      method: data === undefined ? "GET" : options.method || "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: options.origin || env.APP_ORIGIN,
        Cookie: options.cookie ?? "",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  return { env, request };
}
