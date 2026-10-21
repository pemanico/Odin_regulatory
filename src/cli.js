// Minimal argument parser for the scripts (no dependencies).
// --key value | --key=value | --flag ; everything else goes to `_`.
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > -1) {
      pushArg(out, a.slice(2, eq), a.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      pushArg(out, a.slice(2), argv[++i]);
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

function pushArg(out, key, value) {
  if (key === 'filter' || key === 'map') {
    (out[key] ??= []).push(value);
  } else {
    out[key] = value;
  }
}
