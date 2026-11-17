-- Activar el flujo de Abogados (plantilla id=9) para el tenant abogao (id=39).
-- El motor de flujos se usa SOLO para agendamiento; el listado de propiedades
-- se resuelve con la tool buscar_propiedades contra tenant_properties (D1).
-- Ejecutar en la base de datos D1 "citas" (compartida por sgc-saas y sgc-flujos).

INSERT INTO sgc_flu_Config (tenant_id, flujo_id, activo, custom_pasos_json, modo)
VALUES (39, 9, 1, NULL, 'mixto')
ON CONFLICT(tenant_id) DO UPDATE SET
  flujo_id = excluded.flujo_id,
  activo = excluded.activo,
  custom_pasos_json = NULL,
  modo = excluded.modo,
  updated_at = datetime('now');

-- Verificación:
-- SELECT tenant_id, flujo_id, activo, modo FROM sgc_flu_Config WHERE tenant_id = 39;
