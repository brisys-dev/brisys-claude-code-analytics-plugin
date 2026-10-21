// このプラグインがどの経路で届いたかの診断 (session.started の payload に載せる)。
//
// 同じプラグインが 2 つの経路で届く。managed settings のマーケットプレイス (public ミラー) と、
// claude.ai の組織同期 (private の正本) だ。両方あると Claude Code は managed 側だけを読み込むので、
// 「読み込まれた経路」とは別に「組織同期の写しが届いているか」も記録し、public ミラーを閉じて
// 組織同期だけにできるかを判断する材料にする。
//
// どのリポジトリの配布物かは、コードに書かず配布物の `distribution.json` で決める。正本では
// 正本の名前で、public ミラーへの同期 (sync-to-public.yml) がミラーの名前に書き換える。
// 同じコードがどちらのリポジトリからも配られるので、コードに名前を書くと両方が同じ値を送ってしまう。
//
// ここには文字列だけを扱う関数を置く。ファイルを読む・写しを探す処理は `$` を使うので register.ts にある。

import type { JsonObject } from './types'

/**
 * 観測のしかたの版。フィールドの意味を変えたら上げる (プラグインの版とは別)。
 *
 * - 2: このセッションの bucket (Claude Code が写しを読み込む、今のアカウントの bucket) だけを見て、
 *   その manifest.json が指す世代のディレクトリ (`<プラグイン名>~g<世代>` も見る) で写しを確かめる。
 *   bucket を決められないときや、manifest と置き場所が食い違うときは unknown にする
 * - 1: 全部の bucket の、接尾辞の無い `<プラグイン名>/` だけを見ていた。2 世代目以降の写しを見落として
 *   absent と送るので、1 の absent は集計に使わない
 */
export const DELIVERY_OBSERVATION_VERSION = 2

/** 配布物の出どころを書いたファイル (プラグインのディレクトリ直下)。 */
export const DISTRIBUTION_FILE = 'distribution.json'

export type DeliveryRoute = 'synced' | 'marketplace' | 'local'

/**
 * 名前をそのまま送ってよいリポジトリ・マーケットプレイス (このプラグインを配る 2 つ。どちらも
 * リポジトリ名とマーケットプレイス名が同じ)。値を決めるためではなく、知らない名前 (個人や他組織の
 * マーケットプレイスなど) を送らないための許可リスト。ほかは other にまとめる。
 */
const KNOWN_DISTRIBUTIONS = new Set(['brisys-claude-analytics-plugin', 'brisys-claude-code-analytics-plugin'])

export type PluginLocation = {
  route: DeliveryRoute
  /** プラグインを読み込んだ設定ディレクトリ。local では分からない */
  configDir?: string
  /** route が marketplace のときのマーケットプレイス名 */
  marketplace?: string
  /** route が synced のときの bucket の名前 (アカウントの uuid を含むので送らない) */
  bucket?: string
}

/**
 * プラグインのディレクトリの形から、どこから読み込まれたかを決める。
 * - 組織同期: `<設定ディレクトリ>/plugins/synced/<bucket>/<plugin>` (2 世代目以降は `<plugin>~g<世代>`)。
 *   本体はこの bucket から読み込んだので、このセッションの bucket はこれ
 * - マーケットプレイス: `<設定ディレクトリ>/plugins/cache/<marketplace>/<plugin>/<version>`
 * - それ以外 (`--plugin-dir` など): local
 *
 * 設定ディレクトリの名前に plugins を含む場合に誤らないよう、`plugins/synced` と `plugins/cache` の
 * 組を後ろから探す。設定ディレクトリは区切り文字を保ったまま元の文字列から切り出す。
 */
export function pluginLocation(pluginRoot: string): PluginLocation {
  const trimmed = pluginRoot.replace(/[\\/]+$/, '')
  const segments = trimmed.replaceAll('\\', '/').split('/')
  for (let k = segments.length - 3; k >= 1; k--) {
    if (segments[k] !== 'plugins') continue
    const kind = segments[k + 1]
    const configDir = trimmed.slice(0, segments.slice(0, k).join('/').length)
    if (kind === 'synced' && segments.length === k + 4) return { route: 'synced', configDir, bucket: segments[k + 2] }
    if (kind === 'cache' && segments.length === k + 5) {
      return { route: 'marketplace', configDir, marketplace: segments[k + 2] }
    }
  }
  return { route: 'local' }
}

/** 送るリポジトリ名・マーケットプレイス名。許可リストに無いものは other、無ければ null。 */
export function distributionLabel(name: string | undefined): string | null {
  if (name === undefined) return null
  return KNOWN_DISTRIBUTIONS.has(name) ? name : 'other'
}

/** `distribution.json` の repository。読めない・形がおかしいときは undefined。 */
export function distributionRepository(text: string): string | undefined {
  try {
    const repository = JSON.parse(text)?.repository
    return typeof repository === 'string' && repository ? repository : undefined
  } catch {
    return undefined
  }
}

/** 英小文字・数字・ハイフンの短い識別子 (32 字まで) だけを通す。それ以外は other、無ければ null。 */
export function safeToken(value: string | null | undefined): string | null {
  if (!value) return null
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(value) ? value : 'other'
}

/** プラグインの plugin.json の version。読めない・形がおかしいときは undefined。 */
export function manifestVersion(text: string): string | undefined {
  try {
    const version = JSON.parse(text)?.version
    return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}

// ---- 組織同期の写し ----
//
// Claude Code は、bucket (`<設定ディレクトリ>/plugins/synced/<bucket>/`。アカウントごと) の
// manifest.json の行から写しのディレクトリを決めて読み込む。1 世代目は `<プラグイン名>`、2 世代目
// 以降は `<プラグイン名>~g<世代>` で、世代は行の generation (2 以上の整数。無ければ 1)。manifest が
// 読めなければ、その bucket からは何も読み込まない。
//
// 根拠は Claude Code 2.1.287〜2.1.305 の実行ファイルに入っている JS で、どの版も同じだった。
// 写しの場所は「世代が 1 以下なら `<名前>`、それ以外は `<名前>~g<世代>`」の関数で組み立て、
// manifest の行の generation は「2 以上の整数、ほかは無いものとして 1」で読む。読み込む写しは
// manifest の行だけから決め、写しの名前は `/~g(?:[2-9]|[1-9]\d+)$/` を外して得る。
//
// 世代の番号はスロット番号で、新しい写しほど大きいとは限らない。写しを読み込んでいるセッションが
// あると、更新は今の世代を飛ばして 1 から順に空いている番号に置かれ、古い写しは使われなくなって
// から消される。そのため番号の大小から今の写しを推し量らず、manifest が指すディレクトリだけを
// 写しと数える。

/** bucket の中の、Claude Code が書く manifest (どの写しを読み込むかの正)。 */
export const SYNC_MANIFEST_FILE = 'manifest.json'

/** 世代の接尾辞 (Claude Code と同じ正規表現)。`~g0`・`~g1`・`~g02` は接尾辞ではない。 */
const GENERATION_SUFFIX = /^~g(?:[2-9]|[1-9]\d+)$/

/** その世代の写しのディレクトリ名。1 世代目は接尾辞なし。 */
export function syncedCopyDirName(pluginName: string, generation: number): string {
  return generation <= 1 ? pluginName : `${pluginName}~g${generation}`
}

/** bucket の一覧の 1 項目が、このプラグインの写し (世代は問わない) のディレクトリか。 */
export function isSyncedCopyDir(entry: { name: string; kind: string }, pluginName: string): boolean {
  if (entry.kind !== 'dir' || !entry.name.startsWith(pluginName)) return false
  const suffix = entry.name.slice(pluginName.length)
  return suffix === '' || GENERATION_SUFFIX.test(suffix)
}

/** bucket の一覧から、manifest.json があるかと、このプラグインの写しのディレクトリがあるかを読む。 */
export function syncedBucketLayout(
  entries: readonly { name: string; kind: string }[],
  pluginName: string,
): { hasSyncManifest: boolean; hasCopyDir: boolean } {
  return {
    hasSyncManifest: entries.some((entry) => entry.name === SYNC_MANIFEST_FILE),
    hasCopyDir: entries.some((entry) => isSyncedCopyDir(entry, pluginName)),
  }
}

/**
 * bucket の manifest.json に、このプラグインがどう載っているか。
 * - missing: manifest.json が無い
 * - unreadable: 読めない・JSON の object でない・plugins が配列でない
 * - unlisted: 読めたが、このプラグインの行が無い
 * - listed: 行がある (generation はその世代)
 */
export type SyncManifestEntry =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'unlisted' }
  | { kind: 'listed'; generation: number }

/**
 * manifest.json の本文から、このプラグインの行を読む。text が undefined (読めなかった) なら unreadable。
 *
 * 行の扱いは Claude Code にそろえる。pluginId と name が文字列でない行は捨て、generation は 2 以上の
 * 整数のときだけ使う (ほかは 1 世代目)。同じ名前の行が複数あれば最初の行を見る。Claude Code も
 * 同じ名前の写しは 1 つしか読み込まない。最初の行の写しが無ければ、食い違いとして unknown になる。
 */
export function syncManifestEntry(text: string | undefined, pluginName: string): SyncManifestEntry {
  if (text === undefined) return { kind: 'unreadable' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'unreadable' }
  }
  if (!isRecord(parsed)) return { kind: 'unreadable' }
  const plugins = parsed.plugins
  // plugins が無いのは、載っているプラグインが無いということ (Claude Code も空として読む)
  if (plugins === undefined) return { kind: 'unlisted' }
  if (!Array.isArray(plugins)) return { kind: 'unreadable' }
  const row = plugins.find(
    (item): item is Record<string, unknown> =>
      isRecord(item) && typeof item.pluginId === 'string' && item.name === pluginName,
  )
  if (row === undefined) return { kind: 'unlisted' }
  const generation = row.generation
  const valid = typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 2
  return { kind: 'listed', generation: valid ? generation : 1 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 組織同期の写しを調べられなかった理由。生のエラー文やパスは送らない。
 * - io_error: 同期の置き場や bucket を一覧できない・確かめられない
 * - unrecognized_root: 設定ディレクトリが分からない
 * - bucket_unresolved: bucket はあるのに、このセッションの bucket の名前を決められない
 *   (ログイン記録が読めない、組織が決まらない)
 * - bucket_mismatch: このセッションの bucket が無い (ほかの bucket だけがある)、または印 (`.bucket-<名前>`) が無い
 * - bucket_ambiguous: このセッションの bucket の候補が 2 つあり、写しの有無が食い違う
 * - manifest_unreadable: manifest.json があるのに読めない (JSON でない・形が違う)
 * - manifest_mismatch: manifest.json と置き場所が食い違う (manifest が指す写しが無い、manifest に無い写しがある)
 */
export type SyncedProbeError =
  | 'io_error'
  | 'unrecognized_root'
  | 'bucket_unresolved'
  | 'bucket_mismatch'
  | 'bucket_ambiguous'
  | 'manifest_unreadable'
  | 'manifest_mismatch'

/** 1 つの bucket を調べた結果。version は写しの plugin.json の版 (読めなければ undefined)。 */
export type SyncedBucketResult =
  | { kind: 'present'; version: string | undefined }
  | { kind: 'absent' }
  | { kind: 'unknown'; error: SyncedProbeError }

/**
 * bucket に、Claude Code が読み込む写しがあるかを決める。
 *
 * present は、manifest に載っていて、その世代の写しの plugin.json があるときだけ。manifest と
 * 置き場所が食い違うときは unknown にして、present とも absent とも数えない。同期の途中
 * (写しを置いてから manifest を書き直すまで、古い写しを消している間) に一時的に起こるほか、
 * 置き場所の規則が変わったときにも起こる。v1 は規則の変化を黙って absent にしていた。
 *
 * @param entry manifest.json の読み取り結果
 * @param designatedCopy manifest が指す写しの plugin.json があれば、その版。無ければ undefined
 * @param hasCopyDir bucket に、このプラグインの写し (世代は問わない) のディレクトリがあるか
 */
export function syncedBucketResult(
  entry: SyncManifestEntry,
  designatedCopy: { version: string | undefined } | undefined,
  hasCopyDir: boolean,
): SyncedBucketResult {
  if (entry.kind === 'unreadable') return { kind: 'unknown', error: 'manifest_unreadable' }
  if (entry.kind === 'listed') {
    return designatedCopy === undefined
      ? { kind: 'unknown', error: 'manifest_mismatch' }
      : { kind: 'present', version: designatedCopy.version }
  }
  return hasCopyDir ? { kind: 'unknown', error: 'manifest_mismatch' } : { kind: 'absent' }
}

// ---- このセッションの bucket ----
//
// Claude Code は、同期の置き場 (`<設定ディレクトリ>/plugins/synced/`) にあるアカウントごとの bucket の
// うち、1 つだけから写しを読み込む。bucket の名前は `<組織の uuid>_<アカウントの uuid>` (小文字。
// アカウントが決まらなければ `<組織の uuid>_unbound`) で、同期の置き場に印のファイル `.bucket-<名前>`
// があるときだけ読み込む。アカウントを切り替える前の bucket などは、残っていても読み込まない。
//
// アカウントの uuid は、本体が使っている OAuth トークンの出どころで決まる。
// - ログインして保存したトークン (CLI の通常の形): ログイン記録 (`.claude.json` の oauthAccount) の accountUuid
// - ホストが渡したトークン (CLAUDE_CODE_OAUTH_TOKEN やファイル記述子。Desktop など) と、OAuth トークンを
//   使わないとき (API キーなど): CLAUDE_CODE_ACCOUNT_UUID。無ければ unbound
// 組織はどちらも CLAUDE_CODE_ORGANIZATION_UUID で、無ければログイン記録の organizationUuid。環境変数が
// あれば、uuid の形でなくてもログイン記録には後退しない。組織が uuid の形でなければ、どの bucket からも
// 読み込まない。根拠は Claude Code 2.1.287〜2.1.305 の実行ファイルに入っている JS で、どの版も同じだった。
//
// mod からはトークンの出どころが分からない (トークンの値は読まない) ので、両方の名前を候補にする。
// 本体は、使っている経路の bucket を同期のたびに作って印を書くので、実在しない候補はこのセッションの
// bucket ではないとみなす。実在する候補が 2 つあって写しの有無が食い違えば、どちらを読み込むか
// 分からないので unknown にする。候補がどれも無いときや印が無いときも、本体の規則が変わった
// 可能性があるので absent にせず unknown にする (v2 の前の版は、規則の変化を黙って absent にしていた)。

/** 同期の置き場に置かれる、bucket の印のファイル名の頭 (`.bucket-<bucket の名前>`)。 */
export const BUCKET_MARKER_PREFIX = '.bucket-'

/** bucket の名前に使う uuid の形 (Claude Code と同じ。大文字小文字は問わない)。 */
const BUCKET_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** uuid の形の文字列ならそのまま、ほかは null。 */
function bucketUuid(value: unknown): string | null {
  return typeof value === 'string' && BUCKET_UUID.test(value) ? value : null
}

/** bucket の名前。アカウントが決まらなければ `<組織>_unbound`。 */
export function syncBucketName(org: string, account: string | null): string {
  return `${org.toLowerCase()}_${account?.toLowerCase() ?? 'unbound'}`
}

/** ログイン記録 (`.claude.json` の oauthAccount) のうち、bucket の名前に使う値。 */
export type LoginAccount = { organizationUuid?: unknown; accountUuid?: unknown }

/**
 * `.claude.json` の本文から、oauthAccount の組織とアカウントを読む。JSON の object でなければ
 * undefined (読めない)、oauthAccount が無ければ空 (ログインしていない)。
 */
export function loginAccountFromClaudeJson(text: string): LoginAccount | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const account = parsed.oauthAccount
  return isRecord(account) ? { organizationUuid: account.organizationUuid, accountUuid: account.accountUuid } : {}
}

/**
 * このセッションの bucket の名前の候補 (重複なし)。ログイン記録が読めなければ undefined、
 * 組織が決まらなければ空 (本体はどの bucket からも読み込まない)。
 *
 * @param login ログイン記録。ファイルが無ければ空、あるのに読めなければ undefined
 * @param env CLAUDE_CODE_ORGANIZATION_UUID と CLAUDE_CODE_ACCOUNT_UUID の値
 */
export function sessionBucketNames(
  login: LoginAccount | undefined,
  env: { organizationUuid: string | undefined; accountUuid: string | undefined },
): string[] | undefined {
  if (login === undefined) return undefined
  const org = bucketUuid(env.organizationUuid ?? login.organizationUuid)
  if (org === null) return []
  const names = new Set<string>()
  // ログインして保存したトークンを使うとき
  const account = bucketUuid(login.accountUuid)
  if (account !== null) names.add(syncBucketName(org, account))
  // ホストが渡したトークンを使うとき・OAuth トークンを使わないとき
  names.add(syncBucketName(org, bucketUuid(env.accountUuid)))
  return [...names]
}

/**
 * 同期の置き場の一覧と名前の候補から選んだ、このセッションの bucket。
 * - decided: 中を調べるまでもなく決まる (bucket が 1 つも無い、候補を決められない、候補が実在しない)
 * - found: 実在する候補 (1 つか 2 つ)。marked は印 (`.bucket-<名前>`) があるか
 */
export type SessionBuckets =
  | { kind: 'decided'; result: SyncedBucketResult }
  | { kind: 'found'; buckets: { name: string; marked: boolean }[] }

/** 同期の置き場の一覧と、このセッションの bucket の名前の候補 (sessionBucketNames) から選ぶ。 */
export function chooseSessionBuckets(
  entries: readonly { name: string; kind: string }[],
  candidates: readonly string[] | undefined,
): SessionBuckets {
  const buckets = new Set(
    entries.filter((entry) => entry.kind === 'dir' && !entry.name.startsWith('.')).map((entry) => entry.name),
  )
  // bucket が 1 つも無いのは、組織同期が届いていないということ
  if (buckets.size === 0) return { kind: 'decided', result: { kind: 'absent' } }
  if (candidates === undefined || candidates.length === 0) {
    return { kind: 'decided', result: { kind: 'unknown', error: 'bucket_unresolved' } }
  }
  const markers = new Set(
    entries
      .filter((entry) => entry.kind === 'file' && entry.name.startsWith(BUCKET_MARKER_PREFIX))
      .map((entry) => entry.name.slice(BUCKET_MARKER_PREFIX.length)),
  )
  const found = candidates.filter((name) => buckets.has(name)).map((name) => ({ name, marked: markers.has(name) }))
  // ほかの bucket しか無い (アカウントを切り替えた直後や、本体の名前の付け方が変わったとき)
  if (found.length === 0) return { kind: 'decided', result: { kind: 'unknown', error: 'bucket_mismatch' } }
  return { kind: 'found', buckets: found }
}

/** 印の無い bucket の結果。本体は読み込まないが、同期の途中や規則の変化でも起こるので absent にしない。 */
export const UNMARKED_BUCKET: SyncedBucketResult = { kind: 'unknown', error: 'bucket_mismatch' }

/**
 * このセッションの bucket の候補を調べた結果を 1 つにまとめる。unknown があればそれを、
 * 写しの有無が候補で食い違えば unknown (bucket_ambiguous) を、そろえばその結果を返す。
 * 版は、候補の写しの版がそろうときだけ返す。
 */
export function combineBucketResults(results: readonly SyncedBucketResult[]): SyncedBucketResult {
  const unknown = results.find((result) => result.kind === 'unknown')
  if (unknown !== undefined) return unknown
  const versions = results.flatMap((result) => (result.kind === 'present' ? [result.version] : []))
  if (versions.length === 0) return { kind: 'absent' }
  if (versions.length < results.length) return { kind: 'unknown', error: 'bucket_ambiguous' }
  return { kind: 'present', version: new Set(versions).size === 1 ? versions[0] : undefined }
}

/**
 * 調べた結果を payload のフィールドにする。absent と unknown を混ぜない (調べられなかったものを
 * 「届いていない」と数えないため)。count は、このセッションの bucket に写しがあれば 1、無ければ 0。
 */
export function syncedCopyFields(result: SyncedBucketResult): JsonObject {
  return {
    synced_copy: result.kind,
    synced_copy_count: result.kind === 'present' ? 1 : result.kind === 'absent' ? 0 : null,
    synced_copy_version: result.kind === 'present' ? (result.version ?? null) : null,
    synced_probe_error: result.kind === 'unknown' ? result.error : null,
  }
}
