# 王子 Comment Reader 会員版 🌙

## 設計

既存の `nero-comment-reader`（王子本人用API／MCP）を壊さず、別の
`nero-comment-reader-members` Worker として会員向けサイトを用意しています。

- **Cloudflare Access** の認証画面でメール認証ログイン。未認証アクセスは Worker 内でも403拒否（fail closed）
- `ctx.access.getIdentity()` で **Cloudflareが認証済みのメール**を取得。クライアントからメールを送ってもユーザーを変更できません
- メール単位のDurable Objectにnoteユーザー名、差分判定状態、未対応コメントを保存。アカウント間でのデータ混在を防止
- noteのユーザー名だけ登録。**noteのパスワード、Cookie、セッションキーは不要**
- ログアウトは `/cdn-cgi/access/logout`。Cloudflare Accessがセッションを終了します
- 記事一覧の取得は更新操作につき1回。コメント増減がある記事、前回未対応スレッド、過去の失敗、分散した定期検査記事のみ走査
- 1つの記事の読み込みに失敗しても全体停止はせず、該当記事を保留とし次回再検査
- 更新を開始するボタンを押したときだけnoteへ通信。日次定期取得は行いません

## 安全なセットアップ手順（**Access設定前に会員URLを配布しない**）

1. Cloudflare Zero Trust を有効化
2. `cd members && npx wrangler deploy -c wrangler.jsonc` で**別Worker**としてデプロイ
3. Cloudflare → **Workers & Pages** → `nero-comment-reader-members` → **Access** →
   **Protect this Worker behind Access** → **All traffic** を選択
4. Cloudflare Zero Trust → Access → Applications の会員専用アプリを開き、
   **Allow対象を現役会員のメールアドレスだけ**に限定。
   メールドメイン全体や Everyone を許可しない。OTPのメールログインを設定する
5. 自分の許可メールでログインを試し、別ブラウザの非許可メールは拒否されること、
   `/api/me` が拒否されること、ログアウトすると再認証になることを確認
6. 退会した会員はAccessポリシーの許可リストから外し、Accessセッションを失効させる
7. 上記確認後に初めて会員URLを告知する

**注意**：noteメンバーシップの会員資格をAPIで自動照合する機能は実装していません。
入退会の管理者による許可メール更新が必要です。

## 重要な制約

- 無料公開されているnote APIから取得できるコメントのみ対象です。非公開のコメント情報は取得しません
- noteのユーザー名は自己申告です。noteアカウント本人確認を行っているわけではありません
- 会員版は今回 **自分の記事の未対応コメント一覧／返信案コピー**から提供します。
  元サイトの企画ハッシュタグ・マガジン検索機能を会員ユーザー向けに一般化するのは次の段階です
- **GitHub Pages の元URLは引き続き公開サイト**です。GitHub Pagesに見た目だけログイン画面を足しても会員限定にはなりません
- 既存のMCP Worker（王子用）をAccess保護するとChatGPTとの接続が切れるため、**会員版だけを保護**してください
- Cloudflare Access はログアウトで同じチームの他のAccessアプリのセッションにも影響することがあります
- 本WorkerをデプロイしてもAccess設定は自動では完了しません。サイトはAccess未設定の間、Worker側で403を返します
- `wrangler dev` で認証を模擬する際は `access.dev` の設定が必要です（本番には含めない）

公式ドキュメント：
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
