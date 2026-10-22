// Thin control-server API client (/api/v1). In dev, Vite proxies /api → control-server.
// Management calls carry a session token from /admin/login. Only a confirmed
// /admin/me 401 invalidates it; an endpoint-specific denial stays visible.
const BASE = '/api/v1'
const TKEY = 'fp_admin_token'

let token = localStorage.getItem(TKEY) || ''
let tokenRevision = 0

function setToken(t) {
  tokenRevision += 1
  token = t || ''
  if (token) localStorage.setItem(TKEY, token)
  else localStorage.removeItem(TKEY)
}

async function req(method, path, body) {
  const requestToken = token
  const revision = tokenRevision
  const opts = { method, headers: {} }
  if (requestToken) opts.headers['authorization'] = `Bearer ${requestToken}`
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const r = await fetch(`${BASE}${path}`, opts)
  if (!r.ok) {
    const e = new Error(`${method} ${path} → HTTP ${r.status}`)
    e.status = r.status
    e.sessionExpired = false
    if (r.status === 401 && requestToken && path !== '/admin/login') {
      let expired = path === '/admin/me'
      if (!expired) {
        try {
          const session = await fetch(`${BASE}/admin/me`, { method: 'GET', headers: { authorization: `Bearer ${requestToken}` } })
          expired = session.status === 401
        } catch { /* A failed session probe cannot establish expiration. */ }
      }
      // A late denial from an older request must not clear a newer login.
      if (expired && revision === tokenRevision) {
        setToken('')
        e.sessionExpired = true
      }
    }
    throw e
  }
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
  deleteNetwork: (networkId) => req('DELETE', `/networks/${encodeURIComponent(networkId)}`),
  revokeInvite: (networkId, code) => req('DELETE', `/networks/${encodeURIComponent(networkId)}/invites/${encodeURIComponent(code)}`),
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
