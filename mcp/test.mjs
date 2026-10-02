import worker from "./worker.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rpc(method, params, id = 1) {
  const req = new Request("https://example.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const res = await worker.fetch(req, {});
  const body = await res.json();
  assert(res.status === 200, method + " returned HTTP " + res.status);
  return body;
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "1" },
});
assert(init.result?.serverInfo?.name === "nero-comment-reader", "initialize failed");

const list = await rpc("tools/list", {});
const names = list.result?.tools?.map((tool) => tool.name) || [];
for (const expected of [
  "get_comment_reader_status",
  "list_unanswered_comments",
  "list_unanswered_by_article",
  "get_unanswered_comment",
]) {
  assert(names.includes(expected), "missing tool " + expected);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async () =>
  new Response(JSON.stringify({
    version: 1,
    owner: "nero_notelover",
    updatedAt: "2026-10-02T00:00:00.000Z",
    articleCount: 2,
    unresolvedCount: 7,
    failedArticles: 0,
    items: [
      {
        id: "note:comment1",
        authorName: "テストさん",
        authorUrlname: "test",
        body: "こんにちは",
        publishedAt: "2026-10-02T09:00:00+09:00",
        articleTitle: "テスト記事",
        articleUrl: "https://note.com/nero_notelover/n/test",
        rootBody: "こんにちは",
        rootAuthorUrlname: "test"
      },
      {
        id: "note:comment2",
        authorName: "別の人",
        authorUrlname: "other",
        body: "二つ目です",
        publishedAt: "2026-10-02T08:30:00+09:00",
        articleTitle: "テスト記事",
        articleUrl: "https://note.com/nero_notelover/n/test",
        rootBody: "二つ目です",
        rootAuthorUrlname: "other"
      },
      {
        id: "note2:comment3",
        authorName: "三人目",
        authorUrlname: "third",
        body: "別記事です",
        publishedAt: "2026-10-02T08:00:00+09:00",
        articleTitle: "別の記事",
        articleUrl: "https://note.com/nero_notelover/n/test2",
        rootBody: "別記事です",
        rootAuthorUrlname: "third"
      },
      {
        id: "note3:comment4",
        authorName: "四人目",
        authorUrlname: "fourth",
        body: "三記事目です1",
        publishedAt: "2026-10-02T07:50:00+09:00",
        articleTitle: "三つ目の記事",
        articleUrl: "https://note.com/nero_notelover/n/test3",
        rootBody: "三記事目です1",
        rootAuthorUrlname: "fourth"
      },
      {
        id: "note3:comment5",
        authorName: "五人目",
        authorUrlname: "fifth",
        body: "三記事目です2",
        publishedAt: "2026-10-02T07:40:00+09:00",
        articleTitle: "三つ目の記事",
        articleUrl: "https://note.com/nero_notelover/n/test3",
        rootBody: "三記事目です2",
        rootAuthorUrlname: "fifth"
      },
      {
        id: "note3:comment6",
        authorName: "六人目",
        authorUrlname: "sixth",
        body: "三記事目です3",
        publishedAt: "2026-10-02T07:30:00+09:00",
        articleTitle: "三つ目の記事",
        articleUrl: "https://note.com/nero_notelover/n/test3",
        rootBody: "三記事目です3",
        rootAuthorUrlname: "sixth"
      },
      {
        id: "note3:comment7",
        authorName: "七人目",
        authorUrlname: "seventh",
        body: "三記事目です4",
        publishedAt: "2026-10-02T07:20:00+09:00",
        articleTitle: "三つ目の記事",
        articleUrl: "https://note.com/nero_notelover/n/test3",
        rootBody: "三記事目です4",
        rootAuthorUrlname: "seventh"
      }
    ]
  }), { status: 200, headers: { "content-type": "application/json" } });

const call = await rpc("tools/call", {
  name: "list_unanswered_comments",
  arguments: { limit: 5 },
});
assert(call.result?.structuredContent?.comments?.length === 5, "tools/call failed");
assert(call.result.structuredContent.comments[0].id === "note:comment1", "wrong comment");

const grouped = await rpc("tools/call", {
  name: "list_unanswered_by_article",
  arguments: { min_comments: 5 },
});
assert(grouped.result?.structuredContent?.articles?.length === 3, "article grouping failed");
assert(grouped.result.structuredContent.returnedComments === 7, "minimum comment batch failed");
assert(grouped.result.structuredContent.articles[0].commentCount === 2, "same article comments were not grouped");
assert(grouped.result.structuredContent.articles[2].commentCount === 4, "last article was split unexpectedly");
assert(grouped.result.structuredContent.articles[2].comments[3].id === "note3:comment7", "grouped comment missing");

globalThis.fetch = originalFetch;
console.log("MCP tests passed");
