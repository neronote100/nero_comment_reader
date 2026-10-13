# 王子 Comment Reader 🌙

note「nero_notelover」専用の未返信コメント管理サイトです。

## できること

- 王子の記事一覧を取得
- コメントがある記事だけコメントスレッドを確認
- 王子の最後の返信より後にある他ユーザーのコメントを未返信として抽出
- 未返信コメントを新しい順に一覧表示
- ChatGPTへ相談用プロンプトをワンタップでコピー
- noteの記事をすぐ開ける
- GitHub Actionsで定期同期
- GitHub Pagesで表示

AI API、Cloudflare、有料DBは使いません。

## 今後

- ② 王子の記事引用
- ③ ウォッチリスト
- ChatGPT Plusから直接取得するMCP連携

## GitHub Pages 初回設定

初回だけ GitHub の Settings → Pages で Source を GitHub Actions に設定してください。
有効化後のURLは https://neronote100.github.io/nero_comment_reader/ です。


## 2026年10月：高速差分同期

- 取得操作ごとに記事一覧を**1回**取得し、前回からコメント件数が変わった記事を優先走査
- 未対応コメントが残るスレッドは件数が変わらなくても確認（スキ・返信による対応完了を検出）
- 取得エラーのある記事は判定保留にして次回再試行
- 結果と記事ごとの状態を Cloudflare Durable Objects に保存（次回の差分判定に利用）
- 週単位の分散した再検証で件数だけでは検出できない変化も補助チェック
- 過去の `/comments/live` API は互換性のため残しています

**コードをGitHubに反映しただけでは、Cloudflare Workerは更新されません。**
高速更新を有効にするには、従来のMCP Workerを再デプロイしてください。

```sh
cd mcp
npx wrangler deploy
```

反映まではWeb画面は従来APIにフォールバックします。

## 城下町向け会員版（別アプリ）

ログイン／ログアウトと会員ごとのコメントデータ分離を備えた
Cloudflare Access保護の会員版を `members/` に用意しました。
**設置手順と会員メールの管理方法は [members/README.md](members/README.md) を参照**してください。

既存のGitHub Pagesは公開サイトであり、ログイン画面だけで会員限定にはできません。
会員向けページは別のCloudflare Workerで運用します。
