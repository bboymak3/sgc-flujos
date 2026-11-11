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
      const itemCtx = { ...item, num: idx + 1 };
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
        respuestaCompleta = mensaje + '\n\n' + siguientePaso.mensaje.replace(/\{(\w+)\}/g, (m, key) => datos[key] || '');
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

async function ejecutarMensaje(env, sesion, pasos, datos, modo, pasoActualOverride) {
  const pasoActual = pasoActualOverride || pasos[sesion.paso_actual];
  try {
    // Resolver selección de propiedad si aplica
    if (pasoActual.resolver_seleccion && datos[pasoActual.resolver_seleccion]) {
      const num = parseInt(datos[pasoActual.resolver_seleccion]);
      const resultadosIds = datos['_resultados_ids'] || [];
      const sel = resultadosIds.find(r => r.num === num);
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

    const nextPaso = sesion.paso_actual + 1;
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
        // FIX FASE 3: aceptar auth por JWT (legacy) O por X-Admin-Password (como el superadmin)
        const adminPwd = request.headers.get('X-Admin-Password');
        const ADMIN_PWD_FLUJOS = 'admin123';
        const isAdminViaPwd = (adminPwd === ADMIN_PWD_FLUJOS);

        let user = null;
        if (!isAdminViaPwd) {
          user = await getUser(request, env);
          if (!user) return jsonError('No autorizado', 401);
        }

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
