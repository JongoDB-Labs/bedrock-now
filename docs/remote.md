# Remote access: the portal from your phone and laptop

Back to the [README](../README.md#remote-access).

By default bedrock-now is reachable only on the computer it runs on (`http://bedrock-now.localhost`, bound to
`127.0.0.1`). `./stack remote` adds a second way in for **your own devices**, over HTTPS, without opening any
port to the internet. The local address keeps working exactly as before.

| Mode | Command | Addresses | Certificate | Who can connect |
|---|---|---|---|---|
| off (default) | `./stack remote disable` | `http://bedrock-now.localhost` | none (plain HTTP on 127.0.0.1) | this computer |
| **Tailscale** (recommended) | `./stack remote enable tailscale` | `https://bedrock-now.<tailnet>.ts.net` plus `-chat`, `-admin`, `-files` | Tailscale (Let's Encrypt, automatic) | devices in your tailnet that your policy allows; your Tailscale login **and** the portal password |
| Own domain | `./stack remote enable domain bedrock.example.com` | `https://bedrock.example.com` plus `chat.`, `admin.`, `files.` | Let's Encrypt wildcard via DNS-01 (Cloudflare) | devices in your tailnet that your policy allows; the portal password |

Setup asks once: *only this computer, or also your phone/laptop through Tailscale?* (default: only this
computer). `./stack remote status` shows what is on; `./stack status`, the setup summary and Home show the
remote address too. `./stack open` always opens the local one.

## How it works

```
phone (Tailscale) ──HTTPS──▶ Tailscale Service svc:bedrock-now[-chat|-admin|-files]
                             │  tailscale sidecar container (userspace networking, tag:bedrock-now)
                             │  terminates TLS, deletes client Tailscale-User-* headers, adds
                             │  Tailscale-User-Login + X-Forwarded-Proto: https
                             ▼
                     caddy:8081 (remote listener, NOT published on the host)
                             │  sets X-Portal-Remote: 1 (after deleting any client copy)
                             │  forward_auth → portal: remote cookie + Tailscale login check
                             ▼
                     portal / Open WebUI / LiteLLM / RustFS (as for local access)
```

- A `tailscale/tailscale` container (`compose.tailscale.yaml`, pinned by version and digest) joins your
  tailnet as its own machine, `bedrock-now-node`, with **outbound** connections only. It needs no
  `/dev/net/tun` and no capabilities (`cap_drop: ALL`); its login lives in the `tailscale-state` volume.
- It hosts four [Tailscale Services](https://tailscale.com/kb/1552/tailscale-services), one per app, because
  Open WebUI and LiteLLM both use a host-only cookie called `token` and must stay on different host names. The
  serve config (`tailscale/serve.json`, written by `./stack`) maps `svc:<name>` HTTPS 443 to Caddy's internal
  listener. Containerboot advertises them at start (`TS_EXPERIMENTAL_SERVICE_AUTO_ADVERTISEMENT`, default since
  Tailscale v1.96).
- Caddy's remote site (`caddy/remote-tailscale.caddy`) listens on port 8081 **inside** the Docker network
  only; nothing on your machine or LAN can reach it. It marks requests with `X-Portal-Remote: 1`, which the
  local site always deletes.
- The portal then uses a separate session cookie, `__Secure-bn_session` (`Secure`, `HttpOnly`,
  `SameSite=Strict`), the remote origin for its CSRF check and redirects, and `https://…` app addresses on
  Home. Open WebUI's own cookie becomes `Secure` (`WEBUI_AUTH_COOKIE_SECURE=true`).
- One-click Update / Rollback / Clean stay off for remote requests unless you set `REMOTE_ADMIN_ACTIONS=true`
  ([security](security.md#the-update-helper)).

### Your Tailscale login, checked

Tailscale adds `Tailscale-User-Login` (your login name) to every request from a device signed in as a user,
after deleting any copy the client sent. Setup asks for your login (`TAILSCALE_ALLOWED_LOGIN`); the portal then
refuses (403) any remote request that names a **different** login, before and after sign-in. Devices that are
**tagged** (servers, not people) get no such header from Tailscale; for them it is the password alone.
`./stack remote status` tells you which case it saw last ("Identity").

### The cookie caveat (Tailscale mode)

All four names live under `<tailnet>.ts.net`, so the session cookie is scoped to that domain
(`ts.net` is a [public suffix](https://publicsuffix.org/list/), so `<tailnet>.ts.net` is a site of its own).
That means **every machine in your tailnet** whose `*.ts.net` name your browser visits would receive the
cookie. Mitigations: the cookie is `Secure` (only over HTTPS), `HttpOnly` (no page script can read it),
`SameSite=Strict`, has a distinctive name, is never forwarded by Caddy to the apps, and is useless without
the portal's `PORTAL_SECRET` — but a malicious machine in your own tailnet that you browse to could replay it
for up to 30 days. **Sign out** on Home (or change `PORTAL_PASSWORD`) revokes every session. If other people
run machines in your tailnet, consider the own-domain mode (its cookie is scoped to `bedrock.example.com`).

## Tailscale mode, step by step

Requirements (checked against Tailscale's documentation, October 2026):

- **Tailscale Services**: hosts on v1.86+ (the sidecar runs v1.102.5); the host must be **tagged** (a device
  signed in as a user cannot host a Service); each Service must first be **defined** in the admin console;
  hosts must be **approved** per Service (or auto-approved by `autoApprovers`); clients need a **grant** to the
  Service. Clients on v1.94+ need nothing else (Linux clients up to v1.93: `sudo tailscale set --accept-routes`).
- **HTTPS certificates** enabled for the tailnet (and MagicDNS).
- An owner, admin or network admin of the tailnet for the one-time steps.

`./stack remote enable tailscale` prints these steps with your names filled in:

1. **DNS** page: MagicDNS on, HTTPS Certificates on.
2. **Access controls**: merge this into the policy file (with your login):

   ```json
   "tagOwners": { "tag:bedrock-now": ["autogroup:admin"] },
   "autoApprovers": {
     "services": {
       "svc:bedrock-now": ["tag:bedrock-now"],
       "svc:bedrock-now-chat": ["tag:bedrock-now"],
       "svc:bedrock-now-admin": ["tag:bedrock-now"],
       "svc:bedrock-now-files": ["tag:bedrock-now"]
     }
   },
   "grants": [
     { "src": ["you@example.com"],
       "dst": ["svc:bedrock-now", "svc:bedrock-now-chat", "svc:bedrock-now-admin", "svc:bedrock-now-files"],
       "ip": ["443"] }
   ]
   ```

3. **Keys**: an auth key that is not reusable, not ephemeral, pre-approved, with tag `tag:bedrock-now`. (Or an
   OAuth client with the `auth_keys` scope and that tag; `./stack` appends `?ephemeral=false` to its secret.)
4. **Services**: *Advertise → Define a Service* four times — `bedrock-now`, `bedrock-now-chat`,
   `bedrock-now-admin`, `bedrock-now-files` — each with port `tcp:443`.
5. Then run `./stack remote enable tailscale`, paste the key (hidden) and your login. The key is removed from
   `.env` as soon as the sidecar has logged in.
6. `./stack remote test` checks what can be checked from the computer (sidecar logged in and tagged, serve
   config, Services served, Caddy's remote routes) and prints a checklist for your phone.

A second copy of bedrock-now (another `COMPOSE_PROJECT_NAME`) uses `bedrock-now-<project>` names, so both can be
in one tailnet. `TS_SERVICE`, `TS_HOSTNAME` and `TS_TAG` in `.env` override the names.

## Own-domain mode

```bash
./stack remote enable domain bedrock.example.com
```

- The same sidecar joins your tailnet, but forwards **raw TCP 443** to Caddy (`caddy:8443`, not published),
  which terminates TLS itself. You add two DNS records pointing at the sidecar's Tailscale address (printed by
  the command and by `./stack remote status`):

  ```
  bedrock.example.com     A   100.x.y.z
  *.bedrock.example.com   A   100.x.y.z
  ```

  A `100.x` address answers only inside your tailnet, so the records reveal nothing usable to anyone else.
- Caddy gets a Let's Encrypt certificate for `bedrock.example.com` and a wildcard for `*.bedrock.example.com`
  through the **DNS-01** challenge, so no port is opened and the app names stay out of certificate-transparency
  logs. That needs a Caddy build with a DNS plugin: `caddy/Dockerfile` builds one (xcaddy, pinned versions)
  only when this mode is on, and its certificates are kept in the `caddy-data` volume (Let's Encrypt rate
  limits). **Cloudflare** is built in: create an API token with *Zone → DNS → Edit* for the zone; the command
  asks for it (hidden) and stores it as `CLOUDFLARE_API_TOKEN` in `.env` (only the Caddy container receives it).
  Another provider: change `DNS_PLUGIN` in `caddy/Dockerfile` to its [caddy-dns](https://github.com/caddy-dns)
  module at a pinned version, the `dns` line in `caddy/remote-domain.caddy`, and the token variable in
  `compose.domain.yaml`.
- Tailscale cannot see inside this TLS, so there is no `Tailscale-User-Login`: access is your tailnet grant
  (to `tag:bedrock-now`, port 443) plus the portal password. The cookie is scoped to `bedrock.example.com` only.

## Cloudflare Tunnel + Access (documentation only)

You can also publish the local Caddy through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
with [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front. bedrock-now
does not automate this; know the trade-offs first:

- **Cloudflare decrypts everything at its edge.** Prompts, answers, uploaded files and your session cookies pass
  through Cloudflare in clear text. Tailscale modes are end-to-end encrypted between your devices.
- **Validate the Access JWT, not just its presence.** Access adds `Cf-Access-Jwt-Assertion`; anything that can
  reach the tunnel origin without going through Access could send its own. A proxy in front of Caddy would have
  to verify the JWT's signature (your team's certs URL), audience (the application's AUD tag) and expiry —
  bedrock-now's portal does not do this. Without it, Access is the only gate and the portal password the second.
- **100 MB request body limit** on Cloudflare's free and pro plans: larger uploads to Chat or Files fail.
- Map four public host names (portal, chat, admin, files) to `http://127.0.0.1:<PORTAL_PORT>` with the matching
  **local** `Host` header (`httpHostHeader`), and keep the portal's cookie rules in mind: the local site is
  plain HTTP with a non-`Secure` cookie for `PORTAL_HOST`. A proper integration would need the remote-site
  treatment above (a `X-Portal-Remote` Caddy block with `https` names); it is not provided.

## Turning it off

`./stack remote disable` stops the sidecar, removes the remote site from Caddy and the portal, and makes Open
WebUI's cookie non-`Secure` again. The sidecar's login stays in the `tailscale-state` volume for a later
`enable`. To forget it completely: remove the machine in the admin console and
`docker volume rm <project>_tailscale-state`; delete the Services and DNS records you no longer need.

## Troubleshooting

| Symptom | Check |
|---|---|
| `enable` waits, then "did not log in" | the auth key (tagged? expired? already used?), `./stack logs tailscale` |
| Status shows `!! not tagged` | the key must carry `tag:bedrock-now`, and `tagOwners` must allow it |
| Phone: name does not resolve | MagicDNS on; the Service defined; the host approved (Services page) |
| Phone: connection refused/times out | the grant (step 2); Linux clients ≤ v1.93: `--accept-routes` |
| Certificate warning | HTTPS Certificates enabled (DNS page); own domain: `./stack logs caddy` (DNS-01) |
| "not shared with your Tailscale login" | you are signed in to Tailscale as someone else than `TAILSCALE_ALLOWED_LOGIN` |
| Login page loops | the device's clock; a stale cookie — sign out on Home, or clear site data |
