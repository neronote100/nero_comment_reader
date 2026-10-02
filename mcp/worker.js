const DEFAULT_INBOX_URL = "https://neronote100.github.io/nero_comment_reader/data/inbox.json";
const MCP_PROTOCOL_VERSION = "2025-06-18";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, accept, mcp-session-id, authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return json({ jsonrpc: "2.0", id: id ?? null, error }, 200);
}

async function loadInbox(env) {
  const url = env?.INBOX_URL || DEFAULT_INBOX_URL;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 15, cacheEverything: true },
  });
  if (!response.ok) throw new Error("Comment Reader data returned HTTP " + response.status);
  const data = await response.json();
  return {
    version: Number(data?.version || 1),
    owner: String(data?.owner || "nero_notelover"),
    updatedAt: data?.updatedAt || null,
    articleCount: Number(data?.articleCount || 0),
    unresolvedCount: Number(data?.unresolvedCount || 0),
    failedArticles: Number(data?.failedArticles || 0),
    items: Array.isArray(data?.items) ? data.items : [],
  };
}

function publicComment(item) {
  return {
    id: String(item?.id || ""),
    authorName: String(item?.authorName || ""),
    authorUrlname: String(item?.authorUrlname || ""),
    body: String(item?.body || ""),
    publishedAt: item?.publishedAt || null,
    articleTitle: String(item?.articleTitle || ""),
    articleUrl: String(item?.articleUrl || ""),
    rootBody: String(item?.rootBody || ""),
    rootAuthorUrlname: String(item?.rootAuthorUrlname || ""),
  };
}

function groupByArticle(items) {
  const groups = new Map();
  for (const item of items) {
    const articleUrl = String(item?.articleUrl || "");
    const articleTitle = String(item?.articleTitle || "");
    const key = articleUrl || articleTitle || "unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        articleTitle,
        articleUrl,
        commentCount: 0,
        comments: [],
      });
    }
    const group = groups.get(key);
    group.comments.push(publicComment(item));
    group.commentCount = group.comments.length;
  }
  return [...groups.values()];
}

const TOOLS = [
  {
    name: "get_comment_reader_status",
    title: "王子 Comment Readerの状態",
    description:
      "王子（nero_notelover）のComment Readerの最終同期日時、確認記事数、未対応コメント件数を取得します。未対応とは、王子が返信しておらず、かつ王子がコメントにスキを付けていないものです。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_unanswered_comments",
    title: "王子の未対応コメント一覧",
    description:
      "王子の記事に付いた未対応コメントを新しい順に取得します。王子が返信済み、または王子がスキ済みのコメントは除外済みです。返信案を考えるときは、このツールで対象コメントを取得してください。",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "取得件数。通常は5〜10件。",
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "0始まりの取得開始位置。",
        },
        query: {
          type: "string",
          description: "任意。コメント者名、note ID、記事タイトル、コメント本文の部分一致検索。",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_unanswered_by_article",
    title: "記事ごとの未対応コメント",
    description:
      "王子の記事ごとに、未返信かつ王子未スキのコメントをまとめて取得します。1つの記事を開いたまま、その記事に残っている未対応コメントを一括で返信したい場合はこちらを使ってください。",
    inputSchema: {
      type: "object",
      properties: {
        limit_articles: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 5,
          description: "取得する記事数。コメント数ではなく記事数です。",
        },
        offset_articles: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "0始まりの記事取得開始位置。",
        },
        query: {
          type: "string",
          description: "任意。コメント者名、note ID、記事タイトル、コメント本文の部分一致検索。",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_unanswered_comment",
    title: "未対応コメントを1件取得",
    description:
      "Comment ReaderのコメントIDを指定して、返信案作成に必要な記事名・本文・元スレッド文脈を1件取得します。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "list_unanswered_commentsが返したコメントID。" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

async function callTool(name, args, env) {
  const inbox = await loadInbox(env);

  if (name === "get_comment_reader_status") {
    const result = {
      owner: inbox.owner,
      updatedAt: inbox.updatedAt,
      articleCount: inbox.articleCount,
      unresolvedCount: inbox.unresolvedCount,
      failedArticles: inbox.failedArticles,
      definition: "未返信かつ王子がスキしていないコメント",
    };
    return {
      content: [{ type: "text", text: "未対応コメントは " + result.unresolvedCount + " 件です。" }],
      structuredContent: result,
    };
  }

  if (name === "list_unanswered_comments") {
    const limit = Math.min(50, Math.max(1, Number(args?.limit || 10)));
    const offset = Math.max(0, Number(args?.offset || 0));
    const query = String(args?.query || "").trim().toLowerCase();
    let items = inbox.items;

    if (query) {
      items = items.filter((item) =>
        [item?.authorName, item?.authorUrlname, item?.articleTitle, item?.body]
          .some((value) => String(value || "").toLowerCase().includes(query))
      );
    }

    const selected = items.slice(offset, offset + limit).map(publicComment);
    const result = {
      updatedAt: inbox.updatedAt,
      total: items.length,
      offset,
      returned: selected.length,
      comments: selected,
    };

    return {
      content: [{
        type: "text",
        text:
          "未対応コメントを " + selected.length + " 件取得しました。必要に応じて各コメントへの王子らしい返信案を作成してください。",
      }],
      structuredContent: result,
    };
  }

  if (name === "list_unanswered_by_article") {
    const limitArticles = Math.min(20, Math.max(1, Number(args?.limit_articles || 5)));
    const offsetArticles = Math.max(0, Number(args?.offset_articles || 0));
    const query = String(args?.query || "").trim().toLowerCase();
    let items = inbox.items;

    if (query) {
      items = items.filter((item) =>
        [item?.authorName, item?.authorUrlname, item?.articleTitle, item?.body]
          .some((value) => String(value || "").toLowerCase().includes(query))
      );
    }

    const groups = groupByArticle(items);
    const selected = groups.slice(offsetArticles, offsetArticles + limitArticles);
    const result = {
      updatedAt: inbox.updatedAt,
      totalArticles: groups.length,
      totalComments: items.length,
      offsetArticles,
      returnedArticles: selected.length,
      articles: selected,
    };

    return {
      content: [{
        type: "text",
        text:
          "未対応コメントを記事ごとにまとめて " + selected.length + " 記事分取得しました。同じ記事のコメントは、記事を1回開くだけで順番に対応できるよう、記事単位でまとめて返信案を作成してください。",
      }],
      structuredContent: result,
    };
  }

  if (name === "get_unanswered_comment") {
    const id = String(args?.id || "");
    const item = inbox.items.find((candidate) => String(candidate?.id || "") === id);
    if (!item) {
      return {
        isError: true,
        content: [{ type: "text", text: "指定された未対応コメントは見つかりませんでした。同期後に解消済みの可能性があります。" }],
      };
    }

    const result = publicComment(item);
    return {
      content: [{
        type: "text",
        text:
          "返信案作成用のコメントを取得しました。相手の内容に具体的に触れ、王子らしく明るく親しみやすく、必要なら🌙や🤭︎を自然に使い、そのままnoteへ貼れる返信案を作成してください。",
      }],
      structuredContent: result,
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: "Unknown tool: " + name }],
  };
}

async function handleMcp(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method === "GET") {
    return json({
      name: "Nero Comment Reader MCP",
      status: "ok",
      endpoint: "/mcp",
      transport: "Streamable HTTP (stateless JSON responses)",
    });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

  let message;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const id = message?.id;
  const method = String(message?.method || "");

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: message?.params?.protocolVersion || MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "nero-comment-reader", version: "0.2.0" },
      instructions:
        "王子（nero_notelover）の未対応コメントを読み取る専用MCPです。返信済み、または王子がスキ済みのコメントは一覧から除外されています。ユーザーが未対応コメントの確認や返信案を求めた場合は、原則としてlist_unanswered_by_articleを使い、コメント単位ではなく記事単位でまとめて処理してください。1つの記事に未対応コメントが1件でもある場合、その記事に残っている他の『未返信かつ王子未スキ』コメントもすべて同じ記事グループとして扱います。出力は記事ごとにまとめ、記事タイトルと記事URLは各記事につき1回だけ表示してください。その下にコメント者ごとの返信案を並べます。返信案本文は、ChatGPT上でコピーボタンが出るように必ず markdown の text コードブロック（\`\`\`text ... \`\`\`）の中だけに入れてください。コードブロック内には『返信案：』などのラベルや記事URLを入れず、そのままnoteへ貼り付けられる返信本文だけを書いてください。王子の返信は、相手の内容へ具体的に反応し、明るく親しみやすく、短めの段落で、🌙や🤭︎を自然に使います。感謝はふざけず丁寧にし、定型的なお礼だけで終わらせません。記事内のコメントは、取得結果の順番でまとめて回答してください。MCP側ではAI生成を行いません。",
    });
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 202, headers: CORS });
  }

  if ((id === undefined || id === null) && method.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers: CORS });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = String(message?.params?.name || "");
    try {
      const result = await callTool(name, message?.params?.arguments || {}, env);
      return rpcResult(id, result);
    } catch (error) {
      return rpcResult(id, {
        isError: true,
        content: [{ type: "text", text: "Comment Readerの取得に失敗しました: " + String(error?.message || error) }],
      });
    }
  }

  return rpcError(id, -32601, "Method not found", { method });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      try {
        const inbox = await loadInbox(env);
        return json({
          ok: true,
          owner: inbox.owner,
          updatedAt: inbox.updatedAt,
          unresolvedCount: inbox.unresolvedCount,
        });
      } catch (error) {
        return json({ ok: false, error: String(error?.message || error) }, 502);
      }
    }

    if (url.pathname === "/mcp") return handleMcp(request, env);

    if (url.pathname === "/") {
      return new Response("Nero Comment Reader MCP 🌙\n/mcp\n/health\n", {
        status: 200,
        headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404, headers: CORS });
  },
};
