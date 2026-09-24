# Deploying to crystalmark.co.uk/rt

The app is served at `https://crystalmark.co.uk/rt/`. It's static, so nothing is built and nothing runs on a server.

## How crystalmark.co.uk is put together
- One CloudFront distribution (`EZS3KVTVPEGYG`) serves the whole domain.
- Its default behaviour serves the static site from the S3 bucket `crystalmark.co.uk` (eu-west-2).
- `/flightlog*`, `/.well-known/oauth-*`, `/.well-known/openid-configuration*` and `/pollyglot*` go to Node services on
  the Lightsail box `wordpress-shared` (eu-west-1, 54.220.197.149), which also runs the WordPress sites.

RT Trainer lives in the S3 bucket under `rt/`, behind its own `/rt*` behaviour, and adds nothing to the Lightsail box.
When this was set up (2026-09-22) the box was a 1 GB micro instance with ~370 MB free and already using swap, so it's
kept for things that need a server.

## Deploy
```sh
deploy/deploy.sh            # tests, sync the app to s3://crystalmark.co.uk/rt/, invalidate /rt/*
deploy/deploy.sh --dryrun   # list what would change
```
Only the app goes up (`index.html`, `sw.js`, `manifest.webmanifest`, `css/`, `js/`, `icons/`), all with
`Cache-Control: no-cache`, so browsers revalidate and a deploy shows up on the next load. Needs the AWS CLI signed in
to the AWS account that hosts crystalmark.co.uk.

## One-off CloudFront setup
```sh
deploy/cloudfront.sh            # publish the rewrite function and the headers policy, add the /rt* behaviour, wait, check
deploy/cloudfront.sh --remove   # rollback: take the /rt* behaviour out again
```
The S3 origin has no index documents, so the CloudFront Function `rt-trainer-index` (`deploy/rt-index.js`) sends `/rt`
to `/rt/` and serves `/rt/` as `/rt/index.html`. The script tests it on CloudFront before publishing. The `/rt*`
behaviour is a copy of the default one plus that function and the response headers policy below; nothing else on the
distribution changes. If the default behaviour ever gets a headers policy of its own, the script stops before changing
anything, as `/rt*` would lose it. Safe to re-run: it's also how a change to the headers goes live.

## Sharing an origin with Flight Log and Pollyglot
Every app on `https://crystalmark.co.uk` shares one browser origin, so:
- **Service-worker caches** belong to the origin, not the worker's scope. Name them `rt-trainer-…` and only ever delete
  caches with that prefix (`tests/sw.test.mjs` checks it). Flight Log and Pollyglot do the same with their prefixes.
- **localStorage** is shared too: keep every key under `rt.` (the `store` helper in `js/main.js`).
- The Claude API key (`rt.o-key`) is readable by any page on the origin. Acceptable while they're all our own apps;
  the key proxy below takes it out of the browser.

## Requirements
- **HTTPS**: browsers only allow the microphone on secure origins.

## Security headers
- The page's Content-Security-Policy is the `<meta>` tag in `index.html`: scripts, styles and the service worker from
  this origin, fonts from Google, and connections only to `https://api.anthropic.com` (the Claude fallback and debrief).
- What a `<meta>` tag can't do comes from the CloudFront response headers policy `rt-trainer-headers`
  (`deploy/rt-headers.json`, attached to `/rt*` by `deploy/cloudfront.sh`): HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` with `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, and a Permissions-Policy that
  allows the microphone and the screen wake lock and denies the camera and geolocation. Flight Log and Pollyglot send
  much the same from their own servers.
- HSTS covers the whole host, whichever path sends it, and a browser keeps the last `max-age` it was given. Flight Log
  sends a year, so `/rt` does too: anything shorter would cut Flight Log's short. `includeSubDomains` is left off.
- `npm run serve` sends the same headers, all but HSTS, so a feature the policy leaves out fails locally first, and
  `tests/headers.test.mjs` fails if the app starts using one the policy doesn't allow. To change them, edit
  `deploy/rt-headers.json` and re-run `deploy/cloudfront.sh`.

## Optional: key proxy
To stop keeping the Anthropic key in the browser, add a tiny server-side endpoint (e.g. `/rt/api/claude`) that adds
the key and forwards to `https://api.anthropic.com/v1/messages`, then point `js/claude.js` at it and drop the
`anthropic-dangerous-direct-browser-access` header. Protect it (basic auth or a shared secret) so it isn't an open
relay. A Lambda function URL behind a `/rt/api/*` behaviour keeps it off the Lightsail box; a small service beside
Flight Log and Pollyglot works too, but mind the box's memory.

## Suggested consolidation (for Claude Code)
When the other crystalmark web apps join this repo, a layout like this keeps them independent:

```
crystalmark-web/
  apps/
    rt-trainer/        <- this repo's contents
    <other-app>/
  deploy/              <- one deploy script / CI workflow that publishes apps/* to their paths
```

A GitHub Actions workflow can run `npm test` in `apps/rt-trainer` and then publish `apps/*` to their hosts.
