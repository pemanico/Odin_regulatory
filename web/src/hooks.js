import { useEffect, useRef, useState } from 'react';

/** Loads async data; reloads when `deps` change. Ignores stale responses. */
export function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(fn)
      .then((data) => id === seq.current && setState({ loading: false, data, error: null }))
      .catch((error) => id === seq.current && setState({ loading: false, data: null, error }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** Keyboard shortcuts (ignored while focus is in a text field, except Escape). */
export function useKeys(handlers, deps) {
  useEffect(() => {
    const on = (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (typing && e.key !== 'Escape') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const h = handlers[e.key];
      if (h) { e.preventDefault(); h(e); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
