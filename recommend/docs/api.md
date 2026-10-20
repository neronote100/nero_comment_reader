# API設計

同一オリジンのPages Functions → Service binding → Worker。`/api/*` は全て管理者セッション必須。更新は `Origin: APP_ORIGIN`、JSON入力（32KBまで）。200成功、201作成、202予約、400入力不正、401未認証、403権限/Origin、404なし、409重複、503未設定、502処理失敗。バックエンドエラーやトークンは返さない。

| メソッド | パス                | 入力・結果                                                                                                             |
| -------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET      | /auth/login         | Google認可へリダイレクト。PKCE・state Cookie                                                                           |
| GET      | /auth/callback      | code/state検証、管理者メールとGmail scope確認、セッション発行                                                          |
| POST     | /api/logout         | 現セッション削除、Cookie失効                                                                                           |
| GET      | /api/dashboard      | members, overdue, recommendations, rotation, weekly, rising, articles, pendingEvents, jobs, counts。本文は含めない     |
| GET      | /api/setup          | Google/AI/Discord設定の有無、同期・通知日時、通知エラー                                                                |
| POST     | /api/members        | name, note_username（任意）, joined_at（任意）。IDなしはpending                                                        |
| PATCH    | /api/members/{id}   | name, note_username, profile_url, account_url, discord_name, tags: string[], priority: 0〜100, status, joined_at, plan |
| POST     | /api/events/resolve | event_id, member_id, kind: join/withdraw/plan, plan_name（プラン変更時）                                               |
| POST     | /api/sync           | kind: gmail/articles。収集ジョブを予約                                                                                 |
| POST     | /api/jobs/run       | `{}`。待機ジョブを1件だけ進める                                                                                        |
| POST     | /api/jobs/retry     | id。failedジョブを再予約                                                                                               |
| GET      | /api/articles/{id}  | 保存した本文・メタデータ                                                                                               |
| POST     | /api/articles/flags | id, favorite: boolean, participated: boolean                                                                           |
| POST     | /api/analyze        | id。同一本文は分析キャッシュ、それ以外はAIジョブを予約                                                                 |
| GET      | /api/introductions  | 直近200件の紹介履歴、会員名・記事名                                                                                    |
| POST     | /api/introductions  | article_id, published_url。掲載したnote記事のURLで紹介を記録                                                           |

```json
{
  "article_id": "n123456789abc",
  "published_url": "https://note.com/nero_notelover/n/nabcdef123456"
}
```

推薦はactive会員の取得済み記事から既紹介記事を除き、1人1記事で選択。スコア順は会員優先度→総合おすすめ度、入会順・未紹介は最終紹介日が古い/未紹介→初回入会日→新しい記事。AI推薦理由は本文分析から生成し、スコアと履歴はアプリが判断する。AIに全会員リストやメール本文は送信しない。

ジョブ種別は `gmail/list/article/ai`。Gmail継続ページ・記事一覧継続ページ・個別記事を別ジョブに分ける。記事ごとの障害は他の会員の処理を妨げない。定期処理は同じジョブIDを再予約しない。手動同期は新バッチを作る。
