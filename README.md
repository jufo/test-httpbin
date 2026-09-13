# Benchmarking k6 resource usage

This project explores how much CPU and memory k6 needs to generate a given
HTTP workload, and how throughput changes as concurrency and response size
increase. It uses go-httpbin to generate responses, Prometheus to store k6
metrics, and Grafana to inspect results.

k6 runs directly on the host. By default, go-httpbin and monitoring share
that machine, so their resource usage must be measured alongside k6's.
A throughput plateau can reflect limits in the target, networking, or
monitoring as well as in k6 itself.

## Prerequisites

- Linux with Docker Engine and the Docker Compose plugin. Docker Desktop
  requires separate [host-networking configuration](https://docs.docker.com/engine/network/drivers/host/#platform-support).
- A native k6 binary for the host architecture.
- `sysstat` for `pidstat` and `mpstat`, and `curl` for readiness checks.
- Available host ports 8000, 9090, and 3000.

See [the EC2 Graviton guide](EC2-GRAVITON.md) for instance setup, Arm64 k6
installation, SSH access, and viewing remote Grafana from a Windows browser.

## Start the services

From the repository root:

```bash
docker compose up -d
docker compose ps
```

Use `sudo docker` if your user does not have access to the Docker daemon.

| Service | Address | Purpose |
| --- | --- | --- |
| go-httpbin | `http://localhost:8000` | Generate HTTP responses |
| Prometheus | `http://localhost:9090` | Receive and store k6 metrics |
| Grafana | `http://localhost:3000` | View the provisioned k6 Prometheus dashboard |

go-httpbin uses host networking and listens directly on `127.0.0.1:8000`.
This avoids Docker's published-port forwarding path for the workload.
`LOG_LEVEL=WARN` suppresses per-request INFO logging to reduce overhead.

Grafana enables anonymous administrator access. Grafana and Prometheus
publish their ports on all host interfaces. On EC2, keep those ports closed
in the security group and use the SSH tunnel described in the EC2 guide.

Before generating load, verify readiness:

```bash
curl -fsS http://127.0.0.1:8000/bytes/4096 -o /tmp/httpbin-response
wc -c /tmp/httpbin-response
curl -fsS http://127.0.0.1:9090/-/ready
curl -fsS http://127.0.0.1:3000/api/health
k6 inspect k6/scripts/httpbin-bytes.js
```

The response file should contain 4096 bytes. Retry readiness checks if
services are still starting. Use `docker compose logs --tail=100` to
investigate failures. These checks verify service readiness and script
configuration, not behavior under load.

## Monitor CPU and memory

Before starting the test, run these commands in separate terminals on the
Docker host. Capture all processes so that Docker, Prometheus, and Grafana
are included, along with overall and per-core CPU activity:

```bash
pidstat -u -r -h -l -p ALL 10 | tee process-usage.log
```

```bash
mpstat -P ALL 10 | tee cpu-all.log
```

For a smaller log focused on k6 and go-httpbin, add `-C 'k6|httpbin'` to
the `pidstat` command. Start the monitors close together to help compare
their sampling windows.

- `pidstat` reports CPU (`-u`) and memory (`-r`), with full command lines
  (`-l`). RSS reports resident memory in KiB.
- Process `%CPU` of 100 means one fully occupied CPU core. Both k6 and
  go-httpbin can exceed 100%. Process `%system` is included in `%CPU`;
  `%wait` describes waiting to be scheduled, not disk I/O wait.
- The `mpstat` `all` row is averaged across CPUs. It separates user,
  system, soft-interrupt, and idle time; individual rows reveal imbalance.

See the [pidstat manual](https://man7.org/linux/man-pages/man1/pidstat.1.html)
for column definitions. Stop the monitors with **Ctrl+C** after k6 and its
in-flight requests finish. The example logs are overwritten on each run;
use different filenames or run directories to preserve comparisons.

## Run the benchmark

From the repository root, for console results without streaming metrics:

```bash
k6 run -e TARGET_VUS=50 -e BYTES=4096 k6/scripts/httpbin-bytes.js
```

To also send metrics to Prometheus for viewing in Grafana:

```bash
run_id="httpbin-$(date -u +%Y%m%dT%H%M%SZ)"

K6_PROMETHEUS_RW_SERVER_URL=http://127.0.0.1:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS='p(95),p(99),min,max' \
K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=false \
k6 run --out experimental-prometheus-rw \
  --tag "testid=$run_id" \
  -e TARGET_VUS=50 -e BYTES=4096 \
  k6/scripts/httpbin-bytes.js
```

The unique `testid` distinguishes runs in Grafana. The trend settings match
the provisioned dashboard. k6 pushes metrics to Prometheus; Prometheus does
not scrape k6 in this setup. See the
[Prometheus output documentation](https://grafana.com/docs/k6/latest/results-output/real-time/prometheus-remote-write/).

Open Grafana and select **Dashboards → k6 Prometheus**, choose the run's
`testid`, and set the time range to cover the test. A 5-second dashboard
refresh is useful during a run. Dashboard refresh and query step are
separate from the frequency at which k6 pushes metrics.

## Workload configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TARGET_VUS` | `10` | Final VU count; integer at least 1 |
| `BYTES` | `1024` | Requested response size; integer from 0 to 102400 |
| `BASE_URL` | `http://localhost:8000` | Target base URL |

The test ramps linearly from 1 VU to `TARGET_VUS` over 10 minutes. Each VU
continuously sends sequential GET requests with no added sleep. The run
ends after the ramp, with up to 30 seconds for in-flight requests to finish.
There is no hold stage at the final VU count.

VUs control concurrency, not a fixed request rate: achieved RPS depends on
how quickly requests complete. Change `BYTES` to explore response-size
effects, and `TARGET_VUS` to explore concurrency and throughput limits.

Response bodies are discarded with `discardResponseBodies: true` to reduce
memory use and garbage collection, following the
[k6 guidance](https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/#save-memory-with-discardresponsebodies).
The workload checks HTTP status 200, but does not validate response-body
length. All requests must succeed and all status checks must pass for a
successful exit. Latency is reported without an imposed latency threshold.
The script enforces a 100 KiB maximum for `BYTES`.

## Compare runs

Record the machine or EC2 instance type, CPU count, RAM, operating system,
repository commit, k6 version, and container image IDs:

```bash
git rev-parse HEAD
k6 version
docker compose images
```

Also record workload settings, networking mode, log level, and whether
Prometheus output and dashboard refresh were enabled. The Compose file
uses `latest` tags, so later pulls can change the software being benchmarked.

Compare k6 CPU and resident memory at similar achieved RPS and response
sizes. Inspect sustained throughput and latency alongside errors and
whole-machine utilization. Repeat runs and change one variable at a time;
isolated peaks are less useful than repeatable behavior over matching
intervals. Monitoring has its own cost, especially when it shares the host.

Moving the target and monitoring to other machines can help isolate k6's
resource requirements, but also changes the network path and should be
recorded as a separate configuration.

## Save results and stop the services

Keep console summaries and monitoring logs with the run metadata. For CSV
analysis, set an absolute time range in Grafana, then use each panel's
**Inspect → Data → Download CSV**. CSV exports contain panel query results;
dashboard JSON contains layout and queries, not measurements.

The Compose setup does not explicitly configure persistent metrics storage.
Export results you need before removing or recreating containers. To stop
and remove the services:

```bash
docker compose down
```

On EC2, stop or terminate the instance separately when finished; stopping
the Compose stack does not stop EC2 compute charges.
