// SPDX-License-Identifier: BSD-3-Clause
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

const originalFetch = globalThis.fetch
const originalStorage = globalThis.localStorage
let moduleId = 0

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = originalStorage
})

async function fixture(initial = 'session-old') {
  const storage = new Map(initial ? [['fp_admin_token', initial]] : [])
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  }
  const { api } = await import(`../src/api.js?case=${moduleId++}`)
  return { api, storage }
}

const response = (status, body = {}) => new Response(JSON.stringify(body), { status })
function sequence(replies) {
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    assert.ok(replies.length, `unexpected fetch: ${url}`)
    const next = replies.shift()
    if (next instanceof Error) throw next
    return next
  }
  return calls
}

test('login session is sent to the drawer config request', async () => {
  const { api, storage } = await fixture('')
  const calls = sequence([response(200, { token: 'login-session', username: 'admin' }), response(200, { peers: [] })])
  await api.login('admin', 'password')
  assert.deepEqual(await api.deviceConfig('dev-1'), { peers: [] })
  assert.equal(calls[1].opts.headers.authorization, 'Bearer login-session')
  assert.equal(storage.get('fp_admin_token'), 'login-session')
})

test('endpoint 401 with a live admin session remains an error without logging out', async () => {
  const { api, storage } = await fixture()
  const calls = sequence([response(401), response(200, { username: 'admin' })])
  await assert.rejects(api.deviceConfig('dev-1'), (e) => e.status === 401 && e.sessionExpired === false && e.message.includes('/devices/dev-1/config'))
  assert.equal(calls[1].url, '/api/v1/admin/me')
  assert.equal(calls[1].opts.headers.authorization, 'Bearer session-old')
  assert.equal(storage.get('fp_admin_token'), 'session-old')
  assert.equal(api.isAuthed(), true)
})

test('endpoint 403 stays visible without probing or clearing a session', async () => {
  const { api, storage } = await fixture()
  const calls = sequence([response(403)])
  await assert.rejects(api.deviceConfig('dev-1'), (e) => e.status === 403 && !e.sessionExpired)
  assert.equal(calls.length, 1)
  assert.equal(storage.get('fp_admin_token'), 'session-old')
})

test('confirmed session 401 clears storage and marks the error for the login screen', async () => {
  const { api, storage } = await fixture()
  sequence([response(401), response(401)])
  await assert.rejects(api.deviceConfig('dev-1'), (e) => e.status === 401 && e.sessionExpired)
  assert.equal(api.isAuthed(), false)
  assert.equal(storage.has('fp_admin_token'), false)
})

test('a direct admin/me 401 does not recurse', async () => {
  const { api } = await fixture()
  const calls = sequence([response(401)])
  await assert.rejects(api.me(), (e) => e.sessionExpired)
  assert.equal(calls.length, 1)
  assert.equal(api.isAuthed(), false)
})

for (const status of [403, 500, 503, 'network']) {
  test(`unconfirmed session failure (${status}) retains credentials`, async () => {
    const { api, storage } = await fixture()
    sequence([response(401), status === 'network' ? new TypeError('Failed to fetch') : response(status)])
    await assert.rejects(api.deviceSettings('dev-1'), (e) => e.status === 401 && !e.sessionExpired)
    assert.equal(api.isAuthed(), true)
    assert.equal(storage.get('fp_admin_token'), 'session-old')
  })
}

test('failed login never clears an existing session or probes admin/me', async () => {
  const { api, storage } = await fixture()
  const calls = sequence([response(401)])
  await assert.rejects(api.login('wrong', 'wrong'), (e) => e.status === 401 && !e.sessionExpired)
  assert.equal(calls.length, 1)
  assert.equal(storage.get('fp_admin_token'), 'session-old')
})

test('late session denial cannot invalidate a newer login', { timeout: 2000 }, async () => {
  const { api, storage } = await fixture()
  let finishProbe, probeStarted
  const started = new Promise((resolve) => { probeStarted = resolve })
  globalThis.fetch = async (url) => {
    if (url.endsWith('/config')) return response(401)
    if (url.endsWith('/admin/login')) return response(200, { token: 'session-new', username: 'admin' })
    assert.ok(url.endsWith('/admin/me'))
    probeStarted()
    return new Promise((resolve) => { finishProbe = resolve })
  }
  const rejected = assert.rejects(api.deviceConfig('dev-1'), (e) => e.status === 401 && !e.sessionExpired)
  await started
  await api.login('admin', 'password')
  finishProbe(response(401))
  await rejected
  assert.equal(api.isAuthed(), true)
  assert.equal(storage.get('fp_admin_token'), 'session-new')
})
