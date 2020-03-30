const resolveDatPath = require('resolve-dat-path')
const Headers = require('fetch-headers')
const mime = require('mime/lite')
const concat = require('concat-stream')
const intoStream = require('into-stream')
const SDK = require('dat-sdk')
const nodeFetch = require('node-fetch')
const reallyReady = require('hypercore-really-ready')

const DAT_REGEX = /\w+:\/\/([^/]+)\/?([^#?]*)?/

module.exports = function makeFetch (opts = {}) {
  let { Hyperdrive, resolveName, base, fetch = nodeFetch } = opts

  let sdk = null
  let gettingSDK = null
  let onClose = async () => undefined

  const isSourceDat = base && base.startsWith('dat://')

  datFetch.close = () => onClose()

  return datFetch

  function getResolve () {
    if (resolveName) return resolveName
    return getSDK().then(({ resolveName }) => resolveName)
  }

  function getHyperdrive () {
    if (Hyperdrive) return Hyperdrive
    return getSDK().then(({ Hyperdrive }) => Hyperdrive)
  }

  function getSDK () {
    if (sdk) return Promise.resolve(sdk)
    if (gettingSDK) return gettingSDK
    return SDK(opts).then((gotSDK) => {
      sdk = gotSDK
      gettingSDK = null
      onClose = async () => sdk.close()
      Hyperdrive = sdk.Hyperdrive
      resolveName = sdk.resolveName

      return sdk
    })
  }

  function resolveDatPathAwait (archive, path) {
    return new Promise((resolve, reject) => {
      resolveDatPath(archive, path, (err, resolved) => {
        if (err) reject(err)
        else resolve(resolved)
      })
    })
  }

  async function datFetch (url) {
    if (typeof url !== 'string') return fetch.apply(this, arguments)

    const isDatURL = url.startsWith('dat://')
    const urlHasProtocol = url.match(/^\w+:\/\//)

    const shouldIntercept = isDatURL || (!urlHasProtocol && isSourceDat)

    if (!shouldIntercept) return fetch.apply(this, arguments)

    let { path, key } = parseDatURL(url)
    if (!path) path = '/'

    const resolve = await getResolve()
    key = await resolve(`dat://${key}`)
    const Hyperdrive = await getHyperdrive()

    const archive = Hyperdrive(key)

    await archive.ready()

    await reallyReady(archive.metadata)

    let resolved = null

    try {
      resolved = await resolveDatPathAwait(archive, path)
      path = resolved.path
    } catch (e) {
      return new FakeResponse(
        404,
        'Not Found',
        new Headers([
          'content-type', 'text/plain'
        ]),
        intoStream(e.stack),
        url)
    }

    let stream = null

    if (resolved.type === 'file') {
      stream = archive.createReadStream(path)
    } else {
      const files = await archive.readdir()

      const page = `
        <title>${url}</title>
        <h1>Index of ${url}</h1>
        <ul>
          <li><a href="../">../</a></li>${files.map((file) => `
          <li><a href="${file}">${file}</a></li>
        `).join('')}</ul>
      `

      const buffer = Buffer.from(page)
      stream = intoStream(buffer)
    }

    const contentType = mime.getType(path) || 'text/plain'

    const headers = new Headers([
      ['content-type', contentType]
    ])

    return new FakeResponse(200, 'ok', headers, stream, url)
  }
}

function parseDatURL (url) {
  let [, key, path] = url.toString().match(DAT_REGEX)
  let version = null
  if (key.includes('+')) [key, version] = key.split('+')

  return {
    key,
    path,
    version
  }
}

class FakeResponse {
  constructor (status, statusText, headers, stream, url) {
    this.body = stream
    this.headers = headers
    this.url = url
    this.status = status
    this.statusText = statusText
  }

  get ok () {
    return this.status && this.status < 400
  }

  get useFinalURL () {
    return true
  }

  async arrayBuffer () {
    const buffer = await concatPromise(this.body)
    return buffer.buffer
  }

  async text () {
    const buffer = await concatPromise(this.body)
    return buffer.toString('utf-8')
  }

  async json () {
    return JSON.parse(await this.text())
  }
}

function concatPromise (stream) {
  return new Promise((resolve, reject) => {
    var concatStream = concat(resolve)
    concatStream.once('error', reject)
    stream.pipe(concatStream)
  })
}
