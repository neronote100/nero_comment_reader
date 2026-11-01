import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLikeCandidatesFeed,fetchLikeCandidatesFeed,CANDIDATE_FEED_URL,ReaderApiClient,ReaderApiError,READER_API_ORIGIN,verifiedConnectionMessage,parseReaderCallback,normalizeLikeResult} from '../like-candidates.js';

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

const connection={token:'T'.repeat(43),expiresAt:now+3600000,owner:'nero_notelover'};
const apiResponse=(value,status=200)=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify(value)});
test('stored browser fetch retains its Window receiver before a request is sent',async()=>{
  let calls=0;
  const client=new ReaderApiClient({now:()=>now,fetcher:async function(url,options){
    assert.equal(this,globalThis,'native browser fetch requires its global receiver');
    assert.equal(url,READER_API_ORIGIN+'/reader/status');
    assert.equal(options.method,'GET');
    calls++;
    return apiResponse({ok:true,connected:true,noteReady:true});
  }});
  client.setConnection(connection);
  const result=await client.request('/reader/status');
  assert.equal(result.noteReady,true);
  assert.equal(calls,1);
});
test('owner API stores the bearer only in private memory and omits browser credentials',async()=>{
  const requests=[];
  const client=new ReaderApiClient({now:()=>now,fetcher:async(url,options)=>{requests.push({url,options});return apiResponse({ok:true,connected:true,noteReady:true});}});
  client.setConnection(connection);
  assert.equal(client.connected,true);
  assert.ok(!JSON.stringify(client).includes(connection.token));
  await client.request('/reader/status');
  assert.equal(requests[0].url,READER_API_ORIGIN+'/reader/status');
  assert.equal(requests[0].options.credentials,'omit');
  assert.equal(requests[0].options.headers.Authorization,'Bearer '+connection.token);
  assert.equal(requests[0].options.method,'GET');
  client.clear();assert.equal(client.connected,false);
  await assert.rejects(client.request('/reader/status'),error=>error.code==='READER_AUTH_REQUIRED');
  assert.equal(requests.length,1);
});
test('the one-time PKCE exchange sends no bearer; API paths cannot target another service',async()=>{
  const requests=[];
  const client=new ReaderApiClient({now:()=>now,fetcher:async(url,options)=>{requests.push({url,options});return apiResponse({ok:true,...connection});}});
  await client.request('/reader/exchange',{method:'POST',body:{code:'C'.repeat(43),verifier:'V'.repeat(43)}});
  assert.equal(requests[0].options.headers.Authorization,undefined);
  assert.deepEqual(JSON.parse(requests[0].options.body),{code:'C'.repeat(43),verifier:'V'.repeat(43)});
  await assert.rejects(client.request('https://evil.example/reader/status'),error=>error.code==='INVALID_INPUT');
  await assert.rejects(client.request('/reader/like'),error=>error.code==='INVALID_INPUT');
  assert.equal(requests.length,1);
});
test('expired or unauthorized sessions cannot send likes, and no failed request is retried',async()=>{
  let calls=0;
  const client=new ReaderApiClient({now:()=>now,fetcher:async()=>{calls++;return apiResponse({ok:false,code:'READER_AUTH_REQUIRED',message:'UNTRUSTED_SECRET_TEXT'},401);}});
  client.setConnection(connection);
  await assert.rejects(client.request('/reader/like',{method:'POST',body:{key:'n123456789abc'}}),error=>error.code==='READER_AUTH_REQUIRED'&&!error.message.includes('SECRET'));
  assert.equal(calls,1);assert.equal(client.connected,false);
  await assert.rejects(client.request('/reader/like',{method:'POST',body:{key:'n123456789abc'}}));
  assert.equal(calls,1);
  assert.throws(()=>client.setConnection({...connection,expiresAt:now-1}),ReaderApiError);
});
test('response bodies and network exceptions never become product error text',async()=>{
  const client=new ReaderApiClient({now:()=>now,fetcher:async()=>apiResponse({ok:false,code:'NOTE_READ_FAILED',message:'TOKEN_PRIVATE_RAW_RESPONSE'},502)});
  client.setConnection(connection);
  await assert.rejects(client.request('/reader/status'),error=>error.code==='NOTE_READ_FAILED'&&!error.message.includes('TOKEN_PRIVATE'));
  let calls=0;
  const broken=new ReaderApiClient({now:()=>now,fetcher:async()=>{calls++;throw Error('PRIVATE_ENV_VALUE');}});
  broken.setConnection(connection);
  await assert.rejects(broken.request('/reader/like',{method:'POST',body:{key:'n123456789abc'}}),error=>!error.message.includes('PRIVATE_ENV_VALUE'));
  assert.equal(calls,1);
});
test('popup authorization requires the exact service origin, popup and nonce',()=>{
  const popup={},nonce='N'.repeat(43),code='C'.repeat(43);
  const event={origin:READER_API_ORIGIN,source:popup,data:{type:'ouji-reader-connected',nonce,code}};
  assert.equal(verifiedConnectionMessage(event,{popup,nonce}),code);
  assert.equal(verifiedConnectionMessage({...event,origin:'https://evil.example'},{popup,nonce}),null);
  assert.equal(verifiedConnectionMessage({...event,source:{}},{popup,nonce}),null);
  assert.equal(verifiedConnectionMessage(event,{popup,nonce:'X'.repeat(43)}),null);
  assert.equal(verifiedConnectionMessage({...event,data:{...event.data,code:'bad'}},{popup,nonce}),null);
});
test('openerless callbacks accept only one valid code and nonce, and an uncertain send is not called delivered',()=>{
  const code='C'.repeat(43),nonce='N'.repeat(43);
  assert.deepEqual(parseReaderCallback('#reader-code='+code+'&reader-nonce='+nonce),{code,nonce});
  assert.equal(parseReaderCallback('#reader-code='+code+'&reader-code='+code+'&reader-nonce='+nonce),null);
  assert.equal(parseReaderCallback('#like-candidates'),null);
  assert.equal(normalizeLikeResult({liked:true}),'liked');
  assert.equal(normalizeLikeResult({liked:false,confirmationPending:true}),'unknown');
  assert.equal(normalizeLikeResult({ok:true}),'unknown');
});
