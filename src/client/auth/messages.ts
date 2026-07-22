export function formatAuthSourceError(authSources: Array<string | undefined>): string {
  const sources = authSources.filter((source): source is string => Boolean(source));
  const joined = sources.join(', ');
  const hasUseAuth = sources.includes('use_auth');
  const hasRefresh =
    sources.includes('refresh_token') || sources.includes('refresh_token_path');
  const base = `Specify only one auth source: ${joined}.`;
  if (hasUseAuth && hasRefresh) {
    return (
      base +
      ' use_auth uses cached tokens; refresh_token* refreshes in-memory. Remove use_auth when using refresh_token*.'
    );
  }
  return (
    base +
    ' Choose one: use_auth (cached), access_token/access_token_path, or refresh_token/refresh_token_path.'
  );
}
