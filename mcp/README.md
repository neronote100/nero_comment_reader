# Nero Comment Reader MCP

ChatGPTから王子（nero_notelover）の未対応コメントを読むための、読み取り専用MCPサーバーです。

## 役割

このMCPは文章生成をしません。Comment Readerの公開JSONからデータを取得してChatGPTへ渡すだけです。

- AI API: なし
- OpenAI API key: 不要
- Workers AI: 不要
- note_session_key: 不要
- note Cookie: 不要

文章生成はChatGPT Plus側で行います。

## MCP tools

- get_comment_reader_status
- list_unanswered_comments
- get_unanswered_comment

## Cloudflare Workers

Cloudflare Workers無料枠で動かす想定です。

Root directoryを mcp にする場合は:

- Build command: なし
- Deploy command: npx wrangler deploy
- MCP endpoint: https://nero-comment-reader-mcp.<subdomain>.workers.dev/mcp

ローカル確認:

```bash
cd mcp
npx wrangler dev
```

MCP Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

Streamable HTTPとして `http://localhost:8787/mcp` を指定します。
