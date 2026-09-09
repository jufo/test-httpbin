# httpbin bytes ramp test

Run from the repository root:

```bash
k6 run -e TARGET_VUS=50 -e BYTES=4096 k6/scripts/httpbin-bytes.js
```

Configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TARGET_VUS` | `10` | Final VU count; integer at least 1 |
| `BYTES` | `1024` | Requested response size; integer from 0 to 102400 |
| `BASE_URL` | `http://localhost:8000` | httpbin base URL |

The test ramps linearly from 1 VU to `TARGET_VUS` over 10 minutes.
Each VU continuously sends sequential GET requests with no added sleep.
The run ends after the ramp, with up to 30 seconds for in-flight requests
to finish. There is no hold stage at the final VU count.

Responses are read as binary so the byte-count check measures bytes accurately.
All requests must succeed and all status/size checks must pass for a successful
exit. Latency is reported without an arbitrary latency threshold.

The locally installed httpbin caps `/bytes/{n}` responses at 100 KiB (102400
bytes). The script validates this limit before generating traffic.

Validation: the k6 MCP validator ran 1 VU / 1 iteration successfully (exit 0):
HTTP 200, 1024 response bytes, 2/2 checks passed, and no failed HTTP requests.
The validator overrides the scenario for this short check; it does not verify
the full 10-minute ramp. The full load test has not been run.
