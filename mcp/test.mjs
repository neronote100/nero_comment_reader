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
  "find_event_articles_by_hashtag",
  "find_event_articles_by_magazine",
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

globalThis.fetch = async (input) => {
  const url=String(input);
  if(url.includes("neronote100.github.io/nero_comment_reader/data/inbox.json")){
    return new Response(JSON.stringify({
      version:1,owner:"nero_notelover",updatedAt:"2026-10-02T00:00:00.000Z",
      articleCount:0,unresolvedCount:0,failedArticles:0,items:[]
    }),{status:200,headers:{"content-type":"application/json"}});
  }
  if(url.includes("/api/v3/hashtags/")){
    return new Response(JSON.stringify({data:{notes:[{
      key:"nevent1",name:"イベント参加記事",body:"秋の公園でどんぐりを拾った話です。",
      publish_at:"2026-10-02T19:00:00+09:00",like_count:4,
      user:{urlname:"participant",nickname:"参加者"}
    }],next_page:null}}),{status:200,headers:{"content-type":"application/json"}});
  }
  if(url.includes("/api/v1/magazines/")){
    return new Response(JSON.stringify({data:{
      name:"テストマガジン",
      notes:[{
        key:"nevent2",name:"マガジン参加記事",body:null,
        publish_at:"2026-10-02T18:00:00+09:00",
        user:{urlname:"participant2",nickname:"参加者2"}
      }],
      next_page:null
    }}),{status:200,headers:{"content-type":"application/json"}});
  }
  if(url.includes("/note_comments")){
    return new Response(JSON.stringify({data:[],next_page:null}),{status:200,headers:{"content-type":"application/json"}});
  }
  if(url.includes("/api/v3/notes/nevent1")){
    return new Response(JSON.stringify({data:{body:"秋の公園で子どもとどんぐりを拾い、形の違いを楽しみました。"}}),{status:200,headers:{"content-type":"application/json"}});
  }
  if(url.includes("/api/v3/notes/nevent2")){
    return new Response(JSON.stringify({data:{body:"読書の秋に好きな本を読み返した話です。"}}),{status:200,headers:{"content-type":"application/json"}});
  }
  throw new Error("unexpected fetch "+url);
};

const hashtag = await rpc("tools/call", {
  name:"find_event_articles_by_hashtag",
  arguments:{hashtag:"#秋読コレクション",limit:5},
});
assert(hashtag.result?.structuredContent?.articles?.length===1,"hashtag event search failed");
assert(hashtag.result.structuredContent.articles[0].body.includes("どんぐり"),"hashtag article body missing");

const magazine = await rpc("tools/call", {
  name:"find_event_articles_by_magazine",
  arguments:{magazine:"https://note.com/nero_notelover/m/mbdfa1301e316",limit:5},
});
assert(magazine.result?.structuredContent?.articles?.length===1,"magazine event search failed");
assert(magazine.result.structuredContent.articles[0].body.includes("読書の秋"),"magazine article body missing");

globalThis.fetch = originalFetch;
console.log("MCP tests passed");
