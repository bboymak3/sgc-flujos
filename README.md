# SGC Flujos — Sistema de Flujos de Agendamiento

Motor de flujos deterministas para bots de WhatsApp. Reemplaza la IA por pasos predefinidos para agendamiento rápido y preciso.

## 🚀 URLs en producción

| Servicio | URL |
|----------|-----|
| **Landing** | https://sgc-flujos.pages.dev |
| **Panel Admin** | https://sgc-flujos.pages.dev/admin |
| **API** | https://sgc-flujos.pages.dev/api/* |
| **Hosting** | Cloudflare Pages (Advanced Mode) |

## 📋 Características

- 41 plantillas de flujo predefinidas por rubro
- Motor determinista (sin IA, respuestas instantáneas <0.5s)
- 3 modos: Solo IA, Solo Flujo, Mixto (flujo + IA fallback)
- Auto-asignación de flujo por rubro al aprobar negocio
- Editor de flujos custom desde el panel admin
- Gestión de sesiones de conversación
- Integración con sgc-saas (WhatsApp)
- Fallback automático a IA si no hay flujo activo

## 🔄 Cómo funciona

1. sgc-saas recibe mensaje de WhatsApp
2. Consulta a sgc-flujos: `POST /api/motor/ejecutar`
3. Si el tenant tiene flujo activo:
   - **Modo Flujo:** ejecuta paso determinista (sin IA)
   - **Modo Mixto:** si el mensaje está fuera de tema → IA fallback
   - **Modo IA:** no consulta el flujo
4. Al finalizar el flujo → crea cita en `sgc_cit_Citas`
5. Si no hay flujo → comportamiento normal con IA

## 🏗️ Arquitectura

```
sgc-flujos.pages.dev (Pages Advanced Mode)
├── index.html (landing)
├── admin.html (panel admin con 4 tabs)
├── _worker.js (API REST + motor de flujos)
└── wrangler.toml (bindings)

DB: citas (D1, compartida)
├── sgc_flu_Plantillas (41 plantillas por rubro)
├── sgc_flu_Config (config por tenant: flujo_id, activo, modo)
└── sgc_flu_Sesiones (conversaciones en curso)
```

## 🔧 Bindings

| Binding | Tipo | Valor |
|---------|------|-------|
| DB | D1 | citas (678b4adc-...) |
| AI | AI | Cloudflare AI |
| JWT_SECRET | Var | alianza58_secret_2024 |

## 📊 Plantillas disponibles (41)

| Rubro | Campos que pide |
|-------|----------------|
| Barbería | servicio, fecha, hora, nombre |
| Taller Mecánico | patente, servicio, fecha, hora, nombre |
| Clínica Dental | motivo, fecha, hora, nombre |
| Restaurante | comensales, fecha, hora, nombre |
| Spa | tratamiento, fecha, hora, nombre |
| Veterinaria | mascota, servicio, fecha, hora, nombre |
| Mecánico a Domicilio | patente, marca, servicio, dirección, fecha, hora, nombre |
| Tapizado de Volantes | servicio, vehículo, material, fecha, nombre |
| Cámaras de Seguridad | servicio, dirección, tipo, fecha, nombre |
| Electricista | servicio, dirección, tipo, fecha, nombre |
| Soldador | trabajo, dirección, fecha, nombre |
| Papel Ahumado | vehículo, oscuridad, fecha, nombre |
| SPAD/Detailing | servicio, vehículo, fecha, nombre |
| Autolavado | tipo lavado, vehículo, fecha, hora, nombre |
| Restaurante Comida Rápida | pedido, dirección, nombre, pago |
| Masajes | tipo masaje, fecha, hora, nombre |
| Médico Veterinario | mascota, servicio, fecha, hora, nombre |
| Médico General | motivo, fecha, hora, nombre |
| Arquitectos | proyecto, fecha, hora, nombre |
| Fibra Óptica Instalación | servicio, dirección, fecha, nombre |
| Fibra Óptica Servicio Técnico | problema, dirección, fecha, nombre |
| Publicidad | servicio, negocio, fecha, nombre |
| Panadería | pedido, fecha, nombre |
| Tienda de Ropa | prenda, talla, nombre |
| Farmacia | producto, receta, nombre |
| Tienda Agrícola | producto, cultivo, nombre |
| Bodega | producto, cantidad, nombre |
| Licorería | producto, dirección, nombre |
| Venta de Servicios | servicio, fecha, hora, nombre, teléfono |
| Fotografía | tipo sesión, fecha, hora, nombre |
| Abogados | tipo consulta, fecha, hora, nombre |
| Limpieza a Domicilio | servicio, dirección, fecha, hora, nombre |
| Repuestos de Autos | repuesto, vehículo, nombre |
| Rotulados | producto, cantidad, diseño, nombre |
| Reparación de Sonido | problema, vehículo, fecha, nombre |
| Instalación de Alarmas | servicio, vehículo, fecha, nombre |
| Peluquería/Salón | servicio, fecha, hora, nombre |
| Personalizado (vacío) | (crear desde cero) |
| General | servicio, fecha, hora, nombre, teléfono |

## 🔐 Credenciales Admin

- **URL:** https://sgc-flujos.pages.dev/admin
- **Usuario:** admin
- **Contraseña:** 25252550*a

## 🔗 API Endpoints

| Endpoint | Método | Función |
|----------|--------|---------|
| `/api/health` | GET | Health check |
| `/api/plantillas` | GET | Listar plantillas |
| `/api/plantillas/:id` | GET | Obtener plantilla |
| `/api/config?t=X` | GET | Config de flujo del tenant |
| `/api/config` | PUT | Actualizar config (activar, modo, plantilla) |
| `/api/motor/ejecutar` | POST | Ejecutar paso del flujo (interno) |
| `/api/motor/estado` | GET | Verificar si tenant tiene flujo activo |
| `/api/motor/reset` | POST | Reiniciar sesión |
| `/api/sesiones?t=X` | GET | Listar sesiones |

---
**SGC Flujos · MakeSEO Academy · Edward Valencia · @makeseo**
