// CloudFront Function (viewer request) on the /rt* behaviour of the crystalmark.co.uk distribution; deploy/cloudfront.sh
// publishes it. The S3 origin has no index documents, so /rt/ becomes /rt/index.html, and /rt gets the trailing slash
// the app's relative paths need.
function handler(event) {
  var request = event.request;
  if (request.uri === '/rt') {
    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: '/rt/' } } };
  }
  if (request.uri.charAt(request.uri.length - 1) === '/') request.uri += 'index.html';
  return request;
}
