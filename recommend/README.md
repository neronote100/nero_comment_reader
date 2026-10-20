# ネロ王立図書館レコメンドシステム 🌙

メンバーの記事発掘 → 魅力の確認 → 紹介文・コメントの下書き → 掲載履歴の記録を行う、王子専用の管理画面です。既存のコメントリーダー、MCP、会員用Workerと独立して設置します。既存画面の「王立図書館」タブに設置先URLを一度保存すると開けます。

## できること

- Gmailの通知から入会・退会・プラン変更を同期。アカウントやプランが不明な通知は確認待ちへ
- 会員名、note ID・URL、Discord名、タグ、優先度、入会日、状態を編集
- 日本時間6:00 / 18:00に記事収集を開始。記事単位で保存・再試行
- 公開本文、スキ・コメント、タグ、サムネイル、日時を保存。有料・限定記事は認証なしで読める部分のみ
- AI概要・要約・魅力・良かったところ・おすすめ理由・想定読者・引用候補・約200字の紹介文・5行程度のコメント案
- 週間スキ・コメント・総合ランキング、約7日前とのスキ・コメント増加数と増加率
- 入会順・未紹介から最大6人を選択。おすすめ度からも最大6人。同じ人は1枠
- 最終紹介から30日以上、または未紹介の人を表示
- 掲載した紹介記事のURLを登録すると、紹介履歴と最終紹介日を更新。AI生成・コピーだけでは更新しない
- 朝7:00のDiscordレポート。メンションは無効

## 構成

Next.js / React / TypeScript / Tailwindの静的出力をCloudflare Pagesに配置します。Pages FunctionsのService bindingが同一オリジンの `/api/*` と `/auth/*` をWorkersに転送。D1、Cron、Google OAuth、OpenAI Responses APIを利用します。

```text
src/domain.ts                 会員・記事・分析型、スコア、引用検証
src/ports.ts                  リポジトリ・外部APIの契約
src/application/library.ts    紹介候補・ダッシュボード・収集ジョブ
src/infrastructure/           D1、note、Gmail、OpenAI、OAuth
src/worker.ts                 HTTPルート、Cron、通知
web/app/                      Next.js管理画面
migrations/                   D1スキーマ
test/                         実SQLiteとHTTP境界のテスト
docs/                         DB・ER・API・画面設計
```

## ローカルセットアップ

Node.js 24を使用します。

```sh
cd recommend
npm ci
cp .dev.vars.example .dev.vars
# .dev.vars に管理者・OAuth・暗号鍵を設定する
npm run build
npm run db:local
npm run dev
```

`http://localhost:8787` を開きます。Google Cloud Consoleで、Gmail APIを有効化し、OAuthクライアントを「ウェブアプリケーション」で作成してください。リダイレクトURIは `http://localhost:8787/auth/callback`。同意画面のテストユーザーに管理者Googleアカウントを追加し、`openid email https://www.googleapis.com/auth/gmail.readonly` を使用します。

OAuthのテスト公開ではリフレッシュトークンが短期間で失効する場合があります。継続運用時はGoogle側の公開・検証要件を確認してください。管理画面の「接続を更新」で再同意できます。ChatGPTのGmail接続とは別のOAuth設定です。

暗号鍵を生成:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
```

鍵は再デプロイ時にも維持します。変更すると保存済みGoogleトークンを復号できなくなるため、Google接続をやり直してください。

Dockerは `.dev.vars` を設定してから:

```sh
docker compose up --build
```

ローカルDBは名前付きvolumeに永続化します。Docker内でもホストからは同じ `http://localhost:8787` を利用します。

## 本番セットアップ

1. `npx wrangler login` でCloudflareへログイン。
2. `npx wrangler d1 create nero-library` でD1を作り、表示されたdatabase_idを `wrangler.jsonc` に設定。
3. Pagesプロジェクト `nero-royal-library` を作成し、利用する本番URLを確定。
4. `wrangler.jsonc` の `APP_ORIGIN` を本番の `https://…pages.dev` または独自ドメイン（末尾スラッシュなし）、`ADMIN_EMAIL` を管理者のGoogleアドレスに変更。
5. `MEMBERSHIP_NAME` と `GMAIL_FROM` を実通知の表記に合わせて確認。
6. Google OAuthに本番URLの `/auth/callback` を登録。
7. 次のコマンドで保存・配置:

```sh
cd recommend
npm ci
npm run build
npm run db:remote
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put OPENAI_API_KEY
# Discord通知を有効にするときのみ設定
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler deploy
cd web
../node_modules/.bin/wrangler pages deploy out --project-name nero-royal-library
```

Pagesの `RECOMMEND_API` Service bindingが `nero-library-api` を指すことを確認します。Workerの直接公開は既定で無効です。Googleリダイレクト先・APP_ORIGIN・実際の管理画面URLは一致させてください。PagesプレビューURLで本番の認証を使い回さず、検証用は別Worker / D1 / OAuthクライアントを設定します。

初回ログイン後、「Gmailからメンバー同期」→「メンバー管理」の確認待ちを処理→記事収集→記事を開いて分析、の順で確認します。DiscordはWebhook設定後の朝7時から送信対象です。実際のメール書式・noteレスポンスは運用開始時に実データと照合してください。

## 定期処理・費用・運用

- Cronは1分ごと。JST 6:00 / 18:00に収集予約、6:50 / 18:50に未分析の候補を予約、7:00に通知。UTC変換はコード内で行います。
- ジョブは毎回最大6件。1ジョブは記事本文1件、一覧1ページ、Gmail最大2通（プロフィール転送は1通あたり最大2回）、またはAI1記事。IDで重複を防ぎ、原子的リース取得・5分期限・最大3回再試行を使います。
- 初回は全記事のバックフィルです。人数と記事数によっては数時間以上かかります。6:00は取得開始時刻で、全件の完了時刻ではありません。朝レポートはその時点で収集済みの候補を使用します。
- 一覧は1会員200ページまで。ダッシュボードの記事表示は新しい順2,000本まで。D1の本文自体は残ります。上限に達した場合は設計・クエリを拡張してください。
- スナップショットはUTC日付で1記事1日1行、90日保持。7日前以前・9日前以後の最も近い記録と比較。初回は増加率未計測。基準が0の場合、増加数は表示し、増加率は未算出。
- 閲覧数は公開APIから取得できないため未対応。コミュニティ活動は共同企画参加フラグを管理者が設定。コメント本文は収集せず、「交流が活発」とAIに推測させません。
- AI評価は0〜5。総合は `スキ + コメント×3 + AI評価×20 + 共同企画参加×30 + 王子お気に入り×100`。優先度は候補選択時の並びに使用し、スコア式に混ぜません。
- `AUTO_AI_LIMIT` は朝夕それぞれの自動分析上限（既定6、最大20、0で停止）。同じ本文は保存済み分析を利用。AIにはタイトル・公開本文の先頭24,000文字と公開範囲だけを送信し、Gmail・Discord名などは送信しません。
- OpenAIはAPI利用料が別途必要です。Workers / D1のプランによる制限と使用量を監視してください。無料枠での運用を保証しません。
- noteは非公式公開APIを使用するため、仕様変更や429で取得に失敗する場合があります。失敗は状態を消さずジョブ履歴に残します。取得不能になった記事の過去キャッシュは残るため、紹介前はnote原文を確認してください。
- メール通知が届かない・通知設定を変更した場合はGmailだけでは会員状態を完全には再現できません。入会日・会員状態は管理画面で修正できます。再入会時も入会順は初回入会日を保持します。
- Discordは当日成功後の再送を避けます。配信成功直後の保存失敗や同時実行時は重複する可能性があり、厳密な一度だけの配信保証はありません。エラーは連携画面に表示されます。

## セキュリティ

管理者Googleアカウント1名だけを許可。メール認証済みアドレスをGoogle UserInfoで確認します。OAuthはPKCE・state・10分の一時Cookie、管理セッションはHttpOnly・本番Secure・SameSite=Lax・7日有効・DBにはハッシュを保存。GmailのリフレッシュトークンはAES-GCM暗号化でD1に保存し、鍵・APIキー・WebhookはWorkers Secretsへ配置します。更新APIはOrigin検証。会員・メールのデータは公開リポジトリへ出力しません。

## 検証

```sh
cd recommend
npm run check
npx wrangler d1 migrations apply nero-library --local
npx wrangler pages functions build web/functions --outdir /tmp/library-functions
cd ..
node mcp/test.mjs
node mcp/fast-sync.test.mjs
node members/test.mjs
```

GitHub Actionsの `Royal library checks` が同じ検証を実行します。自動本番デプロイは設定していません。セットアップに必要な外部アカウントの設定・Secrets登録後に、本番OAuth・実通知メール・note・OpenAI・Discordの受入確認を行ってください。

設計は [DB・ER](docs/database.md)、[API](docs/api.md)、[画面と要件対応](docs/screens.md) を参照。

実装の参照資料: [Next.js静的出力](https://nextjs.org/docs/app/guides/static-exports)、[Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/)、[D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)、[Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)、[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。
