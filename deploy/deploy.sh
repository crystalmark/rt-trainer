#!/usr/bin/env bash
# Deploy RT Trainer to https://crystalmark.co.uk/rt/. The app is static: it goes to the site's S3 bucket under rt/ and
# CloudFront serves it through the /rt* behaviour (deploy/cloudfront.sh sets that up once). Nothing runs on the
# Lightsail host, so Flight Log, Pollyglot and the WordPress sites there are untouched.
#   deploy/deploy.sh            run the tests, sync the app to s3://crystalmark.co.uk/rt/, invalidate /rt/*
#   deploy/deploy.sh --dryrun   list what would change and stop
set -euo pipefail
cd "$(dirname "$0")/.."
BUCKET=${BUCKET:-crystalmark.co.uk}
PREFIX=rt   # the sync below deletes, so it must never run at the bucket root: the main site lives there
DIST=${DIST:-EZS3KVTVPEGYG}
SITE=https://crystalmark.co.uk/$PREFIX/
DRY=; [ "${1:-}" = --dryrun ] && DRY=--dryrun

npm test > /dev/null 2>&1 || { echo "Tests failed: run npm test"; exit 1; }
# Only the app goes up: no tests, docs, notes or reference material. Copied without timestamps so every file is
# uploaded (it's ~150 KB) and nothing stale survives.
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
cp -R index.html sw.js manifest.webmanifest css js icons "$STAGE/"
find "$STAGE" -name .DS_Store -delete
# no-cache: browsers and CloudFront revalidate on every load (cheap 304s), so a deploy shows up straight away
aws s3 sync "$STAGE/" "s3://$BUCKET/${PREFIX:?}/" --delete --no-progress --cache-control no-cache --exclude manifest.webmanifest $DRY
aws s3 cp "$STAGE/manifest.webmanifest" "s3://$BUCKET/$PREFIX/manifest.webmanifest" --no-progress --cache-control no-cache --content-type application/manifest+json $DRY
[ -z "$DRY" ] || exit 0
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/$PREFIX" "/$PREFIX/*" --query 'Invalidation.Id' --output text > /dev/null
if curl -fsS --max-time 10 -o /dev/null "$SITE"; then echo "Deployed → $SITE"
else echo "Uploaded, but $SITE does not answer: has deploy/cloudfront.sh run?"; exit 1; fi
