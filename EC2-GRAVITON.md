# Run the k6 test on AWS Graviton

This guide uses one **c8g.2xlarge** instance in **London (eu-west-2)**,
running **Ubuntu Server 24.04 LTS Arm64**. k6 runs directly on the host;
go-httpbin, Prometheus, and Grafana run in Docker Compose. Connect from WSL
for the console and view Grafana in a Windows browser through an SSH tunnel.

The test targets localhost, so it measures the combined CPU and local
networking performance of this stack. EC2's external network bandwidth
becomes relevant when the target moves to another instance.

## 1. Launch the instance

In the EC2 console, select London (`eu-west-2`) and launch an instance with:

| Setting | Value |
| --- | --- |
| Name | `k6-httpbin-test` |
| AMI | Canonical Ubuntu Server 24.04 LTS, **64-bit Arm** |
| Instance type | `c8g.2xlarge` (8 vCPUs, 16 GiB RAM) |
| Purchasing option | On-Demand |
| Root disk | 30 GiB gp3 |
| Network | Public subnet with an internet-gateway route |
| Public IPv4 | Enabled |
| Key pair | Create or select an SSH key |
| Security group inbound | TCP **22**, restricted to your current public IP `/32` |

Allow outbound access for package installation, container downloads, and
cloning GitHub. Leave ports **3000, 8000, and 9090 closed to inbound internet
traffic**. The repository enables anonymous Grafana administrator access;
use the SSH tunnel for browser access.

Wait for the instance's status checks to pass and note its public IP.

## 2. Select the networking configuration

Modern supported AMIs enable ENA enhanced networking automatically. Verify
the driver after connecting rather than installing one manually. See
[AWS ENA guidance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/enhanced-networking-ena.html).

Use the default bandwidth configuration for the initial localhost test.
For a later test against another instance, consider **Advanced details →
Instance bandwidth configuration → `vpc-1`** at launch.

AWS lists these values for `c8g.2xlarge` as of September 2026:

| Configuration | Baseline network bandwidth | Burst |
| --- | --- | --- |
| Default | 3.75 Gbps | 15 Gbps |
| `vpc-1` | 4.688 Gbps | 15 Gbps |

`vpc-1` trades some EBS bandwidth for network bandwidth; it does not
increase the packet-per-second allowance. “Up to 15 Gbps” is burst
capacity. See [AWS bandwidth configuration](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configure-bandwidth-weighting.html).

## 3. Connect from WSL and forward Grafana

Put the downloaded private key in WSL's `~/.ssh` directory and restrict its
permissions. The commands below assume it is named `k6-ec2.pem`:

```bash
chmod 600 ~/.ssh/k6-ec2.pem
```

From your local WSL terminal, replace `EC2_PUBLIC_IP` and connect:

```bash
ssh -i ~/.ssh/k6-ec2.pem \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -L 127.0.0.1:13000:127.0.0.1:3000 \
  ubuntu@EC2_PUBLIC_IP
```

This opens an interactive EC2 shell and forwards local port **13000** to
Grafana's port **3000**. Using 13000 avoids conflicting with an existing
local Grafana installation. Keep this SSH connection open.

Windows browsers can normally access services listening in WSL through
localhost. See [Microsoft WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking).

## 4. Install dependencies on EC2

The Ubuntu Pro image used for this setup,
`ubuntu-pro-server/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-pro-server-20251001`,
already included `ca-certificates`, `curl`, `gnupg`, `git`, `tmux`, `sysstat`,
and `ethtool`. The package installation command below is retained for
other images; it also succeeds when those packages are already installed.

Run the following commands **in the EC2 shell**:

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y \
  ca-certificates curl gnupg git tmux sysstat ethtool
```

For this disposable test machine, use Docker's official convenience
installer. Inspect the downloaded script before running it:

```bash
curl -fsSL https://get.docker.com -o /tmp/install-docker.sh
less /tmp/install-docker.sh
sudo sh /tmp/install-docker.sh
sudo systemctl enable --now docker
sudo docker compose version
```

Docker supports Ubuntu Arm64 and documents this installer for testing and
development. See [Docker installation guidance](https://docs.docker.com/engine/install/ubuntu/#install-using-the-convenience-script).

Install the native Linux Arm64 binary from the official k6 release. The
k6 APT repository does not currently publish an Arm64 package, so the
Debian/Ubuntu APT instructions do not work on this Graviton instance.
This guide pins k6 to v2.2.0 for repeatability.

If you already added the unsupported APT source, disable it:

```bash
if [ -f /etc/apt/sources.list.d/k6.list ]; then
  sudo mv /etc/apt/sources.list.d/k6.list /etc/apt/sources.list.d/k6.list.disabled
fi
```

Download and install the binary:

```bash
(
  set -eu
  k6_install_dir=$(mktemp -d)
  cd "$k6_install_dir"
  curl -fLO https://github.com/grafana/k6/releases/download/v2.2.0/k6-v2.2.0-linux-arm64.tar.gz
  tar -xzf k6-v2.2.0-linux-arm64.tar.gz
  sudo install -m 0755 k6-v2.2.0-linux-arm64/k6 /usr/local/bin/k6
)
k6 version
```

See the [official v2.2.0 release assets](https://github.com/grafana/k6/releases/tag/v2.2.0).
This standalone installation must be upgraded manually; APT will not update it.

Check the architecture and versions:

```bash
uname -m
k6 version
sudo docker version
sudo docker compose version
```

Expect `aarch64` from `uname`. Use native Arm64 container images and
binaries when benchmarking. Reboot if the package upgrade requires it,
then reconnect using the same SSH command.

## 5. Verify networking and resource limits

On EC2, inspect the interfaces and default route:

```bash
ip -br link
ip route show default
```

Find the interface carrying the default route and inspect its driver. For
example, replacing `ens5` with the actual interface name:

```bash
sudo ethtool -i ens5
```

Expect the driver to be `ena`.

Keep the AMI's MTU and TCP settings for the first run. Changing ENA
settings or enabling jumbo frames will not accelerate traffic staying on
this host. Establish a baseline before making kernel changes.

Check the file-descriptor limits:

```bash
ulimit -Sn
ulimit -Hn
```

If the soft limit is below 65,536 and the hard limit permits it, raise it
in the shell that will run k6:

```bash
ulimit -n 65536
```

At the initial 50 VUs, aggressive socket tuning should not be necessary.

## 6. Clone and start the stack

On EC2:

```bash
git clone https://github.com/jufo/test-httpbin.git
cd test-httpbin

sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
```

Check all three services:

```bash
curl -fsS http://127.0.0.1:8000/bytes/4096 -o /tmp/httpbin-response
wc -c /tmp/httpbin-response

curl -fsS http://127.0.0.1:9090/-/ready
curl -fsS http://127.0.0.1:3000/api/health

k6 inspect k6/scripts/httpbin-bytes.js
```

The response file should contain **4096 bytes**. Allow a little time for
services to start before retrying readiness checks. If a service fails:

```bash
sudo docker compose logs --tail=100
```

Record the repository commit, k6 version, and downloaded image IDs for
comparisons between machines:

```bash
git rev-parse HEAD
k6 version
sudo docker compose images
```

The Compose file uses `latest` tags, so later downloads can change the
versions used by a test.

## 7. Open Grafana in Windows

With the SSH tunnel still connected, open this address in a Windows browser:

```text
http://localhost:13000
```

Open **Dashboards → k6 Prometheus**. Set the time range to **Last 15
minutes** and refresh to **5 seconds**.

The dashboard will initially be empty. Its `testid` selector becomes
useful once the test starts.

## 8. Run the test with a persistent console and monitoring

On EC2, start a tmux session:

```bash
tmux new -s k6-test
```

In its first window, record CPU and memory usage:

```bash
cd ~/test-httpbin
mkdir -p results

pidstat -u -r -h -l -p ALL -C 'k6|httpbin' 10 |
  tee results/process-usage.log
```

Use a different monitoring filename for each run if you want to preserve
earlier readings.

Create a second tmux window with **Ctrl+B**, then **C**. Check or raise the
file-descriptor limit here as described above, then run:

```bash
cd ~/test-httpbin
mkdir -p results
set -o pipefail

run_id="graviton-$(date -u +%Y%m%dT%H%M%SZ)"

K6_PROMETHEUS_RW_SERVER_URL=http://127.0.0.1:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS='p(95),p(99),min,max' \
K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=false \
k6 run \
  --out experimental-prometheus-rw \
  --tag "testid=$run_id" \
  -e TARGET_VUS=50 \
  -e BYTES=4096 \
  k6/scripts/httpbin-bytes.js \
  2>&1 | tee "results/$run_id.log"
```

This runs the existing **10-minute ramp from 1 to 50 VUs**, plus time for
outstanding requests. The `testid` separates runs in Grafana, and the trend
settings match the bundled dashboard. See
[k6 Prometheus output guidance](https://grafana.com/docs/k6/latest/results-output/real-time/prometheus-remote-write/).

Select the new test ID in Grafana. Watch request rate, latency, errors,
and VUs alongside `pidstat`. In another tmux window, inspect overall CPU
usage:

```bash
mpstat -P ALL 10
```

Use **Ctrl+B**, then **N** to switch windows. If SSH disconnects, reconnect
with the tunnel and reattach:

```bash
tmux attach -t k6-test
```

tmux keeps the remote commands running when SSH disconnects; the browser
tunnel becomes available again when you reconnect.

## 9. Save results and stop the instance

Stop `pidstat` and `mpstat` with **Ctrl+C** in their windows after the test
finishes. Copy the logs back from a **local WSL terminal**:

```bash
scp -i ~/.ssh/k6-ec2.pem -r \
  ubuntu@EC2_PUBLIC_IP:~/test-httpbin/results \
  ./ec2-results
```

Export any Grafana results you want to retain before removing containers;
the current Compose setup does not define named persistent data volumes.

Stop the EC2 instance when finished to stop compute charges. EBS storage
remains billable while the instance is stopped. A normal stop/start may
assign a different public IPv4 address, so check the address before
reconnecting and update the SSH command accordingly.

Terminate the instance once you no longer need it or its retained data.
