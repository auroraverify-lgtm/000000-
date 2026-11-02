import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, extractDomains, extractUrls, inspectMessage, inspectOutboundContent, normalizeUrl } from '../security/policy.js';

test('URL extraction returns normalized destinations without duplicating links', () => {
  const links = extractUrls('Open https://Example.com/path?token=secret#section and https://example.com/path?token=secret#other.');
  assert.equal(links.length, 1);
  assert.equal(links[0].domain, 'example.com');
  assert.equal(new URL(links[0].url).hash, '');
});

test('unsupported and malformed URL schemes are ignored', () => {
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('outgoing policy checks bare domains and whole forbidden phrases', () => {
  const rules = [{
    id: 8,
    name: 'Blocked phrase',
    category: 'keyword',
    enabled: 1,
    rule_json: JSON.stringify({ terms: ['forbidden phrase'] }),
  }];
  const content = inspectOutboundContent(
    'FORBIDDEN   phrase at blocked.example.test/path',
    rules,
    [{ domain: 'example.test', status: 'blocked' }],
  );
  assert.deepEqual(content.blockedDomains, ['blocked.example.test']);
  assert.deepEqual(content.blockedRules, [{ id: 8, name: 'Blocked phrase' }]);
  assert.equal(inspectOutboundContent('unforbidden phraseology', rules).blockedRules.length, 0);
});

test('direct-message URL checks reduce links to domains before sending them to Security', () => {
  const domains = extractDomains('https://example.com/private/path?token=must-not-leak#fragment');
  assert.deepEqual(domains, ['example.com']);
  assert.equal(JSON.stringify(domains).includes('private'), false);
  assert.equal(JSON.stringify(domains).includes('token'), false);
});

test('a configured blocked parent domain applies to subdomains', () => {
  const parsed = normalizeUrl('https://login.example.test/account');
  const verdict = classifyUrl(parsed, [{ domain: 'example.test', status: 'blocked', reason: 'Known phishing' }]);
  assert.equal(verdict.status, 'blocked');
  assert.equal(verdict.threat, 'owner_blocklist');
});

test('direct-message inspection returns links only and never message findings', () => {
  const result = inspectMessage('Please review https://example.com/profile?private=value', 'dm');
  assert.equal(result.findings.length, 0);
  assert.equal(result.urls.length, 1);
  assert.equal(result.urls[0].domain, 'example.com');
});

test('group moderation flags suspicious destinations and repeated link spam', () => {
  const text = 'https://127.0.0.1/a '.repeat(4);
  const result = inspectMessage(text, 'group');
  assert.ok(result.findings.some((item) => item.category === 'phishing'));
  assert.ok(result.findings.some((item) => item.category === 'spam'));
});

test('owner keyword rules create a policy finding only in group contexts', () => {
  const rules = [{
    name: 'No promotional phrase',
    category: 'keyword',
    enabled: 1,
    rule_json: JSON.stringify({ terms: ['buy now'] }),
  }];
  assert.equal(inspectMessage('buy now', 'dm', rules).findings.length, 0);
  assert.ok(inspectMessage('buy now', 'channel', rules).findings.some((item) => item.category === 'policy'));
});
