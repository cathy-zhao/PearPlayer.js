module.exports = Server

var arrayRemove = require('unordered-array-remove')
var http = require('http')
var mime = require('mime')
var pump = require('pump')
var rangeParser = require('range-parser')
var url = require('url')

function Server (torrent, opts) {
  var server = http.createServer()
  if (!opts) opts = {}
  if (!opts.origin) opts.origin = '*' // allow all origins by default

  var sockets = []
  var pendingReady = []
  var closed = false

  server.on('connection', onConnection)
  server.on('request', onRequest)

  var _close = server.close
  server.close = function (cb) {
    closed = true
    server.removeListener('connection', onConnection)
    server.removeListener('request', onRequest)
    while (pendingReady.length) {
      var onReady = pendingReady.pop()
      torrent.removeListener('ready', onReady)
    }
    torrent = null
    _close.call(server, cb)
  }

  server.destroy = function (cb) {
    sockets.forEach(function (socket) {
      socket.destroy()
    })

    // Only call `server.close` if user has not called it already
    if (!cb) cb = function () {}
    if (closed) process.nextTick(cb)
    else server.close(cb)
  }

  function isOriginAllowed (req) {
    // When `origin` option is `false`, deny all cross-origin requests
    if (opts.origin === false) return false

    // Requests without an 'Origin' header are not actually cross-origin, so just
    // deny them
    if (req.headers.origin == null) return false

    // The user allowed all origins
    if (opts.origin === '*') return true

    // Allow requests where the 'Origin' header matches the `opts.origin` setting
    return req.headers.origin === opts.origin
  }

  function onConnection (socket) {
    socket.setTimeout(36000000)
    sockets.push(socket)
    socket.once('close', function () {
      arrayRemove(sockets, sockets.indexOf(socket))
    })
  }

  function onRequest (req, res) {
    var pathname = url.parse(req.url).pathname

    if (pathname === '/favicon.ico') {
      return serve404Page()
    }

    // Allow cross-origin requests (CORS)
    if (isOriginAllowed(req)) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
    }

    // Prevent browser mime-type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff')

    // Allow CORS requests to specify arbitrary headers, e.g. 'Range',
    // by responding to the OPTIONS preflight request with the specified
    // origin and requested headers.
    if (req.method === 'OPTIONS') {
      if (isOriginAllowed(req)) return serveOptionsRequest()
      else return serveMethodNotAllowed()
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (torrent.ready) {
        handleRequest()
      } else {
        pendingReady.push(onReady)
        torrent.once('ready', onReady)
      }
      return
    }

    return serveMethodNotAllowed()

    function serveOptionsRequest () {
      res.statusCode = 204 // no content
      res.setHeader('Access-Control-Max-Age', '600')
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE')

      if (req.headers['access-control-request-headers']) {
        res.setHeader(
          'Access-Control-Allow-Headers',
          req.headers['access-control-request-headers']
        )
      }
      res.end()
    }

    function onReady () {
      arrayRemove(pendingReady, pendingReady.indexOf(onReady))
      handleRequest()
    }

    function handleRequest () {
      if (pathname === '/') {
        return serveIndexPage()
      }

      var index = Number(pathname.split('/')[1])
      if (Number.isNaN(index) || index >= torrent.files.length) {
        return serve404Page()
      }

      var file = torrent.files[index]
      serveFile(file)
    }

    function serveIndexPage () {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html')

      var listHtml = torrent.files.map(function (file, i) {
        return '<li><a download="' + file.name + '" href="/' + i + '/' + file.name + '">' + file.path + '</a> ' +
          '(' + file.length + ' bytes)</li>'
      }).join('<br>')

      var html = getPageHTML(
        torrent.name + ' - WebTorrent',
        '<h1>' + torrent.name + '</h1><ol>' + listHtml + '</ol>'
      )
      res.end(html)
    }

    function serve404Page () {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/html')

      var html = getPageHTML('404 - Not Found', '<h1>404 - Not Found</h1>')
      res.end(html)
    }

    function serveFile (file) {
      res.statusCode = 200
      res.setHeader('Content-Type', mime.lookup(file.name))

      // Support range-requests
      res.setHeader('Accept-Ranges', 'bytes')

      // Set name of file (for "Save Page As..." dialog)
      res.setHeader(
        'Content-Disposition',
        'inline; filename*=UTF-8\'\'' + encodeRFC5987(file.name)
      )

      // Support DLNA streaming
      res.setHeader('transferMode.dlna.org', 'Streaming')
      res.setHeader(
        'contentFeatures.dlna.org',
        'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000'
      )

      // `rangeParser` returns an array of ranges, or an error code (number) if
      // there was an error parsing the range.
      var range = rangeParser(file.length, req.headers.range || '')

      if (Array.isArray(range)) {
        res.statusCode = 206 // indicates that range-request was understood

        // no support for multi-range request, just use the first range
        range = range[0]

        res.setHeader(
          'Content-Range',
          'bytes ' + range.start + '-' + range.end + '/' + file.length
        )
        res.setHeader('Content-Length', range.end - range.start + 1)
      } else {
        range = null
        res.setHeader('Content-Length', file.length)
      }

      if (req.method === 'HEAD') {
        return res.end()
      }

      pump(file.createReadStream(range), res)
    }

    function serveMethodNotAllowed () {
      res.statusCode = 405
      res.setHeader('Content-Type', 'text/html')
      var html = getPageHTML('405 - Method Not Allowed', '<h1>405 - Method Not Allowed</h1>')
      res.end(html)
    }
  }

  return server
}

function getPageHTML (title, pageHtml) {
  return '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<title>' + title + '</title>' +
    '</head><body>' + pageHtml + '</body></html>'
}

// From https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent
function encodeRFC5987 (str) {
  return encodeURIComponent(str)
    // Note that although RFC3986 reserves "!", RFC5987 does not,
    // so we do not need to escape it
    .replace(/['()]/g, escape) // i.e., %27 %28 %29
    .replace(/\*/g, '%2A')
    // The following are not required for percent-encoding per RFC5987,
    // so we can allow for a little better readability over the wire: |`^
    .replace(/%(?:7C|60|5E)/g, unescape)
}
