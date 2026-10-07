const TOKEN_FIELD = /("token"\s*:\s*")[^"]*(")/g

/** Replaces the exact token wherever it appears. Safe on JSON: it never touches other characters. */
export function redactToken(text: string, token?: string): string {
  if (!token || token.length < 4) return text
  return text.split(token).join('***')
}

/**
 * Removes the configured token, and any `"token": "..."` field, from a
 * response body. openGym hands out tokens in bodies (`/api/pair/redeem`, a
 * renewed one on `/api/me`); none of them may reach a log line or tool output.
 */
export function redactBody(text: string, token?: string): string {
  return redactToken(text, token).replace(TOKEN_FIELD, '$1***$2')
}
