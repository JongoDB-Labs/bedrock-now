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
        "arn:aws:bedrock:us-east-1::foundation-model/*",
        "arn:aws:bedrock:us-east-2::foundation-model/*",
        "arn:aws:bedrock:us-west-2::foundation-model/*",
        "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.*",
        "arn:aws:bedrock:us-west-2:111122223333:inference-profile/us.*"
      ]
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

- The `us.` **inference profiles** are what the catalog calls for most models; a profile routes each request to
  one of the US regions listed in its definition, so the role needs the foundation-model ARNs in those regions
  too. `bedrock:InvokeModelWithResponseStream` is required for streaming chat and Claude Code.
- `arn:aws:bedrock:us-west-2:…` is there for the models only offered in `us-west-2` (the Stability image models)
  and for a per-model region in `catalog/models.tsv`. Drop the regions you don't use.
- `bedrock:ListFoundationModels` is optional and has no resource-level scoping (hence `"*"`).
- **AWS Marketplace:** third-party models (anything not made by Amazon, e.g. Anthropic, Meta, Mistral) need a
  one-time Marketplace subscription per account. An admin enables them in the Bedrock console; then the role
  above is enough. If you'd rather let the first call subscribe, the role also needs
  `aws-marketplace:Subscribe` and `aws-marketplace:ViewSubscriptions` — prefer leaving that with your admin.
  `./stack models` names models that are blocked this way (*no Marketplace access*).
- For the first login without SSH or open ports, also attach the AWS managed policy
  **`AmazonSSMManagedInstanceCore`** (Systems Manager Session Manager; the agent is preinstalled on AL2023).

### Asking your AWS admin for the role

> Subject: EC2 instance role for bedrock-now
>
> Hi, I'd like to run bedrock-now (a private AI workbench that calls AWS Bedrock through LiteLLM) on a small EC2
> instance (t4g.medium, Amazon Linux 2023, us-east-1, no inbound ports). Instead of an IAM user access key it
> can use an instance role, so no long-lived keys are stored anywhere. Could you please:
>
> 1. **Create an EC2 role** (or instance profile) named `bedrock-now` with the inline policy in
>    https://github.com/JongoDB-Labs/bedrock-now/blob/main/docs/cloud-vm.md#1-the-iam-role
>    (`bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on US foundation models and our `us.`
>    inference profiles; optional `bedrock:ListFoundationModels`), plus `AmazonSSMManagedInstanceCore` for
>    Session Manager access.
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

LiteLLM and setup's `aws-cli` check run in containers. Their requests to the instance metadata service pass one
extra network hop (Docker's bridge), so with a hop limit of **1** they get no credentials ("Unable to locate
credentials"). Amazon Linux 2023 AMIs default to 2; other AMIs often use 1. Check or fix it any time:

```bash
aws ec2 describe-instances --instance-ids i-0123456789abcdef0 \
  --query 'Reservations[0].Instances[0].MetadataOptions'
aws ec2 modify-instance-metadata-options --instance-id i-0123456789abcdef0 \
  --http-tokens required --http-put-response-hop-limit 2 --http-endpoint enabled
```

Setup prints this command (with your instance ID) when the role doesn't work from a container.

## 3. Log in and install Docker

Connect with **Session Manager** (console: *Connect* → *Session Manager*, or
`aws ssm start-session --target i-0123456789abcdef0`), then:

```bash
sudo dnf install -y docker git openssl
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user

# Compose v2 plugin (not packaged for AL2023)
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# 2 GB of swap: 4 GB of RAM is enough, swap absorbs the first-start peaks
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap defaults 0 0' | sudo tee -a /etc/fstab

sudo su - ec2-user     # a fresh login picks up the docker group
docker compose version
```

Setup warns if the Docker Engine is older than 28 (older engines can let other machines on the same LAN reach
ports published on `127.0.0.1`). On EC2 the security group without inbound rules drops such traffic at the
network interface, so the warning is informational there; update Docker when AL2023 ships a newer package.

## 4. Install bedrock-now

```bash
curl -fsSL https://raw.githubusercontent.com/JongoDB-Labs/bedrock-now/main/install.sh | bash
```

Setup finds the instance role and asks:

```
This machine has an AWS IAM role (bedrock-now). Use it instead of an access key (nothing stored in .env)? [Y/n]
```

Answer yes (the default; `--yes` accepts it too). Setup verifies the role from a container
(`sts get-caller-identity`), writes `AWS_AUTH=instance-role` to `.env` and **no** access key, and continues as
usual: probe, keys, smoke test. Exported `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or a key already in
`.env`, take precedence; the role is only offered when no key is configured.

Later:

- `./stack rotate-aws` explains there's nothing to rotate (AWS rotates role credentials).
- `./stack rotate-aws --use-keys` switches to an access key; `./stack rotate-aws --use-instance-role` switches
  an existing key install to the role (verified first; the key lines are removed from `.env`, deactivate the old
  key in IAM afterwards).
- `./stack update` keeps the role mode.

## 5. Reach it

The portal listens on `127.0.0.1` only. For remote access over Tailscale (no inbound ports), see
[docs/remote.md](remote.md). For Claude Code from your phone or laptop over SSH, install Tailscale on the VM
itself and see [docs/phone-claude-code.md](phone-claude-code.md):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh      # --ssh: Tailscale SSH, no SSH keys or port 22 to manage
./stack ssh-info
```

Servers don't sleep, so `./stack serve` has nothing to hold on Linux; the stack comes back after a reboot on
its own (Docker's restart policy, with `docker.service` enabled as above).

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

The same recipe works with an **IAM user access key** (there is no instance role outside AWS): an arm64 or x86
VM with 4 GB+ RAM and 30 GB+ disk, Docker Engine 28+ with the Compose plugin from
[Docker's repository](https://docs.docker.com/engine/install/), the provider's firewall with **no inbound
rules** except what you need to reach the box the first time (close SSH again once Tailscale is up), then the
one-line install and your key when setup asks. Use a region near the US Bedrock regions for latency; your
prompts still go to Bedrock's US regions as above.

## What to check on a real EC2 instance

The role detection is unit-tested with stubs; after your first install, confirm:

1. `./stack setup` offered the role and printed `authenticated as arn:aws:sts::…:assumed-role/bedrock-now/i-…`.
2. `grep -c AWS_ACCESS_KEY_ID .env` prints `0`, and `grep AWS_AUTH .env` shows `AWS_AUTH=instance-role`.
3. `docker compose exec litellm env | grep AWS_` shows only `AWS_REGION_NAME` (no keys).
4. `./stack test` passes (LiteLLM reached Bedrock with the role's credentials).
5. With the hop limit set to 1, `./stack setup` stops with the hop-limit command above; set it back to 2.
