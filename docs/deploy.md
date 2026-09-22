# Deploying to crystalmark.co.uk

The app is static: copy the repository contents (minus `tests/`, `docs/`, `package.json`) to any
HTTPS web root. Nothing needs building.

## Requirements
- **HTTPS**: browsers only allow the microphone on secure origins.
- **Content-Security-Policy** (if the site sets one) must allow:
  - `connect-src https://api.anthropic.com` (Claude fallback and debrief)
  - `style-src https://fonts.googleapis.com` and `font-src https://fonts.gstatic.com`
  - `worker-src 'self'` (offline service worker)
- **Permissions-Policy**: don't block `microphone=(self)` or `screen-wake-lock=(self)`.

## Options
1. **Subfolder** `https://crystalmark.co.uk/rt/`: simplest if the site already serves static files.
2. **Subdomain** `https://rt.crystalmark.co.uk`: keeps it separate from the other web apps; works
   well with GitHub Pages, Cloudflare Pages or Netlify (a CNAME record to the host).

## Suggested consolidation (for Claude Code)
When the other crystalmark web apps join this repo, a layout like this keeps them independent:

```
crystalmark-web/
  apps/
    rt-trainer/        <- this repo's contents
    <other-app>/
  deploy/              <- one deploy script / CI workflow that publishes apps/* to their paths
```

A GitHub Actions workflow can run `npm test` in `apps/rt-trainer` and then publish `apps/*` to the
host (rsync/SFTP to the current server, or a Pages deployment).

## Optional: key proxy
To stop keeping the Anthropic key in the browser, add a tiny server-side endpoint on
crystalmark.co.uk (e.g. `/rt/api/claude`) that adds the key and forwards to
`https://api.anthropic.com/v1/messages`, then point `js/claude.js` at it and drop the
`anthropic-dangerous-direct-browser-access` header. Protect it (basic auth or a shared secret)
so it isn't an open relay.
