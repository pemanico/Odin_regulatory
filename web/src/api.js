// API client. The agent tools (metrics/query) and the UI-only endpoints (keys) are kept apart on purpose.
async function call(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  return p.toString();
};

export const api = {
  meta: () => call('/api/meta'),
  metrics: () => call('/api/metrics'),
  questions: () => call('/api/questions'),
  query: (request) => call('/api/query', { method: 'POST', body: JSON.stringify(request) }),
  keys: (params) => call(`/api/keys?${qs(params)}`),
  key: (id, date) => call(`/api/keys/${encodeURIComponent(id)}?${qs({ date })}`),
};

/** Filters with the selected date. */
export const onDate = (date, extra = []) => [{ dimension: 'business_date', op: 'eq', value: date }, ...extra];
