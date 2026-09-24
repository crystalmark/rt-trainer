// The security headers the app is served with. deploy/rt-headers.json is the response headers policy CloudFront adds to
// /rt* (deploy/cloudfront.sh puts it there), and the local server sends the same, bar HSTS. The rest of the page's
// policy is the CSP meta tag in index.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const policy = JSON.parse(read('deploy/rt-headers.json'));
const security = policy.SecurityHeadersConfig;
const permissions = policy.CustomHeadersConfig.Items.find(h => h.Header === 'Permissions-Policy').Value;
const allowed = Object.fromEntries(permissions.split(',').map(d => d.trim().split('=')));   // { microphone: '(self)', … }
const code = [read('sw.js'), ...readdirSync(new URL('../js/', import.meta.url), { recursive: true })
  .filter(f => f.endsWith('.js')).map(f => read(`js/${f}`))].join('\n');

// What each browser feature is called in a Permissions-Policy, and how the app would be using it.
const FEATURES = {
  microphone: /getUserMedia|SpeechRecognition/,
  'screen-wake-lock': /\bwakeLock\b/,
  camera: /\bvideo\s*:/,
  geolocation: /\bgeolocation\b/,
};

// A feature the app uses and the policy leaves out works on this machine, and fails on the live site.
test('every browser feature the app uses is allowed to it, and the ones it does not use are not', () => {
  for (const [feature, used] of Object.entries(FEATURES)) {
    assert.ok(feature in allowed, `${feature} is not in the Permissions-Policy`);
    if (used.test(code)) assert.equal(allowed[feature], '(self)', `the app uses ${feature}: allow it with ${feature}=(self)`);
    else assert.equal(allowed[feature], '()', `the app does not use ${feature}: deny it with ${feature}=()`);
  }
});

// A <meta> CSP can't say who may frame the page, so the header says that and nothing more. A second whole policy there
// would have to be kept in step with the meta tag, and on sw.js it would govern the service worker's own fetches.
test('the header CSP only forbids framing; the page’s policy is the meta tag', () => {
  assert.equal(security.ContentSecurityPolicy.ContentSecurityPolicy, "frame-ancestors 'none'");
  assert.equal(security.FrameOptions.FrameOption, 'DENY');
  assert.match(read('index.html'), /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
});

// HSTS covers the whole host, whichever path sends it, and a browser keeps the last max-age it was given. Flight Log sends
// a year: anything shorter here would cut it short for everyone who opens RT Trainer.
test('HSTS matches Flight Log’s year, for this host only', () => {
  const hsts = security.StrictTransportSecurity;
  assert.equal(hsts.AccessControlMaxAgeSec, 31536000);
  assert.equal(hsts.IncludeSubdomains, false, 'not every subdomain is known to serve HTTPS');
  assert.equal(hsts.Preload, false);
});

test('the policy is in the shape CloudFront takes', () => {
  assert.match(policy.Name, /^[\w-]{1,128}$/);
  assert.ok(policy.Comment.length <= 128);
  assert.equal(policy.CustomHeadersConfig.Quantity, policy.CustomHeadersConfig.Items.length);
  for (const item of Object.values(security)) assert.equal(item.Override, true, 'the origin never decides these');
});
