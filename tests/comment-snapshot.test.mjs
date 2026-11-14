import test from 'node:test';
import assert from 'node:assert/strict';
import {validCommentSnapshot,chooseCommentSnapshot,snapshotFreshness} from '../comment-snapshot.mjs';
const snapshot=(date,extra={})=>({owner:'nero_notelover',updatedAt:date,
  articleCount:115,failedArticles:0,items:[],...extra});
test('newest public backup wins over stale worker and stale device cache',()=>{
  const best=chooseCommentSnapshot([
    {source:'worker',snapshot:snapshot('2026-11-01T01:00:00Z',{articleCount:99})},
    {source:'cache',snapshot:snapshot('2026-10-31T10:00:00Z')},
    {source:'static',snapshot:snapshot('2026-11-14T01:00:00Z',{articleCount:115})},
  ]);
  assert.equal(best.source,'static'); assert.equal(best.snapshot.articleCount,115);
});
test('worker wins ties, even when static appears before it',()=>{
  const same=snapshot('2026-11-14T01:00:00Z');
  const best=chooseCommentSnapshot([{source:'static',snapshot:same},{source:'worker',snapshot:same}]);
  assert.equal(best.source,'worker');
});
test('owner mismatch or malformed timestamps are never accepted',()=>{
  assert.equal(validCommentSnapshot(snapshot('2026-11-14T01:00:00Z',{owner:'other'})),false);
  assert.equal(validCommentSnapshot(snapshot('invalid')),false);
  assert.equal(validCommentSnapshot(snapshot('2026-11-14T01:00:00Z',{items:null})),false);
  assert.equal(chooseCommentSnapshot([{source:'worker',snapshot:snapshot('invalid')}]),null);
});
test('freshness communicates estimated public status and stale data',()=>{
  const recent=snapshotFreshness({source:'static',snapshot:snapshot('2026-11-14T01:00:00Z')},
    Date.parse('2026-11-14T02:00:00Z'));
  assert.equal(recent.kind,'fresh');
  assert.match(recent.message,/未対応は候補値/);
  const stale=snapshotFreshness({source:'worker',snapshot:snapshot('2026-11-01T01:00:00Z')},
    Date.parse('2026-11-14T02:00:00Z'));
  assert.equal(stale.kind,'stale');
  assert.match(stale.message,/13日経過/);
});
