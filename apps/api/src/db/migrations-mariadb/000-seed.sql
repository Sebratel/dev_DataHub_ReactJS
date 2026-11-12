-- Dados iniciais de um banco NOVO (os mesmos do 001-init.sql do Postgres):
-- o tenant e os três papéis de fábrica. Separado do 000-base.sql de propósito:
-- quando o banco é preenchido pela CÓPIA do Postgres (scripts/metaCopy.ts),
-- estes registros vêm de lá, com os ids de lá — o copiador marca este arquivo
-- como aplicado sem rodá-lo.
INSERT INTO tenants (slug, name)
SELECT 'sebratel', 'Sebratel' FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE slug = 'sebratel');

INSERT INTO roles (tenant_id, name, builtin)
SELECT t.id, r.name, TRUE
  FROM tenants t
  JOIN (SELECT 'admin' AS name UNION ALL SELECT 'editor' UNION ALL SELECT 'viewer') r
 WHERE t.slug = 'sebratel'
   AND NOT EXISTS (SELECT 1 FROM roles x WHERE x.tenant_id = t.id AND x.name = r.name);
