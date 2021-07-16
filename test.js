const SDK = require('hyper-sdk')
const test = require('tape')

runTests()

const SAMPLE_CONTENT = 'Hello World'

async function runTests () {
  const { Hyperdrive, close } = await SDK({
    persist: false
  })

  const fetch = require('./')({
    Hyperdrive,
    writable: true
  })

  test.onFinish(close)

  test('Read index.html', async (t) => {
    const archive = Hyperdrive('example1')

    const FILE_LOCATION = '/index.html'
    const FILE_DATA = '<h1>Hello World!</h1>'

    await archive.writeFile(FILE_LOCATION, FILE_DATA)

    const url = `hyper://${archive.key.toString('hex')}${FILE_LOCATION}`

    t.pass('Prepped archive ' + url)

    const response = await fetch(url)

    t.pass('got response')

    const text = await response.text()

    t.pass('got response text')

    const contentType = response.headers.get('content-type')

    t.equal(contentType, 'text/html; charset=utf-8')
    t.equal(text, FILE_DATA)
    t.pass('Headers ' + [...response.headers.entries()])
  })

  test('GET .well-known/dat', async (t) => {
    const response = await fetch('hyper://example/.well-known/dat')
    t.ok(response, 'Got response')
    t.equal(response.status, 200, 'Got OK response code')
    const text = await response.text()
    t.ok(text.startsWith('dat://'), 'Returned dat URL')
  })

  test('GET .well-known/hyper', async (t) => {
    const response = await fetch('hyper://example/.well-known/hyper')
    t.ok(response, 'Got response')
    t.equal(response.status, 200, 'Got OK response code')
    const text = await response.text()
    t.ok(text.startsWith('hyper://'), 'Returned dat URL')
  })

  test('PUT file', async (t) => {
    const response1 = await fetch('hyper://example/checkthis.txt', { method: 'PUT', body: SAMPLE_CONTENT })

    t.equal(response1.status, 200, 'Got OK response on write')

    const response2 = await fetch('hyper://example/checkthis.txt')

    t.equal(response2.status, 200, 'Got OK response on read')

    t.equal(await response2.text(), SAMPLE_CONTENT, 'Read back written data')
  })

  test('PUT directory', async (t) => {
    const response1 = await fetch('hyper://example/foo/bar/', { method: 'PUT' })

    t.equal(response1.status, 200, 'Got OK response on directory creation')
  })

  test('PUT file in new directory', async (t) => {
    const response1 = await fetch('hyper://example/fizz/buzz/example.txt', { method: 'PUT', body: SAMPLE_CONTENT })

    t.equal(response1.status, 200, 'Got OK response on directory/file creation')
  })

  test('PUT to overwrite a file', async (t) => {
    const response1 = await fetch('hyper://example/baz/index.html', { method: 'PUT', body: SAMPLE_CONTENT })
    t.ok(response1.ok)
    const response2 = await fetch('hyper://example/baz/index.html', { method: 'PUT', body: SAMPLE_CONTENT })

    t.equal(response2.status, 200, 'Got OK response on file overwrite')
  })

  test('DELETE file', async (t) => {
    const response1 = await fetch('hyper://example/test.txt', { method: 'PUT', body: SAMPLE_CONTENT })
    t.ok(response1.ok)

    const response2 = await fetch('hyper://example/test.txt', { method: 'DELETE' })

    t.equal(response2.status, 200, 'Got OK response on file delete')

    const response3 = await fetch('hyper://example/test.txt', { method: 'GET' })

    t.equal(response3.status, 404, 'Got not found on deleted file')
  })

  test('GET index.html', async (t) => {
    const response1 = await fetch('hyper://example/baz')

    t.equal(await response1.text(), SAMPLE_CONTENT, 'Got index.html content')

    const response2 = await fetch('hyper://example/baz?noResolve')

    t.equal(response2.headers.get('content-type'), 'application/json; charset=utf-8', 'noResolve flag yields JSON by default')
    t.deepEqual(await response2.json(), ['index.html'], 'Listed directory')

    const response3 = await fetch('hyper://example/baz?noResolve')
    t.equal(response3.headers.get('content-type'), 'application/json; charset=utf-8', 'noResolve flag yields JSON by default')
    t.deepEqual(await response3.json(), ['index.html'], 'Listed directory')
  })

  test('Create and read tags', async (t) => {
    await fetch('hyper://example/test.txt', { method: 'PUT', body: SAMPLE_CONTENT })

    const response2 = await fetch('hyper://example/$/tags/tag1', { method: 'PUT' })
    t.ok(response2.ok, 'Able to create tag')

    const version = await response2.json()

    const response3 = await fetch('hyper://example/$/tags/')

    t.ok(response3.ok, 'Able to ask for tags')
    t.deepEqual(await response3.json(), { tag1: version }, 'Tag got created')

    // Insert a file which won't be available with the old tag
    await fetch('hyper://example/notaccessible.txt', { method: 'PUT', body: 'test' })

    const response4 = await fetch('hyper://example+tag1/notaccessible.txt')

    t.equal(response4.status, 404, 'Newer file not found in older tag')

    const response5 = await fetch('hyper://example/$/tags/tag1', { method: 'DELETE' })

    t.ok(response5.ok, 'Able to delete tag')

    const response6 = await fetch('hyper://example/$/tags/')

    t.deepEqual(await response6.json(), {}, 'No tags left after delete')
  })

  test('Load Mauve\'s blog', async (t) => {
    const response = await fetch('hyper://blog.mauve.moe/')

    t.ok(response.ok, 'Succesfully loaded homepage')
  })

  test('Watch for changes', async (t) => {
    const response = await fetch('hyper://example/', {
      headers: {
        Accept: 'text/event-stream'
      }
    })

    t.ok(response.ok, 'Able to open request')
    t.equal(response.headers.get('Content-Type'), 'text/event-stream', 'Response is event stream')

    const reader = await response.body.getReader()

    await Promise.all([
      reader.read(),
      fetch('hyper://example/example4.txt', { method: 'PUT', body: 'Hello World' })
    ])

    t.pass('Got an event after writing')
  })
}
