import Database from 'better-sqlite3';

process.on('message', ({ sqlitePath }) => {
  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'deal_hunter_%'
      ORDER BY name
    `).all().map(({ name }) => name);
    process.send?.({ ok: true, tables });
  } catch (error) {
    process.send?.({ ok: false, error: error.message });
  } finally {
    database.close();
  }
});
