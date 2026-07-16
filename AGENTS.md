# brisys-claude-code-analytics-plugin

Claude Code 向け利用統計プラグインのマーケットプレイス。
**正本リポジトリ ([brisys-dev/brisys-claude-analytics-plugin](https://github.com/brisys-dev/brisys-claude-analytics-plugin), private) からの自動同期ミラー**であり、
チームには Team settings (managed settings) の `extraKnownMarketplaces` で配布される。

## ルール

- **プラグイン本体 (`.claude-plugin/` / `claude-code-analytics/`) をこのリポジトリで直接編集しない** —
  正本側の main への push で自動同期され、上書きされる。変更は正本リポジトリで行うこと
- このリポジトリで直接管理してよいのは README.md / AGENTS.md / CLAUDE.md / LICENSE のみ (同期対象外)
- **public リポジトリ**なので秘匿情報 (API キー・エンドポイント・社内 URL・社内ホスト名) を絶対に置かない。
  エンドポイント/キーは Team settings の `env` で配布される
- マーケットプレイス仕様は https://code.claude.com/docs/en/plugin-marketplaces.md を参照
