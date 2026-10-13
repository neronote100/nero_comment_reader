import assert from "node:assert/strict";
import fs from "node:fs/promises";

// Raw Text imports are bundled by Wrangler; remove only those imports for Node tests.
const source = (await fs.readFile(new URL("./worker.js", import.meta.url), "utf8"))
  .replace(/^import (html|css|script) from "\.\/[^"]+";$/gm, "");
const uri = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const { MemberStateStore, default: member } = await import(uri);

const cache = new Map();
const store = new MemberStateStore({ storage: {
  get: async key => cache.get(key),
  put: async (key, value) => { cache.set(key, structuredClone(value)); },
  delete: async key => cache.delete(key)
}});
const post = (route, body) => store.fetch(new Request("https://test" + route, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
}));
const get = route => store.fetch(new Request("https://test" + route));
const read = async response => {
  const data = await response.json();
  assert.equal(data.ok, true, data.error);
  return data;
};
assert.equal((await member.fetch(new Request("https://members.local/api/me"), {}, {})).status, 403,
  "Access is mandatory even when an attacker calls API directly");
await read(await post("/profile", { owner: "member_name" }));
const a = { key: "n1", title: "Article 1", commentCount: 2, url: "https://note.com/member_name/n/n1" };
const b = { key: "n2", title: "Article 2", commentCount: 0, url: "https://note.com/member_name/n/n2" };
let started = await read(await post("/start", { owner: "member_name", articles: [a,b] }));
assert.equal(started.candidateArticles, 1, "only articles with comments are scanned");
let next = await read(await get("/peek?scan_id=" + started.scanId));
assert.equal(next.article.key, "n1");
const comment = { key: "c1", rootKey: "c1", body: "Hello", authorName: "Guest", authorUrlname: "guest",
  publishedAt: "2026-10-10T00:00:00Z", pendingCount: 1 };
let result = await read(await post("/commit", { scanId: started.scanId, index: 0, unresolved: [comment] }));
assert.equal(result.done, true);
assert.equal(result.unresolvedCount, 1);

started = await read(await post("/start", { owner: "member_name", articles: [a,b] }));
assert.equal(started.candidateArticles, 1, "pending threads are revisited even if count is unchanged");
next = await read(await get("/peek?scan_id=" + started.scanId));
assert.equal(next.article.scanMode, "pending_only");
result = await read(await post("/commit", { scanId: started.scanId, index: 0, unresolved: [] }));
assert.equal(result.unresolvedCount, 0, "replied/liked thread is cleared");

started = await read(await post("/start", { owner: "member_name", articles: [a,b] }));
assert.equal(started.done, true);
assert.equal(started.candidateArticles, 0, "all unchanged and resolved articles are skipped");

started = await read(await post("/start", { owner: "member_name", articles: [{...a,commentCount:3},b] }));
assert.equal(started.candidateArticles, 1, "new comments trigger rescan");
result = await read(await post("/commit", {scanId:started.scanId,index:0,error:"HTTP 429"}));
assert.equal(result.failedArticles, 1);
assert.equal(result.unresolvedCount, 0, "failed data is not falsely presented as verified");
started = await read(await post("/start", { owner: "member_name", articles: [{...a,commentCount:3},b] }));
assert.equal(started.candidateArticles, 1, "failed articles are retried");

await read(await post("/profile", {owner:"other_name"}));
const current = await read(await get("/state"));
assert.equal(current.owner,"other_name");
assert.equal(current.latest,null,"switching note identity clears the prior account snapshot");
console.log("Member incremental-state and auth-gate smoke tests passed");
