// Thin control-server API client (/api/v1). In dev, Vite proxies /api → control-server.
// Management calls carry a session token (from /admin/login) as a bearer; a 401
// clears it so the app falls back to the login screen.
const BASE = '/api/v1'
const TKEY = 'fp_admin_token'

let token = localStorage.getItem(TKEY) || ''

function setToken(t) {
  token = t || ''
  if (token) localStorage.setItem(TKEY, token)
  else localStorage.removeItem(TKEY)
}

async function req(method, path, body) {
  const opts = { method, headers: {} }
  if (token) opts.headers['authorization'] = `Bearer ${token}`
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const r = await fetch(`${BASE}${path}`, opts)
  if (r.status === 401) {
    setToken('')
    const e = new Error('unauthorized')
    e.status = 401
    throw e
  }
  if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status}`)
  const text = await r.text()
  return text ? JSON.parse(text) : null
}

export const api = {
  isAuthed: () => !!token,
  async login(username, password) {
    const r = await req('POST', '/admin/login', { username, password })
    setToken(r.token)
    return r
  },
  logout: () => setToken(''),
  version: () => req('GET', '/version'),
  me: () => req('GET', '/admin/me'),
  changePassword: (oldP, newP) => req('POST', '/admin/password', { old_password: oldP, new_password: newP }),
  listAdmins: () => req('GET', '/admin/admins'),
  createAdmin: (username, password) => req('POST', '/admin/admins', { username, password }),
  deleteAdmin: (username) => req('DELETE', `/admin/admins/${encodeURIComponent(username)}`),
  listAudit: () => req('GET', '/admin/audit'),
  listNetworks: () => req('GET', '/networks'),
  createNetwork: (name) => req('POST', '/networks', { name }),
  listDevices: (networkId) => req('GET', `/networks/${networkId}/devices`),
  deviceConfig: (deviceId) => req('GET', `/devices/${deviceId}/config`),
  deviceSettings: (deviceId) => req('GET', `/devices/${deviceId}/settings`),
  setDeviceSettings: (deviceId, settings) => req('PUT', `/devices/${deviceId}/settings`, settings),
  deviceStats: (deviceId) => req('GET', `/devices/${deviceId}/stats`),
  networkStats: (networkId) => req('GET', `/networks/${networkId}/stats`),
  advertiseRoute: (deviceId, prefix) => req('POST', `/devices/${deviceId}/routes`, { prefix }),
  deviceRoutes: (deviceId) => req('GET', `/devices/${deviceId}/routes`),
  approveRoute: (routeId) => req('POST', `/routes/${routeId}/approve`),
  deleteRoute: (routeId) => req('DELETE', `/routes/${routeId}`),
  renameDevice: (deviceId, name) => req('PATCH', `/devices/${deviceId}`, { name }),
  createInvite: (networkId, maxUses, expiresAt) =>
    req('POST', `/networks/${networkId}/invites`, { max_uses: maxUses ?? null, expires_at: expiresAt ?? null }),
  listInvites: (networkId) => req('GET', `/networks/${networkId}/invites`),
  revokeDevice: (deviceId) => req('DELETE', `/devices/${deviceId}`),
}

// Build a shareable join token `fp://join/<base64url(JSON)>` from the control-server
// public URL + an invite code. `fluxpeer join <token>` decodes exactly this.
export function joinToken(ctrl, code) {
  const json = JSON.stringify({ ctrl: ctrl.replace(/\/+$/, ''), code })
  const b64 = btoa(unescape(encodeURIComponent(json)))
  return 'fp://join/' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
