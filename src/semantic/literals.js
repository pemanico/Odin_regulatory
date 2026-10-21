// Safe rendering of SQL literals.
// Filter values may come from the LLM: they are validated by type and escaped here.
// Identifiers (columns, tables) NEVER come from the request: only from the catalog (whitelist).

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STRING = 200;

export function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function dateLiteral(value) {
  if (!isValidDate(value)) throw new ValidationError(`Invalid date (expected YYYY-MM-DD): ${JSON.stringify(value)}`);
  return `'${value}'`;
}

export function stringLiteral(value) {
  if (typeof value !== 'string') throw new ValidationError(`Expected text: ${JSON.stringify(value)}`);
  if (value.length > MAX_STRING) throw new ValidationError(`Text too long (max. ${MAX_STRING})`);
  if (/[\u0000-\u001f]/.test(value)) throw new ValidationError('Text contains control characters');
  return `'${value.replace(/'/g, "''")}'`;
}

export function intValue(value, { min = 1, max = 1000 } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`Invalid integer (between ${min} and ${max}): ${JSON.stringify(value)}`);
  }
  return n;
}

export function literalFor(type, value) {
  return type === 'date' ? dateLiteral(value) : stringLiteral(value);
}
