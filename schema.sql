-- SGC Flujos — Schema
-- Tablas con prefijo sgc_flu_ en database citas

CREATE TABLE IF NOT EXISTS sgc_flu_Plantillas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rubro TEXT NOT NULL,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  pasos_json TEXT NOT NULL DEFAULT "[]",
  created_at TEXT DEFAULT (datetime("now")),
  updated_at TEXT DEFAULT (datetime("now"))
);

CREATE TABLE IF NOT EXISTS sgc_flu_Config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL UNIQUE,
  flujo_id INTEGER,
  activo INTEGER DEFAULT 0,
  custom_pasos_json TEXT,
  modo TEXT DEFAULT "flujo",
  created_at TEXT DEFAULT (datetime("now")),
  updated_at TEXT DEFAULT (datetime("now"))
);

CREATE TABLE IF NOT EXISTS sgc_flu_Sesiones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  phone TEXT,
  paso_actual INTEGER DEFAULT 0,
  datos_json TEXT DEFAULT "{}",
  estado TEXT DEFAULT "activa",
  created_at TEXT DEFAULT (datetime("now")),
  updated_at TEXT DEFAULT (datetime("now"))
);

CREATE INDEX IF NOT EXISTS idx_sgc_flu_config_tenant ON sgc_flu_Config(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sgc_flu_sesiones_tenant_phone ON sgc_flu_Sesiones(tenant_id, phone);
