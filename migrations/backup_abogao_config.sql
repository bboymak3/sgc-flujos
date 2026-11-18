-- Respaldo exacto de la configuración de abogao (tenant 39 / t_abogao).
-- Generado el 2026-11-18 desde D1 "citas". Restaurable en cualquier momento.
-- Incluye: custom_prompt, welcome_message y los 12 pasos del flujo de visitas.

INSERT INTO sgc_cit_config (tenant_id, clave, valor) VALUES (39, 'custom_prompt', 'Eres Sofi, la asistente virtual de WhatsApp de PACHECO INMOBILIARIA UNIVERSAL. Tu único rubro es la compra, venta, alquiler y visitas de propiedades. NO ofrezcas servicios legales, notariales ni de abogacía.

FECHA Y HORA:
- Zona horaria: America/Caracas (Venezuela).
- Horario de atención: lunes a viernes 08:00-18:00, sábado 09:00-14:00, domingo cerrado.
- Si el cliente pide cita para hoy y ya pasó el horario, sugiere mañana.

TOOLS (úsalas, NUNCA inventes datos):
1. buscar_propiedades: operacion (venta/alquiler), tipo (casa/apartamento/edificio/finca/terreno/local), precio_max, ubicacion, limite (máx 5).
2. enviar_fotos_propiedad: image_urls (URLs reales de gallery_images) y caption.
3. agendar_cita: fecha (YYYY-MM-DD), hora (HH:MM), servicio (nombre de la propiedad o "Visita a propiedad").
4. verificar_disponibilidad: fecha, hora. Si devuelve horarios_sugeridos, ofrécelos.
5. consultar_citas_cliente: teléfono.
6. cancelar_cita: cita_id.
7. registrar_vendedor: cuando el cliente quiera vender, llámala sin pedir datos.

REGLA CRÍTICA ANTI-ALUCINACIÓN:
- NUNCA inventes URLs, precios, características ni nombres de propiedades.
- NUNCA uses placeholders como [insertar URL], SLUG1 o ejemplo.com.
- Las URLs reales son https://pachecoinmobiliariauniversal.com/propiedad/SLUG
- Si la tool no devuelve resultados, dile que no hay propiedades con esos criterios.
- Si preguntan qué servicios ofreces, responde siempre: compra, venta, alquiler y visitas de propiedades.
- NUNCA respondas con frases internas como "uso la herramienta" ni menciones herramientas.
- NUNCA agendes ni confirmes una cita sin que el cliente dé fecha y hora. Si faltan, pregúntalas.

CÓMO RESPONDER:
- Propiedades: el sistema ya consulta el catálogo por ti. Muestra SOLO título, precio, ubicación y URL de lo que devuelva la tool. No pidas tipo ni presupuesto si ya hay opciones.
- Fotos: el sistema envía las fotos reales de la propiedad elegida. Nunca inventes URLs de fotos.
- Visitas: pregunta propiedad, día y hora; verifica disponibilidad y confirma antes de agendar. NUNCA digas "te agendé" sin haber agendado.
- Vender: llama registrar_vendedor de inmediato, sin pedir datos.

PERSONALIDAD: cercana, amable y profesional. Usa "usted". Formato WhatsApp con *negrita*, sin markdown []() ni tablas. Máximo 3-4 líneas salvo listados.

RECUERDA: Eres Sofi de PACHECO INMOBILIARIA UNIVERSAL. Usa las tools. Nunca inventes datos.')
ON CONFLICT(tenant_id, clave) DO UPDATE SET valor = excluded.valor;

INSERT INTO sgc_cit_config (tenant_id, clave, valor) VALUES (39, 'welcome_message', 'Hola 👋 bienvenido a PACHECO INMOBILIARIA UNIVERSAL 😊

🏠 Quiero comprar o alquilar una propiedad
📸 Ver fotos de una propiedad
📅 Agendar una visita
💼 Quiero vender mi propiedad')
ON CONFLICT(tenant_id, clave) DO UPDATE SET valor = excluded.valor;

-- Flujo: propiedades + selección + agendamiento de visita
INSERT INTO sgc_flu_Config (tenant_id, flujo_id, activo, modo, custom_pasos_json, updated_at)
VALUES (39, 6, 1, 'mixto', '[{"id": 0, "tipo": "saludo", "mensaje": "👋 Hola, soy Sofi de PACHECO INMOBILIARIA UNIVERSAL en Barinas, Venezuela. ¿Buscas venta o alquiler?"}, {"id": 1, "tipo": "pregunta", "campo": "operacion", "mensaje": "¿Venta o alquiler?", "espera": "texto", "sinonimos": {"comprar": "venta", "compra": "venta", "compraventa": "venta", "quiero comprar": "venta", "alquilar": "alquiler", "alquilo": "alquiler", "rentar": "alquiler", "renta": "alquiler", "arrendar": "alquiler", "quiero alquilar": "alquiler"}, "valores_aceptados": ["venta", "alquiler"], "mensaje_error": "❌ Responde ''venta'' o ''alquiler''."}, {"id": 2, "tipo": "pregunta", "campo": "presupuesto", "mensaje": "¿Cuál es tu presupuesto en USD? (ej: 50000, o ''cualquiera'')", "espera": "texto", "sinonimos": {"cualquiera": "99999999", "sin limite": "99999999", "sin límite": "99999999", "no tengo limite": "99999999", "no se": "99999999", "no sé": "99999999", "indiferente": "99999999"}}, {"id": 3, "tipo": "api_call", "url": "https://bot.makeseo.app/api/properties/public?t=abogao&operacion={operacion}&precio_max={presupuesto}&limite=5", "campo_resultados": "properties", "template_item": "#{num} 🏠 {title} - ${price} {currency} ({bedrooms}h {bathrooms}b) - {city}\n   🔗 {url}", "template_mensaje": "🔍 Encontré {total} propiedades en Barinas:\n\n{lista}\n\n¿Te interesa alguna? Responde con el número o ''ver más''.", "campo_guardar": "resultados_busqueda", "max_items": 5, "rango_presupuesto": true, "mensaje_vacio": "😔 No encontré propiedades con esos criterios. Empecemos de nuevo.", "mensaje_error": "⚠️ Tuve un problema consultando el catálogo. Intenta de nuevo.", "espera": "respuesta"}, {"id": 4, "tipo": "pregunta", "campo": "propiedad_seleccionada", "mensaje": "¿Cuál te interesa? (número o nombre)", "espera": "texto"}, {"id": 5, "tipo": "mensaje", "resolver_seleccion": "propiedad_seleccionada", "mensaje": "✅ Elegiste: {propiedad_seleccionada_titulo}\n🔗 https://pachecoinmobiliariauniversal.com/propiedad/{propiedad_seleccionada_slug}\n\n¿Quieres agendar una visita? (si/no)", "espera": "respuesta"}, {"id": 6, "tipo": "pregunta", "campo": "quiere_visita", "mensaje": "¿Agendamos la visita? (si/no)", "espera": "texto"}, {"id": 7, "tipo": "pregunta", "campo": "fecha", "mensaje": "📅 ¿Qué día? (ej: mañana, o 2026-11-20)", "espera": "texto"}, {"id": 8, "tipo": "pregunta", "campo": "hora", "mensaje": "⏰ ¿A qué hora? (ej: 10am, 3pm, 15:00)", "espera": "texto"}, {"id": 9, "tipo": "pregunta", "campo": "nombre", "mensaje": "👤 ¿Cómo te llamas?", "espera": "texto"}, {"id": 10, "tipo": "confirmacion", "mensaje": "📋 Confirmo visita:\n\n🏠 {propiedad_seleccionada_titulo}\n📅 {fecha} a las {hora}\n👤 {nombre}\n\n¿Confirmas? (si/no)", "espera": "confirmacion"}, {"id": 11, "tipo": "crear_cita", "mensaje": "🎉 ¡Visita agendada!\n\n🏠 {propiedad_seleccionada_titulo}\n📅 {fecha} a las {hora}\n👤 {nombre}\n\nTe esperamos en Barinas.", "espera": "fin"}]', datetime('now'))
ON CONFLICT(tenant_id) DO UPDATE SET
  flujo_id = excluded.flujo_id,
  activo = excluded.activo,
  modo = excluded.modo,
  custom_pasos_json = excluded.custom_pasos_json,
  updated_at = datetime('now');

-- Verificación:
-- SELECT clave, length(valor) FROM sgc_cit_config WHERE tenant_id=39;
-- SELECT flujo_id, activo, modo, length(custom_pasos_json) FROM sgc_flu_Config WHERE tenant_id=39;
