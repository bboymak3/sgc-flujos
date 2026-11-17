-- Tenant 39 (abogao) = PACHECO INMOBILIARIA UNIVERSAL.
-- Solo propiedades y visitas. Sin servicios legales/notariales.
-- Ejecutar en D1 "citas" (compartida por sgc-saas y sgc-flujos).

UPDATE tenants SET rubro = 'Inmobiliaria' WHERE id = 39;

UPDATE sgc_cit_config SET valor = 'Eres Sofi, asistente de PACHECO INMOBILIARIA UNIVERSAL. Solo compra, venta, alquiler y visitas de propiedades. NO ofrezcas servicios legales ni notariales.

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

-- Flujo custom de agendamiento de visitas (plantilla "Personalizado" id=6)
UPDATE sgc_flu_Config
SET flujo_id = 6,
    activo = 1,
    modo = 'mixto',
    custom_pasos_json = '[{"id":0,"tipo":"saludo","mensaje":"¡Hola! Te ayudo a agendar una visita a la propiedad."},{"id":1,"tipo":"pregunta","campo":"servicio","mensaje":"¿Qué propiedad te interesa? (ej: Casa en La Hormiga)"},{"id":2,"tipo":"pregunta","campo":"fecha","mensaje":"¿Para qué día te queda bien? (ej: 2026-11-20)"},{"id":3,"tipo":"pregunta","campo":"hora","mensaje":"¿A qué hora? (ej: 10:00)"},{"id":4,"tipo":"confirmacion","mensaje":"Confirmas la visita a {servicio} el {fecha} a las {hora}? (sí/no)"},{"id":5,"tipo":"crear_cita","mensaje":"¡Listo! Agendamos tu visita a {servicio} el {fecha} a las {hora}. ¡Te esperamos!"}]',
    updated_at = datetime('now')
WHERE tenant_id = 39;

-- Verificación:
-- SELECT id, slug, rubro FROM tenants WHERE id = 39;
-- SELECT tenant_id, flujo_id, activo, modo FROM sgc_flu_Config WHERE tenant_id = 39;
