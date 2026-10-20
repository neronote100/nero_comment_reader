"use client";
import { useCallback, useEffect, useState } from "react";
import type {
  Analysis,
  Article,
  Candidate,
  Member,
  MembershipEvent,
} from "../../src/domain";
type Card = Omit<Candidate, "body">;
type Job = {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  error: string | null;
  updated_at: string;
};
type Dashboard = {
  members: Member[];
  overdue: (Member & { days: number | null })[];
  pendingEvents: MembershipEvent[];
  jobs: Job[];
  counts: { active: number; articles: number; unintroduced: number };
  recommendations: Card[];
  rotation: Card[];
  articles: Card[];
  weekly: { likes: Card[]; comments: Card[]; combined: Card[] };
  rising: Card[];
};
type Setup = {
  googleConnected: boolean;
  aiConfigured: boolean;
  discordConfigured: boolean;
  gmailSyncedAt: string | null;
  reportAt: string | null;
  reportError: string | null;
};
const date = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—";
const datetime = (s: string | null) =>
  s
    ? new Date(s).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
    : "未実施";
async function api<T>(
  path: string,
  data?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(
    path,
    data === undefined
      ? { cache: "no-store" }
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(
      response.status === 401 ? "LOGIN" : result.error || "処理に失敗しました",
    );
  return result as T;
}
function ArticleCard({
  article,
  onSelect,
}: {
  article: Card;
  onSelect: (a: Card) => void;
}) {
  return (
    <button
      className="article-card text-left"
      onClick={() => onSelect(article)}
    >
      <div className="flex justify-between gap-3">
        <span className="byline">{article.member_name}</span>
        <span className="muted text-xs">{date(article.published_at)}</span>
      </div>
      <h3>{article.title}</h3>
      <p className="article-description">
        {article.analysis?.reason ||
          "記事を開いて、紹介したいところを見つけましょう。"}
      </p>
      <div className="flex flex-wrap gap-3 text-xs muted">
        <span>♡ {article.likes}</span>
        <span>コメント {article.comments}</span>
        <span className="gold">おすすめ度 {article.score}</span>
        {article.introduced && <span>紹介済み</span>}
        {article.body_status === "preview" && <span>公開部分のみ</span>}
        {!article.analysis && <span>AI未分析</span>}
      </div>
      {article.growth && (
        <p className="growth">
          約7日で ♡ {article.growth.likes >= 0 ? "+" : ""}
          {article.growth.likes} ／ コメント{" "}
          {article.growth.comments >= 0 ? "+" : ""}
          {article.growth.comments}
          <br />
          スキ増加率{" "}
          {article.growth.likeRate === null
            ? "基準0のため未算出"
            : (article.growth.likeRate * 100).toFixed(1) + "%"}{" "}
          ／ コメント増加率{" "}
          {article.growth.commentRate === null
            ? "基準0のため未算出"
            : (article.growth.commentRate * 100).toFixed(1) + "%"}
        </p>
      )}
    </button>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
export default function Home() {
  const [data, setData] = useState<Dashboard | null>(null),
    [setup, setSetup] = useState<Setup | null>(null),
    [login, setLogin] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("home"),
    [mode, setMode] = useState("rotation"),
    [ranking, setRanking] = useState<"likes" | "comments" | "combined">(
      "combined",
    ),
    [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Card | null>(null),
    [detail, setDetail] = useState<Article | null>(null),
    [editing, setEditing] = useState<Member | null>(null),
    [history, setHistory] = useState<
      {
        id: string;
        member_name: string;
        article_title: string;
        published_url: string;
        introduced_at: string;
      }[]
    >([]);
  const refresh = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        api<Dashboard>("/api/dashboard"),
        api<Setup>("/api/setup"),
      ]);
      setData(d);
      setSetup(s);
      setLogin(false);
      setError("");
    } catch (e) {
      const text = (e as Error).message;
      if (text === "LOGIN") setLogin(true);
      else setError(text);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!data?.jobs.some((j) => j.state === "queued" || j.state === "running"))
      return;
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [data, refresh]);
  useEffect(() => {
    if (selected && data) {
      const fresh = data.articles.find((a) => a.id === selected.id);
      if (fresh) setSelected(fresh);
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  async function action(fn: () => Promise<unknown>, text = "保存しました") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      setMessage(text);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(a: Card) {
    setSelected(a);
    setDetail(null);
    try {
      setDetail(await api<Article>("/api/articles/" + a.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("コピーしました");
    } catch {
      setError("コピーできませんでした。本文を選択してコピーしてください");
    }
  }
  if (login)
    return (
      <main className="login-screen">
        <div className="login-card">
          <div className="seal">☾</div>
          <p className="eyebrow">NERO ROYAL LIBRARY</p>
          <h1>
            いい記事に、
            <br />
            出会うための編集室。
          </h1>
          <p className="muted">
            城下町のみんなの記事を見つけて、
            <br />
            王子の言葉で紹介しよう。
          </p>
          <a className="primary inline-block mt-8" href="/auth/login">
            Googleでログイン・Gmailを接続
          </a>
          <p className="muted text-xs mt-4">
            管理者専用。メンバーシップ通知の読み取りに使います。
          </p>
        </div>
      </main>
    );
  const list = data
    ? (tab === "ranking"
        ? data.weekly[ranking]
        : tab === "rising"
          ? data.rising
          : tab === "articles"
            ? data.articles
            : mode === "rotation"
              ? data.rotation
              : data.recommendations
      ).filter((a) =>
        (a.title + " " + a.member_name)
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : [];
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span>☾</span>
          <div>
            ネロ王立図書館<small>ARTICLE DISCOVERY</small>
          </div>
        </a>
        <p className="nav-label">編集室</p>
        <nav>
          {[
            ["home", "✦", "今日の紹介候補"],
            ["articles", "▤", "記事を探す"],
            ["members", "♙", "メンバー管理"],
            ["ranking", "↗", "週間ランキング"],
            ["rising", "⤴", "急上昇"],
            ["history", "◷", "紹介履歴"],
            ["settings", "⚙", "連携・収集状況"],
          ].map(([id, icon, label]) => (
            <button
              className={tab === id ? "nav-item active" : "nav-item"}
              key={id}
              onClick={() => {
                setTab(id);
                setSearch("");
                if (id === "history")
                  void api<typeof history>("/api/introductions")
                    .then(setHistory)
                    .catch((e) => setError(e.message));
              }}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          みんなの魅力を、次の出会いへ。
          <br />
          <button
            className="text-xs mt-4"
            onClick={() =>
              void action(async () => {
                await api("/api/logout", {});
                setLogin(true);
              }, "ログアウトしました")
            }
          >
            ログアウト
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <span className="muted text-xs">王子の城下町 🌙 ／ 紹介支援</span>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            ↻ 再読込
          </button>
        </header>
        <section className="page-head">
          <p className="eyebrow">
            {tab === "home" ? "TODAY’S SELECTION" : "ROYAL LIBRARY"}
          </p>
          <h1>
            {
              {
                home: "今日は、誰を紹介しよう。",
                articles: "気になる記事を、見つけよう。",
                members: "城下町の仲間たち。",
                ranking: "今週、届いている記事。",
                rising: "この7日で、伸びた記事。",
                history: "つないだ出会いの記録。",
                settings: "編集室の準備を整える。",
              }[tab]
            }
          </h1>
          <p className="muted">
            {tab === "home"
              ? "記事発掘から紹介文づくりまで。ひとりずつ、魅力を見つけていこう。"
              : tab === "rising"
                ? "約7日前（最大9日前まで）の実測記録と比較。基準のない記事はまだ表示されません。"
                : tab === "ranking"
                  ? "公開から7日以内の記事が対象。総合は要件のスコア式を使います。"
                  : "メンバーの公開記事と紹介履歴を、ここで確認できます。"}
          </p>
        </section>
        {error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        {message && (
          <div role="status" className="notice">
            {message}
            <button onClick={() => setMessage("")}>×</button>
          </div>
        )}
        {!data && !error && <Empty>読み込み中…</Empty>}
        {data && (
          <>
            {tab === "home" && (
              <>
                <div className="stats">
                  <div>
                    <span>城下町のメンバー</span>
                    <strong>
                      {data.counts.active}
                      <small>人</small>
                    </strong>
                  </div>
                  <div>
                    <span>発掘した記事</span>
                    <strong>
                      {data.counts.articles}
                      <small>本</small>
                    </strong>
                  </div>
                  <div>
                    <span>未紹介・30日以上</span>
                    <strong className="gold">
                      {data.counts.unintroduced}
                      <small>人</small>
                    </strong>
                  </div>
                </div>
                <div className="section-top">
                  <div>
                    <h2>
                      今日の紹介候補 <span className="gold">✦</span>
                    </h2>
                    <p className="muted text-sm">
                      同じ人が重ならないよう、最大6人を選びます。
                    </p>
                  </div>
                  <div className="segmented">
                    <button
                      className={mode === "rotation" ? "chosen" : ""}
                      onClick={() => setMode("rotation")}
                    >
                      入会順・未紹介
                    </button>
                    <button
                      className={mode === "score" ? "chosen" : ""}
                      onClick={() => setMode("score")}
                    >
                      おすすめ度
                    </button>
                  </div>
                </div>
              </>
            )}
            {["home", "articles", "ranking", "rising"].includes(tab) && (
              <>
                <div className="flex flex-wrap justify-between gap-3 mb-5">
                  <input
                    aria-label="記事・名前で検索"
                    className="search"
                    placeholder="記事・クリエイターを検索"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {tab === "ranking" && (
                    <select
                      aria-label="ランキング種別"
                      value={ranking}
                      onChange={(e) =>
                        setRanking(e.target.value as typeof ranking)
                      }
                    >
                      <option value="combined">総合おすすめ度</option>
                      <option value="likes">スキ数</option>
                      <option value="comments">コメント数</option>
                    </select>
                  )}
                </div>
                {list.length ? (
                  <div className="article-grid">
                    {list.map((a) => (
                      <ArticleCard
                        key={a.id}
                        article={a}
                        onSelect={(a) => void open(a)}
                      />
                    ))}
                  </div>
                ) : (
                  <Empty>
                    {tab === "rising"
                      ? "比較用の記録がまだありません。収集を続けると約7日後から表示できます。"
                      : "記事候補がありません。メンバーを登録して「連携・収集状況」から記事を取得してください。"}
                  </Empty>
                )}
              </>
            )}
            {tab === "home" && (
              <section className="panel mt-8">
                <h2>最近紹介していないメンバー</h2>
                <div className="member-chips">
                  {data.overdue.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setEditing(m);
                        setTab("members");
                      }}
                    >
                      {m.name}
                      <span>{m.days === null ? "未紹介" : m.days + "日"}</span>
                    </button>
                  ))}
                </div>
                {!data.overdue.length && (
                  <p className="muted">全員を30日以内に紹介しています🌙</p>
                )}
              </section>
            )}
            {tab === "members" && (
              <>
                <form
                  className="panel add-member"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget),
                      form = e.currentTarget;
                    void action(async () => {
                      await api("/api/members", Object.fromEntries(f));
                      form.reset();
                    }, "メンバーを登録しました");
                  }}
                >
                  <h2>メンバーを追加</h2>
                  <div className="form-grid">
                    <label>
                      会員名
                      <input name="name" required maxLength={100} />
                    </label>
                    <label>
                      note ID
                      <input
                        name="note_username"
                        placeholder="nero_notelover"
                        pattern="[A-Za-z0-9_-]{2,80}"
                      />
                    </label>
                    <label>
                      入会日時（任意・日本時間）
                      <input type="datetime-local" name="joined_at" />
                    </label>
                    <button className="primary self-end" disabled={busy}>
                      追加する
                    </button>
                  </div>
                </form>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>メンバー</th>
                        <th>状態</th>
                        <th>入会日</th>
                        <th>最終紹介日</th>
                        <th>優先度</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.members.map((m) => (
                        <tr key={m.id}>
                          <td>
                            <strong>{m.name}</strong>
                            <small>{m.note_username || "note ID未設定"}</small>
                          </td>
                          <td>
                            <span className={"status " + m.status}>
                              {m.status}
                            </span>
                          </td>
                          <td>{date(m.joined_at)}</td>
                          <td>{date(m.last_introduced_at)}</td>
                          <td>{m.priority}</td>
                          <td>
                            <button
                              className="secondary"
                              onClick={() => setEditing(m)}
                            >
                              編集
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <section className="panel mt-8">
                  <h2>
                    確認待ちの通知{" "}
                    <span className="gold">{data.pendingEvents.length}</span>
                  </h2>
                  <p className="muted text-sm">
                    判定できなかった通知です。登録済みメンバーと通知の種別を指定して反映してください。
                  </p>
                  {data.pendingEvents.map((e) => (
                    <form
                      className="pending-event"
                      key={e.id}
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        const f = new FormData(ev.currentTarget);
                        void action(
                          () =>
                            api("/api/events/resolve", {
                              event_id: e.id,
                              ...Object.fromEntries(f),
                            }),
                          "通知を反映しました",
                        );
                      }}
                    >
                      <p>{e.subject}</p>
                      <small className="muted">
                        {e.reason} ／ {date(e.received_at)}
                      </small>
                      <div className="flex gap-3 flex-wrap mt-3">
                        <select
                          name="member_id"
                          required
                          aria-label="対象メンバー"
                        >
                          <option value="">メンバーを選択</option>
                          {data.members
                            .filter((m) => m.note_username)
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                        </select>
                        <select
                          name="kind"
                          defaultValue={e.kind === "unknown" ? "join" : e.kind}
                          aria-label="通知種別"
                        >
                          <option value="join">入会</option>
                          <option value="withdraw">退会</option>
                          <option value="plan">プラン変更</option>
                        </select>
                        <input
                          name="plan_name"
                          aria-label="変更後のプラン名"
                          placeholder="変更後のプラン名（該当時）"
                          defaultValue={e.plan_name || ""}
                        />
                        <button className="secondary" disabled={busy}>
                          確認して反映
                        </button>
                      </div>
                    </form>
                  ))}
                  {!data.pendingEvents.length && (
                    <p className="muted mt-4">確認待ちはありません。</p>
                  )}
                </section>
              </>
            )}
            {tab === "history" && (
              <section className="panel">
                {history.map((h) => (
                  <div className="history-row" key={h.id}>
                    <span className="muted text-sm">
                      {date(h.introduced_at)}
                    </span>
                    <strong>{h.member_name}</strong>
                    <p>{h.article_title}</p>
                    <a href={h.published_url} target="_blank" rel="noreferrer">
                      紹介記事を開く ↗
                    </a>
                  </div>
                ))}
                {!history.length && (
                  <Empty>掲載URLを登録すると、ここに紹介履歴が残ります。</Empty>
                )}
              </section>
            )}
            {tab === "settings" && (
              <>
                <section className="panel">
                  <h2>連携</h2>
                  <div className="integration-grid">
                    <div>
                      <strong>Google / Gmail</strong>
                      <p>{setup?.googleConnected ? "接続済み" : "未接続"}</p>
                      <small>
                        最終同期 {datetime(setup?.gmailSyncedAt || null)}
                      </small>
                      <a
                        className="secondary inline-block mt-4"
                        href="/auth/login"
                      >
                        接続を更新
                      </a>
                    </div>
                    <div>
                      <strong>OpenAI</strong>
                      <p>
                        {setup?.aiConfigured ? "設定済み" : "APIキー未設定"}
                      </p>
                      <small>
                        朝夕それぞれ最大6記事を分析。記事ごとの分析も可能。
                      </small>
                    </div>
                    <div>
                      <strong>Discord</strong>
                      <p>
                        {setup?.discordConfigured
                          ? "設定済み"
                          : "Webhook未設定"}
                      </p>
                      <small>
                        毎朝7:00（日本時間）
                        <br />
                        最終通知 {datetime(setup?.reportAt || null)}
                      </small>
                      {setup?.reportError && (
                        <p className="error-text">{setup.reportError}</p>
                      )}
                    </div>
                  </div>
                </section>
                <section className="panel mt-6">
                  <h2>記事とメンバーの収集</h2>
                  <p className="muted">
                    毎日6:00・18:00（日本時間）に取得を開始します。初回は記事数に応じて時間がかかります。
                  </p>
                  <div className="flex flex-wrap gap-3 mt-5">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          () => api("/api/sync", { kind: "gmail" }),
                          "Gmail通知の同期を予約しました",
                        )
                      }
                    >
                      Gmailからメンバー同期
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          () => api("/api/sync", { kind: "articles" }),
                          "記事の取得を予約しました",
                        )
                      }
                    >
                      メンバーの記事を取得
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          () => api("/api/jobs/run", {}),
                          "処理を1件進めました",
                        )
                      }
                    >
                      待機中の処理を1件進める
                    </button>
                  </div>
                </section>
                <section className="panel mt-6">
                  <h2>直近の処理状況</h2>
                  <p className="muted text-sm">
                    待機中は定期実行で進みます。失敗は3回まで再試行します。
                  </p>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>処理</th>
                          <th>状態</th>
                          <th>実行回数</th>
                          <th>詳細</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.jobs.map((j) => (
                          <tr key={j.id}>
                            <td>{j.kind}</td>
                            <td>{j.state}</td>
                            <td>{j.attempts}</td>
                            <td>
                              {j.error}
                              {j.state === "failed" && (
                                <button
                                  className="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    void action(
                                      () =>
                                        api("/api/jobs/retry", { id: j.id }),
                                      "再試行を予約しました",
                                    )
                                  }
                                >
                                  再試行
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
          </>
        )}
        <footer>
          ☾ NERO ROYAL LIBRARY{" "}
          <span>紹介文とコメントは、王子が確認してから届けよう。</span>
        </footer>
      </main>
      {selected && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setSelected(null);
            setDetail(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="記事の紹介を準備"
            className="drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close"
              aria-label="閉じる"
              onClick={() => setSelected(null)}
            >
              ×
            </button>
            <p className="eyebrow">CREATOR’S STORY</p>
            <p className="gold">{selected.member_name}</p>
            <h2>{selected.title}</h2>
            <a href={selected.url} target="_blank" rel="noreferrer">
              noteで原文を読む ↗
            </a>
            <p className="muted text-sm mt-4">
              {date(selected.published_at)} ／ ♡{selected.likes} ／ コメント
              {selected.comments} ／ おすすめ度{selected.score}
            </p>
            <div className="flex gap-5 mt-4 flex-wrap">
              {(["favorite", "participated"] as const).map((key) => (
                <label className="check" key={key}>
                  <input
                    type="checkbox"
                    checked={Boolean(selected[key])}
                    disabled={busy}
                    onChange={(e) => {
                      const next = {
                        ...selected,
                        [key]: Number(e.target.checked),
                      };
                      void action(() =>
                        api("/api/articles/flags", {
                          id: selected.id,
                          favorite: Boolean(next.favorite),
                          participated: Boolean(next.participated),
                        }),
                      );
                    }}
                  />
                  {key === "favorite"
                    ? "王子お気に入り +100"
                    : "共同企画参加 +30"}
                </label>
              ))}
            </div>
            <details className="panel mt-5">
              <summary>
                取得した本文{" "}
                {selected.body_status === "preview" ? "（公開部分のみ）" : ""}
              </summary>
              <pre className="body-text">
                {detail?.body ||
                  (detail ? "公開本文を取得できませんでした" : "読み込み中…")}
              </pre>
            </details>
            <div className="mt-6">
              <button
                className="primary"
                disabled={
                  busy ||
                  selected.body_status === "unavailable" ||
                  !setup?.aiConfigured
                }
                onClick={() =>
                  void action(
                    () => api("/api/analyze", { id: selected.id }),
                    "本文の分析を予約しました。同じ本文は保存済みの分析を再利用します",
                  )
                }
              >
                {selected.analysis
                  ? "保存済みの分析を確認"
                  : "AIで魅力と紹介案をつくる"}
              </button>
              <p className="muted text-xs mt-2">
                下書きの生成です。noteへの自動投稿は行いません。
              </p>
            </div>
            {selected.analysis && (
              <AnalysisView
                analysis={selected.analysis}
                member={selected.member_name}
                url={selected.url}
                copy={copy}
              />
            )}
            <form
              className="panel mt-7"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void action(
                  () =>
                    api("/api/introductions", {
                      article_id: selected.id,
                      published_url: f.get("published_url"),
                    }),
                  "紹介履歴に記録しました",
                );
              }}
            >
              <h3>掲載したら、紹介済みにする</h3>
              <p className="muted text-sm mb-3">
                紹介した記事のURLを登録すると、最終紹介日を更新します。
              </p>
              <label>
                掲載した紹介記事のURL
                <input
                  name="published_url"
                  type="url"
                  required
                  placeholder="https://note.com/…/n/…"
                />
              </label>
              <button className="secondary mt-3" disabled={busy}>
                掲載URLを登録する
              </button>
            </form>
          </section>
        </div>
      )}
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <form
            role="dialog"
            aria-modal="true"
            aria-label="メンバー編集"
            className="drawer edit-drawer"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const payload = {
                ...Object.fromEntries(f),
                priority: Number(f.get("priority")),
                tags: String(f.get("tags"))
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              };
              void action(async () => {
                await api(
                  "/api/members/" + encodeURIComponent(editing.id),
                  payload,
                  "PATCH",
                );
                setEditing(null);
              });
            }}
          >
            <button
              type="button"
              className="close"
              onClick={() => setEditing(null)}
              aria-label="閉じる"
            >
              ×
            </button>
            <h2>メンバーを編集</h2>
            {[
              ["name", "会員名"],
              ["note_username", "note ID"],
              ["profile_url", "プロフィールURL"],
              ["account_url", "アカウントURL"],
              ["discord_name", "Discord名"],
              ["plan", "プラン"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  name={key}
                  defaultValue={String(editing[key as keyof Member] || "")}
                  required={key === "name"}
                />
              </label>
            ))}
            <label>
              タグ（カンマ区切り）
              <input
                name="tags"
                defaultValue={(JSON.parse(editing.tags) as string[]).join(", ")}
              />
            </label>
            <label>
              紹介優先度（0〜100）
              <input
                name="priority"
                type="number"
                min={0}
                max={100}
                defaultValue={editing.priority}
              />
            </label>
            <label>
              入会日時（日本時間）
              <input
                name="joined_at"
                type="datetime-local"
                defaultValue={new Date(
                  Date.parse(editing.joined_at) + 9 * 3600000,
                )
                  .toISOString()
                  .slice(0, 16)}
              />
            </label>
            <label>
              ステータス
              <select name="status" defaultValue={editing.status}>
                <option value="active">active（有効）</option>
                <option value="withdraw">withdraw（退会）</option>
                <option value="pending">pending（確認待ち）</option>
              </select>
            </label>
            <button className="primary mt-5" disabled={busy}>
              変更を保存
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
function AnalysisView({
  analysis: a,
  member,
  url,
  copy,
}: {
  analysis: Analysis;
  member: string;
  url: string;
  copy: (s: string) => Promise<void>;
}) {
  return (
    <div className="analysis">
      <h3>この記事の魅力</h3>
      <p>{a.overview}</p>
      <p className="muted mt-3">{a.summary}</p>
      {[
        ["良かったところ", a.goodPoints],
        ["魅力ポイント", a.charms],
        ["おすすめポイント", a.recommendedPoints],
        ["紹介ポイント", a.introductionPoints],
        ["引用候補（原文一致）", a.quotes],
      ].map(([title, items]) => (
        <div key={String(title)} className="mt-5">
          <h4>{title}</h4>
          <ul>
            {(items as string[]).map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      ))}
      <p className="muted mt-4">想定読者：{a.audience}</p>
      {[
        [
          "紹介文の下書き",
          member +
            "さんの記事をご紹介します🌙\n\n" +
            a.introduction +
            "\n\n" +
            url,
        ],
        ["王子コメントの下書き", a.comment],
      ].map(([title, text]) => (
        <section className="draft" key={title}>
          <div className="flex justify-between gap-3">
            <h4>{title}</h4>
            <button className="secondary" onClick={() => void copy(text)}>
              コピー
            </button>
          </div>
          <pre>{text}</pre>
        </section>
      ))}
    </div>
  );
}
