import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLikeCandidatesFeed,fetchLikeCandidatesFeed,CANDIDATE_FEED_URL} from '../like-candidates.js';

const now=Date.parse('2026-11-01T00:00:00Z');
const article=(n=0)=>({user:'writer'+n,name:'書き手 '+n,profileUrl:'https://note.com/writer'+n,
  following:115,followers:100,gap:15,articleTitle:'記事 '+n,publishedAt:'2026-10-31T00:00:00Z',
  articleUrl:'https://note.com/writer'+n+'/n/n'+(n+1).toString(16).padStart(12,'0'),liked:false,status:'review_only'});
const report=(candidates=[article()])=>({owner:'nero_notelover',generatedAt:new Date(now).toISOString(),targetCount:30,
  complete:candidates.length===30,reason:candidates.length===30?'target_reached':'source_exhausted',
  summary:{scanned:90},candidates});
const response=value=>({ok:true,text:async()=>JSON.stringify(value)});

test('one full batch shows 30 distinct people and retains verified article links',()=>{
  const rows=Array.from({length:30},(_,n)=>article(n));
  const normalized=normalizeLikeCandidatesFeed(report(rows),now);
  assert.equal(normalized.candidates.length,30);
  assert.equal(normalized.complete,true);
  assert.equal(normalized.scanned,90);
  assert.deepEqual(normalized.candidates.map(r=>r.articleUrl),rows.map(r=>r.articleUrl));
});

test('hostile URLs, mismatched authors and unknown like state cannot become action links',()=>{
  const bad=[
    {...article(1),articleUrl:'javascript:alert(1)'},
    {...article(2),profileUrl:'https://note.com.evil.example/writer2'},
    {...article(3),articleUrl:'https://note.com/writer99/n/n000000000004'},
    {...article(4),articleUrl:article(4).articleUrl+'?redirect=https://evil.example'},
    {...article(5),articleUrl:article(5).articleUrl+'#x'},
    {...article(6),profileUrl:'https://user:password@note.com/writer6'},
    {...article(7),liked:undefined},
    {...article(8),following:114,gap:14},
    {...article(9),followers:null},
    {...article(10),publishedAt:'2026-09-01T00:00:00Z'},
  ];
  const got=normalizeLikeCandidatesFeed(report([article(),...bad]),now);
  assert.equal(got.candidates.length,1);
  assert.equal(got.rejected,bad.length);
  assert.equal(got.candidates[0].user,'writer0');
});

test('same person is shown only once and another owner or oversized batch is rejected',()=>{
  const feed=report([article(),{...article(),articleUrl:'https://note.com/writer0/n/nffffffffffff'}]);
  assert.equal(normalizeLikeCandidatesFeed(feed,now).candidates.length,1);
  assert.throws(()=>normalizeLikeCandidatesFeed({...report(),owner:'someone_else'},now));
  assert.throws(()=>normalizeLikeCandidatesFeed(report(Array.from({length:31},(_,n)=>article(n))),now));
  assert.throws(()=>normalizeLikeCandidatesFeed({...report(),generatedAt:'invalid'},now));
});

test('public source is fetched with GET and without credentials; fallback handles unavailable source',async()=>{
  const requests=[];
  const fetcher=async(url,options)=>{
    requests.push({url,options});
    return url===CANDIDATE_FEED_URL?{ok:false}:response(report());
  };
  const got=await fetchLikeCandidatesFeed({fetcher,localUrl:'https://reader.example/data/like-candidates.json',now});
  assert.equal(got.candidates.length,1);
  assert.deepEqual(requests.map(r=>r.url),[CANDIDATE_FEED_URL,'https://reader.example/data/like-candidates.json']);
  assert.ok(requests.every(r=>r.options.method==='GET'&&r.options.credentials==='omit'&&!r.options.body));
});

test('invalid source falls back and total failure is an error instead of an empty result',async()=>{
  let count=0;
  const got=await fetchLikeCandidatesFeed({fetcher:async()=>response(++count===1?{owner:'wrong'}:report()),
    localUrl:'https://reader.example/data/like-candidates.json',now});
  assert.equal(got.candidates.length,1);
  await assert.rejects(fetchLikeCandidatesFeed({fetcher:async()=>{throw Error('offline');},localUrl:'local',now}),/CANDIDATE_FEED_UNAVAILABLE/);
});

test('cached public metadata can be revalidated without adding note access',()=>{
  const normalized=normalizeLikeCandidatesFeed(report(),now);
  const cached={...normalized,summary:{scanned:normalized.scanned}};
  assert.equal(normalizeLikeCandidatesFeed(cached,now).candidates.length,1);
});
