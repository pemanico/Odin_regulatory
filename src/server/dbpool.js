// Short-lived connection to the DuckDB database (plan approved on 2026-10-20, question 7):
// the server opens the database READ_ONLY when a request arrives and closes it when no request is in flight.
// This way `npm run build:db` and `npm run rules` can run while the server is up (DuckDB only accepts one process
// with write access OR several read-only ones). Concurrent requests share the same connection.

export class DbBusyError extends Error {
  constructor(cause) {
    super(
      'The database is being updated (npm run build:db or npm run rules running?). Try again in a moment.',
    );
    this.name = 'DbBusyError';
    this.cause = cause;
  }
}

/** true if the driver error is a file lock (another process with write access). */
export function isLockError(err) {
  return /lock|being used by another process|conflicting/i.test(String(err?.message ?? ''));
}

/**
 * @param open   () => Promise<db>  (db = { all, exec, close, dialect })
 * @param opts.keepOpen  do not close at the end (tests with in-memory SQLite)
 */
export function createDbPool(open, { keepOpen = false } = {}) {
  let db = null;
  let opening = null;
  let users = 0;

  async function acquire() {
    users += 1;
    try {
      if (!db) {
        opening ??= open();
        db = await opening;
        opening = null;
      }
      return db;
    } catch (err) {
      users -= 1;
      opening = null;
      throw isLockError(err) ? new DbBusyError(err) : err;
    }
  }

  async function release() {
    users -= 1;
    if (users === 0 && db && !keepOpen) {
      const d = db;
      db = null;
      await d.close();
    }
  }

  return {
    /** Runs `fn(db)` with the database open. */
    async with(fn) {
      const d = await acquire();
      try {
        return await fn(d);
      } catch (err) {
        throw isLockError(err) ? new DbBusyError(err) : err;
      } finally {
        await release();
      }
    },
    get dialect() {
      return db?.dialect;
    },
  };
}
