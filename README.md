# brisys-claude-code-analytics-plugin

Claude Code の利用統計を集めて分析基盤 (ai-analytics) に送るプラグイン `brisys-claude-code-analytics` の、
Claude Code 向けマーケットプレイスです。

プラグインは mod (Claude Code の中で動く TypeScript の hooks module) なので、配るバイナリが無く、
Node.js も要りません。

> このリポジトリは正本リポジトリ
> ([brisys-dev/brisys-claude-analytics-plugin](https://github.com/brisys-dev/brisys-claude-analytics-plugin), private)
> からの**自動同期ミラー**です。プラグインへの変更は正本で行い、main への push ごとにここへ同期されます
> (README.md / AGENTS.md / CLAUDE.md / LICENSE は、このリポジトリで管理します)。

## 構成

```
.claude-plugin/marketplace.json     # マーケットプレイス定義 (name: brisys-claude-code-analytics-plugin)
brisys-claude-code-analytics/       # プラグイン本体
├── .claude-plugin/plugin.json      # プラグインマニフェスト
├── hooks/hooks.json                # { "modules": ["./register.ts"] }
├── hooks/register.ts               # イベントの配線と、エンジンの API を使う処理
├── hooks/lib/                      # 検出・送信 body・outbox の形式などの関数
└── distribution.json               # 配布物の出どころ (このミラーでは同期のときに書き換わる)
```

## 送るもの

プラグインが送るのは 3 種類だけです。ほかの利用状況は Claude Code 本体が送り
(Team settings の `type: "http"` hook と OpenTelemetry)、このプラグインは関与しません。

| 送るもの | 送信先 | 内容 |
|---|---|---|
| `session.started` | `POST /api/v1/events` | セッションの開始 (`/clear` の後の新しいセッションも含む) |
| `transcript.command_detected` | `POST /api/v1/transcript-events` | スラッシュコマンドの実行 (コマンド名だけ) |
| `transcript.skill_detected` | `POST /api/v1/transcript-events` | Skill ツールの呼び出し (スキル名だけ。サブエージェントなら種類も付ける) |

見つけたものは手元の `$.store` に保存し、ターンの完了・30 秒ごと・セッションの終了で送ります。
送れなかったものは間隔を広げて送り直し、7 日で捨てます。

## プライバシー — 送信されるもの / されないもの

**送信されるもの**

- イベントメタデータ (セッション ID、イベント種別、時刻、ホスト名、OS)
- アカウント識別用の email
- プロジェクト (git リポジトリのルートパス、なければ cwd) と git remote URL。URL に埋め込まれた
  資格情報 (`https://user:token@host/...` の `user:token@`) は外して送ります
- プラグインの版、Claude Code の版、モデル名
- スキル名・コマンド名 (引数の有無フラグだけ。引数の内容は送りません)
- 配布の経路: どのリポジトリの配布物か、組織同期かマーケットプレイスか、組織同期の写しの有無と版、
  画面の種類 (terminal / desktop など)、起動のしかた

**送信されないもの**

- プロンプト本文
- 編集内容 (Edit / Write に渡した中身)
- アシスタントの応答本文
- ツールの実行結果

送れなかったものは、送れるまで手元の `$.store` (Claude Code の設定ディレクトリの `plugins/store/`) に
残ります。中身は送るものと同じで、プロンプトや応答の本文は含みません。

## 要件

- Claude Code 2.1.287 以降 (Desktop は 2.1.286 以降)。それより古い版では読み込まれません
- 分析 API の URL と API キー (環境変数で渡します)

## インストール

チームのメンバーには Team settings (managed settings) の `extraKnownMarketplaces` / `enabledPlugins` で
自動で配布されるので、通常は手動でのインストールは要りません。手動で入れるときは、Claude Code で次を
実行します。

```
/plugin marketplace add brisys-dev/brisys-claude-code-analytics-plugin
/plugin install brisys-claude-code-analytics@brisys-claude-code-analytics-plugin
```

## 設定

環境変数で設定します。シェルの設定ファイルか、Claude Code の `settings.json` の `env` に書いてください。

| 環境変数 | 必須 | 説明 |
|---|---|---|
| `AI_ANALYTICS_API_URL` | ✅ | 分析 API のベース URL |
| `AI_ANALYTICS_API_KEY` | ✅ | Bearer トークン |
| `AI_ANALYTICS_USER_EMAIL` | — | email の明示指定 (ログインしていない実行など) |
| `AI_ANALYTICS_PROJECT` | — | プロジェクト名の明示指定 (git のルートより優先) |
| `AI_ANALYTICS_DISABLE_GIT_REMOTE` | — | `1` で git remote URL を送らない |
| `AI_ANALYTICS_DEBUG` | — | `1` で送信の成功も debug log に出す |
| `AI_ANALYTICS_DEV_API_URL` / `AI_ANALYTICS_DEV_API_KEY` | — | 検証用の上書き (通常の設定より優先) |

`settings.json` での設定例:

```json
{
  "env": {
    "AI_ANALYTICS_API_URL": "https://api.example.com",
    "AI_ANALYTICS_API_KEY": "sk-team-xxxx"
  }
}
```

**フェイルセーフ**: URL かキーが無いとき、email が決まらないときは何も送りません。送信に失敗しても、
Claude Code の操作は止めません。

### email の決め方

1. `AI_ANALYTICS_USER_EMAIL`
2. 同じセッションのテレメトリの `user.email` (OpenTelemetry と同じ、実際にログインしているアカウント)
3. 今使っている設定ディレクトリの `.claude.json` (`CLAUDE_CONFIG_DIR` があればそこ、無ければ `~/.claude.json`)

どれでも決まらなければ、そのセッションは送りません。

## トラブルシューティング

イベントが届かないときは、`claude --debug` の debug log を見てください。

1. `hooks module brisys-claude-code-analytics@brisys-claude-code-analytics-plugin loaded` があるか。
   無ければ、プラグインが入っていないか、Claude Code が古い
2. `[analytics]` で始まる行。送信の失敗が出ます (成功も見たいときは `AI_ANALYTICS_DEBUG=1`)
3. 送れずに残っているもの。`<設定ディレクトリ>/plugins/store/` の、このプラグイン名で始まる JSON にあります

## なぜ managed settings 経由で配布しているか

Claude の管理コンソールの組織マーケットプレイスに接続できるのは、private リポジトリだけです。一方で、
Claude Code に managed settings (`extraKnownMarketplaces` / `enabledPlugins`) で全員に配るには、どの端末も
認証なしで clone できるリポジトリが要ります。そのため、面ごとに経路を分けています。

- Claude (Web / Desktop / Cowork): 正本の private リポジトリを、管理コンソールの組織同期で配布
- Claude Code: この public ミラーを、managed settings で配布

2026-10 時点では、組織同期のプラグインも Claude Code に `<name>@synced` として届きます (claude.ai の
アカウントでサインインしたターミナルのセッション、v2.1.273 以降)。ただし、Desktop の Code タブと VS Code
への配布はドキュメントに書かれておらず、OAuth トークンや API キーで認証するセッションには届きません。
利用者が `syncClaudeAiPlugins: false` を設定すると止まります。そのため managed settings の経路を残しています。
両方から届いたときは managed settings 側だけが読み込まれ、二重には収集しません。

### 参照

- 公式ヘルプ
  - [Manage plugins for your organization](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization) — 組織マーケットプレイスは private リポジトリ限定 (public は不可)
  - [Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)
- 公式ドキュメント
  - [Create and distribute a plugin marketplace (Claude Code Docs)](https://code.claude.com/docs/en/plugin-marketplaces)
  - [Plugins synced from claude.ai](https://code.claude.com/docs/en/plugins/loading#synced-plugins)
- GitHub Issue
  - [anthropics/claude-code#9756 — Support Auth on Private Marketplaces and Plugins](https://github.com/anthropics/claude-code/issues/9756)
  - [anthropics/claude-code#74923 — GITHUB_TOKEN shadows gh CLI credentials](https://github.com/anthropics/claude-code/issues/74923)

## 開発

プラグインの開発は正本リポジトリで行います。このリポジトリで直接管理しているのは README.md / AGENTS.md /
CLAUDE.md / LICENSE だけで、それ以外への直接のコミットは次の同期で上書きされます。
