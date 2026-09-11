import http from 'k6/http';
import { check } from 'k6';

function integerEnv(name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const raw = __ENV[name] === undefined ? String(fallback) : __ENV[name];
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; got "${raw}"`);
  }
  return value;
}

const targetVUs = integerEnv('TARGET_VUS', 10, 1);
// This httpbin implementation caps /bytes responses at 100 KiB.
const bytes = integerEnv('BYTES', 1024, 0, 102400);
const baseURL = (__ENV.BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');

export const options = {
  discardResponseBodies: true,
  scenarios: {
    bytes_ramp: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [{ duration: '10m', target: targetVUs }],
      // Allow in-flight requests to finish after the ten-minute ramp.
      gracefulStop: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export default function () {
  // Each VU sends sequential requests continuously, with no artificial delay.
  const response = http.get(`${baseURL}/bytes/${bytes}`, {
    timeout: '30s',
    redirects: 0,
    tags: { name: 'GET /bytes/{n}' },
  });

  check(response, {
    'status is 200': (r) => r.status === 200,
  });
}
