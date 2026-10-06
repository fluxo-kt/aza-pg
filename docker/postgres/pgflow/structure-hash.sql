-- Fingerprint of the pgflow schema's STRUCTURE, used by pgflow-upgrade to recognise which pgflow release created a
-- database that predates the "pgflow X.Y.Z" schema comment, and by its tests to build the table of known releases.
-- Structure only — tables, columns, constraints, indexes, enum labels, function signatures — because function bodies,
-- function settings and the aza_* helper functions were changed by aza-pg's own patches between image releases, so
-- two databases of one pgflow release can differ there. Index names are dropped: a release defines the index, not
-- the name a given install path chose. Prints one md5 (empty schema → md5 of the empty string).
-- regclass, regprocedure and format_type print names relative to search_path, and a database owner can set it; fixed
-- here, the hash depends on the structure alone (run with psql -q, or the SET's command tag precedes the md5).
SET
  search_path = pg_catalog,
  pg_temp;


SELECT
  md5(
    coalesce(
      string_agg(
        item,
        E'\n'
        ORDER BY
          item
      ),
      ''
    )
  )
FROM
  (
    SELECT
      'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE
        WHEN a.attnotnull THEN ' not null'
        ELSE ''
      END || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') AS item
    FROM
      pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid
      AND d.adnum = a.attnum
    WHERE
      c.relnamespace = 'pgflow'::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm')
      AND a.attnum > 0
      AND NOT a.attisdropped
    UNION ALL
    SELECT
      'constraint ' || conrelid::regclass || ' ' || pg_get_constraintdef(oid)
    FROM
      pg_constraint
    WHERE
      connamespace = 'pgflow'::regnamespace
    UNION ALL
    SELECT
      'index ' || regexp_replace(pg_get_indexdef(i.indexrelid), 'INDEX \S+ ON', 'INDEX ON')
    FROM
      pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
    WHERE
      c.relnamespace = 'pgflow'::regnamespace
    UNION ALL
    SELECT
      'enum ' || t.typname || ' ' || string_agg(
        e.enumlabel,
        ','
        ORDER BY
          e.enumsortorder
      )
    FROM
      pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE
      t.typnamespace = 'pgflow'::regnamespace
    GROUP BY
      t.typname
    UNION ALL
    SELECT
      'function ' || p.oid::regprocedure
    FROM
      pg_proc p
    WHERE
      p.pronamespace = 'pgflow'::regnamespace
      AND p.proname NOT LIKE 'aza\_%'
  ) structure;