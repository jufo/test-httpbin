# httpbin bytes ramp test

## Start httpbin

From the repository root, activate the virtual environment and start httpbin:

```bash
source .venv/bin/activate
gunicorn --bind 127.0.0.1:8000 httpbin:app
```

Leave this terminal running while you test.

## Start Prometheus and Grafana (optional)

From the `k6-oss-workshop` project directory, run:

```bash
docker compose up -d
```

Use `docker ps` to see the published ports for Prometheus and Grafana.

## Capture CPU usage every 10 seconds

Use `pidstat` (provided by the `sysstat` package) on the host where both k6
and httpbin processes are visible. Before starting the test, run this in a
separate terminal:

```bash
pidstat -u -h -l -p ALL -C 'k6|gunicorn|httpbin|python' 10 \
  | tee cpu-usage.log
```

Run one of the k6 commands below in another terminal. Once the test finishes,
including any in-flight requests, stop pidstat with **Ctrl+C**.
`cpu-usage.log` contains the readings and is overwritten each time this
command runs; use a different filename to preserve earlier runs.

The monitor reports CPU usage averaged over each 10-second interval:

- `-u` selects CPU statistics; `-h` keeps each record on one line.
- `-l` includes full command lines so you can identify the processes.
- `-p ALL` discovers processes throughout the run, including new workers;
  `-C` filters by command name. The filter can include unrelated Python
  processes, so identify httpbin using its command line.
- `%CPU` of 100 means one fully occupied CPU core. Multithreaded k6 can
  exceed 100%. For httpbin with multiple workers, sum their `%CPU` values
  at each timestamp to get the total for the service.

See the [pidstat manual](https://man7.org/linux/man-pages/man1/pidstat.1.html)
for additional options.

## Run the test

From the repository root in another terminal:

```bash
k6 run -e TARGET_VUS=50 -e BYTES=4096 k6/scripts/httpbin-bytes.js
```

To also send metrics to Prometheus for viewing in Grafana:

```bash
k6 run --out=experimental-prometheus-rw \
  -e TARGET_VUS=50 -e BYTES=4096 \
  k6/scripts/httpbin-bytes.js
```

## Configuration and test behavior

| Variable | Default | Meaning |
| --- | --- | --- |
| `TARGET_VUS` | `10` | Final VU count; integer at least 1 |
| `BYTES` | `1024` | Requested response size; integer from 0 to 102400 |
| `BASE_URL` | `http://localhost:8000` | httpbin base URL |

The test ramps linearly from 1 VU to `TARGET_VUS` over 10 minutes.
Each VU continuously sends sequential GET requests with no added sleep.
The run ends after the ramp, with up to 30 seconds for in-flight requests
to finish. There is no hold stage at the final VU count.

Response bodies are discarded with `discardResponseBodies: true` to reduce
load-generator memory use and garbage collection, following the
[k6 guidance](https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/#save-memory-with-discardresponsebodies).
This experiment checks HTTP status only; it no longer validates the received
byte count. All requests must succeed and all status checks must pass for a
successful exit. Latency is reported without an arbitrary latency threshold.

The locally installed httpbin caps `/bytes/{n}` responses at 100 KiB (102400
bytes). The script validates this limit before generating traffic.

## Validation

The response-body experiment passed `k6 inspect` and a local smoke run with
1 VU, 1 iteration, and `BYTES=4096` (exit 0): HTTP 200, 1/1 checks passed,
and no failed HTTP requests. A temporary wrapper replaced the ramp scenario
for the smoke run. This verifies basic functionality; it does not measure
performance improvement or validate the full 10-minute ramp.
