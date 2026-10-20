export type JsonObject = Record<string, unknown>

/**
 * 環境変数から読む設定。送信先とキーは managed settings の `env` で配り、
 * プラグインには書かない (main の内容は public ミラーへ同期される)。
 */
export type Config = {
  apiUrl: string
  apiKey: string
  /** `AI_ANALYTICS_PROJECT` の明示指定 (あれば git の解決より優先する) */
  projectOverride?: string
  /** `AI_ANALYTICS_USER_EMAIL` の明示指定 (CI のボットなど) */
  emailOverride?: string
  /** `AI_ANALYTICS_DISABLE_GIT_REMOTE=1` で git remote URL を送らない */
  disableGitRemote: boolean
  /** `AI_ANALYTICS_DEBUG=1` で送信結果も debug log に出す (失敗は常に出す) */
  debug: boolean
}

/** email をどこから決めたか (診断用に payload へ載せる) */
export type EmailSource = 'override' | 'telemetry' | 'login-record'

/** git remote URL をどこから取ったか (診断用) */
export type GitRemoteSource = 'file' | 'git' | 'none' | 'disabled'

/**
 * セッションの送信元の識別情報。セッションごとに一度だけ決めて `$.store` に固定し、
 * 再送で別の値にならないようにする (同じ event_id に違う本文が並ぶと dbt が選べない)。
 */
export type Origin = {
  project: string
  email: string
  emailSource: EmailSource
  hostname: string
  platform: string
  collectorVersion: string
  gitRemoteUrl?: string
  gitRemoteSource: GitRemoteSource
}
