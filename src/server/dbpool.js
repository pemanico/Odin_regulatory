// Ligação curta à base DuckDB (plano aprovado em 2026-10-20, pergunta 7):
// o servidor abre a base em READ_ONLY quando chega um pedido e fecha-a quando já não há pedidos em curso.
// Assim `npm run build:db` e `npm run rules` podem correr com o servidor ligado (o DuckDB só aceita um processo
// com escrita OU vários só de leitura). Pedidos em simultâneo partilham a mesma ligação.

export class DbBusyError extends Error {
  constructor(cause) {
    super(
      'A base de dados está a ser atualizada (npm run build:db ou npm run rules a correr?). Tente de novo dentro de momentos.',
    );
    this.name = 'DbBusyError';
    this.cause = cause;
  }
}

/** true se o erro do driver for de lock do ficheiro (outro processo com escrita). */
export function isLockError(err) {
  return /lock|being used by another process|conflicting/i.test(String(err?.message ?? ''));
}

/**
 * @param open   () => Promise<db>  (db = { all, exec, close, dialect })
 * @param opts.keepOpen  não fechar no fim (testes com SQLite em memória)
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
    /** Corre `fn(db)` com a base aberta. */
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
