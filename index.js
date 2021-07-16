const resolveDatPath = require('resolve-dat-path')
const Headers = require('fetch-headers')
const mime = require('mime/lite')
const SDK = require('hyper-sdk')
const parseRange = require('range-parser')
const makeDir = require('make-dir')
const { Readable } = require('streamx')
const makeFetch = require('make-fetch')

const DEFAULT_TIMEOUT = 5000

const NUMBER_REGEX = /^\d+$/
const PROTOCOL_REGEX = /^\w+:\/\//
const NOT_WRITABLE_ERROR = 'Archive not writable'

const READABLE_ALLOW = ['GET', 'HEAD']
const WRITABLE_ALLOW = ['PUT', 'DELETE']
const ALL_ALLOW = READABLE_ALLOW.concat(WRITABLE_ALLOW)

const SPECIAL_FOLDER = '/$/'
const TAGS_FOLDER = `${SPECIAL_FOLDER}tags/`

// TODO: Add caching support
const { resolveURL: DEFAULT_RESOLVE_URL } = require('hyper-dns')

module.exports = function makeHyperFetch (opts = {}) {
  let {
    Hyperdrive,
    resolveURL = DEFAULT_RESOLVE_URL,
    base,
    timeout = DEFAULT_TIMEOUT,
    writable = false
  } = opts

  let sdk = null
  let gettingSDK = null
  let onClose = async () => undefined

  const isSourceDat = base && base.startsWith('hyper://')

  const fetch = makeFetch(hyperFetch)

  fetch.close = () => onClose()

  return fetch

  async function hyperFetch ({ url, headers: rawHeaders, method, signal, body }) {
    const isDatURL = url.startsWith('hyper://')
    const urlHasProtocol = url.match(PROTOCOL_REGEX)

    const shouldIntercept = isDatURL || (!urlHasProtocol && isSourceDat)

    if (!shouldIntercept) throw new Error('Invalid protocol, must be hyper://')

    const headers = new Headers(rawHeaders || {})

    const responseHeaders = {}
    responseHeaders['Access-Control-Allow-Origin'] = '*'
    responseHeaders['Allow-CSP-From'] = '*'
    responseHeaders['Access-Control-Allow-Headers'] = '*'

    try {
      let { pathname: path, key, version, searchParams } = parseDatURL(url)
      if (!path) path = '/'
      if (!path.startsWith('/')) path = '/' + path

      try {
        const resolvedURL = await resolveURL(`hyper://${key}`)
        key = resolvedURL.hostname
      } catch (e) {
        // Probably a domain that couldn't resolve
        if (key.includes('.')) throw e
      }

      const Hyperdrive = await getHyperdrive()

      let archive = await Hyperdrive(key)

      if (!archive) {
        return {
          statusCode: 404,
          headers: responseHeaders,
          data: intoAsyncIterable('Unknown drive')
        }
      }

      await archive.ready()

      if (!archive.version) {
        if (!archive.peers.length) {
          await new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error('Timed out looking for peers')), timeout)
            archive.once('peer-open', resolve)
          })
        }
        await new Promise((resolve, reject) => {
          archive.metadata.update({ ifAvailable: true }, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      }

      if (version) {
        if (NUMBER_REGEX.test(version)) {
          archive = await archive.checkout(version)
        } else {
          archive = await archive.checkout(await archive.getTaggedVersion(version))
        }
        await archive.ready()
      }

      const canonical = `hyper://${archive.key.toString('hex')}${path || ''}`
      responseHeaders.Link = `<${canonical}>; rel="canonical"`

      const isWritable = writable && archive.writable
      const allowHeaders = isWritable ? ALL_ALLOW : READABLE_ALLOW
      responseHeaders.Allow = allowHeaders.join(', ')

      // We can say the file hasn't changed if the drive version hasn't changed
      responseHeaders.ETag = `"${archive.version}"`

      if (path.startsWith(SPECIAL_FOLDER)) {
        if (path === SPECIAL_FOLDER) {
          const files = [
          // TODO: Add more special folders here
            'tags/'
          ]
          let data = null
          if (headers.get('Accept') && headers.get('Accept').includes('text/html')) {
            const page = renderDirectory(url, path, files)
            responseHeaders['Content-Type'] = 'text/html; charset=utf-8'
            data = intoAsyncIterable(page)
          } else {
            const json = JSON.stringify(files, null, '\t')
            responseHeaders['Content-Type'] = 'application/json; charset=utf-8'
            data = intoAsyncIterable(json)
          }
          if (method === 'HEAD') {
            return {
              statusCode: 204,
              headers: responseHeaders,
              data: intoAsyncIterable('')
            }
          } else {
            return {
              statusCode: 200,
              headers: responseHeaders,
              data
            }
          }
        } else if (path.startsWith(TAGS_FOLDER)) {
          if (method === 'GET') {
            if (path === TAGS_FOLDER) {
              const tags = await archive.getAllTags()
              const tagsObject = Object.fromEntries(tags)
              const json = JSON.stringify(tagsObject, null, '\t')

              responseHeaders['Content-Type'] = 'application/json; charset=utf-8'

              return {
                statusCode: 200,
                headers: responseHeaders,
                data: intoAsyncIterable(json)
              }
            } else {
              const tagName = path.slice(TAGS_FOLDER.length)
              try {
                const tagVersion = await archive.getTaggedVersion(tagName)

                return {
                  statusCode: 200,
                  headers: responseHeaders,
                  data: intoAsyncIterable(`${tagVersion}`)
                }
              } catch {
                return {
                  statusCode: 404,
                  headers: responseHeaders,
                  data: intoAsyncIterable('Tag Not Found')
                }
              }
            }
          } else if (method === 'DELETE') {
            checkWritable(archive)
            const tagName = path.slice(TAGS_FOLDER.length)
            await archive.deleteTag(tagName || version)
            responseHeaders.ETag = `"${archive.version}"`

            return {
              statusCode: 200,
              headers: responseHeaders,
              data: intoAsyncIterable('')
            }
          } else if (method === 'PUT') {
            checkWritable(archive)
            const tagName = path.slice(TAGS_FOLDER.length)
            const tagVersion = archive.version

            await archive.createTag(tagName, tagVersion)
            responseHeaders['Content-Type'] = 'text/plain; charset=utf-8'
            responseHeaders.ETag = `"${archive.version}"`

            return {
              statusCode: 200,
              headers: responseHeaders,
              data: intoAsyncIterable(`${tagVersion}`)
            }
          } else if (method === 'HEAD') {
            return {
              statusCode: 204,
              headers: responseHeaders,
              data: intoAsyncIterable('')
            }
          } else {
            return {
              statusCode: 405,
              headers: responseHeaders,
              data: intoAsyncIterable('Method Not Allowed')
            }
          }
        } else {
          return {
            statusCode: 404,
            headers: responseHeaders,
            data: intoAsyncIterable('Not Found')
          }
        }
      }

      if (method === 'PUT') {
        checkWritable(archive)
        if (path.endsWith('/')) {
          await makeDir(path, { fs: archive })
        } else {
          const parentDir = path.split('/').slice(0, -1).join('/')
          if (parentDir) {
            await makeDir(parentDir, { fs: archive })
          }

          const source = Readable.from(body)
          const destination = archive.createWriteStream(path)
          // The sink is needed because Hyperdrive's write stream is duplex

          source.pipe(destination)

          await Promise.race([
            once(source, 'error'),
            once(destination, 'error'),
            once(source, 'end')
          ])
        }
        responseHeaders.ETag = `"${archive.version}"`

        return {
          statusCode: 200,
          headers: responseHeaders,
          data: intoAsyncIterable('')
        }
      } else if (method === 'DELETE') {
        if (headers.get('x-clear') === 'cache') {
          await archive.clear(path)
          return {
            statusCode: 200,
            headers: responseHeaders,
            data: intoAsyncIterable('')
          }
        } else {
          checkWritable(archive)

          const stats = await archive.stat(path)
          // Weird stuff happening up in here...
          const stat = Array.isArray(stats) ? stats[0] : stats

          if (stat.isDirectory()) {
            await archive.rmdir(path)
          } else {
            await archive.unlink(path)
          }
          responseHeaders.ETag = `"${archive.version}"`

          return {
            statusCode: 200,
            headers: responseHeaders,
            data: intoAsyncIterable('')
          }
        }
      } else if ((method === 'GET') || (method === 'HEAD')) {
        if (method === 'GET' && headers.get('Accept') === 'text/event-stream') {
          async function * startReader () {
            let _resolve = null
            let _reject = null
            let lastPromise = null

            updatePromise()

            const watcher = archive.watch(path, () => {
              _resolve(archive.version)
              updatePromise()
            })

            watcher.on('error', (e) => _reject(e))

            try {
              while (true) {
                const version = await lastPromise()
                yield `id: ${version}
event: changed
data: ${JSON.stringify(version)}

`
              }
            } finally {
              // TODO: We might have a memory leak here
              // Might not be invoked if no `yield` happens
              watcher.destroy()
            }

            function updatePromise () {
              lastPromise = new Promise((resolve, reject) => {
                _resolve = resolve
                _reject = reject
              })
            }
          }
          responseHeaders['Content-Type'] = 'text/event-stream'
          return {
            statusCode: 200,
            headers: responseHeaders,
            data: startReader()
          }
        }

        let stat = null
        let finalPath = path

        if (headers.get('x-download') === 'cache') {
          await archive.download(path)
        }

        // Legacy DNS spec from Dat protocol: https://github.com/datprotocol/DEPs/blob/master/proposals/0005-dns.md
        if (finalPath === '/.well-known/dat') {
          const { key } = archive
          const entry = `dat://${key.toString('hex')}\nttl=3600`
          return {
            statusCode: 200,
            headers: responseHeaders,
            data: intoAsyncIterable(entry)
          }
        }

        // New spec from hyper-dns https://github.com/martinheidegger/hyper-dns
        if (finalPath === '/.well-known/hyper') {
          const { key } = archive
          const entry = `hyper://${key.toString('hex')}\nttl=3600`
          return {
            statusCode: 200,
            headers: responseHeaders,
            data: intoAsyncIterable(entry)
          }
        }
        try {
          if (searchParams.has('noResolve')) {
            const stats = await archive.stat(path)
            stat = stats[0]
          } else {
            const resolved = await resolveDatPath(archive, path)
            finalPath = resolved.path
            stat = resolved.stat
          }
        } catch (e) {
          responseHeaders['Content-Type'] = 'text/plain; charset=utf-8'
          return {
            statusCode: 404,
            headers: responseHeaders,
            data: intoAsyncIterable(e.stack)
          }
        }

        responseHeaders['Content-Type'] = getMimeType(finalPath)
        responseHeaders['Last-Modified'] = stat.mtime.toUTCString()

        let data = null
        const isRanged = headers.get('Range') || headers.get('range')
        let statusCode = 200

        if (stat.isDirectory()) {
          responseHeaders['x-is-directory'] = 'true'
          const stats = await archive.readdir(finalPath, { includeStats: true })
          const files = stats.map(({ stat, name }) => (stat.isDirectory() ? `${name}/` : name))

          if (headers.get('Accept') && headers.get('Accept').includes('text/html')) {
            const page = renderDirectory(url, path, files)
            responseHeaders['Content-Type'] = 'text/html; charset=utf-8'
            data = intoAsyncIterable(page)
          } else {
            const json = JSON.stringify(files, null, '\t')
            responseHeaders['Content-Type'] = 'application/json; charset=utf-8'
            data = intoAsyncIterable(json)
          }
        } else {
          responseHeaders['Accept-Ranges'] = 'bytes'

          try {
            const { blocks, downloadedBlocks } = await archive.stats(finalPath)
            responseHeaders['X-Blocks'] = `${blocks}`
            responseHeaders['X-Blocks-Downloaded'] = `${downloadedBlocks}`
          } catch (e) {
            // Don't worry about it, it's optional.
          }

          const { size } = stat
          responseHeaders['Content-Length'] = `${size}`

          if (isRanged) {
            const ranges = parseRange(size, isRanged)
            if (ranges && ranges.length && ranges.type === 'bytes') {
              statusCode = 206
              const [{ start, end }] = ranges
              const length = (end - start + 1)
              responseHeaders['Content-Length'] = `${length}`
              responseHeaders['Content-Range'] = `bytes ${start}-${end}/${size}`
              if (method !== 'HEAD') {
                data = archive.createReadStream(finalPath, {
                  start,
                  end
                })
              }
            } else {
              if (method !== 'HEAD') {
                data = archive.createReadStream(finalPath)
              }
            }
          } else if (method !== 'HEAD') {
            data = archive.createReadStream(finalPath)
          }
        }

        if (method === 'HEAD') {
          return {
            statusCode: 204,
            headers: responseHeaders,
            data: intoAsyncIterable('')
          }
        } else {
          return {
            statusCode,
            headers: responseHeaders,
            data
          }
        }
      } else {
        return {
          statusCode: 405,
          headers: responseHeaders,
          data: intoAsyncIterable('Method Not Allowed')
        }
      }
    } catch (e) {
      const isUnauthorized = (e.message === NOT_WRITABLE_ERROR)
      const statusCode = isUnauthorized ? 403 : 500
      const statusText = isUnauthorized ? 'Not Authorized' : 'Server Error'
      return {
        statusCode,
        statusText,
        headers: responseHeaders,
        data: intoAsyncIterable(e.stack)
      }
    }
  }

  function getHyperdrive () {
    if (Hyperdrive) return Hyperdrive
    return getSDK().then(({ Hyperdrive }) => Hyperdrive)
  }

  function getSDK () {
    if (sdk) return Promise.resolve(sdk)
    if (gettingSDK) return gettingSDK
    gettingSDK = SDK(opts).then((gotSDK) => {
      sdk = gotSDK
      gettingSDK = null
      onClose = async () => sdk.close()
      Hyperdrive = sdk.Hyperdrive

      return sdk
    })

    return gettingSDK
  }

  function checkWritable (archive) {
    if (!writable) throw new Error(NOT_WRITABLE_ERROR)
    if (!archive.writable) {
      throw new Error(NOT_WRITABLE_ERROR)
    }
  }
}

function parseDatURL (url) {
  const parsed = new URL(url)
  let key = parsed.hostname
  let version = null
  if (key.includes('+')) [key, version] = key.split('+')

  parsed.key = key
  parsed.version = version

  return parsed
}

async function * intoAsyncIterable (data) {
  yield Buffer.from(data)
}

function getMimeType (path) {
  let mimeType = mime.getType(path) || 'text/plain; charset=utf-8'
  if (mimeType.startsWith('text/')) mimeType = `${mimeType}; charset=utf-8`
  return mimeType
}

function renderDirectory (url, path, files) {
  return `<!DOCTYPE html>
<title>${url}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<h1>Index of ${path}</h1>
<ul>
  <li><a href="../">../</a></li>${files.map((file) => `
  <li><a href="${file}">./${file}</a></li>
`).join('')}
</ul>
`
}

function once (ee, name) {
  return new Promise((resolve, reject) => {
    const isError = name === 'error'
    const cb = isError ? reject : resolve
    ee.once(name, cb)
  })
}
