-- Tenant 39 (abogao) = PACHECO INMOBILIARIA UNIVERSAL, Barinas - Venezuela.
-- Flujo PRIMERO: propiedades y visitas. La IA queda como fallback.
-- Sin contenido legal/notarial. Ejecutar en D1 "citas".

UPDATE tenants SET rubro = 'Inmobiliaria' WHERE id = 39;

UPDATE sgc_cit_config SET valor = 'Eres Sofi, asistente de PACHECO INMOBILIARIA UNIVERSAL en Barinas, Venezuela. Solo compra, venta, alquiler y visitas de propiedades. NO ofrezcas servicios legales ni notariales.

Zona horaria: America/Caracas (Venezuela). Horario: lun-vie 08:00-18:00, sab 09:00-14:00.

TOOLS (usalas, nunca inventes): buscar_propiedades (limite max 5), enviar_fotos_propiedad, agendar_cita, verificar_disponibilidad, consultar_citas_cliente, cancelar_cita, registrar_vendedor.

REGLA CRITICA: nunca inventes URLs, precios, caracteristicas ni nombres de propiedades. nunca uses SLUG1, [insertar URL] ni ejemplo.com. Si la tool no devuelve resultados, dilo.

Propiedades: muestra solo titulo, precio, ubicacion y URL de lo que devuelva la tool. No pidas tipo/presupuesto si ya hay opciones.
Fotos: el sistema envia las fotos reales de la propiedad elegida.
Visitas: pregunta propiedad, dia y hora; verifica y confirma antes de agendar. Nunca digas "te agende" sin haberlo hecho.
Vender: llama registrar_vendedor sin pedir datos.

Personalidad: cercana, amable, usa "usted". Formato WhatsApp, sin markdown. Maximo 3-4 lineas salvo listados.'
WHERE tenant_id = 39 AND clave = 'custom_prompt';

UPDATE sgc_cit_config SET valor = 'Hola 👋 bienvenido a PACHECO INMOBILIARIA UNIVERSAL 😊

🏠 Quiero comprar o alquilar una propiedad
📸 Ver fotos de una propiedad
📅 Agendar una visita
💼 Quiero vender mi propiedad'
WHERE tenant_id = 39 AND clave = 'welcome_message';

-- Flujo: busqueda de propiedades + seleccion + agendamiento de visita
UPDATE sgc_flu_Config
SET flujo_id = 6, activo = 1, modo = 'mixto',
    custom_pasos_json = '[{"id": 0, "tipo": "saludo", "mensaje": "👋 Hola, soy Sofi de PACHECO INMOBILIARIA UNIVERSAL en Barinas, Venezuela. ¿Buscas venta o alquiler?"}, {"id": 1, "tipo": "pregunta", "campo": "operacion", "mensaje": "¿Venta o alquiler?", "espera": "texto", "sinonimos": {"comprar": "venta", "compra": "venta", "compraventa": "venta", "quiero comprar": "venta", "alquilar": "alquiler", "alquilo": "alquiler", "rentar": "alquiler", "renta": "alquiler", "arrendar": "alquiler", "quiero alquilar": "alquiler"}, "valores_aceptados": ["venta", "alquiler"], "mensaje_error": "❌ Responde 'venta' o 'alquiler'."}, {"id": 2, "tipo": "pregunta", "campo": "presupuesto", "mensaje": "¿Cuál es tu presupuesto en USD? (ej: 50000, o 'cualquiera')", "espera": "texto", "sinonimos": {"cualquiera": "99999999", "sin limite": "99999999", "sin límite": "99999999", "no tengo limite": "99999999", "no se": "99999999", "no sé": "99999999", "indiferente": "99999999"}}, {"id": 3, "tipo": "api_call", "url": "https://bot.makeseo.app/api/properties/public?t=abogao&operacion={operacion}&precio_max={presupuesto}&limite=5", "campo_resultados": "properties", "template_item": "#{num} 🏠 {title} - ${price} {currency} ({bedrooms}h {bathrooms}b) - {city}\n   🔗 {url}", "template_mensaje": "🔍 Encontré {total} propiedades en Barinas:\n\n{lista}\n\n¿Te interesa alguna? Responde con el número o 'ver más'.", "campo_guardar": "resultados_busqueda", "max_items": 5, "rango_presupuesto": true, "mensaje_vacio": "😔 No encontré propiedades con esos criterios. Empecemos de nuevo.", "mensaje_error": "⚠️ Tuve un problema consultando el catálogo. Intenta de nuevo.", "espera": "respuesta"}, {"id": 4, "tipo": "pregunta", "campo": "propiedad_seleccionada", "mensaje": "¿Cuál te interesa? (número o nombre)", "espera": "texto"}, {"id": 5, "tipo": "mensaje", "resolver_seleccion": "propiedad_seleccionada", "mensaje": "✅ Elegiste: {propiedad_seleccionada_titulo}\n🔗 https://pachecoinmobiliariauniversal.com/propiedad/{propiedad_seleccionada_slug}\n\n¿Quieres agendar una visita? (si/no)", "espera": "respuesta"}, {"id": 6, "tipo": "pregunta", "campo": "quiere_visita", "mensaje": "¿Agendamos la visita? (si/no)", "espera": "texto"}, {"id": 7, "tipo": "pregunta", "campo": "fecha", "mensaje": "📅 ¿Qué día? (ej: mañana, o 2026-11-20)", "espera": "texto"}, {"id": 8, "tipo": "pregunta", "campo": "hora", "mensaje": "⏰ ¿A qué hora? (ej: 10am, 3pm, 15:00)", "espera": "texto"}, {"id": 9, "tipo": "pregunta", "campo": "nombre", "mensaje": "👤 ¿Cómo te llamas?", "espera": "texto"}, {"id": 10, "tipo": "confirmacion", "mensaje": "📋 Confirmo visita:\n\n🏠 {propiedad_seleccionada_titulo}\n📅 {fecha} a las {hora}\n👤 {nombre}\n\n¿Confirmas? (si/no)", "espera": "confirmacion"}, {"id": 11, "tipo": "crear_cita", "mensaje": "🎉 ¡Visita agendada!\n\n🏠 {propiedad_seleccionada_titulo}\n📅 {fecha} a las {hora}\n👤 {nombre}\n\nTe esperamos en Barinas.", "espera": "fin"}]',
    updated_at = datetime('now')
WHERE tenant_id = 39;

-- Verificacion:
-- SELECT tenant_id, flujo_id, activo, modo FROM sgc_flu_Config WHERE tenant_id = 39;
