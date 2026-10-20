// 送信元の識別情報のうち、文字列だけで決まる部分。解決の順序 (resolveEmail など) は register.ts にある。

/** `.claude.json` の `oauthAccount.emailAddress`。壊れた JSON・キー不在・空文字は undefined。 */
export function emailFromClaudeJson(text: string): string | undefined {
  try {
    const email = JSON.parse(text)?.oauthAccount?.emailAddress
    return typeof email === 'string' && email.trim() ? email.trim() : undefined
  } catch {
    return undefined
  }
}
