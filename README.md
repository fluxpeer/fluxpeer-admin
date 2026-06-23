# fluxpeer-admin

Web admin UI for a self-hosted [fluxpeer](https://github.com/fluxpeer) mesh
network. It talks to the control-server `/api/v1` and gives an operator a single
dashboard for everything a network needs day to day.

Built with **Svelte 5 + Vite + Tailwind CSS** and shipped as static assets — no
runtime backend of its own.

## Features

- **Networks** — create and browse mesh networks, each with its own IPv4/IPv6 pool.
- **Devices** — list every device with live online/offline status and address,
  rename or revoke devices, and open a detail drawer for any one.
- **Invites** — issue single-use, expiry-bounded join invites and share them as a
  ready-to-run `fluxpeer join` command or a scannable QR code.
- **Routes** — review advertised subnet routes, approve or remove them, and
  advertise new prefixes (AllowedIPs) per device.
- **Traffic accounting** — cumulative byte counters plus realtime down/up rates,
  per network, per device, and per peer.
- **WireGuard config export** — render and copy a `wg showconf`-style
  `[Interface]`/`[Peer]` config for any device, including editable MTU, DNS, and
  endpoint override settings.
- **Multiple administrators** — change your own password, add or remove admin
  accounts.
- **Audit log** — review recent administrative actions.

The UI is internationalized (English and Simplified Chinese).

## Develop

```bash
npm install
npm run dev      # dev server; proxies /api → control-server
npm run build    # → dist/  (static assets)
npm run preview  # preview the production build
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).
