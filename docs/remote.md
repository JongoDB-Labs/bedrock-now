# Remote access: the portal from your phone and laptop

Back to the [README](../README.md#remote-access).

By default bedrock-now is reachable only on the computer it runs on (`http://bedrock-now.localhost`, bound to
`127.0.0.1`). `./stack remote` adds a second way in for **your own devices**, over HTTPS, without opening any
port to the internet. The local address keeps working exactly as before.

| Mode | Command | Addresses | Certificate | Who can connect |
|---|---|---|---|---|
| off (default) | `./stack remote disable` | `http://bedrock-now.localhost` | none (plain HTTP on 127.0.0.1) | this computer |
| **Tailscale** (recommended) | `./stack remote enable tailscale` | `https://bedrock-now.<tailnet>.ts.net` plus `-chat`, `-admin`, `-files` | Tailscale (Let's Encrypt, automatic) | devices in your tailnet that your policy allows, signed in to Tailscale as you; your Tailscale login **and** the portal password |
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
                     caddy:8081 (remote listener, NOT published on the host; answers only the
                             │  sidecar's fixed address on its own small network)
                             │  sets X-Portal-Remote: 1 and X-Portal-Proxy (after deleting client copies)
                             │  forward_auth → portal: this host's own cookie + Tailscale login check
                             │  (no cookie on an app host yet → one-time hand-off from the portal host)
                             ▼
                     portal / Open WebUI / LiteLLM / RustFS (as for local access)
```

- A `tailscale/tailscale` container (`compose.tailscale.yaml`, pinned by version and digest) joins your
  tailnet as its own machine, `bedrock-now-node`, with **outbound** connections only. It needs no
  `/dev/net/tun` and no capabilities (`cap_drop: ALL`), runs read-only with memory and process limits, and
  its login lives in the `tailscale-state` volume. It shares a small Docker network of its own (`remote`,
  `REMOTE_SUBNET`, default `10.255.255.248/29` — outside Docker's default pools) with Caddy only, at a fixed
  address: the subnet's last host (`REMOTE_SIDECAR_IP`, `10.255.255.254`; `./stack` derives it). If you set
  `REMOTE_SUBNET`, use a /24 to /29 without host bits. `./stack up`/`setup` check it and look for Docker
  networks it overlaps; if it is unusable they say so and start the stack **without** remote access for that
  run, so the local portal never goes down because of it.
- `./stack up`, `setup` and `restore` never wait for it: the stack comes up first, then the sidecar is
  started and given a few seconds; if it is not logged in you get a warning and the local portal works as
  always. `./stack remote status` shows the login state.
- It hosts four [Tailscale Services](https://tailscale.com/kb/1552/tailscale-services), one per app, because
  Open WebUI and LiteLLM both use a host-only cookie called `token` and must stay on different host names. The
  serve config (`tailscale/serve.json`, written by `./stack`) maps `svc:<name>` HTTPS 443 to Caddy's internal
  listener. Containerboot advertises them at start (`TS_EXPERIMENTAL_SERVICE_AUTO_ADVERTISEMENT`, default since
  Tailscale v1.96).
- Caddy's remote site (`caddy/remote-tailscale.caddy`) listens on port 8081 **inside** Docker only, and
  cuts off every caller except the sidecar's fixed address — not another container, and not a process on the
  host, which on Linux reaches the network through its gateway (another address of the same subnet) — and
  trusts `X-Forwarded-*` only from that address. It marks requests with `X-Portal-Remote: 1`; the local site deletes that
  header and any `Tailscale-User-*` header a client sends.
- Caddy also adds `X-Portal-Proxy: <PORTAL_PROXY_SECRET>` (a random secret in `.env`; client copies are
  deleted, the apps never receive it). The portal believes `X-Portal-Remote` and `Tailscale-User-Login` only
  together with it, so a container that talks to `portal:8000` directly cannot claim to be remote.
- The portal then uses **host-only** session cookies, `__Host-bn_session` (`Secure`, `HttpOnly`,
  `SameSite=Strict`, `Path=/`, no `Domain` — the `__Host-` prefix makes the browser enforce that), the remote
  origin for its CSRF check and redirects, and `https://…` app addresses on Home. The apps' own cookies
  (Open WebUI's and LiteLLM's `token`, …) get `Secure` added by Caddy on the remote site only; locally (plain
  http) they stay as they are.
- **Hand-off.** Each app host gets its own cookie, never a shared one: an app host without a cookie sends the
  browser to `https://<portal>/auth/handoff?to=<app>&next=…`; the portal (signed in) mints a token that is
  signed, valid for 60 seconds, usable once, and only for that one host, and redirects to
  `https://<app host>/.bn/callback?t=…`. Caddy hands that path to the portal, which checks the token and sets
  the host's own cookie with the portal session's start time — so it expires with the portal session and
  **Sign out** (or a changed password) ends it too. `next` stays on the same host. This works inside Home's
  frames as well (tested in Chromium and WebKit: the four names are one "site", so `SameSite=Strict` holds).
  Tokens also carry the password fingerprint and are refused after a portal restart. If a browser refuses the
  app host's cookie, the portal stops after four hand-offs a minute and says so instead of looping.
- **Install it on your phone.** The remote address is installable like the local one (Android/desktop
  Chrome and Edge: *Install app*; iPhone/iPad Safari: *Share → Add to Home Screen*). Being another origin it is
  another app, named **bedrock-now (remote)** (a second copy: *bedrock-now (bn-dev, remote)*). Its manifest,
  icons and service worker are public on the remote site through the same `(public_paths)` list as locally.
- One-click Update / Rollback / Clean and the automatic-updates switch stay off for remote requests unless you
  set `REMOTE_ADMIN_ACTIONS=true` ([security](security.md#the-update-helper)).
- The optional browser terminal (`./stack terminal enable`) stays off for remote access unless you set
  `REMOTE_TERMINAL=true` in `.env` and run `./stack up`. Then it gets a remote name of its own —
  `<base>-terminal.<tailnet>.ts.net` (a fifth Tailscale Service: approve it like the others; `./stack remote
  status` lists it) or `terminal.<your domain>` (the wildcard certificate covers it) — reached through the same
  hand-off, and it still asks for the portal password again ([security](security.md#the-browser-terminal)).
  With the Code page on, the same switch shares it too (`<base>-code`, a sixth Service); its previews of dev servers
  only if you turn them on (`<base>-preview`, a seventh: [below](#previews-of-dev-servers-over-remote-access)).
- Every app host answers only page loads, plain assets and its own pages' requests from the other hosts of the
  site ([the same-site guard](security.md#the-same-site-guard)): all Services of a tailnet are one *site* for the
  browser (`ts.net` is on the public suffix list), and so is everything under your own domain.

### Previews of dev servers over remote access

The Code page's previews of a server running in the sandbox ([README](../README.md#the-code-page-optional)) can work
over remote access too, wherever the Code page does (`REMOTE_TERMINAL=true`). They are **off unless you turn them on**:

```bash
./stack config set REMOTE_PREVIEW true     # or Settings › Remote access — on the computer running bedrock-now only
./stack config set REMOTE_PREVIEW false    # off again (from anywhere, also Settings on your phone)
```

**What turning them on means.** A preview shows whatever the sandbox serves — script included. Over remote access its
address is on the same *site* as everything else there: with Tailscale every name under `<tailnet>.ts.net` (all your
Tailscale Services and Serve apps — Grafana, Home Assistant, a NAS's page, another copy of bedrock-now), in own-domain
mode everything under your registrable domain. Cookies with `SameSite=Strict` or `Lax` do not keep requests from the
same site out. So a preview's script could send those apps form posts and other requests that carry *their* cookies,
and set or flood cookies for the whole site. bedrock-now's own hosts refuse such requests
([the same-site guard](security.md#the-same-site-guard)); your other apps on the tailnet or the domain may not. Turn
previews on when the dev servers you run in the sandbox are your own projects and no other app of your tailnet (or
domain) matters to you more than that convenience — or use a domain of their own (below), or keep previewing on the
computer running bedrock-now.

- **With Tailscale: define and approve the Service first, then turn them on.** In the admin console: *Services → Define
  a Service* `<base>-preview` (port `tcp:443`), and add `svc:<base>-preview` to your policy's `autoApprovers` and
  `grants` (steps 2 and 4 below; with previews on, `./stack remote enable tailscale` prints them with it). Then
  `./stack config set REMOTE_PREVIEW true`; `./stack up` names any Service the sidecar has not served before. (A
  Service the sidecar advertises before it is defined has not been tried on a real tailnet: define it first.)
- **One address for every port.** On this computer each preview has a host of its own,
  `p<port>-<capability>.bedrock-now-preview.localhost`. A Tailscale Service is one host name — no wildcards, and
  every name is in public certificate-transparency logs — so remotely there is one, `https://<base>-preview.<tailnet>.
  ts.net` (`preview.<your domain>` in own-domain mode), and a cookie on it says which port your browser previews:
  `__Host-bn_preview` (host-only, `Secure`, `HttpOnly`, `SameSite=Strict`, signed: the port, the Code page's unlock
  and your Tailscale login). The Code page's **Preview** sets it through a hand-off: `/.bn/preview` on the code host
  mints a single-use, 60-second token for that unlock and port, and the preview host's `/.bn/preview-callback`
  turns it into the cookie, then shows the path. So a browser previews **one port at a time** there: opening another
  port's preview switches the open one (its pane says so; *Try again* switches back), in every tab of that browser.
  On a phone **Preview** opens a new tab, as on this computer.
- **The cookie ends with the unlock**: 12 hours, **Sign out**, a new password; another Tailscale login gets nothing.
  It never reaches the sandbox (Caddy strips it, and a dev server's own `Set-Cookie` of that name is dropped), and the
  preview's script cannot read or overwrite it.
- **No service workers there.** That one origin serves every port and every later unlock, so a service worker the
  sandbox installed would keep answering for other ports and after Sign out, and would see the hand-off's links; the
  remote preview host refuses worker scripts (`Service-Worker: script` → 403). Develop a PWA's worker on this
  computer's preview, where every port and unlock has an origin of its own.
- **Own domain: give the previews a domain of their own.** `preview.bedrock.example.com` is on the same site as
  everything under `example.com`. With `REMOTE_PREVIEW_DOMAIN=preview.example-usercontent.net` in `.env` (a name of a
  registrable domain you own, its zone in the same Cloudflare account and the token allowed to edit it; then
  `./stack up`) the previews are another site: their requests carry no cookies of `example.com`, and they cannot set
  cookies for it. Then previews are **on by default** (`REMOTE_PREVIEW=false` turns them off). Caddy gets a
  certificate for that name by DNS-01 like the others; add its DNS record (`./stack remote enable domain …` and
  `./stack remote test` print it). The cookie is then a third-party one inside the Code page's pane
  (`SameSite=None; Partitioned`, kept for that page only), which Chrome and Firefox keep; in a browser that blocks
  third-party cookies outright (Safari) the pane says the link does not work — use **Open in a new tab** there. (This
  variant is checked by unit tests and `caddy validate`, not yet in a browser end to end.)
- **If a preview flooded the site with cookies** (every page of your tailnet or domain answers "request header too
  large" / 431 / 400): clear the site's cookies in that browser — Chrome: *Settings → Privacy and security → Third-party
  cookies → See all site data and permissions*, search `<tailnet>.ts.net` (or your domain) and delete it; Firefox:
  *Settings → Privacy & Security → Cookies and Site Data → Manage Data*, search and remove; Safari: *Settings →
  Privacy → Manage Website Data*, search and remove. That signs you out of every app on that site, your other tailnet
  apps too; bedrock-now asks for the password again.

### Your Tailscale login, checked

Tailscale adds `Tailscale-User-Login` (your login name) to proxied Service requests from a device signed in as
a user, after deleting any copy the client sent (Tailscale's `ipn/ipnlocal/serve.go`; nothing there exempts
Services). Setup asks for your login (`TAILSCALE_ALLOWED_LOGIN`); the portal then **requires** it: a remote
request without the header, or with another login, is refused (403) — on the login page, at sign-in and on
every app request. Sessions (and hand-off tokens) are bound to that login. **Tagged** devices (servers, not
people) never get the header from Tailscale, so they cannot use the portal remotely while a login is set;
leave `TAILSCALE_ALLOWED_LOGIN` blank to allow them (password only — `enable`, `status` and `test` then warn
loudly, because any device your policy lets in gets the login page). `./stack remote status` shows what the
portal last saw ("Identity"). This has been checked against Tailscale's source, not yet end to end on a real
tailnet: `./stack remote test`'s checklist covers it.

### Cookies stay on their own host

All four names live under `<tailnet>.ts.net`, next to every other machine of your tailnet. A cookie scoped to
that domain would be sent to all of them, so none is: every session cookie is host-only (`__Host-`), each app
host gets its own through the hand-off, and Caddy never forwards them to the apps. Admin and Files then get their
own app session from the portal on their own name, host-only as well
([automatic sign-in](security.md#automatic-sign-in-to-admin-and-files)). Own-domain mode works the same way
(nothing is scoped to `bedrock.example.com` either).

The reverse direction, **cookie tossing**, is limited too: another machine under the same parent (or, in
own-domain mode, any host you run under your domain) could set cookies scoped to the parent that browsers would
then send to bedrock-now. It cannot forge or overwrite the `__Host-` session cookies (browsers refuse that
prefix with a `Domain`), but it could plant other cookies the apps read (for example Open WebUI's or LiteLLM's
`token`; one LiteLLM did not sign sends its UI back to the automatic sign-in). Only
run machines you trust under the same tailnet or parent domain, or give bedrock-now a dedicated subdomain.

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
2. **Access controls**: merge this into the policy file (with your login). It is least privilege only if
   your policy has **no allow-all rule**: a new tailnet's default policy lets every device reach every other on
   every port (`"src": ["*"], "dst": ["*"]` in `grants`, or `"action": "accept"` with `*` in `acls`). Remove or
   narrow that rule, or this snippet adds access without limiting anything.

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

3. **Keys**: a **one-off** auth key — not reusable, not ephemeral, pre-approved, tag `tag:bedrock-now`, short
   expiry. (An OAuth client with the `auth_keys` scope and that tag also works — `./stack` appends
   `?ephemeral=false` to its secret — but it can mint further keys at any time: revoke or rotate it once the
   sidecar is enrolled; `enable` reminds you.)
4. **Services**: *Advertise → Define a Service* four times — `bedrock-now`, `bedrock-now-chat`,
   `bedrock-now-admin`, `bedrock-now-files` — each with port `tcp:443`. With the browser terminal and the Code page
   shared (`REMOTE_TERMINAL=true`) also `bedrock-now-terminal` and `bedrock-now-code`, and `bedrock-now-preview` once
   you decide to turn the Code page's previews on ([above](#previews-of-dev-servers-over-remote-access)) — the printed
   snippet and steps list them.
5. Then run `./stack remote enable tailscale`, paste the key (hidden) and your login. As soon as the sidecar
   has logged in, the key is removed from `.env` and the container is recreated without it, so it does not
   linger in `docker inspect` either.
6. `./stack remote test` checks what can be checked from the computer — sidecar logged in and tagged, serve
   config, Services served, Caddy's remote routes as seen from the sidecar's network, that other containers are
   cut off, and that requests without (or with another) Tailscale login are refused — and prints a checklist
   for your phone.

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
  limits). **Cloudflare** is built in. Create an API token (My Profile → API Tokens → Create Custom Token)
  with exactly the permissions the plugin needs (caddy-dns/cloudflare v0.2.4 README): **Zone → Zone → Read**
  and **Zone → DNS → Edit**, and under *Zone Resources* include **only that one zone** (not "All zones"). Better
  still, delegate a dedicated subzone (say `bn.example.com`) to Cloudflare and scope the token to it. The
  command asks for the token (hidden) and stores it as `CLOUDFLARE_API_TOKEN` in `.env`; only the Caddy
  container receives it. **If it leaks**, whoever holds it can change every DNS record of that zone (redirect
  your mail or web, obtain certificates for your names) until you revoke it — which is why it should be
  limited to one, ideally dedicated, zone.
  Another provider: change `DNS_PLUGIN` in `caddy/Dockerfile` to its [caddy-dns](https://github.com/caddy-dns)
  module at a pinned version, the `dns` line in `caddy/remote-domain.caddy`, and the token variable in
  `compose.domain.yaml`.
- Tailscale cannot see inside this TLS, so there is no `Tailscale-User-Login` (Caddy deletes client copies) and
  no binding to your login: access is your tailnet grant (to `tag:bedrock-now`, port 443) plus the portal
  password. Cookies are host-only, as above.

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

`./stack remote disable` stops the sidecar, removes the remote site (and its names) from Caddy, the portal
and Open WebUI. The sidecar's login stays in the `tailscale-state` volume for a later
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
| "not shared with your Tailscale login" | you are signed in to Tailscale as someone else than `TAILSCALE_ALLOWED_LOGIN`, or the device is tagged (no login header) |
| "sign-in link has expired or was already used" | reload the page (the hand-off token lives 60 s and works once) |
| "keeps refusing the sign-in cookie" | the browser blocks cookies for that app's name (private mode, a strict blocker) — allow them |
| Admin or Files: "automatic sign-in did not work" | the page says why and links the app's own form; the causes are those on this computer (README › Troubleshooting) |
| `./stack up` warns the sidecar is not logged in | `./stack remote status`; re-run `./stack remote enable …` with a new auth key |
| "REMOTE_SUBNET … overlaps Docker network …" (or Docker: "Pool overlaps") | set `REMOTE_SUBNET` in `.env` to a free /29 (e.g. `10.254.254.248/29`), then `./stack up` |
| `./stack logs portal`: "PORTAL_PROXY_SECRET is missing" | `./stack up` generates it (remote requests count as local until then) |
| Login page loops | the device's clock; a stale cookie — sign out on Home, or clear site data |
| Code page: "Previews over remote access are off (the default)" | previews of dev servers stay on this computer unless you turn them on — read [above](#previews-of-dev-servers-over-remote-access) first |
| Code page: "Previews over remote access have no address yet" | `./stack up` on the computer writes `REMOTE_PREVIEW_HOST`; Tailscale: define and approve the Service `<base>-preview` |
| A preview: "no service workers on the remote preview host" | expected: develop a PWA's service worker on this computer's preview |
| A preview: "This preview link does not work (any more)" | open it again from the Code page (Ports › Preview): the unlock ended (12 h, Sign out), or another port's preview took over in this browser |
| A request refused with "same-site guard" (`X-Bn-Refused`) | a page on another host of the site (a preview, another of your tailnet's web apps) sent a script request to bedrock-now: expected; if one of bedrock-now's own pages does, report it |
