// D1 execution and measurements only; callers own the SQL and transaction boundaries.
export type Statement = [sql: string, ...params: unknown[]];

export async function query<T = unknown>(db: D1Database, operation: string, ...[sql, ...params]: Statement) {
  return measure(operation, () => {
    const statement = db.prepare(sql);
    return (params.length ? statement.bind(...params) : statement).all<T>();
  });
}

export async function batch<T = unknown>(db: D1Database, operation: string, statements: Statement[]) {
  return measure(operation, () => db.batch<T>(statements.map(([sql, ...params]) => db.prepare(sql).bind(...params))));
}

async function measure<T extends D1Result | D1Result[]>(operation: string, execute: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await execute();
    const results = Array.isArray(result) ? result : [result];
    console.log(JSON.stringify({
      event: "d1_query",
      operation,
      status: "ok",
      duration_ms: Math.round(performance.now() - started),
      statements: results.length,
      sql_duration_ms: results.reduce((sum, { meta }) => sum + (meta.timings?.sql_duration_ms ?? meta.duration), 0),
      rows_read: results.reduce((sum, { meta }) => sum + meta.rows_read, 0),
      rows_written: results.reduce((sum, { meta }) => sum + meta.rows_written, 0),
      rows_returned: results.reduce((sum, { results }) => sum + results.length, 0),
    }));
    return result;
  } catch (error) {
    // SQL, parameters and third-party error messages can contain private data.
    console.warn(JSON.stringify({ event: "d1_query", operation, status: "error", duration_ms: Math.round(performance.now() - started) }));
    throw error;
  }
}
