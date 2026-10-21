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

/** 観測のしかたの版。フィールドの意味を変えたら上げる (プラグインの版とは別)。 */
export const DELIVERY_OBSERVATION_VERSION = 1

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
}

/**
 * プラグインのディレクトリの形から、どこから読み込まれたかを決める。
 * - 組織同期: `<設定ディレクトリ>/plugins/synced/<bucket>/<plugin>`
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
    if (kind === 'synced' && segments.length === k + 4) return { route: 'synced', configDir }
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

/** plugin.json の version。読めない・形がおかしいときは undefined。 */
export function manifestVersion(text: string): string | undefined {
  try {
    const version = JSON.parse(text)?.version
    return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}

/** 組織同期の写しを調べられなかった理由。生のエラー文やパスは送らない。 */
export type SyncedProbeError = 'io_error' | 'limit_exceeded' | 'unrecognized_root'

/** 組織同期の写しを探した結果。complete は最後まで調べられたか。 */
export type SyncedScan = {
  found: number
  versions: (string | undefined)[]
  complete: boolean
  error?: SyncedProbeError
}

/**
 * 探した結果を payload のフィールドにする。
 * 写しが 1 つでもあれば present、最後まで調べて無ければ absent、調べきれなければ unknown。
 * absent と unknown を混ぜない (調べられなかったものを「届いていない」と数えないため)。
 */
export function syncedCopyFields(scan: SyncedScan): JsonObject {
  const versions = new Set(scan.versions)
  const versionKnown = scan.complete && scan.found > 0 && !versions.has(undefined) && versions.size === 1
  return {
    synced_copy: scan.found > 0 ? 'present' : scan.complete ? 'absent' : 'unknown',
    synced_copy_count: scan.complete || scan.found > 0 ? scan.found : null,
    synced_copy_version: versionKnown ? ([...versions][0] ?? null) : null,
    synced_probe_error: scan.error ?? null,
  }
}
