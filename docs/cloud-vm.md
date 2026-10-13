# Running bedrock-now on a cloud VM

Back to the [README](../README.md#run-it-on-a-cloud-vm).

A small always-on VM is a good home for bedrock-now when you want it from several devices (or from your phone)
without keeping a laptop awake. On **EC2** the VM can use an **IAM role** instead of an access key: nothing is
stored in `.env`, and AWS rotates the role's temporary credentials by itself. Other providers (Hetzner,
DigitalOcean, …) work the same way with an IAM user access key, as on your Mac.

Everything stays private: the security group has **no inbound rules**. You reach the VM over
[Tailscale](https://tailscale.com) (portal: [docs/remote.md](remote.md); SSH and Claude Code from a phone:
[docs/phone-claude-code.md](phone-claude-code.md)) and log in for the first time with AWS Systems Manager.

## What to launch

| Setting | Value |
|---|---|
| Region | `us-east-1` (see [Data residency](#data-residency)) |
| Instance type | `t4g.medium` — 2 vCPU, 4 GB, arm64 (Graviton). `t4g.large` (8 GB) if you also run other things |
| AMI | Amazon Linux 2023, **arm64** |
| Disk | 30–40 GB **gp3** (about 5 GB of images, plus your chats, files and backups) |
| Security group | **no inbound rules**; outbound: all (Bedrock, image pulls, Tailscale) |
| Public IPv4 | yes (outbound internet without a NAT gateway; nothing listens on it) |
| Metadata | IMDSv2 **required**, hop limit **2** (AL2023's default; see below) |
| IAM instance profile | the `bedrock-now` role below |

Every image bedrock-now runs is published for `linux/arm64` (pgvector, RustFS, aws-cli, LiteLLM, Open WebUI,
Caddy, and the Python base of the portal and shared-mcp images, which are built on the VM), so Graviton works
out of the box and costs less than the equivalent x86 type.

## 1. The IAM role

Create a role for EC2 (trusted entity: `ec2.amazonaws.com`) named `bedrock-now`, with this inline policy
(replace `111122223333` with your account ID):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeBedrockModels",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:us-*::foundation-model/*",
        "arn:aws:bedrock:us-*:111122223333:inference-profile/us.*"
      ]
    },
    {
      "Sid": "RerankModels",
      "Effect": "Allow",
      "Action": "bedrock:Rerank",
      "Resource": "*"
    },
    {
      "Sid": "ListModelsOptional",
      "Effect": "Allow",
      "Action": "bedrock:ListFoundationModels",
      "Resource": "*"
    }
  ]
}
```

- `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` (streaming chat and Claude Code) are the
  core. Most catalog models are called through the `us.` **cross-region inference profiles**; a profile
  forwards each request to a foundation model in one of several US regions, so the role needs both the profile
  ARN and the foundation-model ARNs in **every** US region the profile can route to — hence `us-*` for both.
  To see where a profile routes:
  ```bash
  aws bedrock get-inference-profile --region us-east-1 \
    --inference-profile-identifier us.anthropic.claude-haiku-5-5 --query 'models[].modelArn'
  ```
- `bedrock:Rerank` is for Open WebUI's document reranking (Cohere/Amazon rerank models); it has no
  resource-level scoping, so it needs `"*"` (the reranker model itself is covered by `bedrock:InvokeModel`).
- `bedrock:ListFoundationModels` is optional and also has no resource-level scoping.
- **Tighter, optional:** to allow foundation models *only* when reached through your `us.` profiles, add
  `"Condition": {"StringLike": {"bedrock:InferenceProfileArn": "arn:aws:bedrock:us-*:111122223333:inference-profile/us.*"}}`
  to a copy of the first statement that lists only the profile-routed models, and keep the directly called ones
  (embeddings such as `cohere.embed-v4:0` and `amazon.titan-embed-text-v2:0`, Stability in `us-west-2`; see the
  `litellm_model` column of `catalog/models.tsv`) in an unconditioned statement with their exact ARNs.
- **AWS Marketplace:** third-party models (anything not made by Amazon, e.g. Anthropic, Meta, Mistral) need a
  one-time Marketplace subscription per account. An admin enables them in the Bedrock console; then the role
  above is enough. If you'd rather let the first call subscribe, the role also needs
  `aws-marketplace:Subscribe` and `aws-marketplace:ViewSubscriptions` — prefer leaving that with your admin.
  `./stack models` names models that are blocked this way (*no Marketplace access*).
- For the first login without SSH or open ports, also attach the AWS managed policy
  **`AmazonSSMManagedInstanceCore`** (Systems Manager Session Manager; the agent is preinstalled on AL2023).
- With an **Elastic IP**, you can also add `"Condition": {"IpAddress": {"aws:SourceIp": "<elastic-ip>/32"}}` to
  each statement: the role's credentials then don't work from anywhere else, even if they leak. **Verify it on
  your instance** (`./stack test` must still pass), and note it only fits Bedrock over the public internet: behind
  a VPC interface endpoint, use `aws:SourceVpce` instead.

### Asking your AWS admin for the role

> Subject: EC2 instance role for bedrock-now
>
> Hi, I'd like to run bedrock-now (a private AI workbench that calls AWS Bedrock through LiteLLM) on a small EC2
> instance (t4g.medium, Amazon Linux 2023, us-east-1, no inbound ports). Instead of an IAM user access key it
> can use an instance role, so no long-lived keys are stored anywhere. Could you please:
>
> 1. **Create an EC2 role** (or instance profile) named `bedrock-now` with the inline policy in
>    https://github.com/JongoDB-Labs/bedrock-now/blob/main/docs/cloud-vm.md#1-the-iam-role:
>    `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on US foundation models
>    (`arn:aws:bedrock:us-*::foundation-model/*`) and our `us.` inference profiles
>    (`arn:aws:bedrock:us-*:<account>:inference-profile/us.*`), `bedrock:Rerank` (resource `*`), optional
>    `bedrock:ListFoundationModels` — plus the managed policy `AmazonSSMManagedInstanceCore` for Session Manager.
> 2. **Enable model access / the Marketplace subscription** for the models I need (`<model>` …) in `us-east-1`.
> 3. Let me **launch an instance with that role**, or attach it to `<instance-id>` for me.
>
> Thanks!

## 2. Launch the instance

In the console: *Launch instance* → Amazon Linux 2023 (64-bit **Arm**) → `t4g.medium` → no key pair needed
(Session Manager) → a new security group **with the SSH rule removed** → 30–40 GB gp3 → *Advanced details*:
IAM instance profile `bedrock-now`, *Metadata version* **V2 only (token required)**, *Metadata response hop
limit* **2**.

Or with the AWS CLI:

```bash
aws ec2 run-instances --region us-east-1 \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --instance-type t4g.medium \
  --iam-instance-profile Name=bedrock-now \
  --security-group-ids sg-0123456789abcdef0 \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=40,VolumeType=gp3}' \
  --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=bedrock-now}]'
```

### IMDSv2 hop limit 2 (important)

LiteLLM and setup's `aws-cli` checks run in containers. Their requests to the instance metadata service pass one
extra network hop (Docker's bridge), so with a hop limit of **1** they get no credentials ("Unable to locate
credentials"). Amazon Linux 2023 AMIs default to 2; other AMIs often use 1. Check or fix it any time:

```bash
aws ec2 describe-instances --instance-ids i-0123456789abcdef0 \
  --query 'Reservations[0].Instances[0].MetadataOptions'
aws ec2 modify-instance-metadata-options --instance-id i-0123456789abcdef0 \
  --http-tokens required --http-put-response-hop-limit 2 --http-endpoint enabled
```

Setup prints this command (with your instance ID) when the role doesn't work from a container. Hop limit 2
also means **every** container on the VM can reach the role's credentials; see
[Keeping the role's credentials to LiteLLM](#keeping-the-roles-credentials-to-litellm).

## 3. Log in and install Docker

Connect with **Session Manager** (console: *Connect* → *Session Manager*, or
`aws ssm start-session --target i-0123456789abcdef0`), then:

```bash
sudo dnf install -y docker git openssl
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user

# Docker Compose v2 and buildx plugins (not packaged for AL2023): pinned versions, checked against their sha256
case "$(uname -m)" in
  aarch64) BX_ARCH=arm64
           COMPOSE_SHA=d26373b19e89160546d15407516cc59f453030d9bc5b43ba7faf16f7b4980137
           BUILDX_SHA=e5cc9fe3bbff5cbc91230981f7860e06076110730a2db997082652199042a1f2 ;;
  x86_64)  BX_ARCH=amd64
           COMPOSE_SHA=dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372
           BUILDX_SHA=9447199cdb435f25880548343c128a4b6650e8891ee598905d8d29d39a8e359b ;;
esac
curl -fsSLo /tmp/docker-compose \
  "https://github.com/docker/compose/releases/download/v2.40.3/docker-compose-linux-$(uname -m)"
curl -fsSLo /tmp/docker-buildx \
  "https://github.com/docker/buildx/releases/download/v0.37.1/buildx-v0.37.1.linux-$BX_ARCH"
echo "$COMPOSE_SHA  /tmp/docker-compose" | sha256sum -c -
echo "$BUILDX_SHA  /tmp/docker-buildx" | sha256sum -c -
sudo install -D -m 755 /tmp/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
sudo install -D -m 755 /tmp/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx

# 2 GB of swap: 4 GB of RAM is enough, swap absorbs the first-start peaks
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap defaults 0 0' | sudo tee -a /etc/fstab

sudo su - ec2-user     # a fresh login picks up the docker group
docker compose version && docker buildx version
```

Compose builds the portal and shared-mcp images on the first setup, which needs the buildx plugin; on a
`t4g.medium` that build takes a few minutes. Setup warns if the Docker Engine is older than 28 (older engines can
let other machines on the same LAN reach ports published on `127.0.0.1`). On EC2 the security group without
inbound rules drops such traffic at the network interface, so the warning is informational there; update Docker
when AL2023 ships a newer package.

## 4. Install bedrock-now

```bash
curl -fsSL https://raw.githubusercontent.com/JongoDB-Labs/bedrock-now/main/install.sh | bash
cd ~/bedrock-now
```

Setup looks for an instance role **only on EC2**: on Linux whose firmware identifies the machine as an EC2
instance (never on macOS, and never on a network that merely answers `169.254.169.254`). When it finds one and
no access key is configured, it asks:

```
This EC2 instance has an AWS IAM role (bedrock-now). Use it instead of an access key (nothing stored in .env)? [Y/n]
```

Answer yes (the default). Setup then checks, before writing anything, that a **container** gets this role's
credentials (`sts get-caller-identity`, the ARN must name this role) and that the role may **use Bedrock** (a free,
deliberately invalid request to the catalog's Haiku model, then the embedding models: an "invalid input" answer
means authorized). It shows the AWS account and role ARN and asks you to confirm; then it writes
`AWS_AUTH=instance-role` to `.env`, removes the access-key lines and continues as usual (probe, keys, smoke test).
With `--yes`, or when the one-liner runs without a terminal (e.g. from EC2 user data), the role is accepted
without the questions — still only on an EC2 host. Exported `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or a key
already in `.env`, take precedence; the role is only offered when no key is configured.

Later:

- `./stack rotate-aws` explains there's nothing to rotate (AWS rotates role credentials).
- `./stack rotate-aws --use-keys` switches to an access key (verified before `.env` changes).
- `./stack rotate-aws --use-instance-role` switches a key install to the role: the role and its Bedrock access
  are checked first, the old key ID is printed, then the key lines are removed and LiteLLM restarts (if it
  doesn't come up or the smoke test fails, the previous settings are put back and LiteLLM restarted with
  them). Deactivate the old key in IAM afterwards.
- `./stack update` keeps the role mode. `./stack up` refuses role mode on a machine that isn't an EC2 instance,
  and key mode without a key.

## 5. Reach it

The portal listens on `127.0.0.1` only. For remote access over Tailscale (no inbound ports), see
[docs/remote.md](remote.md). For Claude Code from your phone or laptop over SSH, install Tailscale on the VM
itself and see [docs/phone-claude-code.md](phone-claude-code.md):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh      # --ssh: Tailscale SSH, no SSH keys or port 22 to manage
cd ~/bedrock-now && ./stack ssh-info
```

Servers don't sleep, so `./stack serve` has nothing to hold on a VM; the stack comes back after a reboot on
its own (Docker's restart policy, with `docker.service` enabled as above).

## Keeping the role's credentials to LiteLLM

With a key, only the LiteLLM container receives AWS credentials. With the instance role and hop limit 2,
**every container on the VM can ask IMDS for the role's credentials**: Open WebUI, the portal, shared-mcp, RustFS,
Postgres, Caddy, a remote-access sidecar, and anything you `docker run` yourself. The role only allows Bedrock
calls, so the worst case is Bedrock spend outside LiteLLM's budgets by a compromised container — but it is a
wider reach than key mode. Two optional hardening steps:

**1. Allow IMDS only for LiteLLM (Linux firewall; needs sudo).** Docker passes container traffic through the
`DOCKER-USER` iptables chain, so a rule there can drop container requests to the metadata service except
LiteLLM's. Docker's default `bridge` network stays allowed: that is where setup's and `./stack models --recheck`'s
throwaway `aws-cli` containers run (the stack's own services are on the Compose network, not there).

LiteLLM's address changes whenever its container is recreated (`./stack up`, `update`, `rotate-aws`), so the rule
is rebuilt **on every container start** (a `docker events` listener), with a 5-minute timer as a backstop. Each
run builds a complete new chain, points `DOCKER-USER` at it and only then removes the old one, so there is never a
moment without a rule. EC2 also offers IMDS over IPv6 (`fd00:ec2::254`) when the instance has
`HttpProtocolIpv6=enabled`; the script covers it with `ip6tables` when Docker manages an IPv6 `DOCKER-USER` chain.
If you don't need IPv6 IMDS, keep it disabled (the default). Save as `/usr/local/sbin/bedrock-now-imds-guard`
(mode 755; set `PROJECT` if you use another `COMPOSE_PROJECT_NAME`):

```sh
#!/bin/sh
# Containers may reach EC2's metadata service only from LiteLLM and Docker's default bridge (aws-cli checks).
set -eu
PROJECT=bedrock-now
cid="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=litellm)"
v4='' v6=''
if [ -n "$cid" ]; then
  v4="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$cid" | awk '{ print $1 }')"
  v6="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.GlobalIPv6Address}} {{end}}' "$cid" | awk '{ print $1 }')"
fi
bridge4="$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep -v : | head -n 1 || true)"
bridge6="$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep : | head -n 1 || true)"

# apply IPTABLES DEST ALLOWED... — new chain, jump to it, then drop the previous chain(s)
apply() {
  ipt="$1"; dst="$2"; shift 2
  new="BN-IMDS-$(date +%s)-$$"
  "$ipt" -N "$new"
  for src in "$@"; do [ -z "$src" ] || "$ipt" -A "$new" -s "$src" -j RETURN; done
  "$ipt" -A "$new" -j DROP
  "$ipt" -I DOCKER-USER -d "$dst" -j "$new"
  for old in $("$ipt" -S DOCKER-USER | grep -o 'BN-IMDS-[0-9-]*' | grep -vx "$new" || true); do
    "$ipt" -D DOCKER-USER -d "$dst" -j "$old" 2>/dev/null || true
    "$ipt" -F "$old"; "$ipt" -X "$old"
  done
}
apply iptables 169.254.169.254/32 "$v4" "$bridge4"
if ip6tables -S DOCKER-USER >/dev/null 2>&1; then apply ip6tables fd00:ec2::254/128 "$v6" "$bridge6"; fi
```

and run it from systemd — a long-running listener plus a timer:

```bash
sudo dnf install -y iptables-nft
sudo tee /etc/systemd/system/bedrock-now-imds-guard.service >/dev/null <<'EOF'
[Unit]
Description=bedrock-now: only LiteLLM may reach the EC2 metadata service (on every container start)
After=docker.service
Requires=docker.service
[Service]
Type=simple
ExecStartPre=/usr/local/sbin/bedrock-now-imds-guard
ExecStart=/bin/sh -c 'docker events --filter type=container --filter event=start --format "{{.ID}}" | while read -r _; do /usr/local/sbin/bedrock-now-imds-guard; done'
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo tee /etc/systemd/system/bedrock-now-imds-guard-refresh.service >/dev/null <<'EOF'
[Unit]
Description=bedrock-now: refresh the metadata-service rule (backstop)
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/bedrock-now-imds-guard
EOF
sudo tee /etc/systemd/system/bedrock-now-imds-guard-refresh.timer >/dev/null <<'EOF'
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now bedrock-now-imds-guard.service bedrock-now-imds-guard-refresh.timer
```

**Check it** (from `~/bedrock-now`). Ask for an IMDSv2 token — the first step of every credential lookup — from
another container and from LiteLLM:

```bash
docker compose exec open-webui python -c "import urllib.request as u; print(u.urlopen(u.Request('http://169.254.169.254/latest/api/token', method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'}), timeout=3).status)"
docker compose exec litellm python -c "import urllib.request as u; print(u.urlopen(u.Request('http://169.254.169.254/latest/api/token', method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'}), timeout=3).status)"
```

With the guard, the first one fails with a **timeout** (the packet is dropped) and the second prints `200`.
Without it, both print `200`. (A plain `GET /` without a token is no test: IMDSv2 answers it with HTTP 401 either
way.) `./stack test` must still pass.

Limits: between a container start and the rule rebuild (a fraction of a second) the previous rule applies, so a
container that starts at the same moment and receives LiteLLM's old address could briefly pass. There is
deliberately no `./stack` command for this: it changes the host firewall as root, so it stays a recipe you read and
install yourself. We don't pin a fixed Compose subnet for LiteLLM instead, because a fixed subnet would collide with
a second copy or an existing network.

**2. Bind the credentials to this VM.** With an Elastic IP, the `aws:SourceIp` condition from
[the role](#1-the-iam-role) makes leaked credentials useless anywhere else. **Verify it on your instance** before
relying on it: after adding the condition, `./stack test` must still pass. It only works while Bedrock is reached
over the public internet; with a VPC interface endpoint for Bedrock, requests carry no public source IP and the
condition would block everything — use `aws:SourceVpce` (your endpoint's ID) instead.

## Data residency

The catalog uses the `us.` cross-region inference profiles, which keep requests on **US** Bedrock regions.
LiteLLM calls Bedrock in `AWS_REGION_NAME` (your answer in setup, default `us-east-1`), so put the VM in
`us-east-1` and keep that region: your prompts then never leave US AWS regions, end to end. A per-model region
in `catalog/models.tsv` (e.g. `us-west-2` for Stability) is still a US region. Use the `eu.`/`apac.` profiles and
a matching region only if you change the catalog accordingly.

## Costs (us-east-1, on-demand, about)

| Item | Per month |
|---|---|
| `t4g.medium` (≈ $0.0336/h) | ≈ $25 |
| 30–40 GB gp3 (≈ $0.08/GB) | ≈ $2.40–3.20 |
| Public IPv4 address (≈ $0.005/h) | ≈ $3.60 |
| **Total, before Bedrock usage** | **≈ $31–32** |

A 1-year Savings Plan or reserved instance cuts the instance cost by about a third. Stopping the instance stops
the instance charge (the disk and the IPv4 address are still billed while it exists). Bedrock usage is billed as
on your Mac; `./stack costs` shows it.

## Other VPS providers (Hetzner, DigitalOcean, …)

The same recipe works with an **IAM user access key** (there is no instance role outside AWS, and setup never
asks a metadata service there): an arm64 or x86 VM with 4 GB+ RAM and 30 GB+ disk, Docker Engine 28+ with the
Compose and buildx plugins from [Docker's repository](https://docs.docker.com/engine/install/), the provider's
firewall with **no inbound rules** except what you need to reach the box the first time (close SSH again once
Tailscale is up), then the one-line install and your key when setup asks. Use a region near the US Bedrock
regions for latency; your prompts still go to Bedrock's US regions as above.

## What to check on a real EC2 instance

The role detection is unit-tested with stubs; after your first install, from `~/bedrock-now`, confirm:

1. The first `./stack setup` built the portal and shared-mcp images (buildx) without errors.
2. Setup offered the role, printed `Bedrock access confirmed with the role` and showed
   `arn:aws:sts::<account>:assumed-role/bedrock-now/i-…` with your account ID.
3. `grep -c AWS_ACCESS_KEY_ID .env` prints `0`, and `grep AWS_AUTH .env` shows `AWS_AUTH=instance-role`.
4. `docker compose exec litellm env | grep AWS_` shows only `AWS_REGION_NAME` (no keys).
5. `./stack test` passes (LiteLLM reached Bedrock with the role's credentials).
6. With the hop limit set to 1, `./stack setup` stops with the hop-limit command above; set it back to 2.
7. If you installed the IMDS guard: the token request from `open-webui` times out, LiteLLM's prints `200`, and
   `./stack test` still passes — also right after `./stack up` recreates LiteLLM.
