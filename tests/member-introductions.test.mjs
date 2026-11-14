import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntroductions, introductionSummary, filteredIntroductions, makeIntroductionDraft }
  from '../introduction-history.mjs';

const a={
  id:'alice-nabc12',member_name:'アリス🌙',member_note_id:'Alice_1',
  introduced_at:'2026-10-05',published_url:'https://note.com/nero_notelover/n/nabc12',
  source_article_url:'https://note.com/alice_1/n/ndef34',
};
const b={
  id:'bob-nbeef55',member_name:'ボブさん',member_note_id:'bob2',
  introduced_at:'2026-11-13',published_url:'https://note.com/nero_notelover/n/nbeef55',
};
const c={
  id:'alice-ncafe22',member_name:'アリス🌙',member_note_id:'Alice_1',
  introduced_at:'2026-11-02',published_url:'https://note.com/nero_notelover/n/ncafe22',
};
const ledger={schema_version:1,coverage:'backfill_pending',records:[a,b,c]};

test('valid ledger sorts by published introduction date and normalizes note user ids',()=>{
  const result=parseIntroductions(ledger);
  assert.deepEqual(result.records.map(x=>x.id),[b.id,c.id,a.id]);
  assert.equal(result.records[1].member_note_id,'alice_1');
  assert.equal(result.coverage,'backfill_pending');
});

test('introduced people count and last introduction are distinct from number of posts',()=>{
  const rows=parseIntroductions(ledger).records;
  const stats=introductionSummary(rows,'2026-11-14');
  assert.equal(stats.introductions,3);
  assert.equal(stats.people,2);
  assert.equal(stats.lastByPerson.get('alice_1').introduced_at,'2026-11-02');
  assert.equal(stats.thirtyDaysOrMore,0);
  assert.equal(introductionSummary([rows[2]],'2026-11-14').thirtyDaysOrMore,1);
});

test('search, older and recent filters never assume unrecorded members are unintroduced',()=>{
  const rows=parseIntroductions(ledger).records;
  assert.equal(filteredIntroductions(rows,'アリス','all','2026-11-14').length,2);
  assert.deepEqual(filteredIntroductions(rows,'','older','2026-11-14').map(x=>x.id),[a.id]);
  assert.equal(filteredIntroductions([], '', 'all', '2026-11-14').length,0);
});

test('requires verified 王子 note URL, note username, real date and non-duplicate entry',()=>{
  assert.throws(()=>parseIntroductions({...ledger,records:[a,a]}),/重複/);
  assert.throws(()=>parseIntroductions({...ledger,records:[{...b,published_url:'https://evil.example/n/nbeef55'}]}),/不正/);
  assert.throws(()=>parseIntroductions({...ledger,records:[{...b,introduced_at:'2026-02-31'}]}),/不正/);
  assert.throws(()=>parseIntroductions({...ledger,records:[{...b,member_note_id:'evil/../../'}]}),/不正/);
  assert.throws(()=>parseIntroductions({...ledger,records:[{...b,source_article_url:'javascript:alert(1)'}]}),/不正/);
  assert.throws(()=>parseIntroductions({schema_version:1,coverage:'complete',records:[]}),/形式/);
});

test('drafts are validated but never saved until the public ledger is edited',()=>{
  const row=makeIntroductionDraft({
    member_name:'王子の友人',member_note_id:'Friend_12',
    introduced_at:'2026-11-14',
    published_url:'https://note.com/nero_notelover/n/nabcdef',
  });
  assert.equal(row.id,'friend_12-nabcdef');
  assert.equal(row.member_note_id,'friend_12');
});
