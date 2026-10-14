// sgc-flujos Worker — Sistema de Flujos de Agendamiento
// API REST para gestionar flujos visuales de bots

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function jsonError(msg, status = 400) {
  return json({ error: msg }, status);
}

// JWT helpers
const JWT_SECRET = 'alianza58_secret_2024';

async function verifyJWT(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    const data = headerB64 + '.' + payloadB64;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    let sigB64 = signatureB64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = sigB64.length % 4;
    if (pad) sigB64 += '='.repeat(4 - pad);
    const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return await verifyJWT(auth.substring(7), env.JWT_SECRET || JWT_SECRET);
}

// === MOTOR DE FLUJOS ===
// Ejecuta un paso del flujo y devuelve la respuesta + siguiente paso

async function ejecutarPaso(env, tenantId, phone, mensajeUsuario) {
  // 1. Obtener configuración del flujo del tenant
  const config = await env.DB.prepare(
    'SELECT fc.*, fp.pasos_json, fp.rubro, fp.nombre FROM sgc_flu_Config fc LEFT JOIN sgc_flu_Plantillas fp ON fc.flujo_id = fp.id WHERE fc.tenant_id = ?'
  ).bind(tenantId).first();

  if (!config || !config.activo) {
    return { flujo_activo: false };
  }

  const modo = config.modo || 'flujo'; // 'flujo', 'mixto'

  // Determinar pasos a usar (custom o plantilla)
  let pasos;
  try {
    pasos = config.custom_pasos_json ? JSON.parse(config.custom_pasos_json) : JSON.parse(config.pasos_json || '[]');
  } catch (e) {
    pasos = [];
  }

  if (!pasos.length) {
    return { flujo_activo: false };
  }

  // 2. Obtener o crear sesión
  let sesion = await env.DB.prepare(
    'SELECT * FROM sgc_flu_Sesiones WHERE tenant_id = ? AND phone = ? AND estado = "activa" ORDER BY id DESC LIMIT 1'
  ).bind(tenantId, phone).first();

  if (!sesion) {
    // Crear sesión nueva
    const result = await env.DB.prepare(
      'INSERT INTO sgc_flu_Sesiones (tenant_id, phone, paso_actual, datos_json, estado) VALUES (?, ?, 0, "{}", "activa")'
    ).bind(tenantId, phone).run();
    sesion = { id: result.meta.last_row_id, paso_actual: 0, datos_json: '{}' };
  }

  let datos = {};
  try { datos = JSON.parse(sesion.datos_json || '{}'); } catch (e) {}

  const pasoActual = pasos[sesion.paso_actual] || pasos[0];

  // === MODO MIXTO: detectar si el mensaje está fuera del flujo ===
  if (modo === 'mixto' && pasoActual.tipo === 'pregunta') {
    const msgLower = (mensajeUsuario || '').toLowerCase().trim();
    // Palabras que indican que el cliente está preguntando algo fuera del flujo
    const fueraDeFlujo = [
      'precio', 'cuanto', 'cuánto', 'cuesta', 'vale', 'cost',
      'horario', 'hora abren', 'hora cierran', 'atienden', 'abierto',
      'donde', 'dónde', 'direccion', 'dirección', 'ubicacion', 'ubicación',
      'quien', 'quién', 'dueño', 'dueno',
      'que servicios', 'qué servicios', 'que hacen', 'qué hacen',
      'info', 'informacion', 'información',
      'cancelar', 'cancela', 'no quiero', 'despues', 'después',
      'gracias', 'muchas gracias', 'perfecto gracias',
      'reclamo', 'queja', 'problema',
      'pagos', 'pago', 'tarjeta', 'transferencia', 'efectivo',
      'estacionamiento', 'parking',
      'whatsapp', 'telefono', 'teléfono', 'contacto',
      'instagram', 'facebook', 'redes',
    ];
    
    const esFueraDeFlujo = fueraDeFlujo.some(palabra => msgLower.includes(palabra));
    
    if (esFueraDeFlujo) {
      // El mensaje está fuera del flujo → usar IA como fallback
      // NO avanzar el paso, mantener la sesión activa
      return {
        flujo_activo: true,
        usar_ia: true,
        razon: 'mensaje fuera de flujo',
        paso_actual: sesion.paso_actual,
        fin: false,
        datos_recopilados: datos
      };
    }
  }
  // === FIN MODO MIXTO ===

  // 3. Procesar según tipo de paso
  if (pasoActual.tipo === 'saludo') {
    // Avanzar al siguiente paso
    const nextPaso = sesion.paso_actual + 1;
    await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = ?, updated_at = datetime("now") WHERE id = ?')
      .bind(nextPaso, sesion.id).run();

    const siguientePaso = pasos[nextPaso];
    return {
      flujo_activo: true,
      respuesta: pasoActual.mensaje + '\n\n' + (siguientePaso ? siguientePaso.mensaje : ''),
      paso_actual: nextPaso,
      fin: !siguientePaso
    };
  }

  if (pasoActual.tipo === 'pregunta') {
    // Guardar la respuesta del usuario en datos
    datos[pasoActual.campo] = mensajeUsuario.trim();

    const nextPaso = sesion.paso_actual + 1;
    await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = ?, datos_json = ?, updated_at = datetime("now") WHERE id = ?')
      .bind(nextPaso, JSON.stringify(datos), sesion.id).run();

    const siguientePaso = pasos[nextPaso];
    if (siguientePaso) {
      return {
        flujo_activo: true,
        respuesta: siguientePaso.mensaje.replace(/\{(\w+)\}/g, (m, key) => datos[key] || ''),
        paso_actual: nextPaso,
        fin: false
      };
    }
    return { flujo_activo: true, respuesta: 'Gracias!', paso_actual: nextPaso, fin: true };
  }

  if (pasoActual.tipo === 'confirmacion') {
    // Verificar si el usuario confirma
    const confirma = /\b(si|s[ií]|claro|perfecto|ok|confirmo|dale|as[ií] es|correcto)\b/i.test(mensajeUsuario);
    const cancela = /\b(no|cancelar|no gracias|cambiar)\b/i.test(mensajeUsuario);

    if (confirma) {
      const nextPaso = sesion.paso_actual + 1;
      await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = ?, datos_json = ?, updated_at = datetime("now") WHERE id = ?')
        .bind(nextPaso, JSON.stringify(datos), sesion.id).run();

      const siguientePaso = pasos[nextPaso];
      return {
        flujo_activo: true,
        respuesta: siguientePaso ? siguientePaso.mensaje.replace(/\{(\w+)\}/g, (m, key) => datos[key] || '') : 'Listo!',
        paso_actual: nextPaso,
        fin: true,
        crear_cita: siguientePaso && siguientePaso.tipo === 'crear_cita',
        datos_cita: datos
      };
    } else if (cancela) {
      // Reiniciar flujo
      await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = 0, datos_json = "{}", updated_at = datetime("now") WHERE id = ?')
        .bind(sesion.id).run();
      return {
        flujo_activo: true,
        respuesta: 'No hay problema. Empecemos de nuevo. ' + pasos[0].mensaje,
        paso_actual: 0,
        fin: false
      };
    } else {
      // En modo mixto, si no confirma ni cancela, podría ser una pregunta → IA
      if (modo === 'mixto') {
        return {
          flujo_activo: true,
          usar_ia: true,
          razon: 'respuesta ambigua en confirmacion',
          paso_actual: sesion.paso_actual,
          fin: false,
          datos_recopilados: datos
        };
      }
      return {
        flujo_activo: true,
        respuesta: 'Por favor confirma: ¿sí o no?',
        paso_actual: sesion.paso_actual,
        fin: false
      };
    }
  }

  if (pasoActual.tipo === 'crear_cita') {
    // Marcar sesión como completada
    await env.DB.prepare('UPDATE sgc_flu_Sesiones SET estado = "completada", updated_at = datetime("now") WHERE id = ?')
      .bind(sesion.id).run();

    return {
      flujo_activo: true,
      respuesta: pasoActual.mensaje.replace(/\{(\w+)\}/g, (m, key) => datos[key] || ''),
      paso_actual: sesion.paso_actual,
      fin: true,
      crear_cita: true,
      datos_cita: datos
    };
  }

  // Si no coincide ningún tipo, avanzar
  const nextPaso = sesion.paso_actual + 1;
  await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = ?, updated_at = datetime("now") WHERE id = ?')
    .bind(nextPaso, sesion.id).run();

  return {
    flujo_activo: true,
    respuesta: pasos[nextPaso] ? pasos[nextPaso].mensaje : 'Gracias!',
    paso_actual: nextPaso,
    fin: !pasos[nextPaso]
  };
}

// === ENDPOINTS ===
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      // === HEALTH ===
      if (path === '/api/health') {
        return json({ ok: true, service: 'sgc-flujos', time: new Date().toISOString() });
      }

      // === MOTOR DE FLUJOS (interno, llamado por sgc-saas) ===
      // POST /api/motor/ejecutar — Ejecuta un paso del flujo
      if (path === '/api/motor/ejecutar' && method === 'POST') {
        const { tenant_id, phone, mensaje } = await request.json();
        if (!tenant_id || !phone) return jsonError('tenant_id y phone requeridos', 400);

        const resultado = await ejecutarPaso(env, parseInt(tenant_id), phone, mensaje || '');
        return json(resultado);
      }

      // GET /api/motor/estado?t=:tenant&phone=:phone — Verifica si el tenant tiene flujo activo
      if (path === '/api/motor/estado' && method === 'GET') {
        const tenantId = parseInt(url.searchParams.get('t') || '0');
        const phone = url.searchParams.get('phone') || '';
        if (!tenantId) return jsonError('tenant_id requerido', 400);

        const config = await env.DB.prepare(
          'SELECT activo FROM sgc_flu_Config WHERE tenant_id = ?'
        ).bind(tenantId).first();

        if (!config || !config.activo) {
          return json({ flujo_activo: false });
        }

        // Verificar si hay sesión activa
        const sesion = phone ? await env.DB.prepare(
          'SELECT * FROM sgc_flu_Sesiones WHERE tenant_id = ? AND phone = ? AND estado = "activa" ORDER BY id DESC LIMIT 1'
        ).bind(tenantId, phone).first() : null;

        return json({
          flujo_activo: true,
          sesion_activa: !!sesion,
          paso_actual: sesion ? sesion.paso_actual : 0
        });
      }

      // POST /api/motor/reset — Reinicia sesión de un usuario
      if (path === '/api/motor/reset' && method === 'POST') {
        const { tenant_id, phone } = await request.json();
        await env.DB.prepare(
          'UPDATE sgc_flu_Sesiones SET estado = "cancelada", updated_at = datetime("now") WHERE tenant_id = ? AND phone = ? AND estado = "activa"'
        ).bind(parseInt(tenant_id), phone).run();
        return json({ success: true });
      }

      // === PLANTILLAS (público) ===
      // GET /api/plantillas — Listar todas las plantillas
      if (path === '/api/plantillas' && method === 'GET') {
        const result = await env.DB.prepare(
          'SELECT id, rubro, nombre, descripcion, pasos_json FROM sgc_flu_Plantillas ORDER BY id'
        ).all();
        return json({ plantillas: result.results || [] });
      }

      // GET /api/plantillas/:id — Obtener una plantilla
      const plantillaMatch = path.match(/^\/api\/plantillas\/(\d+)$/);
      if (plantillaMatch && method === 'GET') {
        const id = parseInt(plantillaMatch[1]);
        const plantilla = await env.DB.prepare(
          'SELECT * FROM sgc_flu_Plantillas WHERE id = ?'
        ).bind(id).first();
        if (!plantilla) return jsonError('Plantilla no encontrada', 404);
        return json({ plantilla });
      }

      // === CONFIG POR TENANT (requiere auth admin) ===
      // GET /api/config?t=:tenant — Obtener config de flujo del tenant
      if (path === '/api/config' && method === 'GET') {
        const tenantId = parseInt(url.searchParams.get('t') || '0');
        if (!tenantId) return jsonError('tenant_id requerido', 400);

        const config = await env.DB.prepare(
          'SELECT fc.*, fp.rubro, fp.nombre as plantilla_nombre FROM sgc_flu_Config fc LEFT JOIN sgc_flu_Plantillas fp ON fc.flujo_id = fp.id WHERE fc.tenant_id = ?'
        ).bind(tenantId).first();

        return json({ config: config || { tenant_id: tenantId, activo: 0 } });
      }

      // PUT /api/config — Actualizar config de flujo del tenant
      if (path === '/api/config' && method === 'PUT') {
        const user = await getUser(request, env);
        if (!user) return jsonError('No autorizado', 401);

        const { tenant_id, flujo_id, activo, custom_pasos_json, modo } = await request.json();
        if (!tenant_id) return jsonError('tenant_id requerido', 400);

        const modoVal = (modo === 'mixto' || modo === 'ia') ? modo : 'flujo';
        await env.DB.prepare(
          'INSERT INTO sgc_flu_Config (tenant_id, flujo_id, activo, custom_pasos_json, modo) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET flujo_id = excluded.flujo_id, activo = excluded.activo, custom_pasos_json = excluded.custom_pasos_json, modo = excluded.modo, updated_at = datetime("now")'
        ).bind(
          parseInt(tenant_id),
          flujo_id || null,
          activo ? 1 : 0,
          custom_pasos_json || null,
          modoVal
        ).run();

        return json({ success: true });
      }

      // === SESIONES (requiere auth admin) ===
      // GET /api/sesiones?t=:tenant — Listar sesiones de un tenant
      if (path === '/api/sesiones' && method === 'GET') {
        const user = await getUser(request, env);
        if (!user) return jsonError('No autorizado', 401);

        const tenantId = parseInt(url.searchParams.get('t') || '0');
        const result = await env.DB.prepare(
          'SELECT * FROM sgc_flu_Sesiones WHERE tenant_id = ? ORDER BY id DESC LIMIT 50'
        ).bind(tenantId).all();
        return json({ sesiones: result.results || [] });
      }

      // === SERVIR ARCHIVOS ESTÁTICOS ===
      if (!path.startsWith('/api/')) {
        if (env.ASSETS) {
          return env.ASSETS.fetch(request);
        }
        return new Response('<html><body style="background:#0a0a0a;color:#22c55e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h1>SGC Flujos</h1><p>Sistema de Flujos de Agendamiento</p><p><a href="/admin" style="color:#22c55e">Panel Admin</a> | <a href="/api/health" style="color:#22c55e">Health</a></p></div></body></html>', { headers: { 'Content-Type': 'text/html' } });
      }

      return jsonError('Endpoint no encontrado: ' + path, 404);
    } catch (error) {
      console.error('Worker error:', error);
      return json({ error: 'Error interno', details: error.message }, 500);
    }
  }
};
