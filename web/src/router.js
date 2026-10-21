// Hash router (#/top10, #/drill?field=ISIN...). The drill-down state lives in the URL:
// it is what the agent's open_drilldown tool will produce, and it allows copying/sharing the view.
import { useEffect, useState } from 'react';

export function parseHash(hash = window.location.hash) {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  return { view: path.replace(/^\//, '') || 'top10', params: Object.fromEntries(new URLSearchParams(query)) };
}

export function href(view, params = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const q = p.toString();
  return `#/${view}${q ? `?${q}` : ''}`;
}

export function navigate(view, params) {
  window.location.hash = href(view, params);
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
