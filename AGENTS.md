# brisys-claude-code-analytics-plugin

Claude Code 向け利用統計プラグイン `brisys-claude-code-analytics` (mod) のマーケットプレイス。
**正本リポジトリ ([brisys-dev/brisys-claude-analytics-plugin](https://github.com/brisys-dev/brisys-claude-analytics-plugin), private) からの自動同期ミラー**であり、
チームには Team settings (managed settings) の `extraKnownMarketplaces` で配布される。

## ルール

- **プラグイン本体 (`.claude-plugin/` / `brisys-claude-code-analytics/`) をこのリポジトリで直接編集しない** —
  正本側の main への push で自動同期され、上書きされる。変更は正本リポジトリで行うこと
- 同期のときに書き換わるのは 2 つだけ:
  - マーケットプレイス名 (`brisys-claude-analytics-plugin` → `brisys-claude-code-analytics-plugin`)
  - `brisys-claude-code-analytics/distribution.json` の `repository` (このミラーの名前になる。mod は
    session.started でこれを送り、どちらのリポジトリの配布物かを示す)
  - プラグイン名は変えない (組織同期と同じ名前にして、Claude Code で二重に読み込ませないため)
- 旧プラグイン `claude-code-analytics` (Rust バイナリを command hook で起動する方式) は 2026-10-21 に外した。
  バイナリを戻さない
- このリポジトリで直接管理してよいのは README.md / AGENTS.md / CLAUDE.md / LICENSE のみ (同期対象外)
- **public リポジトリ**なので秘匿情報 (API キー・エンドポイント・社内 URL・社内ホスト名) を絶対に置かない。
  エンドポイント/キーは Team settings の `env` で配布される
- マーケットプレイス仕様は https://code.claude.com/docs/en/plugin-marketplaces.md を参照
