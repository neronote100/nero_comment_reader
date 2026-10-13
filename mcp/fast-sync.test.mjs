import assert from "node:assert/strict";
import { CommentSnapshotStore } from "./worker.js";

const storage = new Map();
const store = new CommentSnapshotStore({ storage: {
  get: async k => storage.get(k),
  put: async (k,v) => storage.set(k, structuredClone(v)),
  delete: async k => storage.delete(k),
}});
const post = (route,body) => store.fetch(new Request("https://test" + route, {
  method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
}));
const get = route => store.fetch(new Request("https://test" + route));
const read = async response => {
  assert.equal(response.ok,true,await response.clone().text());
  return response.json();
};
const articles = [
  { key:"a",title:"A",commentCount:7,url:"https://note.com/nero_notelover/n/a" },
  { key:"b",title:"B",commentCount:0,url:"https://note.com/nero_notelover/n/b" }
];
const fallbackStates = { a:{...articles[0],checkedAt:Date.now(),unresolved:[]}};
let started = await read(await post("/fast/start",{articles,fallbackStates}));
assert.equal(started.done,true);
assert.equal(started.candidateArticles,0);
assert.equal(started.unresolvedCount,0);

started = await read(await post("/fast/start",{articles:[{...articles[0],commentCount:8},articles[1]],fallbackStates}));
assert.equal(started.candidateArticles,1);
assert.equal(started.done,false);
let peek = await read(await get("/fast/peek?scan_id="+started.scanId));
assert.equal(peek.article.key,"a");
assert.equal(peek.article.scanMode,"full");
const comment={key:"x",rootKey:"x",body:"test",authorUrlname:"reader",
  publishedAt:"2026-10-13T09:00:00Z",pendingCount:1,pendingBodies:["test"]};
let done = await read(await post("/fast/commit",{scanId:started.scanId,index:0,unresolved:[comment]}));
assert.equal(done.done,true);
assert.equal(done.items.length,1);
assert.equal((await read(await get("/fast/snapshot"))).items.length,1);

started = await read(await post("/fast/start",{articles:[{...articles[0],commentCount:8},articles[1]],fallbackStates}));
assert.equal(started.candidateArticles,1);
peek = await read(await get("/fast/peek?scan_id="+started.scanId));
assert.equal(peek.article.scanMode,"pending_only");
done = await read(await post("/fast/commit",{scanId:started.scanId,index:0,unresolved:[]}));
assert.equal(done.items.length,0);

started = await read(await post("/fast/start",{articles:[{...articles[0],commentCount:8},articles[1]],fallbackStates}));
assert.equal(started.candidateArticles,0);
assert.equal(started.done,true);

started = await read(await post("/fast/start",{articles:[{...articles[0],commentCount:9},articles[1]],fallbackStates}));
done = await read(await post("/fast/commit",{scanId:started.scanId,index:0,error:"HTTP 429"}));
assert.equal(done.failedArticles,1);
assert.equal(done.unresolvedCount,0);
started = await read(await post("/fast/start",{articles:[{...articles[0],commentCount:9},articles[1]],fallbackStates}));
assert.equal(started.candidateArticles,1);
console.log("Main Worker Durable Object incremental sync regression passed");
