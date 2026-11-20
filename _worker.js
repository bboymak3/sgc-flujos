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

// Contraseña de superadmin: se valida contra bot.makeseo.app (misma contraseña del superadmin),
// así no hay contraseñas escritas en el código. Cache corto por proceso para no consultar en cada petición.
const SUPERADMIN_OK_CACHE = new Map();
// Límite de intentos (misma tabla que sgc-saas): 10 contraseñas malas en 10 min por IP => 15 min bloqueada
async function segundosBloqueoAuth(env, ip) {
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS sgc_auth_fallos (ip TEXT PRIMARY KEY, fallos INTEGER NOT NULL DEFAULT 0, ventana_inicio INTEGER NOT NULL DEFAULT 0, bloqueado_hasta INTEGER NOT NULL DEFAULT 0)").run();
    const r = await env.DB.prepare('SELECT bloqueado_hasta FROM sgc_auth_fallos WHERE ip = ?').bind(ip).first();
    const ahora = Math.floor(Date.now() / 1000);
    return r && r.bloqueado_hasta > ahora ? r.bloqueado_hasta - ahora : 0;
  } catch (e) { return 0; }
}
async function registrarFalloAuth(env, ip) {
  try {
    const ahora = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO sgc_auth_fallos (ip, fallos, ventana_inicio, bloqueado_hasta) VALUES (?1, 1, ?2, 0)
       ON CONFLICT(ip) DO UPDATE SET
         fallos = CASE WHEN ?2 - ventana_inicio > 600 THEN 1 ELSE fallos + 1 END,
         ventana_inicio = CASE WHEN ?2 - ventana_inicio > 600 THEN ?2 ELSE ventana_inicio END`
    ).bind(ip, ahora).run();
    const r = await env.DB.prepare('SELECT fallos FROM sgc_auth_fallos WHERE ip = ?').bind(ip).first();
    if (r && r.fallos >= 10) {
      await env.DB.prepare('UPDATE sgc_auth_fallos SET bloqueado_hasta = ?, fallos = 0, ventana_inicio = ? WHERE ip = ?').bind(ahora + 900, ahora, ip).run();
      console.log(`[LIMITE] IP ${ip} bloqueada 15 min por contraseñas incorrectas`);
    }
  } catch (e) { console.error('[LIMITE] error:', e.message); }
}
async function esSuperadmin(request) {
  const pwd = request.headers.get('X-Admin-Password') || '';
  if (!pwd || pwd.length > 200) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd));
  const key = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const hit = SUPERADMIN_OK_CACHE.get(key);
  if (hit && hit.exp > Date.now()) return hit.ok;
  let ok = false;
  try {
    const r = await fetch('https://bot.makeseo.app/api/onboarding/list', { headers: { 'X-Admin-Password': pwd } });
    ok = r.status === 200;
  } catch (e) {
    console.error('[AUTH] No se pudo validar con bot.makeseo.app:', e.message);
  }
  SUPERADMIN_OK_CACHE.set(key, { ok, exp: Date.now() + (ok ? 5 * 60 * 1000 : 30 * 1000) });
  return ok;
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return await verifyJWT(auth.substring(7), env.JWT_SECRET || JWT_SECRET);
}

// === MOTOR DE FLUJOS ===
// Ejecuta un paso del flujo y devuelve la respuesta + siguiente paso

// ============================================================
// Helpers para tipos api_call y mensaje (extraídos para poder
// ser llamados desde el handler de 'pregunta' cuando el siguiente
// paso es de estos tipos — permite ejecución automática sin esperar
// input del usuario)
// ============================================================
async function ejecutarApiCall(env, sesion, pasos, datos, modo, pasoActualOverride) {
  const pasoActual = pasoActualOverride || pasos[sesion.paso_actual];
  try {
    // ============================================================
    // FIX RANGO DE PRECIO: si el paso tiene "rango_presupuesto: true"
    // y datos.presupuesto existe, calcular rango ± 40% y filtrar
    // ============================================================
    let urlsAConsultar = [];
    if (pasoActual.rango_presupuesto && datos.presupuesto) {
      const presupuestoNum = parseFloat(datos.presupuesto) || 0;
      if (presupuestoNum > 0 && presupuestoNum < 99999990) {
        // Calcular rango ± 40% (más amplio para encontrar más opciones)
        const precioMin = Math.round(presupuestoNum * 0.6);
        const precioMax = Math.round(presupuestoNum * 1.4);
        console.log(`[API_CALL] Rango de precio: ${precioMin} - ${precioMax} (presupuesto: ${presupuestoNum})`);
        // Guardar el rango en datos para mostrarlo al usuario
        datos.rango_precio_min = precioMin;
        datos.rango_precio_max = precioMax;
        // Para el rango, hacemos una consulta sin filtro de precio y filtramos manualmente
        // (porque la API solo soporta precio_max, no precio_min)
        const urlSinFiltro = (pasoActual.url || '').replace(/\{(\w+)\}/g, (m, key) => {
          if (key === 'presupuesto') return ''; // sin filtro
          return encodeURIComponent(datos[key] || '');
        }).replace(/&precio_max=&/, '&').replace(/\?precio_max=&/, '?').replace(/&precio_max=$/, '').replace(/\?precio_max=$/, '');
        urlsAConsultar = [urlSinFiltro];
      }
    }

    // Si no es rango, usar la URL normal
    if (urlsAConsultar.length === 0) {
      const urlNormal = (pasoActual.url || '').replace(/\{(\w+)\}/g, (m, key) => encodeURIComponent(datos[key] || ''));
      urlsAConsultar = [urlNormal];
    }

    console.log(`[API_CALL] fetch URL: ${urlsAConsultar[0]}`);
    const apiRes = await fetch(urlsAConsultar[0], { method: 'GET' });
    if (!apiRes.ok) {
      console.log(`[API_CALL] HTTP ${apiRes.status}`);
      return {
        flujo_activo: true,
        respuesta: pasoActual.mensaje_error || 'Hubo un problema consultando el catálogo. Intenta de nuevo en un momento.',
        paso_actual: sesion.paso_actual,
        fin: false
      };
    }
    const apiData = await apiRes.json();
    let items = apiData[pasoActual.campo_resultados] || [];

    // ============================================================
    // FILTRAR POR RANGO DE PRECIO si está activado
    // Si no hay resultados en el rango, mostrar las más cercanas al presupuesto
    // ============================================================
    if (pasoActual.rango_presupuesto && datos.rango_precio_min && datos.rango_precio_max) {
      const min = datos.rango_precio_min;
      const max = datos.rango_precio_max;
      const presupuestoCentro = parseFloat(datos.presupuesto) || 0;
      console.log(`[API_CALL] Filtrando ${items.length} items por rango ${min}-${max} (centro: ${presupuestoCentro})`);
      
      // Primero intentar filtrar por rango
      let itemsEnRango = items.filter(item => {
        const price = parseFloat(item.price) || 0;
        return price >= min && price <= max;
      });
      console.log(`[API_CALL] Items en rango: ${itemsEnRango.length}`);
      
      // Si no hay en rango, tomar las más cercanas al presupuesto (hasta 5)
      if (itemsEnRango.length === 0 && items.length > 0) {
        console.log(`[API_CALL] No hay items en rango, tomando las más cercanas al presupuesto ${presupuestoCentro}`);
        itemsEnRango = items
          .map(item => ({
            ...item,
            _distancia: Math.abs((parseFloat(item.price) || 0) - presupuestoCentro)
          }))
          .sort((a, b) => a._distancia - b._distancia)
          .slice(0, 5)
          .map(item => {
            const { _distancia, ...rest } = item;
            return rest;
          });
        // Actualizar el mensaje para indicar que son sugerencias cercanas
        datos._sugerencias_cercanas = true;
      }
      
      items = itemsEnRango;
      console.log(`[API_CALL] Items finales: ${items.length}`);
    }

    const total = items.length;
    const maxItems = pasoActual.max_items || 5;
    const itemsToShow = items.slice(0, maxItems);

    if (itemsToShow.length === 0) {
      // No hay resultados → reiniciar flujo
      await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = 0, datos_json = "{}", updated_at = datetime("now") WHERE id = ?')
        .bind(sesion.id).run();
      return {
        flujo_activo: true,
        respuesta: pasoActual.mensaje_vacio || 'No se encontraron resultados. Empecemos de nuevo.',
        paso_actual: 0,
        fin: false
      };
    }

    // Construir lista formateada
    const lista = itemsToShow.map((item, idx) => {
      const n = idx + 1;
      // {num_emoji}: número grande tipo teclado (1️⃣ 2️⃣ ... 🔟)
      const num_emoji = n === 10 ? '\u{1F51F}' : (n < 10 ? n + '\uFE0F\u20E3' : '#' + n);
      const itemCtx = { ...item, num: n, num_emoji };
      return (pasoActual.template_item || '#{num}: {title}')
        .replace(/\{(\w+)\}/g, (m, key) => itemCtx[key] !== undefined ? itemCtx[key] : '');
    }).join('\n');

    // Construir mensaje final
    let mensaje = (pasoActual.template_mensaje || '{lista}')
      .replace(/\{total\}/g, total)
      .replace(/\{lista\}/g, lista);

    // Si hay rango de precio, agregar info del rango al mensaje
    if (datos.rango_precio_min && datos.rango_precio_max) {
      mensaje = mensaje.replace(/\{rango_precio\}/g, `$${datos.rango_precio_min.toLocaleString()} - $${datos.rango_precio_max.toLocaleString()}`);
      // Si son sugerencias cercanas (no había en rango), cambiar el mensaje
      if (datos._sugerencias_cercanas) {
        mensaje = mensaje.replace(/Encontré (\d+) propiedades para ti \(rango [^)]+\):/, 'No encontré propiedades exactas en tu rango, pero estas son las más cercanas a tu presupuesto:');
      }
    }

    // Guardar los resultados en datos si se especifica
    if (pasoActual.campo_guardar) {
      datos[pasoActual.campo_guardar] = itemsToShow;
    }
    // Guardar mapping número → id+title+slug (slug para construir URL pública)
    datos['_resultados_ids'] = itemsToShow.map((item, idx) => ({
      num: idx + 1,
      id: item.id,
      title: item.title,
      slug: item.slug || ''
    }));

    const nextPaso = sesion.paso_actual + 1;
    await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = ?, datos_json = ?, updated_at = datetime("now") WHERE id = ?')
      .bind(nextPaso, JSON.stringify(datos), sesion.id).run();

    const siguientePaso = pasos[nextPaso];
    let respuestaCompleta = mensaje;
    if (siguientePaso) {
      if (siguientePaso.tipo === 'mensaje') {
        // Si el siguiente es tipo mensaje, ejecutarlo y concatenar
        const sesionActualizada = { ...sesion, paso_actual: nextPaso };
        const resultadoMensaje = await ejecutarMensaje(env, sesionActualizada, pasos, datos, modo);
        if (resultadoMensaje && resultadoMensaje.respuesta) {
          respuestaCompleta = mensaje + '\n\n' + resultadoMensaje.respuesta;
          return {
            flujo_activo: true,
            respuesta: respuestaCompleta,
            paso_actual: resultadoMensaje.paso_actual,
            fin: resultadoMensaje.fin
          };
        }
      } else if (siguientePaso.mensaje) {
        const preguntaSiguiente = siguientePaso.mensaje.replace(/\{(\w+)\}/g, (m, key) => datos[key] || '');
        // pregunta_arriba: la pregunta del siguiente paso va antes de la lista, no al final
        respuestaCompleta = pasoActual.pregunta_arriba
          ? preguntaSiguiente + '\n\n' + mensaje
          : mensaje + '\n\n' + preguntaSiguiente;
      }
    }

    return {
      flujo_activo: true,
      respuesta: respuestaCompleta,
      paso_actual: nextPaso,
      fin: !siguientePaso
    };
  } catch (e) {
    console.error('[API_CALL] error:', e.message);
    return {
      flujo_activo: true,
      respuesta: 'Disculpa, tuve un problema consultando el catálogo. Intenta de nuevo.',
      paso_actual: sesion.paso_actual,
      fin: false
    };
  }
}

// ============================================================
// VALIDACIONES OPCIONALES (se activan por paso; los flujos que no las usan no cambian)
//  - pasos[i].salida_inteligente = true (en cualquier paso): "no gracias", "adiós", "cancelar"... cierran el flujo
//  - pregunta.validar = "fecha" | "hora" | "nombre" | "si_no": si la respuesta no sirve, se vuelve a preguntar
//  - mensaje.seleccion_estricta = true: si no eligió una opción válida de la lista, se vuelve a pedir
// ============================================================
const RE_SALIDA = /^(no+|nop|nah|no\s*,?\s*gracias|no\s+quiero(\s+[a-záéíóúñ]+){0,3}|no\s+por\s+ahora|no\s+todav[ií]a(\s+[a-záéíóúñ]+){0,2}|ahora\s+no|todav[ií]a\s+no|adi[oó]s|bye|chao|chau|hasta\s+luego|cancelar|cancela|olv[ií]dalo|no\s+me\s+interesa|nada)[\s!.,]*(gracias)?[\s!.,]*$/i;
const MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
function respuestaValida(tipo, texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!t) return false;
  if (tipo === 'fecha') {
    return /\b(hoy|manana|pasado\s+manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(t)
      || /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(t)
      || /\b\d{1,2}\s*[\/-]\s*\d{1,2}(\s*[\/-]\s*\d{2,4})?\b/.test(t)
      || new RegExp('\\b\\d{1,2}\\s*(de\\s+)?(' + MESES + ')\\b').test(t)
      || /^(el\s+)?\d{1,2}$/.test(t);
  }
  if (tipo === 'hora') {
    return /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.?\s?m\.?|p\.?\s?m\.?|hrs?|h)\b/.test(t)
      || /\b\d{1,2}:\d{2}\b/.test(t)
      || /\b\d{1,2}\s*(de\s+la\s+)?(manana|tarde|noche)\b/.test(t)
      || /\b(mediodia|medio\s+dia)\b/.test(t)
      || /^(a\s+las\s+)?\d{1,2}$/.test(t);
  }
  if (tipo === 'nombre') {
    if (!/[a-zñ]{2,}/.test(t) || t.length > 60 || /\d{3,}/.test(t)) return false;
    return !/^(no+|si|ok|okey|dale|nada|ninguno|ninguna|adios|bye|chao|hola|que\s+no|no\s+se|nose|gracias|no\s+gracias|cancelar)$/.test(t);
  }
  if (tipo === 'si_no') {
    return /\b(si|claro|ok|okey|dale|por\s+supuesto|afirmativo|de\s+acuerdo|confirmo|no|nop|nah|negativo|cancelar)\b/.test(t);
  }
  return true;
}
const MSG_VALIDACION = {
  fecha: '📅 No entendí la fecha. Escríbela así: *mañana*, *viernes* o *25/11*.',
  hora: '⏰ No entendí la hora. Escríbela así: *10am*, *3pm* o *15:00*.',
  nombre: '👤 ¿Me dices tu nombre, por favor?',
  si_no: '🙂 Responde *sí* o *no*.'
};
// Número elegido en una lista: "2", "2️⃣", "la 2", "#2", "la segunda", "opción 2"
function numeroDeLista(texto) {
  const t = ' ' + String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') + ' ';
  const ord = { primera: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3, cuarta: 4, cuarto: 4, quinta: 5, quinto: 5 };
  for (const [w, n] of Object.entries(ord)) if (new RegExp('[^a-z]' + w + '[^a-z]').test(t)) return n;
  const m = t.match(/(?:^|[^0-9])(\d{1,2})(?![0-9])/);
  return m ? parseInt(m[1], 10) : 0;
}
async function ejecutarMensaje(env, sesion, pasos, datos, modo, pasoActualOverride) {
  const pasoActual = pasoActualOverride || pasos[sesion.paso_actual];
  try {
    // Resolver selección de propiedad si aplica
    if (pasoActual.resolver_seleccion && datos[pasoActual.resolver_seleccion]) {
      const num = parseInt(datos[pasoActual.resolver_seleccion]);
      const resultadosIds = datos['_resultados_ids'] || [];
      let sel = resultadosIds.find(r => r.num === num);
      if (!sel && pasoActual.seleccion_estricta) {
        // Por número escrito de otra forma ("la 2", "la segunda") o por nombre
        const n2 = numeroDeLista(datos[pasoActual.resolver_seleccion]);
        sel = resultadosIds.find(r => r.num === n2);
        if (!sel) {
          const txt = String(datos[pasoActual.resolver_seleccion]).toLowerCase().trim();
          if (txt.length >= 4) sel = resultadosIds.find(r => String(r.title || '').toLowerCase().includes(txt));
        }
        if (!sel) {
          // No eligió una opción válida: volver a la pregunta de elección, sin avanzar
          const pasoPregunta = Math.max(0, sesion.paso_actual - 1);
          delete datos[pasoActual.resolver_seleccion];
          await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = ?, datos_json = ?, updated_at = datetime("now") WHERE id = ?')
            .bind(pasoPregunta, JSON.stringify(datos), sesion.id).run();
          const kc = (n) => n === 10 ? '\u{1F51F}' : (n < 10 ? n + '\uFE0F\u20E3' : '#' + n);
          const listaCorta = resultadosIds.map(r => kc(r.num) + ' ' + (r.title || '')).join('\n');
          return {
            flujo_activo: true,
            respuesta: '🤔 No encontré esa opción. Responde con el número de la propiedad:' + (listaCorta ? '\n\n' + listaCorta : ''),
            paso_actual: pasoPregunta,
            fin: false
          };
        }
      }
      if (sel) {
        datos['propiedad_seleccionada_id'] = sel.id;
        datos['propiedad_seleccionada_titulo'] = sel.title;
        datos['propiedad_seleccionada_slug'] = sel.slug || '';
      }
    }
    const nextPaso = sesion.paso_actual + 1;
    await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = ?, datos_json = ?, updated_at = datetime("now") WHERE id = ?')
      .bind(nextPaso, JSON.stringify(datos), sesion.id).run();
    const siguientePaso = pasos[nextPaso];
    const respuestaBase = (pasoActual.mensaje || '').replace(/\{(\w+)\}/g, (m, key) => datos[key] || '');
    
    // Si el siguiente paso también es tipo que se ejecuta solo, lo ejecutamos y concatenamos
    if (siguientePaso) {
      if (siguientePaso.tipo === 'mensaje') {
        const sesionActualizada = { ...sesion, paso_actual: nextPaso };
        const resultadoSiguiente = await ejecutarMensaje(env, sesionActualizada, pasos, datos, modo);
        if (resultadoSiguiente && resultadoSiguiente.respuesta) {
          return {
            flujo_activo: true,
            respuesta: respuestaBase + '\n\n' + resultadoSiguiente.respuesta,
            paso_actual: resultadoSiguiente.paso_actual,
            fin: resultadoSiguiente.fin
          };
        }
      }
    }
    
    if (!siguientePaso && pasos.some(p => p && p.salida_inteligente)) {
      // Fin del flujo: cerrar la sesión para que un "ok" posterior no reabra pasos viejos
      await env.DB.prepare('UPDATE sgc_flu_Sesiones SET estado = "completada", updated_at = datetime("now") WHERE id = ?')
        .bind(sesion.id).run();
    }
    return {
      flujo_activo: true,
      respuesta: respuestaBase,
      paso_actual: nextPaso,
      fin: !siguientePaso
    };
  } catch (e) {
    console.error('[MENSAJE] error:', e.message);
    return {
      flujo_activo: true,
      respuesta: 'Error procesando mensaje',
      paso_actual: sesion.paso_actual,
      fin: false
    };
  }
}

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

  let datos = {};

  // ============================================================
  // FIX UX: Si el cliente dice "hola" (o similar) y YA tiene una
  // sesión activa en paso > 0, reiniciar el flujo. Esto permite
  // que el cliente "recomience" en cualquier momento.
  // ============================================================
  const saludosRegex = /^(hola|buenos?\s*(d[ií]as|tardes|noches)|hello|hi|hey|saludos|buenas)\b/i;
  if (sesion && sesion.paso_actual > 0 && saludosRegex.test(mensajeUsuario)) {
    console.log(`[FLUJO] Cliente dijo "${mensajeUsuario}" con sesión activa en paso ${sesion.paso_actual}, reiniciando flujo`);
    await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = 0, datos_json = "{}", updated_at = datetime("now") WHERE id = ?')
      .bind(sesion.id).run();
    sesion.paso_actual = 0;
    sesion.datos_json = '{}';
    datos = {};
    // Ahora va a procesar como si fuera el primer mensaje → ejecuta paso saludo
  }

  if (!sesion) {
    // Crear sesión nueva
    const result = await env.DB.prepare(
      'INSERT INTO sgc_flu_Sesiones (tenant_id, phone, paso_actual, datos_json, estado) VALUES (?, ?, 0, "{}", "activa")'
    ).bind(tenantId, phone).run();
    sesion = { id: result.meta.last_row_id, paso_actual: 0, datos_json: '{}' };

    // ============================================================
    // FIX FASE 3: Si el primer mensaje NO es un saludo reconocido
    // (hola, buenas, hello, hi, buenos días, etc), igualmente
    // ejecutar el paso 'saludo' pero guardar el mensaje original
    // del usuario como "mensaje_inicial" para referencia.
    // El usuario puede decir "quiero una casa" y el bot responde
    // con el saludo + primera pregunta, en vez de esperar "hola".
    // ============================================================
    const saludosRegex = /^(hola|buenos?\s*(d[ií]as|tardes|noches)|hello|hi|hey|saludos|buenas)\b/i;
    if (!saludosRegex.test(mensajeUsuario)) {
      console.log(`[FLUJO] Primer mensaje "${mensajeUsuario}" no es saludo estándar, guardando como mensaje_inicial`);
      datos = { mensaje_inicial: mensajeUsuario };
      await env.DB.prepare('UPDATE sgc_flu_Sesiones SET datos_json = ? WHERE id = ?')
        .bind(JSON.stringify(datos), sesion.id).run();
    }
  } else {
    try { datos = JSON.parse(sesion.datos_json || '{}'); } catch (e) {}
  }

  const pasoActual = pasos[sesion.paso_actual] || pasos[0];

  // === SALIDA: "no gracias", "adiós", "cancelar"... cierran el flujo (solo si el flujo lo activa) ===
  const salidaActiva = pasos.some(p => p && p.salida_inteligente);
  const tieneRamaNo = pasoActual.tipo === 'pregunta' && (pasoActual.siguiente_no !== undefined || pasoActual.siguiente_paso_no !== undefined || pasoActual.goto_no !== undefined);
  if (salidaActiva && sesion.paso_actual > 0 && !tieneRamaNo && RE_SALIDA.test((mensajeUsuario || '').trim())) {
    await env.DB.prepare('UPDATE sgc_flu_Sesiones SET estado = "completada", updated_at = datetime("now") WHERE id = ?')
      .bind(sesion.id).run();
    const pasoSalida = pasos.find(p => p && p.mensaje_salida);
    console.log(`[FLUJO] Salida del cliente ("${mensajeUsuario}") en paso ${sesion.paso_actual}: sesión cerrada`);
    return {
      flujo_activo: true,
      respuesta: (pasoSalida && pasoSalida.mensaje_salida) || '¡Perfecto! Si cambias de opinión, aquí estoy para ayudarte. 😊',
      paso_actual: sesion.paso_actual,
      fin: true
    };
  }

  // En una pregunta sí/no, una negativa ("no quiero agendar nada") toma la rama "no" en vez de irse a la IA
  const negativaEnRamaNo = salidaActiva && tieneRamaNo && RE_SALIDA.test((mensajeUsuario || '').trim());

  // === MODO MIXTO: detectar si el mensaje está fuera del flujo ===
  if (modo === 'mixto' && pasoActual.tipo === 'pregunta' && !negativaEnRamaNo) {
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
    // Validación opcional por paso (fecha, hora, nombre, si_no): si no sirve, se vuelve a preguntar
    if (pasoActual.validar && !respuestaValida(pasoActual.validar, mensajeUsuario)) {
      const aviso = pasoActual.mensaje_error || MSG_VALIDACION[pasoActual.validar] || 'No entendí tu respuesta.';
      return {
        flujo_activo: true,
        respuesta: pasoActual.validar === 'si_no' ? aviso + '\n\n' + pasoActual.mensaje : aviso,
        paso_actual: sesion.paso_actual,
        fin: false
      };
    }
    // Guardar la respuesta del usuario en datos
    let valorRespuesta = mensajeUsuario.trim();
    
    // ============================================================
    // NUEVO: Normalización de sinónimos
    // Si el paso tiene un campo "sinonimos", mapea respuestas del usuario
    // a un valor canónico antes de guardarlo.
    // Ej: sinonimos: { "comprar": "venta", "compra": "venta", "alquilar": "alquiler", "rentar": "alquiler" }
    // ============================================================
    if (pasoActual.sinonimos && typeof pasoActual.sinonimos === 'object') {
      const valorLower = valorRespuesta.toLowerCase().trim();
      if (pasoActual.sinonimos[valorLower]) {
        valorRespuesta = pasoActual.sinonimos[valorLower];
        console.log(`[SINONIMOS] Normalizado: "${mensajeUsuario}" → "${valorRespuesta}"`);
      }
      // También probar sinónimos como substrings (ej: "quiero comprar" → "venta")
      for (const [key, val] of Object.entries(pasoActual.sinonimos)) {
        if (valorLower.includes(key)) {
          valorRespuesta = val;
          console.log(`[SINONIMOS] Normalizado por substring: "${mensajeUsuario}" → "${valorRespuesta}" (matched "${key}")`);
          break;
        }
      }
    }

    // ============================================================
    // NUEVO: Normalización de presupuesto (parsear "50 mil", "más de 50", "50k", etc.)
    // Si el campo es "presupuesto", intentar extraer el número
    // ============================================================
    if (pasoActual.campo === 'presupuesto') {
      const original = valorRespuesta;
      let presupuestoNum = null;

      // Caso 1: "50 mil", "50mil", "5millón", "50k", "50m"
      let m = valorRespuesta.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(mil|millon|millón|millones|k|m)\b/);
      if (m) {
        let num = parseFloat(m[1].replace(',', '.'));
        const multi = m[2];
        if (multi === 'mil' || multi === 'k' || multi === 'm') num *= 1000;
        else if (multi.includes('millon')) num *= 1000000;
        presupuestoNum = num;
      }

      // Caso 2: "más de 50", "mas de 50", "al menos 50", "sobre 50"
      if (presupuestoNum === null) {
        m = valorRespuesta.toLowerCase().match(/(?:m[aá]s\s+de|mas\s+de|al\s+menos|sobre|mayor\s+a|por\s+encima\s+de)\s*(\d+(?:[.,]\d+)?)/);
        if (m) {
          presupuestoNum = parseFloat(m[1].replace(',', '.'));
        }
      }

      // Caso 3: "menos de 50", "hasta 50", "no más de 50"
      if (presupuestoNum === null) {
        m = valorRespuesta.toLowerCase().match(/(?:menos\s+de|hasta|m[aá]ximo|maximo|no\s+m[aá]s\s+de)\s*(\d+(?:[.,]\d+)?)/);
        if (m) {
          presupuestoNum = parseFloat(m[1].replace(',', '.'));
        }
      }

      // Caso 4: solo un número "50000", "50,000", "50.000"
      if (presupuestoNum === null) {
        m = valorRespuesta.match(/(\d+(?:[.,]\d{3})*(?:[.,]\d+)?)/);
        if (m) {
          // Quitar separadores de miles (coma o punto) y parsear
          let numStr = m[1].replace(/[.,](\d{3})/g, '$1').replace(',', '.');
          presupuestoNum = parseFloat(numStr);
        }
      }

      if (presupuestoNum !== null && presupuestoNum > 0) {
        // HEURÍSTICA: si el número es menor a 1000, asumir que son miles
        // (porque presupuestos inmobiliarios siempre son miles de USD)
        if (presupuestoNum < 1000) {
          presupuestoNum = presupuestoNum * 1000;
          console.log(`[PRESUPUESTO] Auto-multiplicado por 1000 (presupuesto inmobiliario): ${presupuestoNum}`);
        }
        valorRespuesta = String(Math.round(presupuestoNum));
        console.log(`[PRESUPUESTO] Normalizado: "${original}" → ${valorRespuesta}`);
      }
    }
    
    // ============================================================
    // NUEVO: Validación de valores aceptados
    // Si el paso tiene "valores_aceptados" (array), validar que la respuesta esté en la lista.
    // Si no está, pedir de nuevo sin avanzar el paso.
    // ============================================================
    if (pasoActual.valores_aceptados && Array.isArray(pasoActual.valores_aceptados) && pasoActual.valores_aceptados.length > 0) {
      const valorLower = valorRespuesta.toLowerCase().trim();
      const aceptado = pasoActual.valores_aceptados.some(v => v.toLowerCase() === valorLower);
      if (!aceptado) {
        return {
          flujo_activo: true,
          respuesta: pasoActual.mensaje_error || `❌ Valor no válido. Opciones aceptadas: ${pasoActual.valores_aceptados.join(', ')}. Por favor intenta de nuevo.`,
          paso_actual: sesion.paso_actual,
          fin: false
        };
      }
    }
    
    datos[pasoActual.campo] = valorRespuesta;

    let nextPaso = sesion.paso_actual + 1;
    // Soporte de ramificacion si/no en preguntas (ej: quiere agendar visita)
    const ramaSi = (pasoActual.siguiente_si !== undefined) ? pasoActual.siguiente_si : ((pasoActual.siguiente_paso_si !== undefined) ? pasoActual.siguiente_paso_si : pasoActual.goto_si);
    const ramaNo = (pasoActual.siguiente_no !== undefined) ? pasoActual.siguiente_no : ((pasoActual.siguiente_paso_no !== undefined) ? pasoActual.siguiente_paso_no : pasoActual.goto_no);
    let esSiRama = false, esNoRama = false;
    if (ramaSi !== undefined || ramaNo !== undefined) {
      esSiRama = /\b(si|s[ií]|claro|ok|dale|por supuesto|afirmativo|de acuerdo|confirmo)\b/i.test(mensajeUsuario);
      esNoRama = /\b(no|nop|nah|para nada|no gracias|negativo|cancelar)\b/i.test(mensajeUsuario);
      if (esNoRama && ramaNo !== undefined) nextPaso = parseInt(ramaNo, 10);
      else if (esSiRama && ramaSi !== undefined) nextPaso = parseInt(ramaSi, 10);
    }
    // Fin explicito por rama (-1 o fuera de rango)
    if (nextPaso < 0 || nextPaso >= pasos.length) {
      await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = ?, datos_json = ?, estado = "completada", updated_at = datetime("now") WHERE id = ?')
        .bind(nextPaso, JSON.stringify(datos), sesion.id).run();
      const finMsg = (esNoRama && pasoActual.mensaje_fin_no) ? pasoActual.mensaje_fin_no.replace(/\{(\w+)\}/g, (m, key) => datos[key] || '') : ((pasoActual.mensaje_fin) ? pasoActual.mensaje_fin.replace(/\{(\w+)\}/g, (m, key) => datos[key] || '') : '¡Perfecto! Si necesitas algo más, aquí estaré para ayudarte. 😊');
      return { flujo_activo: true, respuesta: finMsg, paso_actual: nextPaso, fin: true, datos_recopilados: datos };
    }
    await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = ?, datos_json = ?, updated_at = datetime("now") WHERE id = ?')
      .bind(nextPaso, JSON.stringify(datos), sesion.id).run();

    const siguientePaso = pasos[nextPaso];
    if (siguientePaso) {
      // Si el siguiente paso es api_call o mensaje, ejecutarlo automáticamente
      // (estos tipos no requieren input del usuario, se ejecutan solos)
      // IMPORTANTE: actualizar paso_actual del objeto sesión en memoria para que
      // ejecutarApiCall/ejecutarMensaje calcule correctamente su propio nextPaso
      const sesionActualizada = { ...sesion, paso_actual: nextPaso };
      if (siguientePaso.tipo === 'api_call') {
        return await ejecutarApiCall(env, sesionActualizada, pasos, datos, modo, siguientePaso);
      }
      if (siguientePaso.tipo === 'mensaje') {
        return await ejecutarMensaje(env, sesionActualizada, pasos, datos, modo, siguientePaso);
      }
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
      const siguientePaso = pasos[nextPaso];
      const esCrearCita = !!(siguientePaso && siguientePaso.tipo === 'crear_cita');
      await env.DB.prepare('UPDATE sgc_flu_Sesiones SET paso_actual = ?, datos_json = ?, estado = ?, updated_at = datetime("now") WHERE id = ?')
        .bind(nextPaso, JSON.stringify(datos), esCrearCita ? "completada" : "activa", sesion.id).run();

      return {
        flujo_activo: true,
        respuesta: siguientePaso ? siguientePaso.mensaje.replace(/\{(\w+)\}/g, (m, key) => datos[key] || '') : 'Listo!',
        paso_actual: nextPaso,
        fin: true,
        crear_cita: esCrearCita,
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

  if (pasoActual.tipo === 'api_call') {
    return await ejecutarApiCall(env, sesion, pasos, datos, modo, pasoActual);
  }

  if (pasoActual.tipo === 'mensaje') {
    return await ejecutarMensaje(env, sesion, pasos, datos, modo, pasoActual);
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

    // Redirect 301: dominios viejos -> flujos.makeseo.app
    const host = (request.headers.get('host') || '').toLowerCase();
    if (host === 'sgc-flujos.pages.dev' || host === 'www.flujos.makeseo.app') {
      return Response.redirect('https://flujos.makeseo.app' + url.pathname + url.search, 301);
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
        // Auth: JWT del panel de flujos O contraseña real de superadmin (validada contra bot.makeseo.app).
        // Antes se aceptaba una contraseña fija escrita en el código.
        const ipCfg = request.headers.get('CF-Connecting-IP') || 'desconocida';
        const pwdEnviada = !!request.headers.get('X-Admin-Password');
        if (pwdEnviada) {
          const restante = await segundosBloqueoAuth(env, ipCfg);
          if (restante > 0) return jsonError(`Demasiados intentos con contraseña incorrecta. Intenta de nuevo en ${Math.ceil(restante / 60)} min.`, 429);
        }
        const isAdminViaPwd = await esSuperadmin(request);
        if (pwdEnviada && !isAdminViaPwd) await registrarFalloAuth(env, ipCfg);

        let user = null;
        if (!isAdminViaPwd) {
          user = await getUser(request, env);
          if (!user) return jsonError('No autorizado', 401);
        }

        const bodyCfg = await request.json();
        const { tenant_id, flujo_id, activo, modo } = bodyCfg;
        let { custom_pasos_json } = bodyCfg;
        if (!tenant_id) return jsonError('tenant_id requerido', 400);
        // Si no se envía custom_pasos_json y la plantilla no cambia (ej: solo se cambia modo o activo),
        // se conserva el flujo personalizado existente en vez de borrarlo.
        if (!('custom_pasos_json' in bodyCfg)) {
          const prev = await env.DB.prepare('SELECT flujo_id, custom_pasos_json FROM sgc_flu_Config WHERE tenant_id = ?').bind(parseInt(tenant_id)).first();
          if (prev && prev.custom_pasos_json && (prev.flujo_id || null) === (flujo_id || null)) custom_pasos_json = prev.custom_pasos_json;
        }

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
