<script>
  import { Plus, Trash2, RefreshCw, LogOut, LogIn, Settings, UserPlus, KeyRound, History, Pencil, X, Copy, Activity } from '@lucide/svelte'
  import { api, joinToken } from './api.js'
  import qrcode from 'qrcode-generator'
  import { t, LANGS } from './i18n.js'
  import Mark from './Mark.svelte'

  let lang = $state(localStorage.getItem('fp_lang') || 'en')
  let authed = $state(api.isAuthed())
  let username = $state('admin')
  let password = $state('')
  let loginError = $state(false)

  let me = $state('')
  let showSettings = $state(false)
  let admins = $state([])
  let oldPw = $state('')
  let newPw = $state('')
  let pwMsg = $state(null)
  let newAdminUser = $state('')
  let newAdminPass = $state('')
  let audit = $state([])

  let networks = $state([])
  let selected = $state(null)
  let devices = $state([])
  let stats = $state({}) // device_id → {rx,tx,updated_at}
  let rates = $state({}) // device_id → {down,up} bytes/s (realtime, from deltas)
  let prevStats = {} // non-reactive sample cache for rate computation
  let newNetName = $state('')
  let lastInvite = $state(null)
  let invites = $state([])
  let inviteExpiry = $state(60) // minutes; 0 = never
  let error = $state(null)
  let copied = $state('')

  // Detail drawer
  let drawer = $state(null) // the device object, or null
  let tab = $state('overview')
  let cfg = $state(null) // device config (peers/allowed-ips)
  let dstats = $state(null) // device /stats (per-peer + totals)
  let sample = $state(null) // {rx,tx,at} for realtime-rate delta
  let rate = $state({ down: 0, up: 0 })
  let routePrefix = $state('')
  let routes = $state([]) // this device's subnet routes
  let settings = $state({ mtu: '', dnsStr: '', endpoint: '' }) // editable wg settings
  let settingsMsg = $state(null)

  // Join-token sharing
  let publicUrl = $state(localStorage.getItem('fp_public_url') || window.location.origin)
  let token = $derived(lastInvite && publicUrl ? joinToken(publicUrl, lastInvite.code) : '')

  const T = (k) => t(lang, k)
  const setLang = (l) => { lang = l; localStorage.setItem('fp_lang', l) }
  const fmtTime = (ts) => new Date(ts).toLocaleString()
  const NOW = () => Math.floor(Date.now() / 1000)

  function humanBytes(n) {
    n = Number(n) || 0
    const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let i = 0
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
    return i === 0 ? `${n} B` : `${n.toFixed(2)} ${u[i]}`
  }
  function humanRate(bps) {
    bps = Number(bps) || 0
    const u = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s']
    let i = 0
    while (bps >= 1024 && i < u.length - 1) { bps /= 1024; i++ }
    return `${bps.toFixed(bps < 10 && i > 0 ? 1 : 0)} ${u[i]}`
  }
  function ago(unix) {
    if (!unix) return T('never')
    const d = NOW() - unix
    if (d < 0) return T('now')
    if (d < 60) return `${d}s`
    if (d < 3600) return `${Math.floor(d / 60)}m`
    if (d < 86400) return `${Math.floor(d / 3600)}h`
    return `${Math.floor(d / 86400)}d`
  }
  // A device is "online" if it reported stats within the last 30s (node up).
  const isOnline = (d) => { const s = stats[d.id]; return s && NOW() - s.updated_at < 30 }

  async function copyText(text, tag) {
    try { await navigator.clipboard.writeText(text); copied = tag; setTimeout(() => copied === tag && (copied = ''), 1500) } catch (e) { /* blocked */ }
  }
  function qrSvg(text) { const qr = qrcode(0, 'M'); qr.addData(text); qr.make(); return qr.createSvgTag({ margin: 2, scalable: true }) }

  async function signIn() {
    loginError = false
    try { const r = await api.login(username.trim(), password); password = ''; me = r.username; authed = true; loadNetworks() } catch (e) { loginError = true }
  }
  function signOut() { api.logout(); authed = false; showSettings = false; networks = []; selected = null; devices = []; lastInvite = null; drawer = null }

  async function guard(fn) {
    error = null
    try { await fn() } catch (e) { if (e.status === 401) { authed = false; return } error = friendlyError(e) }
  }
  function friendlyError(e) {
    const s = String(e)
    if (s.includes('502') || s.includes('Failed to fetch')) return T('errUnreachable') || 'Cannot reach the control-server.'
    return s
  }

  async function loadNetworks() { await guard(async () => { networks = await api.listNetworks() }) }
  async function createNetwork() {
    if (!newNetName.trim()) return
    await guard(async () => { await api.createNetwork(newNetName.trim()); newNetName = ''; await loadNetworks() })
  }
  async function selectNetwork(n) {
    selected = n; lastInvite = null; drawer = null
    await guard(async () => { devices = await api.listDevices(n.id); await refreshStats(); await loadInvites() })
  }
  async function loadInvites() { if (!selected) return; try { invites = await api.listInvites(selected.id) } catch (e) { /* non-fatal */ } }
  // An invite is used (consumed), expired, or still unused/redeemable.
  function inviteStatus(inv) {
    if (inv.uses > 0 && (inv.max_uses == null || inv.uses >= inv.max_uses)) return 'used'
    if (inv.expires_at && NOW() >= inv.expires_at) return 'expired'
    return 'unused'
  }
  function until(unix) {
    const d = unix - NOW()
    if (d <= 0) return T('expired')
    if (d < 3600) return `${Math.ceil(d / 60)}m`
    if (d < 86400) return `${Math.floor(d / 3600)}h`
    return `${Math.floor(d / 86400)}d`
  }
  const expiryLabel = (inv) => (inv.expires_at ? `${T('expiresIn')} ${until(inv.expires_at)}` : T('noExpiry'))
  async function refreshStats() {
    if (!selected) return
    try {
      const rows = await api.networkStats(selected.id)
      const m = {}, nr = {}
      for (const r of rows) {
        m[r.device_id] = r
        const p = prevStats[r.device_id]
        if (p && r.updated_at > p.at) {
          const dt = r.updated_at - p.at
          nr[r.device_id] = { down: Math.max(0, (r.rx_bytes - p.rx) / dt), up: Math.max(0, (r.tx_bytes - p.tx) / dt) }
        } else if (rates[r.device_id]) nr[r.device_id] = rates[r.device_id]
        prevStats[r.device_id] = { rx: r.rx_bytes, tx: r.tx_bytes, at: r.updated_at }
      }
      stats = m
      rates = nr
    } catch (e) { /* non-fatal */ }
  }
  async function makeInvite() {
    if (!selected) return
    await guard(async () => {
      const expiresAt = inviteExpiry ? NOW() + inviteExpiry * 60 : null
      lastInvite = await api.createInvite(selected.id, 1, expiresAt) // single-use by default
      await loadInvites()
    })
  }
  async function revoke(d, ev) {
    ev?.stopPropagation()
    await guard(async () => { await api.revokeDevice(d.id); devices = await api.listDevices(selected.id) })
  }

  // --- drawer ---
  async function openDrawer(d) {
    drawer = d; tab = 'overview'; cfg = null; dstats = null; sample = null; rate = { down: 0, up: 0 }; routePrefix = ''; routes = []
    settings = { mtu: '', dnsStr: '', endpoint: '' }; settingsMsg = null
    await guard(async () => {
      cfg = await api.deviceConfig(d.id)
      routes = await api.deviceRoutes(d.id)
      const s = await api.deviceSettings(d.id)
      settings = { mtu: s.mtu ?? '', dnsStr: (s.dns || []).join(', '), endpoint: s.endpoint ?? '' }
    })
  }
  async function saveSettings() {
    if (!drawer) return
    settingsMsg = null
    await guard(async () => {
      const body = {}
      if (settings.mtu !== '' && settings.mtu != null) body.mtu = Number(settings.mtu)
      const dns = settings.dnsStr.split(',').map((x) => x.trim()).filter(Boolean)
      if (dns.length) body.dns = dns
      if (settings.endpoint.trim()) body.endpoint = settings.endpoint.trim()
      await api.setDeviceSettings(drawer.id, body)
      cfg = await api.deviceConfig(drawer.id)
      settingsMsg = { ok: true }
    })
  }
  function closeDrawer() { drawer = null }
  async function loadRoutes() { if (!drawer) return; try { routes = await api.deviceRoutes(drawer.id) } catch (e) { /* non-fatal */ } }
  async function approveRoute(r) { await guard(async () => { await api.approveRoute(r.id); routes = await api.deviceRoutes(drawer.id); cfg = await api.deviceConfig(drawer.id) }) }
  async function removeRoute(r) { await guard(async () => { await api.deleteRoute(r.id); routes = await api.deviceRoutes(drawer.id); cfg = await api.deviceConfig(drawer.id) }) }
  async function loadDeviceStats() {
    if (!drawer) return
    try {
      const s = await api.deviceStats(drawer.id)
      if (sample && s.updated_at > sample.at) {
        const dt = s.updated_at - sample.at
        rate = { down: (s.rx_bytes - sample.rx) / dt, up: (s.tx_bytes - sample.tx) / dt }
      }
      sample = { rx: s.rx_bytes, tx: s.tx_bytes, at: s.updated_at }
      dstats = s
    } catch (e) { /* non-fatal */ }
  }
  async function renameDevice() {
    const name = (drawer?.renameVal ?? '').trim()
    if (!name || name === drawer.name) { drawer.editing = false; drawer = drawer; return }
    await guard(async () => {
      const upd = await api.renameDevice(drawer.id, name)
      drawer.name = upd.name; drawer.editing = false; drawer = drawer
      devices = await api.listDevices(selected.id)
    })
  }
  async function advertise() {
    if (!routePrefix.trim() || !drawer) return
    await guard(async () => { await api.advertiseRoute(drawer.id, routePrefix.trim()); routePrefix = ''; routes = await api.deviceRoutes(drawer.id) })
  }
  // One-click: make this device a full-tunnel exit (advertise + approve 0.0.0.0/0).
  // Declaring an exit is privileged, so it is an explicit admin action. Idempotent:
  // reuse an existing 0.0.0.0/0 route, only approving if still pending.
  let exitRoute = $derived(routes.find((r) => r.prefix === '0.0.0.0/0'))
  async function setAsExit() {
    if (!drawer) return
    await guard(async () => {
      let r = exitRoute || (await api.advertiseRoute(drawer.id, '0.0.0.0/0'))
      if (r && r.id && !r.approved) await api.approveRoute(r.id)
      routes = await api.deviceRoutes(drawer.id)
      cfg = await api.deviceConfig(drawer.id)
    })
  }
  async function unsetExit() {
    if (!drawer || !exitRoute) return
    await guard(async () => { await api.deleteRoute(exitRoute.id); routes = await api.deviceRoutes(drawer.id); cfg = await api.deviceConfig(drawer.id) })
  }

  // wg showconf-style render from the control config + device record.
  function wgConf(d, c) {
    if (!c) return ''
    const lines = ['[Interface]', `# device: ${d.name}`]
    const addrs = [c.address_v4 && `${c.address_v4}/32`, c.address_v6 && `${c.address_v6}/128`].filter(Boolean)
    if (addrs.length) lines.push(`Address = ${addrs.join(', ')}`)
    lines.push(`PublicKey = ${d.wg_public_key}`)
    for (const p of c.peers || []) {
      lines.push('', '[Peer]', `PublicKey = ${p.wg_public_key}`)
      if (p.allowed_ips?.length) lines.push(`AllowedIPs = ${p.allowed_ips.join(', ')}`)
      if (p.endpoints?.length) lines.push(`Endpoint = ${p.endpoints[0]}`)
    }
    return lines.join('\n')
  }
  // Merge config peers with their live stats (transport / handshake / bytes).
  function peerRows(c, s) {
    const byKey = {}
    for (const p of (s?.peers || [])) byKey[p.public_key] = p
    return (c?.peers || []).map((p) => ({ ...p, live: byKey[p.wg_public_key] || null }))
  }

  async function openSettings() {
    showSettings = !showSettings; pwMsg = null
    if (showSettings) {
      if (!me) await guard(async () => { me = (await api.me()).username })
      await guard(async () => { admins = await api.listAdmins() })
      await guard(async () => { audit = await api.listAudit() })
    }
  }
  async function changePassword() {
    pwMsg = null
    if (!oldPw || newPw.length < 4) { pwMsg = { ok: false }; return }
    try { await api.changePassword(oldPw, newPw); oldPw = ''; newPw = ''; pwMsg = { ok: true } } catch (e) { pwMsg = { ok: false } }
  }
  async function addAdmin() {
    if (!newAdminUser.trim() || newAdminPass.length < 4) return
    await guard(async () => { await api.createAdmin(newAdminUser.trim(), newAdminPass); newAdminUser = ''; newAdminPass = ''; admins = await api.listAdmins() })
  }
  async function removeAdmin(u) { await guard(async () => { await api.deleteAdmin(u); admins = await api.listAdmins() }) }

  if (authed) { loadNetworks(); api.me().then((r) => (me = r.username)).catch(() => {}) }

  // Poll the network traffic rollup every 5s while a network is selected.
  $effect(() => {
    if (!selected || !authed) return
    const id = setInterval(refreshStats, 2000)
    return () => clearInterval(id)
  })
  // Poll the device stats every 5s while the Traffic tab is open.
  $effect(() => {
    if (!drawer || tab !== 'traffic') return
    loadDeviceStats()
    const id = setInterval(loadDeviceStats, 2000)
    return () => clearInterval(id)
  })
</script>

{#snippet langSwitch()}
  <div class="flex overflow-hidden rounded-md border border-line text-xs">
    {#each LANGS as l}
      <button class="px-2 py-1 {lang === l.code ? 'bg-brand text-white' : 'bg-surface text-muted hover:text-fg'}" onclick={() => setLang(l.code)}>{l.label}</button>
    {/each}
  </div>
{/snippet}

{#snippet pill(text, kind)}
  <span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs
    {kind === 'ok' ? 'bg-ok/15 text-ok' : kind === 'danger' ? 'bg-danger/15 text-danger' : 'bg-surface2 text-muted'}">{text}</span>
{/snippet}

{#if !authed}
  <main class="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8 font-sans">
    <div class="mb-5 flex items-center gap-2">
      <h1 class="flex items-center gap-2 text-xl font-bold"><Mark size={26} /> fluxpeer</h1>
      <div class="ml-auto">{@render langSwitch()}</div>
    </div>
    <div class="rounded-xl border border-line bg-surface p-6 shadow-lg">
      <h2 class="mb-1 text-lg font-semibold">{T('signInTitle')}</h2>
      <p class="mb-4 text-xs text-muted">{T('signInHint')}</p>
      <input class="mb-3 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm" placeholder={T('username')} bind:value={username} onkeydown={(e) => e.key === 'Enter' && signIn()} />
      <input type="password" class="mb-3 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm" placeholder={T('password')} bind:value={password} onkeydown={(e) => e.key === 'Enter' && signIn()} />
      {#if loginError}<p class="mb-3 text-sm text-danger">{T('wrongPassword')}</p>{/if}
      <button class="inline-flex w-full items-center justify-center gap-1 rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong" onclick={signIn}>
        <LogIn size={15} /> {T('signIn')}
      </button>
    </div>
  </main>
{:else}
  <main class="mx-auto max-w-5xl p-6 font-sans md:p-8">
    <div class="mb-6 flex items-center gap-3">
      <h1 class="flex items-center gap-2 text-2xl font-bold"><Mark size={28} /> fluxpeer <span class="text-sm font-normal text-muted">admin</span></h1>
      {#if me}<span class="rounded-md bg-surface2 px-2 py-0.5 text-xs text-muted">{me}</span>{/if}
      <div class="ml-auto">{@render langSwitch()}</div>
      <button class="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-muted hover:text-fg" onclick={openSettings}><Settings size={14} /> {T('settings')}</button>
      <button class="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-muted hover:text-fg" onclick={signOut}><LogOut size={14} /> {T('logout')}</button>
    </div>

    {#if error}<p class="mb-4 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>{/if}

    {#if showSettings}
      <section class="mb-8 rounded-xl border border-line bg-surface p-5">
        <div class="grid gap-6 md:grid-cols-2">
          <div>
            <h3 class="mb-3 flex items-center gap-1 text-sm font-semibold"><KeyRound size={15} /> {T('changePassword')}</h3>
            <input type="password" class="mb-2 w-full rounded-md border border-line bg-bg px-3 py-1.5 text-sm" placeholder={T('currentPassword')} bind:value={oldPw} />
            <input type="password" class="mb-2 w-full rounded-md border border-line bg-bg px-3 py-1.5 text-sm" placeholder={T('newPassword')} bind:value={newPw} />
            <button class="rounded-md bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-strong" onclick={changePassword}>{T('save')}</button>
            {#if pwMsg}<p class="mt-2 text-sm {pwMsg.ok ? 'text-ok' : 'text-danger'}">{pwMsg.ok ? T('passwordChanged') : T('passwordError')}</p>{/if}
          </div>
          <div>
            <h3 class="mb-3 flex items-center gap-1 text-sm font-semibold"><UserPlus size={15} /> {T('admins')}</h3>
            <ul class="mb-3 divide-y divide-line rounded-md border border-line">
              {#each admins as a (a)}
                <li class="flex items-center gap-2 px-3 py-2 text-sm">
                  <span class="font-medium">{a}</span>
                  {#if a === me}<span class="text-xs text-muted">({T('you')})</span>{/if}
                  {#if a !== me}<button class="ml-auto text-xs text-danger hover:underline" onclick={() => removeAdmin(a)}>{T('remove')}</button>{/if}
                </li>
              {/each}
            </ul>
            <div class="flex flex-wrap gap-2">
              <input class="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-1.5 text-sm" placeholder={T('username')} bind:value={newAdminUser} />
              <input type="password" class="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-1.5 text-sm" placeholder={T('password')} bind:value={newAdminPass} />
              <button class="inline-flex items-center gap-1 rounded-md border border-line bg-surface2 px-3 py-1.5 text-sm" onclick={addAdmin}><Plus size={13} /> {T('addAdmin')}</button>
            </div>
          </div>
        </div>
        <div class="mt-6">
          <h3 class="mb-2 flex items-center gap-1 text-sm font-semibold"><History size={15} /> {T('auditLog')}</h3>
          <ul class="max-h-64 divide-y divide-line overflow-auto rounded-md border border-line text-xs">
            {#each audit as e (e.ts + e.action + e.actor)}
              <li class="flex gap-3 px-3 py-1.5"><span class="whitespace-nowrap text-muted">{fmtTime(e.ts)}</span><span class="font-medium">{e.actor}</span><span class="truncate text-muted">{e.action}</span></li>
            {/each}
          </ul>
        </div>
      </section>
    {/if}

    <div class="grid gap-6 md:grid-cols-[260px_1fr]">
      <!-- Networks -->
      <section>
        <div class="mb-3 flex items-center gap-2">
          <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">{T('networks')}</h2>
          <button class="ml-auto inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-muted hover:text-fg" onclick={loadNetworks}><RefreshCw size={13} /> {T('refresh')}</button>
        </div>
        <div class="mb-3 flex gap-2">
          <input class="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-1.5 text-sm" placeholder={T('newNetwork')} bind:value={newNetName} onkeydown={(e) => e.key === 'Enter' && createNetwork()} />
          <button class="inline-flex items-center gap-1 rounded-md bg-brand px-2.5 py-1.5 text-sm text-white hover:bg-brand-strong" onclick={createNetwork}><Plus size={14} /></button>
        </div>
        <ul class="space-y-1">
          {#each networks as n (n.id)}
            <li>
              <button class="flex w-full flex-col items-start rounded-lg border px-3 py-2 text-left {selected?.id === n.id ? 'border-brand bg-brand/10' : 'border-line bg-surface hover:border-brand/40'}" onclick={() => selectNetwork(n)}>
                <span class="font-medium">{n.name}</span>
                <span class="font-mono text-xs text-muted">{n.ipv4_pool}</span>
              </button>
            </li>
          {:else}
            <li class="rounded-lg border border-line bg-surface p-3 text-sm text-muted">{T('noNetworks')}</li>
          {/each}
        </ul>
      </section>

      <!-- Devices -->
      {#if selected}
        <section>
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">{T('devices')} — {selected.name}</h2>
            <label class="ml-auto flex items-center gap-1 text-xs text-muted">{T('expiry')}
              <select class="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg" bind:value={inviteExpiry}>
                <option value={60}>{T('min60')}</option>
                <option value={1440}>{T('hours24')}</option>
                <option value={10080}>{T('days7')}</option>
                <option value={0}>{T('noExpiry')}</option>
              </select>
            </label>
            <button class="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-brand/40" onclick={makeInvite}>{T('generateInvite')}</button>
          </div>

          {#if invites.length}
            <div class="mb-4 rounded-xl border border-line bg-surface p-3">
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{T('activeInvites')} · {T('singleUse')}</h3>
              <ul class="max-h-44 divide-y divide-line overflow-auto text-xs">
                {#each invites as inv (inv.code)}
                  <li class="flex items-center gap-2 py-1.5">
                    <code class="font-mono text-muted">{inv.code.slice(0, 12)}…</code>
                    {#if inviteStatus(inv) === 'used'}{@render pill(T('used'), 'muted')}
                    {:else if inviteStatus(inv) === 'expired'}{@render pill(T('expired'), 'danger')}
                    {:else}{@render pill(T('unused'), 'ok')}{/if}
                    <span class="ml-auto text-muted">{expiryLabel(inv)}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if lastInvite}
            <div class="mb-4 rounded-xl border border-line bg-surface p-4">
              <h3 class="mb-2 text-sm font-semibold">{T('inviteShare')}</h3>
              <label class="mb-1 block text-xs text-muted">{T('publicUrl')}
                <input class="mt-1 w-full rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-sm" value={publicUrl} oninput={(e) => { publicUrl = e.target.value; localStorage.setItem('fp_public_url', publicUrl) }} />
              </label>
              <p class="mb-3 text-xs text-muted">{T('publicUrlHint')}</p>
              <div class="flex flex-wrap items-start gap-4">
                <div class="h-36 w-36 shrink-0 rounded-lg border border-line bg-white p-1.5">{@html qrSvg(token)}</div>
                <div class="min-w-0 flex-1">
                  <p class="mb-1 text-xs text-muted">{T('joinCommand')}</p>
                  <div class="mb-3 flex items-start gap-2">
                    <code class="block min-w-0 flex-1 break-all rounded-md bg-bg px-2 py-1.5 font-mono text-xs text-accent">sudo fluxpeer join {token}</code>
                    <button class="shrink-0 rounded-md border border-line bg-surface2 px-2 py-1 text-xs hover:text-fg" onclick={() => copyText('sudo fluxpeer join ' + token, 'cmd')}>{copied === 'cmd' ? T('copied') : T('copy')}</button>
                  </div>
                  <p class="text-xs text-muted">{T('inviteCode')}: <code class="font-mono text-fg">{lastInvite.code}</code> · {T('expiresUses')} {lastInvite.max_uses ?? '∞'}</p>
                </div>
              </div>
            </div>
          {/if}

          <div class="overflow-hidden rounded-xl border border-line">
            <table class="w-full text-sm">
              <thead class="bg-surface text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th class="px-3 py-2 font-medium">{T('devices')}</th>
                  <th class="px-3 py-2 font-medium">{T('address')}</th>
                  <th class="px-3 py-2 font-medium">{T('status')}</th>
                  <th class="px-3 py-2 text-right font-medium">{T('traffic')}</th>
                  <th class="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                {#each devices as d (d.id)}
                  <tr class="cursor-pointer bg-surface/40 hover:bg-surface" onclick={() => openDrawer(d)}>
                    <td class="px-3 py-2.5 font-medium">{d.name}</td>
                    <td class="px-3 py-2.5 font-mono text-xs text-muted">{d.address_v4 ?? '—'}</td>
                    <td class="px-3 py-2.5">
                      {#if d.status !== 'active'}{@render pill(T('revoked'), 'danger')}
                      {:else if isOnline(d)}{@render pill(T('online'), 'ok')}
                      {:else}{@render pill(T('offline'), 'muted')}{/if}
                    </td>
                    <td class="px-3 py-2.5 text-right font-mono text-xs">
                      {#if stats[d.id]}
                        <div class="text-muted">↓{humanBytes(stats[d.id].rx_bytes)} ↑{humanBytes(stats[d.id].tx_bytes)}</div>
                        {#if rates[d.id] && (rates[d.id].down || rates[d.id].up)}<div class="text-accent">↓{humanRate(rates[d.id].down)} ↑{humanRate(rates[d.id].up)}</div>{/if}
                      {:else}<span class="text-muted">—</span>{/if}
                    </td>
                    <td class="px-3 py-2.5 text-right">
                      {#if d.status === 'active'}<button class="text-danger hover:text-danger/80" title={T('revoke')} onclick={(e) => revoke(d, e)}><Trash2 size={15} /></button>{/if}
                    </td>
                  </tr>
                {:else}
                  <tr><td colspan="5" class="px-3 py-6 text-center text-sm text-muted">{T('noDevices')}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      {/if}
    </div>
  </main>

  <!-- Detail drawer -->
  {#if drawer}
    <div class="fixed inset-0 z-20 bg-black/50" onclick={closeDrawer} role="presentation"></div>
    <aside class="fixed inset-y-0 right-0 z-30 w-full max-w-lg overflow-y-auto border-l border-line bg-bg p-6 shadow-2xl font-sans">
      <div class="mb-4 flex items-center gap-2">
        {#if drawer.editing}
          <input class="rounded-md border border-line bg-surface px-2 py-1 text-lg font-semibold" bind:value={drawer.renameVal} onkeydown={(e) => e.key === 'Enter' && renameDevice()} />
          <button class="rounded-md bg-brand px-2 py-1 text-xs text-white" onclick={renameDevice}>{T('save')}</button>
          <button class="rounded-md border border-line px-2 py-1 text-xs text-muted" onclick={() => { drawer.editing = false; drawer = drawer }}>{T('cancel')}</button>
        {:else}
          <h2 class="text-xl font-bold">{drawer.name}</h2>
          <button class="text-muted hover:text-fg" title={T('rename')} onclick={() => { drawer.renameVal = drawer.name; drawer.editing = true; drawer = drawer }}><Pencil size={15} /></button>
          {#if drawer.status === 'active' && isOnline(drawer)}{@render pill(T('online'), 'ok')}{/if}
        {/if}
        <button class="ml-auto text-muted hover:text-fg" title={T('close')} onclick={closeDrawer}><X size={20} /></button>
      </div>

      <div class="mb-5 flex gap-1 border-b border-line text-sm">
        {#each [['overview', T('overview')], ['config', T('config')], ['traffic', T('traffic')], ['peers', T('peers')]] as [id, label]}
          <button class="-mb-px border-b-2 px-3 py-2 {tab === id ? 'border-brand text-fg' : 'border-transparent text-muted hover:text-fg'}" onclick={() => (tab = id)}>{label}</button>
        {/each}
      </div>

      {#if tab === 'overview'}
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt class="text-muted">{T('deviceId')}</dt><dd class="font-mono">{drawer.id}</dd>
          <dt class="text-muted">{T('publicKey')}</dt>
          <dd class="flex min-w-0 items-center gap-2"><code class="break-all font-mono text-xs">{drawer.wg_public_key}</code><button class="shrink-0 rounded bg-surface2 px-1.5 py-0.5 text-[10px] hover:text-fg" onclick={() => copyText(drawer.wg_public_key, 'pk')}>{copied === 'pk' ? T('copied') : T('copy')}</button></dd>
          <dt class="text-muted">{T('overlayV4')}</dt><dd class="font-mono">{drawer.address_v4 ?? '—'}</dd>
          <dt class="text-muted">{T('overlayV6')}</dt><dd class="font-mono text-xs">{drawer.address_v6 ?? '—'}</dd>
          <dt class="text-muted">{T('status')}</dt><dd>{T(drawer.status)}</dd>
        </dl>
      {:else if tab === 'config'}
        <h3 class="mb-2 text-sm font-semibold">{T('editableSettings')}</h3>
        <div class="space-y-2">
          <label class="block text-xs text-muted">{T('mtu')}
            <input type="number" class="mt-1 w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-fg" bind:value={settings.mtu} placeholder="1420" />
          </label>
          <label class="block text-xs text-muted">{T('dns')}
            <input class="mt-1 w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-fg" bind:value={settings.dnsStr} placeholder="1.1.1.1, 8.8.8.8" />
          </label>
          <label class="block text-xs text-muted">{T('endpointOverride')}
            <input class="mt-1 w-full rounded-md border border-line bg-surface px-3 py-1.5 font-mono text-sm text-fg" bind:value={settings.endpoint} placeholder="203.0.113.5:51820" />
          </label>
          <div class="flex items-center gap-2">
            <button class="rounded-md bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-strong" onclick={saveSettings}>{T('save')}</button>
            {#if settingsMsg?.ok}<span class="text-xs text-ok">{T('saved')}</span>{/if}
            <span class="ml-auto text-xs text-muted">{T('keepaliveAuto')}</span>
          </div>
        </div>

        <h3 class="mb-2 mt-6 text-sm font-semibold">{T('routes')} · AllowedIPs</h3>
        {#if routes.length}
          <ul class="mb-2 divide-y divide-line rounded-md border border-line text-xs">
            {#each routes as r (r.id)}
              <li class="flex items-center gap-2 px-3 py-1.5">
                <code class="font-mono">{r.prefix}</code>
                {#if r.approved}{@render pill(T('approved'), 'ok')}{:else}{@render pill(T('pending'), 'muted')}{/if}
                <span class="ml-auto flex gap-3">
                  {#if !r.approved}<button class="text-ok hover:underline" onclick={() => approveRoute(r)}>{T('approve')}</button>{/if}
                  <button class="text-danger hover:underline" onclick={() => removeRoute(r)}>{T('remove')}</button>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="mb-2 flex items-center gap-2 rounded-md border border-line bg-surface2 px-3 py-2 text-sm">
          <span class="font-medium">{T('exitNode')}</span>
          <span class="hidden text-xs text-muted sm:inline">{T('exitNodeHint')}</span>
          {#if exitRoute && exitRoute.approved}
            {@render pill(T('enabled'), 'ok')}
            <button class="ml-auto rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-danger hover:underline" onclick={unsetExit}>{T('disableExit')}</button>
          {:else}
            <button class="ml-auto rounded-md bg-brand px-2.5 py-1 text-xs text-white hover:bg-brand-strong" onclick={setAsExit}>{exitRoute ? T('approveExit') : T('makeExit')}</button>
          {/if}
        </div>
        <div class="flex gap-2">
          <input class="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm" placeholder={T('subnetPrefix')} bind:value={routePrefix} onkeydown={(e) => e.key === 'Enter' && advertise()} />
          <button class="rounded-md border border-line bg-surface2 px-3 py-1.5 text-sm" onclick={advertise}>{T('advertiseRoute')}</button>
        </div>

        <div class="mt-6 flex items-center">
          <h3 class="text-sm font-semibold">{T('generatedConfig')}</h3>
          <button class="ml-auto inline-flex items-center gap-1 rounded-md border border-line bg-surface2 px-2 py-1 text-xs hover:text-fg" onclick={() => copyText(wgConf(drawer, cfg), 'conf')}><Copy size={12} /> {copied === 'conf' ? T('copied') : T('copyConfig')}</button>
        </div>
        <p class="mb-1 text-xs text-muted">{T('managedNote')}</p>
        <pre class="overflow-x-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed text-fg">{wgConf(drawer, cfg) || '…'}</pre>
      {:else if tab === 'traffic'}
        <div class="mb-4 grid grid-cols-2 gap-3">
          <div class="rounded-lg border border-line bg-surface p-3">
            <div class="text-xs text-muted">↓ {T('received')} · {T('total')}</div>
            <div class="text-lg font-semibold">{humanBytes(dstats?.rx_bytes ?? 0)}</div>
            <div class="text-xs text-accent">{humanRate(rate.down)}</div>
          </div>
          <div class="rounded-lg border border-line bg-surface p-3">
            <div class="text-xs text-muted">↑ {T('sent')} · {T('total')}</div>
            <div class="text-lg font-semibold">{humanBytes(dstats?.tx_bytes ?? 0)}</div>
            <div class="text-xs text-accent">{humanRate(rate.up)}</div>
          </div>
        </div>
        <div class="flex items-center gap-1 text-xs text-muted"><Activity size={12} /> {T('now')} · {T('realtime') || 'live'}</div>
        <ul class="mt-2 divide-y divide-line rounded-lg border border-line text-xs">
          {#each (dstats?.peers || []).filter((p) => p.rx_bytes || p.tx_bytes) as p}
            <li class="flex items-center gap-2 px-3 py-2">
              <code class="font-mono text-muted">{p.public_key.slice(0, 10)}…</code>
              <span class="rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-muted">{p.transport}</span>
              <span class="ml-auto font-mono">↓{humanBytes(p.rx_bytes)} ↑{humanBytes(p.tx_bytes)}</span>
            </li>
          {:else}
            <li class="px-3 py-3 text-center text-muted">{T('noPeers')}</li>
          {/each}
        </ul>
      {:else if tab === 'peers'}
        <ul class="divide-y divide-line rounded-lg border border-line text-xs">
          {#each peerRows(cfg, dstats) as p}
            <li class="px-3 py-2.5">
              <div class="flex items-center gap-2">
                <code class="font-mono text-muted">{p.wg_public_key.slice(0, 12)}…</code>
                {#if p.live}<span class="rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-muted">{p.live.transport}</span>{/if}
                {#if p.live?.last_handshake_unix}<span class="ml-auto text-muted">{ago(p.live.last_handshake_unix)}</span>{/if}
              </div>
              <div class="mt-1 text-muted">AllowedIPs: <span class="font-mono text-fg">{(p.allowed_ips || []).join(', ') || '—'}</span></div>
              {#if p.endpoints?.length}<div class="text-muted">Endpoint: <span class="font-mono text-fg">{p.endpoints[0]}</span></div>{/if}
            </li>
          {:else}
            <li class="px-3 py-3 text-center text-muted">{T('noPeers')}</li>
          {/each}
        </ul>
      {/if}
    </aside>
  {/if}
{/if}
