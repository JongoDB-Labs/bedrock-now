# Claude Code from your phone

Back to the [README](../README.md#claude-code-from-your-phone).

`claude-bedrock` runs on the machine that runs bedrock-now (your Mac, or a [cloud VM](cloud-vm.md)). From a
phone you reach it the way you'd reach any server: **SSH**, inside **tmux** so a dropped connection doesn't end
the session. That is what this page describes: Claude Code on the machine itself, with your projects and tools.

There is also an easier, more limited way: the optional **browser terminal** (`./stack terminal enable`;
[README](../README.md#claude-code-in-the-browser)). On a phone it opens from the portal's **More →
Terminal**, full screen, and needs no SSH app. It is a sandbox rather than a shell on your machine: Claude Code
runs in a container that sees only one folder you choose, opening it takes the portal password again, and it
stays off for [remote access](remote.md) unless you set `REMOTE_TERMINAL=true`. Its tmux session also survives a
dropped connection. Typing on a phone's on-screen keyboard is cramped either way; an external keyboard helps.

`./stack ssh-info` prints everything below with this machine's name filled in.

## 1. Put the machine and the phone on Tailscale

[Tailscale](https://tailscale.com) gives both devices private addresses that work from anywhere, with no open
ports or router changes. (Remote access to the *portal* is a separate, optional feature: [docs/remote.md](remote.md).
Its Tailscale sidecar only serves the portal; for SSH, Tailscale must run on the machine itself.)

- **Mac:** install the Tailscale app and sign in.
- **Linux / cloud VM:** `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`
- **Phone:** install the Tailscale app and sign in to the same tailnet.

`./stack ssh-info` then shows the machine's MagicDNS name, e.g. `studio.tail1234.ts.net`. Without Tailscale it
shows `<hostname>.local`, which works only on the same Wi-Fi.

## 2. Turn on SSH

- **Mac:** System Settings › General › Sharing › **Remote Login**.
- **Linux:** `sudo apt install openssh-server` (Debian/Ubuntu) or `sudo dnf install openssh-server && sudo systemctl enable --now sshd`.
- **Tailscale SSH (optional, Linux):** `sudo tailscale set --ssh` lets your tailnet identity log you in, with no
  SSH keys to copy and nothing listening on the public internet. On macOS it needs the open-source `tailscaled`,
  not the App Store or standalone app.

Use SSH keys, not passwords: let the phone app generate a key, append its public key to
`~/.ssh/authorized_keys` on the machine, then set `PasswordAuthentication no` in `/etc/ssh/sshd_config`.

## 3. A phone SSH app

| | Apps |
|---|---|
| iOS | **Blink Shell** (supports mosh), **Termius** |
| Android | **Termius**, **JuiceSSH** |

## 4. Connect and start Claude Code

```bash
ssh you@studio.tail1234.ts.net
tmux new -A -s claude          # attaches to the "claude" session, or creates it
cd ~/your-project
claude-bedrock
```

Lost the connection? Reconnect and run `tmux new -A -s claude` again: Claude Code is still where you left it.
`Ctrl-b d` detaches on purpose. Install tmux with `brew install tmux` (macOS) or your package manager.

On flaky mobile networks, **mosh** keeps the session through network switches and sleep:
`mosh you@studio.tail1234.ts.net -- tmux new -A -s claude` (install `mosh` on the machine too; Blink has it
built in). Over Tailscale, mosh's UDP ports need no firewall changes.

## 5. Keep the machine awake

A sleeping Mac answers no SSH. While you're away, run:

```bash
cd ~/bedrock-now               # your checkout
./stack serve                  # brings the stack up and keeps the Mac awake until Ctrl-C
./stack serve --background     # the same without a terminal; ./stack serve --stop ends it
```

It holds `caffeinate -i -s`: no idle sleep, and no system sleep **on AC power** (macOS ignores `-s` on
battery; `serve` warns). If Docker Desktop's *Start Docker Desktop when you sign in* is switched off, it reminds
you to turn it on so the stack comes back after a restart (it only reads Docker Desktop's settings, never changes
them). `--background` remembers the wake lock's pid and start time, so `--stop` never kills another process.

**Lid closed:** a MacBook sleeps when you close the lid, whatever `caffeinate` holds, unless it's in
closed-display ("clamshell") mode: on power **and** connected to an external display (plus keyboard/mouse).
For a laptop in a bag, leave the lid open or use a desktop Mac / a [cloud VM](cloud-vm.md). We don't recommend
`sudo pmset -a disablesleep 1`: it overrides lid-close sleep too, so a closed MacBook keeps running hot in a
bag, and it stays on until you remember to undo it. A Mac mini or Studio: set *Prevent automatic sleeping when
the display is off* and *Start up automatically after a power failure* in its Energy settings.

`serve` coexists with the update helper (`./stack helper install`, a launchd agent): the helper needs the Mac
awake to run a one-click Update from Home or an automatic update in its nightly window, and `serve` provides
that. If an update, rollback or clean is running when you start `serve`, it doesn't start the stack in the
middle of it (the update does that) and only keeps the Mac awake. The helper itself keeps the Mac awake only while
an update or rollback runs (`caffeinate`), and never wakes it: a Mac asleep when the window starts misses it and
tries the next night.

On Linux, `./stack serve` only acts on a laptop (a machine with a battery): it holds a `systemd-inhibit` sleep
lock until Ctrl-C, and says so if the inhibitor can't be taken (or `systemd-inhibit` is missing). Without a
battery it only notes that servers don't sleep. `--background` is macOS-only; on a Linux laptop run `serve` in tmux.

## SSH or the browser terminal?

| | SSH + tmux (this page) | Browser terminal (`./stack terminal enable`) |
|---|---|---|
| Runs | on the machine, as you | in a sandbox container |
| Sees | everything your user can | only its workspace folder (`/workspace`) |
| Needs | Tailscale (or the same Wi-Fi), SSH on, an SSH app | the portal (and, away from home, remote access with `REMOTE_TERMINAL=true`) |
| Tools | yours (brew, your projects, Docker) | git, node/npm, python/pip, ripgrep, jq, nano inside the container |
| Signing in | your SSH key | the portal password again (12 h per browser; Sign out locks it) |

## Why not Claude Code's Remote Control?

Claude Code's **Remote Control** (continuing a session from claude.ai or the Claude app) needs a claude.ai
subscription login. It doesn't work when Claude Code talks to Bedrock or to a custom API URL, which is what
`claude-bedrock` does (LiteLLM on `127.0.0.1`). SSH + tmux gives you the same "pick it up on the phone" with
your Bedrock billing and budgets intact.
