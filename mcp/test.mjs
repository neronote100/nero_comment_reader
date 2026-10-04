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
  "list_live_comment_check_articles",
  "check_live_unanswered_article",
  "get_unanswered_comment",
]) {
  assert(names.includes(expected), "missing tool " + expected);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url=String(input);

  if(url.includes("/data/state.json")){
    return new Response(JSON.stringify({articles:{}}),{status:200,headers:{"content-type":"application/json"}});
  }

  if(url.includes("/api/v2/creators/nero_notelover/contents")){
    return new Response(JSON.stringify({data:{
      contents:[
        {key:"note",name:"テスト記事",commentCount:2,publishAt:"2026-10-02T09:30:00+09:00"},
        {key:"note2",name:"別の記事",commentCount:1,publishAt:"2026-10-02T08:10:00+09:00"},
        {key:"note3",name:"三つ目の記事",commentCount:4,publishAt:"2026-10-02T07:55:00+09:00"}
      ],
      isLastPage:true
    }}),{status:200,headers:{"content-type":"application/json"}});
  }

  const roots = {
    note:[
      {key:"comment1",comment:"こんにちは",is_root:true,reply_count:0,is_creator_liked:false,created_at:"2026-10-02T09:00:00+09:00",user:{urlname:"test",nickname:"テストさん"}},
      {key:"comment2",comment:"二つ目です",is_root:true,reply_count:0,is_creator_liked:false,created_at:"2026-10-02T08:30:00+09:00",user:{urlname:"other",nickname:"別の人"}}
    ],
    note2:[
      {key:"comment3",comment:"別記事です",is_root:true,reply_count:0,is_creator_liked:false,created_at:"2026-10-02T08:00:00+09:00",user:{urlname:"third",nickname:"三人目"}}
    ],
    note3:[
      {key:"comment4",comment:"三記事目です1",is_root:true,reply_count:0,is_creator_liked:false,created_at:"2026-10-02T07:50:00+09:00",user:{urlname:"fourth",nickname:"四人目"}},
      {key:"comment5",comment:"三記事目です2",is_root:true,reply_count:0,is_creator_liked:false,created_at:"2026-10-02T07:40:00+09:00",user:{urlname:"fifth",nickname:"五人目"}},
      {key:"comment6",comment:"三記事目です3",is_root:true,reply_count:0,is_creator_liked:false,created_at:"2026-10-02T07:30:00+09:00",user:{urlname:"sixth",nickname:"六人目"}},
      {key:"comment7",comment:"三記事目です4",is_root:true,reply_count:0,is_creator_liked:false,created_at:"2026-10-02T07:20:00+09:00",user:{urlname:"seventh",nickname:"七人目"}}
    ]
  };

  for(const [key,comments] of Object.entries(roots)){
    if(url.includes("/api/v3/notes/"+key+"/note_comments")){
      return new Response(JSON.stringify({data:comments,next_page:null}),{status:200,headers:{"content-type":"application/json"}});
    }
  }

  throw new Error("unexpected fetch "+url);
};

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

// Long-thread unanswered detection: evaluate the whole conversation, not a stale root flag.
globalThis.fetch = async (input) => {
  const url=String(input);

  if(url.includes("/data/state.json")){
    return new Response(JSON.stringify({
      articles:{
        nthread1:{commentCount:4,checkedAt:1,unresolved:[{key:"old-stale",rootKey:"root1",body:"古い未返信"}]},
        npending:{commentCount:3,checkedAt:1,unresolved:[{key:"old-pending",rootKey:"root2",body:"古い未返信"}]},
        nfail:{commentCount:1,checkedAt:1,unresolved:[{key:"stale-fallback",rootKey:"root-fail",body:"返信済みなのに残っていた古いデータ"}]}
      }
    }),{status:200,headers:{"content-type":"application/json"}});
  }

  if(url.includes("/api/v2/creators/nero_notelover/contents")){
    return new Response(JSON.stringify({data:{
      contents:[
        {key:"nthread1",name:"長いやり取り・対応済み",commentCount:4,publishAt:"2026-10-04T01:00:00+09:00"},
        {key:"npending",name:"長いやり取り・最後だけ未対応",commentCount:3,publishAt:"2026-10-04T00:50:00+09:00"},
        {key:"nfail",name:"取得失敗記事",commentCount:1,publishAt:"2026-10-04T00:40:00+09:00"}
      ],
      isLastPage:true
    }}),{status:200,headers:{"content-type":"application/json"}});
  }

  if(url.includes("/api/v3/notes/nthread1/note_comments") && !url.includes("parent_key")){
    return new Response(JSON.stringify({data:[{
      key:"root1",comment:"最初のコメント",is_root:true,reply_count:3,
      is_creator_replied:true,is_creator_liked:false,created_at:"2026-10-04T01:00:00+09:00",
      user:{urlname:"guest1",nickname:"ゲスト1"}
    }],next_page:null}),{status:200,headers:{"content-type":"application/json"}});
  }
  if(url.includes("/api/v3/notes/nthread1/note_comments") && url.includes("parent_key=root1")){
    return new Response(JSON.stringify({data:[
      {key:"r1",comment:"王子返信1",is_root:false,is_creator_liked:false,created_at:"2026-10-04T01:01:00+09:00",user:{urlname:"nero_notelover",nickname:"王子"}},
      {key:"r2",comment:"相手の追撃",is_root:false,is_creator_liked:false,created_at:"2026-10-04T01:02:00+09:00",user:{urlname:"guest1",nickname:"ゲスト1"}},
      {key:"r3",comment:"王子の最後の返信",is_root:false,is_creator_liked:false,created_at:"2026-10-04T01:03:00+09:00",user:{urlname:"nero_notelover",nickname:"王子"}}
    ],next_page:null}),{status:200,headers:{"content-type":"application/json"}});
  }

  if(url.includes("/api/v3/notes/npending/note_comments") && !url.includes("parent_key")){
    return new Response(JSON.stringify({data:[{
      key:"root2",comment:"最初のコメント",is_root:true,reply_count:2,
      is_creator_replied:true,is_creator_liked:false,created_at:"2026-10-04T02:00:00+09:00",
      user:{urlname:"guest2",nickname:"ゲスト2"}
    }],next_page:null}),{status:200,headers:{"content-type":"application/json"}});
  }
  if(url.includes("/api/v3/notes/npending/note_comments") && url.includes("parent_key=root2")){
    return new Response(JSON.stringify({data:[
      {key:"p1",comment:"王子返信",is_root:false,is_creator_liked:false,created_at:"2026-10-04T02:01:00+09:00",user:{urlname:"nero_notelover",nickname:"王子"}},
      {key:"p2",comment:"最後の相手コメント",is_root:false,is_creator_liked:false,created_at:"2026-10-04T02:02:00+09:00",user:{urlname:"guest2",nickname:"ゲスト2"}}
    ],next_page:null}),{status:200,headers:{"content-type":"application/json"}});
  }

  if(url.includes("/api/v3/notes/nfail/note_comments")){
    throw new Error("simulated note API failure");
  }

  throw new Error("unexpected live fetch "+url);
};

async function getLive(path){
  const res=await worker.fetch(new Request("https://example.test"+path),{});
  return res.json();
}

const handledThread=await getLive("/comments/live?offset=0&batch=1");
assert(handledThread.ok===true,"live handled thread request failed");
assert(handledThread.items.length===0,"already replied long thread was incorrectly unresolved");

const pendingThread=await getLive("/comments/live?offset=1&batch=1");
assert(pendingThread.items.length===1,"pending long thread was not detected");
assert(pendingThread.items[0].commentKey==="p2","latest pending reply was not selected");
assert(pendingThread.items[0].pendingCount===1,"pending thread count incorrect");

const failedThread=await getLive("/comments/live?offset=2&batch=1");
assert(failedThread.failedArticles===1,"failed article was not marked pending review");
assert(failedThread.items.length===0,"stale unresolved data was revived after scan failure");

globalThis.fetch = originalFetch;
console.log("MCP tests passed");
