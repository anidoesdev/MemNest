import { describe, expect, it } from 'vitest';
import { defaultRedactor, redactContent, redactMetadata } from '../src/index';
import { CREDENTIAL_FIXTURES, credentialTranscript } from '../src/testing/index';

const redact = (s: string) => defaultRedactor.redact(s);

describe('defaultRedactor', () => {
  it.each([
    ['sk- keys', 'use sk-ant-api03-abcdefghijklmnopqrstuv now', 'sk-ant-api03'],
    ['bearer tokens', 'Authorization: Bearer abc.def-ghi_jkl1234567', 'abc.def-ghi_jkl1234567'],
    ['AWS access key ids', 'id AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
    ['JWTs', `token ${CREDENTIAL_FIXTURES[3]}`, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
    ['env assignments', 'STRIPE_SECRET=whsec_123abc', 'whsec_123abc'],
    ['JSON keys', '{"clientSecret": "abc 123", "name": "x"}', 'abc 123'],
    ['YAML keys', 'db:\n  password: p4ss w0rd\n  host: localhost', 'p4ss w0rd'],
    ['credential keys', 'gcp_credentials = {base64stuff}', 'base64stuff'],
    ['auth keys', 'AUTH_HEADER: xyz987', 'xyz987'],
    ['spoken passwords', 'my password is hunter2', 'hunter2'],
  ])('redacts %s', (_label, input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED');
  });

  it('keeps ordinary key-value text intact', () => {
    const input = 'author: Jane Doe\nhost: localhost\nkeywords: memory, graphs\nSee https://example.com/a';
    expect(redact(input)).toBe(input);
  });

  it('keeps the non-secret parts of a line', () => {
    expect(redact('name: alex, token: abc123, role: pm')).toBe('name: alex, token: [REDACTED], role: pm');
  });

  it('removes every fixture from the credential transcript', () => {
    const out = JSON.stringify(redactContent(credentialTranscript(), defaultRedactor));
    for (const fixture of CREDENTIAL_FIXTURES) expect(out).not.toContain(fixture);
    expect(out).toContain('I prefer Postgres over MongoDB');
  });

  it('redacts metadata by key and by value', () => {
    expect(
      redactMetadata({ apiToken: 'plain', note: 'key=sk-live-abcdefghijklmnopqr', count: 3 }, defaultRedactor),
    ).toEqual({ apiToken: '[REDACTED]', note: 'key=[REDACTED:secret-key]', count: 3 });
  });
});
