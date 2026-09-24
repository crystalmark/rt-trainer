#!/usr/bin/env bash
# One-off (safe to re-run): serve https://crystalmark.co.uk/rt/ from the site's S3 bucket. Publishes the CloudFront
# Function in deploy/rt-index.js (tested on CloudFront first), creates or updates the response headers policy in
# deploy/rt-headers.json, and adds a /rt* behaviour that uses both. The behaviour is otherwise a copy of the default one,
# so /rt is cached like the rest of the static site; other behaviours and origins, and the Lightsail host, are left alone.
#   deploy/cloudfront.sh            function, headers policy, behaviour; wait for it to deploy and check the headers
#   deploy/cloudfront.sh --remove   take the /rt* behaviour out again (the function, the policy and the S3 files stay)
set -euo pipefail
cd "$(dirname "$0")"
DIST=${RT_DIST:-EZS3KVTVPEGYG}   # RT_DIST only: a DIST left in the shell by another project would have been changed
FN=rt-trainer-index
POLICY=$(jq -r .Name rt-headers.json)
PATTERN='/rt*'
SITE=https://crystalmark.co.uk/rt/
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT   # the distribution config carries the other apps' origin secrets

update_distribution() { # update_distribution [jq options] FILTER: apply a jq filter to the live distribution config
  aws cloudfront get-distribution-config --id "$DIST" --output json > "$TMP/dist.json"
  jq "$@" "$TMP/dist.json" > "$TMP/new.json"
  aws cloudfront update-distribution --id "$DIST" --if-match "$(jq -r .ETag "$TMP/dist.json")" \
    --distribution-config "file://$TMP/new.json" --query 'Distribution.Status' --output text
}

if [ "${1:-}" = --remove ]; then
  update_distribution --arg p "$PATTERN" '.DistributionConfig
    | .CacheBehaviors.Items = [.CacheBehaviors.Items[] | select(.PathPattern != $p)]
    | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length)'
  echo "Behaviour $PATTERN removed; the distribution takes a few minutes to deploy. To delete the function afterwards:"
  echo "  aws cloudfront delete-function --name $FN --if-match \$(aws cloudfront describe-function --name $FN --query ETag --output text)"
  echo "and the response headers policy $POLICY: aws cloudfront delete-response-headers-policy --id <its id> --if-match <its ETag>"
  exit 0
fi

# 1. The function: create or update the development stage, check it on CloudFront's runtime, then publish it
CONFIG='{"Comment":"RT Trainer: /rt to /rt/, directory paths to index.html","Runtime":"cloudfront-js-2.0"}'
if aws cloudfront describe-function --name "$FN" --stage DEVELOPMENT --output json > "$TMP/fn.json" 2> /dev/null; then
  ETAG=$(aws cloudfront update-function --name "$FN" --if-match "$(jq -r .ETag "$TMP/fn.json")" \
    --function-config "$CONFIG" --function-code fileb://rt-index.js --query ETag --output text)
else
  ETAG=$(aws cloudfront create-function --name "$FN" --function-config "$CONFIG" --function-code fileb://rt-index.js --query ETag --output text)
fi
check() { # check URI JQ_TEST: run the development stage on a viewer request for URI; JQ_TEST judges its output
  jq -n --arg uri "$1" '{version:"1.0",context:{eventType:"viewer-request"},viewer:{ip:"198.51.100.1"},
    request:{method:"GET",uri:$uri,querystring:{},headers:{},cookies:{}}}' > "$TMP/event.json"
  aws cloudfront test-function --name "$FN" --if-match "$ETAG" --stage DEVELOPMENT --event-object "fileb://$TMP/event.json" \
    --query TestResult --output json > "$TMP/result.json"
  jq -e ".FunctionOutput | fromjson | $2" "$TMP/result.json" > /dev/null || { echo "Function test failed for $1:"; jq . "$TMP/result.json"; exit 1; }
}
check /rt '.response.statusCode == 301 and .response.headers.location.value == "/rt/"'
check /rt/ '.request.uri == "/rt/index.html"'
check /rt/js/main.js '.request.uri == "/rt/js/main.js"'
aws cloudfront publish-function --name "$FN" --if-match "$ETAG" > /dev/null
ARN=$(aws cloudfront describe-function --name "$FN" --stage LIVE --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)
echo "Function $FN tested and published"

# 2. The security headers (deploy/rt-headers.json): created, or brought up to date if the policy is there already
RH=$(aws cloudfront list-response-headers-policies --type custom --output json | jq -r --arg n "$POLICY" \
  '[.ResponseHeadersPolicyList.Items[]?.ResponseHeadersPolicy | select(.ResponseHeadersPolicyConfig.Name == $n) | .Id][0] // empty')
if [ -n "$RH" ]; then
  aws cloudfront update-response-headers-policy --id "$RH" --if-match "$(aws cloudfront get-response-headers-policy --id "$RH" --query ETag --output text)" \
    --response-headers-policy-config file://rt-headers.json > /dev/null
else
  RH=$(aws cloudfront create-response-headers-policy --response-headers-policy-config file://rt-headers.json --query ResponseHeadersPolicy.Id --output text)
fi
echo "Response headers policy $POLICY ($RH) up to date"

# 3. The behaviour: a copy of the default (S3) behaviour for /rt*, plus the function and the headers. A policy of the
# default's own would be replaced by ours, and /rt would quietly lose whatever it added: stop and say so instead.
update_distribution --arg p "$PATTERN" --arg fn "$ARN" --arg rh "$RH" '.DistributionConfig
  | .DefaultCacheBehavior as $d
  | if ($d.TargetOriginId | contains(".s3.")) then . else error("the default behaviour no longer points at the S3 bucket") end
  | if ($d.ResponseHeadersPolicyId // "") == "" then . else error("the default behaviour has a response headers policy of its own: add what it sends to rt-headers.json first") end
  | .CacheBehaviors.Items = ([(.CacheBehaviors.Items // [])[] | select(.PathPattern != $p)]
      + [$d + {PathPattern: $p, ResponseHeadersPolicyId: $rh, FunctionAssociations: {Quantity: 1, Items: [{FunctionARN: $fn, EventType: "viewer-request"}]}}])
  | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length)'
echo "Behaviour $PATTERN added; waiting for the distribution to deploy (usually a few minutes)"
aws cloudfront wait distribution-deployed --id "$DIST"
if curl -fs --max-time 10 -o /dev/null "$SITE"; then
  echo "Live: $SITE"
  SENT=$(curl -fsI --max-time 10 "$SITE" | tr -d '\r' | tr '[:upper:]' '[:lower:]') || true
  for h in strict-transport-security x-content-type-options x-frame-options referrer-policy content-security-policy permissions-policy; do
    grep -q "^$h:" <<< "$SENT" || echo "Warning: $SITE came back without $h"
  done
else echo "Distribution deployed; $SITE has no files yet: run deploy/deploy.sh"; fi
