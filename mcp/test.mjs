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
    unresolvedCount: 1,
    failedArticles: 0,
    items: [{
      id: "note:comment",
      authorName: "テストさん",
      authorUrlname: "test",
      body: "こんにちは",
      publishedAt: "2026-10-02T09:00:00+09:00",
      articleTitle: "テスト記事",
      articleUrl: "https://note.com/nero_notelover/n/test",
      rootBody: "こんにちは",
      rootAuthorUrlname: "test"
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });

const call = await rpc("tools/call", {
  name: "list_unanswered_comments",
  arguments: { limit: 5 },
});
assert(call.result?.structuredContent?.comments?.length === 1, "tools/call failed");
assert(call.result.structuredContent.comments[0].id === "note:comment", "wrong comment");

globalThis.fetch = originalFetch;
console.log("MCP tests passed");
