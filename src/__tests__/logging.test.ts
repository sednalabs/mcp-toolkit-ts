import { describe, expect, it } from 'vitest';
import { redactString } from '../logging.js';

describe('redactString', () => {
  it('redacts bearer tokens, key-value secrets, and connection strings', () => {
    const syntheticGithubToken = ['gh', 'p_', 'a'.repeat(36)].join('');
    const input = `authorization: bearer abc.def github_pat=${syntheticGithubToken} api_key=key postgresql://user:pass@host/db`;
    const output = redactString(input);

    expect(output).not.toContain('abc.def');
    expect(output).toContain('authorization: Bearer REDACTED');
    expect(output).not.toContain(syntheticGithubToken);
    expect(output).toContain('github_pat=REDACTED');
    expect(output).toContain('api_key=REDACTED');
    expect(output).toContain('postgresql://REDACTED');
  });

  it('redacts bare bearer tokens and access tokens', () => {
    const input = 'Bearer secret-token access_token=topsecret';
    const output = redactString(input);

    expect(output).not.toContain('secret-token');
    expect(output).toContain('Bearer REDACTED');
    expect(output).toContain('access_token=REDACTED');
  });
});
