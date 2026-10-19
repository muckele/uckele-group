const oldFields = "'seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes'";
const financialFields = "'annual_profit', 'annual_revenue', 'asking_price'";
const widen = (sql) => sql.includes("'annual_profit'") ? sql : sql.replaceAll(oldFields, `${oldFields}, ${financialFields}`);

// SQLite cannot ALTER an inline CHECK. Rebuild only that known constraint and
// retain the exact columns, data, foreign keys, indexes and trigger definitions.
// Legacy unconstrained tables keep their historical rows and future boundaries.
export function upgradeOperatorFinancialFacts(database) {
  const table = 'deal_hunter_opportunity_facts';
  const currentDefinitions = database.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL").all(table);
  if (currentDefinitions.every((row) => widen(row.sql) === row.sql)
    && ['operator_financial_fact_insert', 'operator_financial_fact_update'].every((name) => currentDefinitions.some((row) => row.name === name))) return;
  database.transaction(() => {
    const original = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
    const definitions = database.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table);
    if (original.includes(oldFields) && !original.includes("'annual_profit'")) {
      const incomingReferences = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
        .flatMap(({ name }) => database.pragma(`foreign_key_list(${JSON.stringify(name)})`)).filter((row) => row.table === table);
      if (incomingReferences.length) throw new Error('Financial fact upgrade requires review of incoming fact foreign keys.');
      database.exec(widen(original).replace(/CREATE TABLE\s+"?deal_hunter_opportunity_facts"?/i, 'CREATE TABLE operator_financial_upgrade'));
      const columns = database.pragma(`table_info(${table})`).map(({ name }) => `"${name.replaceAll('"', '""')}"`).join(',');
      database.exec(`INSERT INTO operator_financial_upgrade (${columns}) SELECT ${columns} FROM ${table}`);
      database.exec(`DROP TABLE ${table}; ALTER TABLE operator_financial_upgrade RENAME TO ${table}`);
      for (const definition of definitions) database.exec(widen(definition.sql));
    } else {
      for (const definition of definitions.filter((row) => row.type === 'trigger' && widen(row.sql) !== row.sql)) {
        database.exec(`DROP TRIGGER "${definition.name.replaceAll('"', '""')}"`);
        database.exec(widen(definition.sql));
      }
    }
    const text = "json_extract(NEW.value, '$.evidenceSource')";
    const amount = "json_extract(NEW.value, '$.amount')";
    const controls = Array.from({ length: 32 }, (_, i) => `instr(${text},char(${i}))=0`).join(' AND ');
    const valid = `CASE WHEN json_valid(NEW.value) THEN
      json_type(NEW.value)='object'
      AND (SELECT count(*)=6 AND count(DISTINCT key)=6 FROM json_each(NEW.value))
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.value) WHERE key NOT IN ('version','amount','currency','metric','period','evidenceSource'))
      AND json_type(NEW.value,'$.version')='integer' AND json_extract(NEW.value,'$.version')=1
      AND json_type(NEW.value,'$.amount')='text' AND length(${amount}) BETWEEN 4 AND 16
      AND ${amount} NOT GLOB '*[^0-9.-]*' AND printf('%.2f',CAST(${amount} AS REAL))=${amount}
      AND abs(CAST(${amount} AS REAL))<=999999999999.99
      AND (NEW.field='annual_profit' OR CAST(${amount} AS REAL)>=0)
      AND json_extract(NEW.value,'$.currency') IN ('USD','CAD','EUR','GBP','AUD','unknown')
      AND ((NEW.field='annual_profit' AND json_extract(NEW.value,'$.metric') IN ('sde','ebitda','unknown'))
        OR (NEW.field='annual_revenue' AND json_extract(NEW.value,'$.metric')='revenue')
        OR (NEW.field='asking_price' AND json_extract(NEW.value,'$.metric')='asking-price'))
      AND ((NEW.field='asking_price' AND json_extract(NEW.value,'$.period') IN ('current','unknown'))
        OR (NEW.field<>'asking_price' AND json_extract(NEW.value,'$.period') IN ('annual','trailing-twelve-months','unknown')))
      AND json_type(NEW.value,'$.evidenceSource')='text' AND length(${text}) BETWEEN 1 AND 500
      AND trim(${text})=${text} AND ${controls} AND instr(${text},char(127))=0
      ELSE 0 END`;
    for (const event of ['INSERT', 'UPDATE']) database.exec(`CREATE TRIGGER IF NOT EXISTS operator_financial_fact_${event.toLowerCase()}
      BEFORE ${event} ON ${table} WHEN NEW.field IN (${financialFields})
      BEGIN SELECT CASE WHEN (${valid}) IS NOT 1 THEN RAISE(ABORT,'invalid typed financial fact') END; END;`);
  }).immediate();
}
