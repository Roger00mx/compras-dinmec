// =============================================================
//  COMPRAS SGC DIGITAL  -  Servidor (Node.js puro, sin dependencias)
//  DINMEC - SGC 2026   ·   Proceso PS-GDC-01 (FO-GDC-01 a 07)
//
//  Arranca con: node server.js   (o doble clic en INICIAR.bat)
//  Base de datos integrada (node:sqlite). No requiere instalar nada.
// =============================================================

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const F = require("./formatos.js");

const PUERTO = process.env.PORT || 3020;
const DIR = __dirname;
const DIR_DATOS = process.env.DIR_DATOS || path.join(DIR, "data");
const DIR_ARCHIVOS = path.join(DIR_DATOS, "uploads");
const DIR_PUBLIC = path.join(DIR, "public");
fs.mkdirSync(DIR_ARCHIVOS, { recursive: true });

// ---------- Base de datos ----------
const db = new DatabaseSync(path.join(DIR_DATOS, "compras.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS compras (
    id TEXT PRIMARY KEY,
    folio TEXT,             -- número: 2026-001 (se muestra REQ-2026-001 / OC-2026-001)
    proyecto TEXT, cliente TEXT, clase TEXT,
    creado TEXT, creado_por TEXT, actualizado TEXT, actualizado_por TEXT
  );
  CREATE TABLE IF NOT EXISTS secciones (
    id TEXT PRIMARY KEY,
    compra_id TEXT, seccion TEXT,   -- requisicion | seleccion | oc | recepcion | cxp
    datos TEXT,                     -- JSON con lo capturado (campos, partidas, estado)
    firmas TEXT,                    -- JSON: [{rol,nombre,firma(dataURL),fecha,usuario}]
    actualizado TEXT, actualizado_por TEXT,
    UNIQUE(compra_id, seccion)
  );
  CREATE TABLE IF NOT EXISTS proveedores (
    id TEXT PRIMARY KEY,
    razon_social TEXT, rfc TEXT, suministra TEXT,
    fecha_alta TEXT, credito_dias INTEGER, condicion_pago TEXT, forma_pago TEXT,
    direccion TEXT, contacto TEXT, telefono TEXT, email TEXT,
    estatus TEXT,                   -- Aprobado | Condicionado | Restringido | Inactivo
    creado TEXT, actualizado TEXT
  );
  CREATE TABLE IF NOT EXISTS evaluaciones (
    id TEXT PRIMARY KEY,
    proveedor_id TEXT,
    datos TEXT,                     -- JSON: fecha, periodo, calificaciones, total, clasificacion
    firmas TEXT,
    creado TEXT, creado_por TEXT
  );
  CREATE TABLE IF NOT EXISTS archivos (
    id TEXT PRIMARY KEY,
    compra_id TEXT, seccion TEXT,
    archivo TEXT, nombre_original TEXT, subido TEXT, subido_por TEXT
  );
  CREATE TABLE IF NOT EXISTS bitacora (
    id TEXT PRIMARY KEY,
    compra_id TEXT, usuario TEXT, fecha TEXT, accion TEXT, detalle TEXT
  );
  CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY,
    usuario TEXT UNIQUE, nombre TEXT, rol TEXT,
    clave TEXT, rol_app TEXT, creado TEXT
  );
  CREATE TABLE IF NOT EXISTS sesiones (
    token TEXT PRIMARY KEY,
    usuario_id TEXT, creado TEXT, expira TEXT
  );
`);
// Migraciones (columnas agregadas después de la versión 1.0)
{
  const cols = db.prepare("PRAGMA table_info(compras)").all().map((c) => c.name);
  if (!cols.includes("destino")) db.exec("ALTER TABLE compras ADD COLUMN destino TEXT");
  const colsU = db.prepare("PRAGMA table_info(usuarios)").all().map((c) => c.name);
  if (!colsU.includes("finanzas")) db.exec("ALTER TABLE usuarios ADD COLUMN finanzas INTEGER DEFAULT 0");
}
// Módulo FINANZAS (control de cajas y gastos)
db.exec(`
  CREATE TABLE IF NOT EXISTS cajas (
    id TEXT PRIMARY KEY, nombre TEXT, creado TEXT
  );
  CREATE TABLE IF NOT EXISTS movimientos (
    id TEXT PRIMARY KEY,
    caja_id TEXT, tipo TEXT, concepto TEXT, importe REAL,
    archivo TEXT, fecha TEXT, usuario TEXT
  );
  CREATE TABLE IF NOT EXISTS whatsapp_destinos (
    id TEXT PRIMARY KEY,
    nombre TEXT, telefono TEXT, apikey TEXT,
    ev_requisicion INTEGER DEFAULT 1, ev_autorizar INTEGER DEFAULT 1, creado TEXT
  );
  CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY, valor TEXT
  );
`);
const puedeFinanzas = (u) => !!u && (u.rol_app === "admin" || u.finanzas === 1);

// ---------- Avisos por WhatsApp ----------
// Vía principal: webhook de n8n (que envía con la API oficial de Meta, ya configurada por DINMEC).
// Respaldo opcional: CallMeBot por destino (si se captura su apikey).
const URL_APP = process.env.RENDER_EXTERNAL_URL || "";
const urlApp = (p) => (URL_APP ? URL_APP + p : "");
const getConf = (k) => (db.prepare("SELECT valor FROM config WHERE clave=?").get(k) || {}).valor || "";
const setConf = (k, v) => db.prepare("INSERT INTO config (clave,valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor").run(k, v);
function enviarWhatsA(telefono, apikey, texto) {
  const u = "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(telefono) +
    "&text=" + encodeURIComponent(texto) + "&apikey=" + encodeURIComponent(apikey);
  try { https.get(u, (r) => { r.resume(); }).on("error", () => {}); } catch (_) {}
}
function postWebhook(urlStr, payload) {
  try {
    const u = new URL(urlStr);
    const datos = JSON.stringify(payload);
    const reqW = (u.protocol === "http:" ? http : https).request(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(datos) } }, (r) => { r.resume(); });
    reqW.on("error", () => {}); reqW.write(datos); reqW.end();
  } catch (_) {}
}
function postWebhookEspera(urlStr, payload) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const datos = JSON.stringify(payload);
      const reqW = (u.protocol === "http:" ? http : https).request(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(datos) }, timeout: 10000 }, (r) => {
        let cuerpo = "";
        r.on("data", (c) => { if (cuerpo.length < 600) cuerpo += c; });
        r.on("end", () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, cuerpo: String(cuerpo).slice(0, 300) }));
      });
      reqW.on("timeout", () => { reqW.destroy(); resolve({ ok: false, status: 0, cuerpo: "sin respuesta (timeout)" }); });
      reqW.on("error", (e) => resolve({ ok: false, status: 0, cuerpo: e.message }));
      reqW.write(datos); reqW.end();
    } catch (e) { resolve({ ok: false, status: 0, cuerpo: e.message }); }
  });
}
function notificarWhats(evento, texto) {
  try {
    // Meta rechaza variables de plantilla con saltos de línea: aplanar el texto a una sola línea
    const textoPlano = String(texto).replace(/\s*\n+\s*/g, " · ").replace(/\s{2,}/g, " ").trim();
    const col = evento === "requisicion" ? "ev_requisicion" : "ev_autorizar";
    const destinos = db.prepare("SELECT * FROM whatsapp_destinos WHERE " + col + "=1").all().filter((d) => d.telefono);
    if (!destinos.length) return;
    const webhook = getConf("webhook_n8n");
    if (webhook) {
      postWebhook(webhook, { origen: "compras-dinmec", evento, texto: textoPlano, telefonos: destinos.map((d) => d.telefono) });
    } else {
      for (const d of destinos) if (d.apikey) enviarWhatsA(d.telefono, d.apikey, textoPlano);
    }
  } catch (_) {}
}

// ---------- Utilidades ----------
const ahora = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};
function leerCuerpo(req, limite = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limite) { reject(new Error("Archivo demasiado grande")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function ipsLocales() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const nombre of Object.keys(ifaces)) for (const ni of ifaces[nombre]) {
    if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
  }
  return out;
}

// ---------- Seguridad: contraseñas, cookies y sesiones ----------
function hashClave(pass) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pass, salt, 64).toString("hex");
  return salt + ":" + hash;
}
function verificarClave(pass, guardado) {
  try {
    const [salt, hash] = guardado.split(":");
    const h = crypto.scryptSync(pass, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(hash, "hex"));
  } catch { return false; }
}
function leerCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("="); if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function crearSesion(usuarioId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expira = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sesiones (token,usuario_id,creado,expira) VALUES (?,?,?,?)").run(token, usuarioId, ahora(), expira);
  return token;
}
function usuarioDeSesion(req) {
  const tok = leerCookies(req)["cd_sesion"];
  if (!tok) return null;
  const s = db.prepare("SELECT * FROM sesiones WHERE token=?").get(tok);
  if (!s) return null;
  if (s.expira && s.expira < ahora()) { db.prepare("DELETE FROM sesiones WHERE token=?").run(tok); return null; }
  return db.prepare("SELECT id,usuario,nombre,rol,rol_app,finanzas FROM usuarios WHERE id=?").get(s.usuario_id) || null;
}
function hayUsuarios() { return db.prepare("SELECT COUNT(*) c FROM usuarios").get().c > 0; }

// ---------- Sincronización en vivo (SSE) ----------
const clientesSSE = new Set();
function avisarCambio(compraId, motivo) {
  const msg = `data: ${JSON.stringify({ compraId, motivo, t: ahora() })}\n\n`;
  for (const c of clientesSSE) { try { c.write(msg); } catch (_) {} }
}

// ---------- Bitácora (audit trail del SGC) ----------
function registrarBitacora(compraId, usuario, accion, detalle) {
  db.prepare("INSERT INTO bitacora (id,compra_id,usuario,fecha,accion,detalle) VALUES (?,?,?,?,?,?)")
    .run(uid(), compraId, usuario || "", ahora(), accion, detalle || "");
}

// ---------- Folio consecutivo por día: DD.MM.AA-## (ej. 07.07.26-01) ----------
function fechaLocalMx() {
  const partes = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit", year: "2-digit" }).formatToParts(new Date());
  const g = (t) => (partes.find((x) => x.type === t) || {}).value || "";
  return { dd: g("day"), mm: g("month"), yy: g("year") };
}
function nuevoFolio() {
  const { dd, mm, yy } = fechaLocalMx();
  const pref = dd + "." + mm + "." + yy + "-";
  const filas = db.prepare("SELECT folio FROM compras WHERE folio LIKE ?").all(pref + "%");
  let max = 0;
  for (const f of filas) { const n = parseInt((f.folio || "").slice(pref.length), 10); if (n > max) max = n; }
  return pref + String(max + 1).padStart(2, "0");
}

// ---------- Estado y progreso del expediente ----------
function seccionesDe(compraId) {
  const filas = db.prepare("SELECT * FROM secciones WHERE compra_id=?").all(compraId);
  const out = {};
  for (const f of filas) out[f.seccion] = {
    datos: JSON.parse(f.datos || "{}"),
    firmas: JSON.parse(f.firmas || "[]"),
    actualizado: f.actualizado, actualizado_por: f.actualizado_por
  };
  return out;
}
function resumenExpediente(sec) {
  const req = sec.requisicion?.datos || {};
  const sel = sec.seleccion?.datos || {};
  const oc = sec.oc?.datos || {};
  const rec = sec.recepcion?.datos || {};
  const cxp = sec.cxp?.datos || {};
  if (req.estado === "rechazada") return { etiqueta: "Rechazada", color: "rojo", pct: 0 };
  let pasos = 0;
  if (req.estado === "autorizada") pasos = 1; else if (req.estado === "solicitada") return { etiqueta: "Pendiente de autorizar", color: "ambar", pct: 8 };
  else return { etiqueta: "Borrador", color: "gris", pct: 0 };
  let etiqueta = "Requisición autorizada";
  if (sel.estado === "aprobada") { pasos = 2; etiqueta = "Selección aprobada"; }
  else if ((sel.cotizaciones || []).some((c) => c.seleccionado)) return { etiqueta: "Selección por aprobar (DG)", color: "ambar", pct: 30 };
  else if ((sel.cotizaciones || []).length) return { etiqueta: "En cotización", color: "ambar", pct: 25 };
  const ords = oc.ordenes || (oc.partidas ? [oc] : []);
  if (ords.length && ords.every(o => o.estado === "enviada")) { pasos = 3; etiqueta = "OC enviada"; }
  else if (ords.some(o => o.estado === "autorizada" || o.estado === "enviada")) { pasos = 3; etiqueta = "OC autorizada"; }
  else if (ords.length) { return { etiqueta: "OC pendiente de autorizar", color: "ambar", pct: 50 }; }
  const entregas = rec.entregas || [];
  const noConforme = entregas.some(e => e.resultado === "no conforme");
  if (rec.estado === "total") { pasos = 4; etiqueta = noConforme ? "Recibida (con NC)" : "Recibida total"; }
  else if (entregas.length) { etiqueta = "Recibida parcial"; }
  const facturas = cxp.facturas || [];
  if (facturas.length && facturas.every(f => f.pagada)) { pasos = 5; etiqueta = "Pagada · Cerrada"; }
  const color = etiqueta.includes("NC") ? "rojo" : (pasos >= 5 ? "verde" : (pasos >= 1 ? "azul" : "gris"));
  return { etiqueta, color, pct: Math.round(pasos / 5 * 100) };
}
function obtenerCompra(id) {
  const c = db.prepare("SELECT * FROM compras WHERE id=?").get(id);
  if (!c) return null;
  const sec = seccionesDe(id);
  const archivos = db.prepare("SELECT * FROM archivos WHERE compra_id=? ORDER BY subido").all(id)
    .map(a => ({ id: a.id, seccion: a.seccion, url: "/archivo/" + a.archivo, nombre: a.nombre_original, subido: a.subido, subido_por: a.subido_por }));
  return { compra: c, secciones: sec, archivos, resumen: resumenExpediente(sec) };
}

// ---------- Validación de transiciones que requieren autorización ----------
function validarPermisos(yo, seccion, previo, nuevo) {
  const esAut = F.puedeAutorizar(yo);
  const p = previo?.datos || {}, n = nuevo || {};
  const cambia = (campo, valor) => p[campo] !== valor && n[campo] === valor;
  if (seccion === "requisicion" && (cambia("estado", "autorizada") || cambia("estado", "rechazada")) && !esAut)
    return "Solo Dirección general puede autorizar o rechazar la requisición";
  if (seccion === "seleccion" && cambia("estado", "aprobada") && !esAut)
    return "Solo Dirección general puede aprobar la selección de proveedor";
  if (seccion === "oc") {
    if (cambia("estado", "autorizada") && !esAut) return "Solo Dirección o Admón. y finanzas pueden autorizar la orden de compra";
    const po = p.ordenes || [], no_ = n.ordenes || [];
    for (const o of no_) {
      const antes = po.find((x) => x.id === o.id);
      const antesEstado = antes ? antes.estado : "";
      if (o.estado === "autorizada" && antesEstado !== "autorizada" && antesEstado !== "enviada" && !esAut)
        return "Solo Dirección o Admón. y finanzas pueden autorizar la orden de compra";
    }
  }
  if (seccion === "cxp") {
    const pf = p.facturas || [], nf = n.facturas || [];
    for (let i = 0; i < nf.length; i++) {
      const antes = pf.find(x => x.id === nf[i].id);
      if (nf[i].autorizada && !(antes && antes.autorizada) && !esAut)
        return "Solo Dirección general puede autorizar facturas para pago";
    }
  }
  return null;
}
function describirCambio(seccion, previo, nuevo) {
  const p = previo?.datos || {}, n = nuevo || {};
  if (p.estado !== n.estado && n.estado) return `${seccion}: estado → ${n.estado}`;
  return `${seccion}: datos actualizados`;
}

// ---------- Servir archivos estáticos ----------
const TIPOS = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json; charset=utf-8", ".json": "application/json; charset=utf-8", ".pdf": "application/pdf", ".xml": "application/xml; charset=utf-8" };
function servirArchivo(res, archivo, descarga) {
  fs.readFile(archivo, (err, data) => {
    if (err) { res.writeHead(404); res.end("No encontrado"); return; }
    const cab = { "Content-Type": TIPOS[path.extname(archivo).toLowerCase()] || "application/octet-stream" };
    if (descarga) cab["Content-Disposition"] = `attachment; filename="${descarga.replace(/"/g, "")}"`;
    res.writeHead(200, cab);
    res.end(data);
  });
}

// ---------- Servidor ----------
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ruta = decodeURIComponent(url.pathname);
  try {
    const yo = usuarioDeSesion(req);

    // ---- Autenticación (rutas públicas) ----
    if (ruta === "/api/estado" && req.method === "GET") {
      return json(res, 200, { configurado: hayUsuarios(), yo: yo ? { usuario: yo.usuario, nombre: yo.nombre, rol: yo.rol, rol_app: yo.rol_app, autoriza: F.puedeAutorizar(yo), veTodo: F.puedeVerTodo(yo), finanzas: puedeFinanzas(yo) } : null });
    }
    if (ruta === "/api/setup" && req.method === "POST") {
      if (hayUsuarios()) return json(res, 403, { error: "Ya está configurado" });
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      if (!b.usuario || !b.clave) return json(res, 400, { error: "Faltan datos" });
      const id = uid();
      db.prepare("INSERT INTO usuarios (id,usuario,nombre,rol,clave,rol_app,creado) VALUES (?,?,?,?,?,?,?)")
        .run(id, b.usuario.toLowerCase().trim(), b.nombre || b.usuario, b.rol || "", hashClave(b.clave), "admin", ahora());
      const token = crearSesion(id);
      res.setHeader("Set-Cookie", `cd_sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
      return json(res, 200, { ok: true });
    }
    if (ruta === "/api/login" && req.method === "POST") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const u = db.prepare("SELECT * FROM usuarios WHERE usuario=?").get((b.usuario || "").toLowerCase().trim());
      if (!u || !verificarClave(b.clave || "", u.clave)) return json(res, 401, { error: "Usuario o contraseña incorrectos" });
      const token = crearSesion(u.id);
      res.setHeader("Set-Cookie", `cd_sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
      return json(res, 200, { ok: true, yo: { usuario: u.usuario, nombre: u.nombre, rol: u.rol, rol_app: u.rol_app } });
    }
    if (ruta === "/api/logout" && req.method === "POST") {
      const tok = leerCookies(req)["cd_sesion"];
      if (tok) db.prepare("DELETE FROM sesiones WHERE token=?").run(tok);
      res.setHeader("Set-Cookie", "cd_sesion=; Path=/; HttpOnly; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    // ---- Gestión de usuarios (solo admin) ----
    if (ruta === "/api/usuarios") {
      if (!yo || yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador" });
      if (req.method === "GET") return json(res, 200, db.prepare("SELECT id,usuario,nombre,rol,rol_app,finanzas,creado FROM usuarios ORDER BY creado").all());
      if (req.method === "POST") {
        const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
        if (!b.usuario || !b.clave) return json(res, 400, { error: "Faltan usuario o contraseña" });
        const existe = db.prepare("SELECT id FROM usuarios WHERE usuario=?").get(b.usuario.toLowerCase().trim());
        if (existe) return json(res, 409, { error: "Ese usuario ya existe" });
        db.prepare("INSERT INTO usuarios (id,usuario,nombre,rol,clave,rol_app,finanzas,creado) VALUES (?,?,?,?,?,?,?,?)")
          .run(uid(), b.usuario.toLowerCase().trim(), b.nombre || b.usuario, b.rol || "", hashClave(b.clave), b.rol_app === "admin" ? "admin" : "usuario", b.finanzas ? 1 : 0, ahora());
        return json(res, 200, { ok: true });
      }
    }
    const mUsr = ruta.match(/^\/api\/usuarios\/([^/]+)$/);
    if (mUsr) {
      if (!yo || yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador" });
      if (req.method === "DELETE") {
        if (mUsr[1] === yo.id) return json(res, 400, { error: "No puedes eliminarte a ti mismo" });
        db.prepare("DELETE FROM usuarios WHERE id=?").run(mUsr[1]);
        db.prepare("DELETE FROM sesiones WHERE usuario_id=?").run(mUsr[1]);
        return json(res, 200, { ok: true });
      }
      if (req.method === "PUT") {
        const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
        if (b.clave) db.prepare("UPDATE usuarios SET clave=? WHERE id=?").run(hashClave(b.clave), mUsr[1]);
        if (b.finanzas !== undefined) db.prepare("UPDATE usuarios SET finanzas=? WHERE id=?").run(b.finanzas ? 1 : 0, mUsr[1]);
        if (!b.clave && b.finanzas === undefined) return json(res, 400, { error: "Nada que actualizar" });
        return json(res, 200, { ok: true });
      }
    }

    // ---- Avisos por WhatsApp: configuración y destinos (solo admin) ----
    if (ruta === "/api/whats-config") {
      if (!yo || yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador" });
      if (req.method === "GET") return json(res, 200, { webhook_n8n: getConf("webhook_n8n") });
      if (req.method === "PUT") {
        const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
        setConf("webhook_n8n", (b.webhook_n8n || "").trim());
        return json(res, 200, { ok: true });
      }
    }
    if (ruta === "/api/whats") {
      if (!yo || yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador" });
      if (req.method === "GET") return json(res, 200, db.prepare("SELECT * FROM whatsapp_destinos ORDER BY creado").all());
      if (req.method === "POST") {
        const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
        if (!b.telefono) return json(res, 400, { error: "Teléfono obligatorio, con código de país (ej. 5212221234567)" });
        db.prepare("INSERT INTO whatsapp_destinos (id,nombre,telefono,apikey,ev_requisicion,ev_autorizar,creado) VALUES (?,?,?,?,?,?,?)")
          .run(uid(), b.nombre || "", b.telefono.trim(), (b.apikey || "").trim(), b.ev_requisicion ? 1 : 0, b.ev_autorizar ? 1 : 0, ahora());
        return json(res, 200, { ok: true });
      }
    }
    const mWhats = ruta.match(/^\/api\/whats\/([^/]+)$/);
    if (mWhats && req.method === "DELETE") {
      if (!yo || yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador" });
      db.prepare("DELETE FROM whatsapp_destinos WHERE id=?").run(mWhats[1]);
      return json(res, 200, { ok: true });
    }
    const mWhatsPr = ruta.match(/^\/api\/whats\/([^/]+)\/prueba$/);
    if (mWhatsPr && req.method === "POST") {
      if (!yo || yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador" });
      const d = db.prepare("SELECT * FROM whatsapp_destinos WHERE id=?").get(mWhatsPr[1]);
      if (!d) return json(res, 404, { error: "Destino no encontrado" });
      const webhook = getConf("webhook_n8n");
      const txt = "✅ Prueba de avisos COMPRAS DINMEC: este número recibirá las notificaciones. " + urlApp("/");
      if (webhook) {
        const rw = await postWebhookEspera(webhook, { origen: "compras-dinmec", evento: "prueba", texto: txt, telefonos: [d.telefono] });
        if (!rw.ok) return json(res, 502, { error: "n8n NO aceptó el aviso (HTTP " + (rw.status || "sin conexión") + "): " + rw.cuerpo });
        return json(res, 200, { ok: true, detalle: "n8n recibió el aviso (HTTP " + rw.status + "). Si no llega el WhatsApp, revisa el nodo de WhatsApp en n8n (Executions)." });
      }
      if (d.apikey) { enviarWhatsA(d.telefono, d.apikey, txt); return json(res, 200, { ok: true, detalle: "Enviado vía CallMeBot" }); }
      return json(res, 400, { error: "Configura primero el webhook de n8n (o la apikey de CallMeBot del destino)" });
    }

    // ---- Respaldo (solo admin) ----
    if (ruta === "/api/respaldo" && req.method === "GET") {
      if (!yo || yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador" });
      const tmp = path.join(DIR_DATOS, "respaldo_tmp.db");
      try { fs.unlinkSync(tmp); } catch (_) {}
      db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
      const data = fs.readFileSync(tmp);
      try { fs.unlinkSync(tmp); } catch (_) {}
      const fecha = ahora().slice(0, 10);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="respaldo-compras-${fecha}.db"` });
      return res.end(data);
    }

    // ---- Protección: API de datos y archivos requieren sesión ----
    if ((ruta.startsWith("/api/") || ruta.startsWith("/archivo/") || ruta.startsWith("/finimg/")) && !yo) {
      return json(res, 401, { error: "Necesitas iniciar sesión" });
    }

    // ---- Catálogos de los formatos ----
    if (ruta === "/api/catalogos" && req.method === "GET") {
      return json(res, 200, {
        roles: F.ROLES, versiones: F.VERSIONES,
        tipos_compra: F.TIPOS_COMPRA, clase_compra: F.CLASE_COMPRA, unidades: F.UNIDADES,
        uso_cfdi: F.USO_CFDI, forma_pago: F.FORMA_PAGO, metodo_pago: F.METODO_PAGO,
        condiciones_pago: F.CONDICIONES_PAGO, monedas: F.MONEDAS, iva: F.IVA_PORC,
        facturacion: F.FACTURACION, criterios_seleccion: F.CRITERIOS_SELECCION,
        criterios_evaluacion: F.CRITERIOS_EVALUACION, clasificaciones: F.CLASIFICACIONES,
        pasos: F.PASOS_EXPEDIENTE,
      });
    }

    // ---- Lista de usuarios para selectores de firmas (cualquier usuario con sesión) ----
    if (ruta === "/api/usuarios-lista" && req.method === "GET") {
      const lista = db.prepare("SELECT nombre,rol,rol_app FROM usuarios ORDER BY nombre").all();
      return json(res, 200, lista.map((u) => ({ nombre: u.nombre, rol: u.rol, autoriza: F.puedeAutorizar(u) })));
    }

    // ---- Expedientes de compra ----
    if (ruta === "/api/compras" && req.method === "GET") {
      const lista = db.prepare("SELECT * FROM compras ORDER BY actualizado DESC").all();
      const out = lista.map(c => {
        const sec = seccionesDe(c.id);
        const req_ = sec.requisicion?.datos || {};
        const parts = req_.partidas || [];
        return { ...c, resumen: resumenExpediente(sec), fecha_requerida: req_.fecha_requerida || "", tipo_compra: req_.tipo_compra || "", partidas: parts.length, descripcion1: (parts[0] || {}).descripcion || "" };
      });
      return json(res, 200, out);
    }
    if (ruta === "/api/compras" && req.method === "POST") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const id = uid(), folio = nuevoFolio();
      db.prepare("INSERT INTO compras (id,folio,proyecto,cliente,clase,destino,creado,creado_por,actualizado,actualizado_por) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, folio, b.proyecto || "", b.cliente || "", b.clase || "Directa", b.destino || "proyecto", ahora(), yo.nombre, ahora(), yo.nombre);
      registrarBitacora(id, yo.nombre, "Crear", "Expediente " + folio + " creado");
      return json(res, 200, { id, folio });
    }
    const mCompra = ruta.match(/^\/api\/compra\/([^/]+)$/);
    if (mCompra && req.method === "GET") {
      const full = obtenerCompra(mCompra[1]);
      if (!full) return json(res, 404, { error: "Expediente no encontrado" });
      // Confidencialidad: quien no ve todo, recibe requisición + recepción (con OC sanitizada SIN precios)
      if (!F.puedeVerTodo(yo)) {
        const ocFull = (full.secciones.oc || {}).datos || {};
        const ordsSan = (ocFull.ordenes || (ocFull.partidas ? [ocFull] : [])).map((o) => ({
          id: o.id, proveedor_id: o.proveedor_id, estado: o.estado,
          partidas: (o.partidas || []).map((p) => ({ cantidad: p.cantidad, unidad: p.unidad, descripcion: p.descripcion })),
        }));
        const idsProv = [...new Set(ordsSan.map((o) => o.proveedor_id).filter(Boolean))];
        full.proveedores = idsProv.map((pid) => db.prepare("SELECT id, razon_social FROM proveedores WHERE id=?").get(pid) || { id: pid, razon_social: "" });
        full.secciones = {
          requisicion: full.secciones.requisicion || { datos: {}, firmas: [] },
          recepcion: full.secciones.recepcion || { datos: {}, firmas: [] },
          oc: { datos: { ordenes: ordsSan }, firmas: [] },
        };
        full.archivos = full.archivos.filter((a) => a.seccion === "requisicion" || a.seccion === "recepcion");
      }
      return json(res, 200, full);
    }
    if (mCompra && req.method === "PUT") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const actual = db.prepare("SELECT folio FROM compras WHERE id=?").get(mCompra[1]);
      if (!actual) return json(res, 404, { error: "Expediente no encontrado" });
      let folio = actual.folio;
      // Cambiar el folio: solo administrador (para empatar con el consecutivo en papel)
      if (b.folio !== undefined && String(b.folio).trim() !== actual.folio) {
        if (yo.rol_app !== "admin") return json(res, 403, { error: "Solo el administrador puede cambiar el folio" });
        const m = String(b.folio).trim().match(/^(\d{2})\.(\d{2})\.(\d{2})-(\d{1,3})$/);
        if (!m) return json(res, 400, { error: "Folio inválido. Usa el formato DD.MM.AA-número, ej. 07.07.26-01" });
        const nuevo = m[1] + "." + m[2] + "." + m[3] + "-" + String(parseInt(m[4], 10)).padStart(2, "0");
        const dup = db.prepare("SELECT id FROM compras WHERE folio=? AND id<>?").get(nuevo, mCompra[1]);
        if (dup) return json(res, 409, { error: "Ya existe otro expediente con el folio " + nuevo });
        folio = nuevo;
        registrarBitacora(mCompra[1], yo.nombre, "Cambio de folio", actual.folio + " → " + nuevo);
      }
      db.prepare("UPDATE compras SET folio=?,proyecto=?,cliente=?,clase=?,destino=?,actualizado=?,actualizado_por=? WHERE id=?")
        .run(folio, b.proyecto || "", b.cliente || "", b.clase || "Directa", b.destino || "proyecto", ahora(), yo.nombre, mCompra[1]);
      avisarCambio(mCompra[1], "cabecera");
      return json(res, 200, { ok: true, folio });
    }
    if (mCompra && req.method === "DELETE") {
      if (yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador puede eliminar expedientes" });
      const c = db.prepare("SELECT folio FROM compras WHERE id=?").get(mCompra[1]);
      db.prepare("DELETE FROM compras WHERE id=?").run(mCompra[1]);
      db.prepare("DELETE FROM secciones WHERE compra_id=?").run(mCompra[1]);
      for (const a of db.prepare("SELECT archivo FROM archivos WHERE compra_id=?").all(mCompra[1])) {
        try { fs.unlinkSync(path.join(DIR_ARCHIVOS, a.archivo)); } catch (_) {}
      }
      db.prepare("DELETE FROM archivos WHERE compra_id=?").run(mCompra[1]);
      registrarBitacora(mCompra[1], yo.nombre, "Eliminar", "Expediente " + (c?.folio || "") + " eliminado");
      avisarCambio(mCompra[1], "eliminado");
      return json(res, 200, { ok: true });
    }

    // Guardar UNA sección del expediente (granular, como las tareas de la hoja viajera)
    const mSec = ruta.match(/^\/api\/compra\/([^/]+)\/seccion$/);
    if (mSec && req.method === "POST") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const { seccion, datos, firmas } = b;
      if (!["requisicion", "seleccion", "oc", "recepcion", "cxp"].includes(seccion)) return json(res, 400, { error: "Sección inválida" });
      if (!["requisicion", "recepcion"].includes(seccion) && !F.puedeVerTodo(yo)) return json(res, 403, { error: "No tienes acceso a esta etapa del proceso (información confidencial)" });
      const previo = seccionesDe(mSec[1])[seccion];
      const errPerm = validarPermisos(yo, seccion, previo, datos);
      if (errPerm) return json(res, 403, { error: errPerm });
      const existente = db.prepare("SELECT id FROM secciones WHERE compra_id=? AND seccion=?").get(mSec[1], seccion);
      if (existente) {
        db.prepare("UPDATE secciones SET datos=?,firmas=?,actualizado=?,actualizado_por=? WHERE id=?")
          .run(JSON.stringify(datos || {}), JSON.stringify(firmas || []), ahora(), yo.nombre, existente.id);
      } else {
        db.prepare("INSERT INTO secciones (id,compra_id,seccion,datos,firmas,actualizado,actualizado_por) VALUES (?,?,?,?,?,?,?)")
          .run(uid(), mSec[1], seccion, JSON.stringify(datos || {}), JSON.stringify(firmas || []), ahora(), yo.nombre);
      }
      db.prepare("UPDATE compras SET actualizado=?,actualizado_por=? WHERE id=?").run(ahora(), yo.nombre, mSec[1]);
      registrarBitacora(mSec[1], yo.nombre, "Guardar", describirCambio(seccion, previo, datos));
      avisarCambio(mSec[1], seccion);
      // Avisos por WhatsApp
      if (seccion === "requisicion" && (datos || {}).estado === "solicitada" && ((previo?.datos || {}).estado || "") !== "solicitada") {
        const cW = db.prepare("SELECT folio FROM compras WHERE id=?").get(mSec[1]);
        const p1 = (((datos || {}).partidas || [])[0] || {}).descripcion || "";
        notificarWhats("requisicion", "📩 COMPRAS DINMEC\nNueva requisición REQ-" + (cW?.folio || "") + " de " + yo.nombre +
          (p1 ? ("\nMaterial: " + p1) : "") + "\n⏳ PENDIENTE DE AUTORIZAR\n" + urlApp("/compra.html?id=" + mSec[1]));
      }
      if (seccion === "seleccion" && ((datos || {}).estado || "") !== "aprobada") {
        const teniaSel = ((previo?.datos || {}).cotizaciones || []).some((c) => c.seleccionado);
        const tieneSel = ((datos || {}).cotizaciones || []).some((c) => c.seleccionado);
        if (tieneSel && !teniaSel) {
          const cW = db.prepare("SELECT folio FROM compras WHERE id=?").get(mSec[1]);
          notificarWhats("autorizar", "⏳ COMPRAS DINMEC\nSelección de proveedor POR APROBAR (Dirección general) en REQ-" + (cW?.folio || "") +
            "\nCapturó: " + yo.nombre + "\n" + urlApp("/compra.html?id=" + mSec[1]));
        }
      }
      if (seccion === "oc") {
        const antesN = ((previo?.datos || {}).ordenes || []).length, ahoraN = ((datos || {}).ordenes || []).length;
        if (ahoraN > antesN) {
          const cW = db.prepare("SELECT folio FROM compras WHERE id=?").get(mSec[1]);
          notificarWhats("autorizar", "⏳ COMPRAS DINMEC\n" + (ahoraN - antesN) + " orden(es) de compra PENDIENTES DE AUTORIZAR en REQ-" + (cW?.folio || "") +
            "\nCapturó: " + yo.nombre + "\n" + urlApp("/compra.html?id=" + mSec[1]));
        }
      }
      const sec = seccionesDe(mSec[1]);
      return json(res, 200, { ok: true, resumen: resumenExpediente(sec) });
    }

    // Subir archivo adjunto (cotización, factura, certificado, foto…)
    const mArch = ruta.match(/^\/api\/compra\/([^/]+)\/archivo$/);
    if (mArch && req.method === "POST") {
      const buf = await leerCuerpo(req);
      const seccion = url.searchParams.get("seccion") || "";
      if (!["requisicion", "recepcion"].includes(seccion) && !F.puedeVerTodo(yo)) return json(res, 403, { error: "No tienes acceso a esta etapa del proceso" });
      const nombre = url.searchParams.get("nombre") || "archivo.pdf";
      const ext = (path.extname(nombre) || ".pdf").toLowerCase();
      const permitidas = [".pdf", ".xml", ".jpg", ".jpeg", ".png", ".webp", ".xlsx", ".docx"];
      if (!permitidas.includes(ext)) return json(res, 400, { error: "Tipo de archivo no permitido: " + ext });
      const archivo = uid() + ext;
      fs.writeFileSync(path.join(DIR_ARCHIVOS, archivo), buf);
      const fid = uid();
      db.prepare("INSERT INTO archivos (id,compra_id,seccion,archivo,nombre_original,subido,subido_por) VALUES (?,?,?,?,?,?,?)")
        .run(fid, mArch[1], seccion, archivo, nombre, ahora(), yo.nombre);
      registrarBitacora(mArch[1], yo.nombre, "Adjuntar", seccion + ": " + nombre);
      avisarCambio(mArch[1], "archivo");
      return json(res, 200, { id: fid, url: "/archivo/" + archivo, nombre, seccion });
    }
    const mArchDel = ruta.match(/^\/api\/archivo\/([^/]+)$/);
    if (mArchDel && req.method === "DELETE") {
      const a = db.prepare("SELECT * FROM archivos WHERE id=?").get(mArchDel[1]);
      if (a) {
        try { fs.unlinkSync(path.join(DIR_ARCHIVOS, a.archivo)); } catch (_) {}
        db.prepare("DELETE FROM archivos WHERE id=?").run(mArchDel[1]);
        registrarBitacora(a.compra_id, yo.nombre, "Quitar adjunto", a.seccion + ": " + a.nombre_original);
        avisarCambio(a.compra_id, "archivo");
      }
      return json(res, 200, { ok: true });
    }
    const mArchGet = ruta.match(/^\/archivo\/(.+)$/);
    if (mArchGet && req.method === "GET") {
      const base = path.basename(mArchGet[1]);
      const fila = db.prepare("SELECT nombre_original, seccion FROM archivos WHERE archivo=?").get(base);
      if (fila && !["requisicion", "recepcion"].includes(fila.seccion) && !F.puedeVerTodo(yo)) return json(res, 403, { error: "Acceso restringido" });
      return servirArchivo(res, path.join(DIR_ARCHIVOS, base), url.searchParams.get("dl") ? (fila?.nombre_original || base) : null);
    }

    // ---- Proveedores (FO-GDC-05) — solo quienes ven todo el proceso ----
    if ((ruta === "/api/proveedores" || ruta.startsWith("/api/proveedor/")) && !F.puedeVerTodo(yo)) {
      return json(res, 403, { error: "Acceso restringido a Dirección / Admón. y finanzas / Responsable de almacén" });
    }
    if (ruta === "/api/proveedores" && req.method === "GET") {
      const lista = db.prepare("SELECT * FROM proveedores ORDER BY razon_social").all();
      const out = lista.map(p => {
        const ev = db.prepare("SELECT datos FROM evaluaciones WHERE proveedor_id=? ORDER BY creado DESC LIMIT 1").get(p.id);
        const d = ev ? JSON.parse(ev.datos || "{}") : null;
        return { ...p, ultima_eval: d ? { total: d.total, clasificacion: d.clasificacion, fecha: d.fecha } : null };
      });
      return json(res, 200, out);
    }
    if (ruta === "/api/proveedores" && req.method === "POST") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      if (!b.razon_social) return json(res, 400, { error: "Falta la razón social" });
      const id = uid();
      db.prepare(`INSERT INTO proveedores (id,razon_social,rfc,suministra,fecha_alta,credito_dias,condicion_pago,forma_pago,direccion,contacto,telefono,email,estatus,creado,actualizado)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, b.razon_social, b.rfc || "", b.suministra || "", b.fecha_alta || ahora().slice(0, 10), parseInt(b.credito_dias) || 0,
          b.condicion_pago || "", b.forma_pago || "", b.direccion || "", b.contacto || "", b.telefono || "", b.email || "",
          b.estatus || "Aprobado", ahora(), ahora());
      return json(res, 200, { id });
    }
    const mProv = ruta.match(/^\/api\/proveedor\/([^/]+)$/);
    if (mProv && req.method === "GET") {
      const p = db.prepare("SELECT * FROM proveedores WHERE id=?").get(mProv[1]);
      if (!p) return json(res, 404, { error: "Proveedor no encontrado" });
      const evaluaciones = db.prepare("SELECT * FROM evaluaciones WHERE proveedor_id=? ORDER BY creado DESC").all(mProv[1])
        .map(e => ({ id: e.id, creado: e.creado, creado_por: e.creado_por, datos: JSON.parse(e.datos || "{}"), firmas: JSON.parse(e.firmas || "[]") }));
      // historial de compras con este proveedor
      const historial = [];
      for (const c of db.prepare("SELECT * FROM compras ORDER BY creado DESC").all()) {
        const sec = seccionesDe(c.id);
        const ocp = sec.oc?.datos || {};
        if (ocp.proveedor_id === mProv[1]) historial.push({ id: c.id, folio: c.folio, proyecto: c.proyecto, total: ocp.total || 0, moneda: ocp.moneda || "MXN", resumen: resumenExpediente(sec) });
      }
      return json(res, 200, { proveedor: p, evaluaciones, historial });
    }
    if (mProv && req.method === "PUT") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      db.prepare(`UPDATE proveedores SET razon_social=?,rfc=?,suministra=?,fecha_alta=?,credito_dias=?,condicion_pago=?,forma_pago=?,direccion=?,contacto=?,telefono=?,email=?,estatus=?,actualizado=? WHERE id=?`)
        .run(b.razon_social || "", b.rfc || "", b.suministra || "", b.fecha_alta || "", parseInt(b.credito_dias) || 0,
          b.condicion_pago || "", b.forma_pago || "", b.direccion || "", b.contacto || "", b.telefono || "", b.email || "",
          b.estatus || "Aprobado", ahora(), mProv[1]);
      return json(res, 200, { ok: true });
    }
    if (mProv && req.method === "DELETE") {
      if (yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador" });
      db.prepare("DELETE FROM proveedores WHERE id=?").run(mProv[1]);
      db.prepare("DELETE FROM evaluaciones WHERE proveedor_id=?").run(mProv[1]);
      return json(res, 200, { ok: true });
    }
    const mEval = ruta.match(/^\/api\/proveedor\/([^/]+)\/evaluacion$/);
    if (mEval && req.method === "POST") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      db.prepare("INSERT INTO evaluaciones (id,proveedor_id,datos,firmas,creado,creado_por) VALUES (?,?,?,?,?,?)")
        .run(uid(), mEval[1], JSON.stringify(b.datos || {}), JSON.stringify(b.firmas || []), ahora(), yo.nombre);
      // actualizar estatus del proveedor según clasificación
      const cl = (b.datos || {}).clasificacion || "";
      let estatus = null;
      if (/no confiable/i.test(cl)) estatus = "Restringido";
      else if (/regular/i.test(cl)) estatus = "Condicionado";
      else if (cl) estatus = "Aprobado";
      if (estatus) db.prepare("UPDATE proveedores SET estatus=?,actualizado=? WHERE id=?").run(estatus, ahora(), mEval[1]);
      return json(res, 200, { ok: true });
    }

    // ---- Cuentas por pagar global (FO-GDC-06) ----
    if (ruta === "/api/cxp" && req.method === "GET" && !F.puedeVerTodo(yo)) {
      return json(res, 403, { error: "Acceso restringido a Dirección / Admón. y finanzas / Responsable de almacén" });
    }
    if (ruta === "/api/cxp" && req.method === "GET") {
      const provs = {};
      for (const c of db.prepare("SELECT * FROM compras").all()) {
        const sec = seccionesDe(c.id);
        const cxp = sec.cxp?.datos || {};
        const ocp = sec.oc?.datos || {};
        for (const f of (cxp.facturas || [])) {
          const pid = f.proveedor_id || ocp.proveedor_id || "";
          if (!provs[pid]) {
            const p = pid ? db.prepare("SELECT * FROM proveedores WHERE id=?").get(pid) : null;
            provs[pid] = { proveedor: p ? { id: p.id, razon_social: p.razon_social, credito_dias: p.credito_dias, contacto: p.contacto, telefono: p.telefono } : { id: "", razon_social: "(Sin proveedor)", credito_dias: 0 }, facturas: [] };
          }
          provs[pid].facturas.push({ ...f, compra_id: c.id, folio_compra: c.folio });
        }
      }
      return json(res, 200, Object.values(provs));
    }

    // ---- Bitácora ----
    const mBit = ruta.match(/^\/api\/bitacora\/([^/]+)$/);
    if (mBit && req.method === "GET") {
      let filas = db.prepare("SELECT * FROM bitacora WHERE compra_id=? ORDER BY fecha DESC").all(mBit[1]);
      // Confidencialidad: los roles restringidos solo ven movimientos de la requisición
      if (!F.puedeVerTodo(yo)) filas = filas.filter((b) => /requisicion|recepcion|Expediente|folio/i.test(b.detalle || "") || b.accion === "Crear");
      return json(res, 200, filas);
    }

    // ---- FINANZAS: control de cajas y gastos (acceso individual asignado por admin) ----
    if ((ruta.startsWith("/api/fin/") || ruta.startsWith("/finimg/")) && !puedeFinanzas(yo)) {
      return json(res, 403, { error: "Acceso restringido: pide al administrador que te active Finanzas" });
    }
    if (ruta === "/api/fin/cajas" && req.method === "GET") {
      const cajas = db.prepare("SELECT * FROM cajas ORDER BY creado").all();
      return json(res, 200, cajas.map((cj) => {
        const r = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo='INGRESO' THEN importe ELSE -importe END),0) s FROM movimientos WHERE caja_id=?").get(cj.id);
        return { ...cj, saldo: r.s };
      }));
    }
    if (ruta === "/api/fin/cajas" && req.method === "POST") {
      if (yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador puede crear cajas" });
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      if (!b.nombre || !b.nombre.trim()) return json(res, 400, { error: "Falta el nombre de la caja" });
      const id = uid();
      db.prepare("INSERT INTO cajas (id,nombre,creado) VALUES (?,?,?)").run(id, b.nombre.trim(), ahora());
      return json(res, 200, { id });
    }
    if (ruta === "/api/fin/movimientos" && req.method === "GET") {
      const caja = url.searchParams.get("caja") || "";
      let filas = caja
        ? db.prepare("SELECT * FROM movimientos WHERE caja_id=? ORDER BY fecha ASC, rowid ASC").all(caja)
        : db.prepare("SELECT * FROM movimientos ORDER BY fecha ASC, rowid ASC").all();
      const saldos = {};
      filas = filas.map((m) => {
        saldos[m.caja_id] = (saldos[m.caja_id] || 0) + (m.tipo === "INGRESO" ? m.importe : -m.importe);
        return { ...m, saldo: saldos[m.caja_id] };
      });
      return json(res, 200, filas.reverse());
    }
    if (ruta === "/api/fin/movimientos" && req.method === "POST") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      if (!b.caja_id || !b.tipo || !(parseFloat(b.importe) > 0)) return json(res, 400, { error: "Caja, tipo e importe (mayor a 0) son obligatorios" });
      const id = uid();
      db.prepare("INSERT INTO movimientos (id,caja_id,tipo,concepto,importe,archivo,fecha,usuario) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, b.caja_id, b.tipo === "INGRESO" ? "INGRESO" : "GASTO", b.concepto || "", parseFloat(b.importe), "", b.fecha || ahora(), yo.nombre);
      return json(res, 200, { id });
    }
    const mMovImg = ruta.match(/^\/api\/fin\/movimiento\/([^/]+)\/imagen$/);
    if (mMovImg && req.method === "POST") {
      const buf = await leerCuerpo(req);
      const nombre = url.searchParams.get("nombre") || "comprobante.jpg";
      const ext = (path.extname(nombre) || ".jpg").toLowerCase();
      if (![".jpg", ".jpeg", ".png", ".webp", ".pdf"].includes(ext)) return json(res, 400, { error: "Tipo de archivo no permitido: " + ext });
      const archivo = "fin_" + uid() + ext;
      fs.writeFileSync(path.join(DIR_ARCHIVOS, archivo), buf);
      db.prepare("UPDATE movimientos SET archivo=? WHERE id=?").run(archivo, mMovImg[1]);
      return json(res, 200, { ok: true, archivo });
    }
    const mMovDel = ruta.match(/^\/api\/fin\/movimiento\/([^/]+)$/);
    if (mMovDel && req.method === "PUT") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const m = db.prepare("SELECT * FROM movimientos WHERE id=?").get(mMovDel[1]);
      if (!m) return json(res, 404, { error: "Movimiento no encontrado" });
      db.prepare("UPDATE movimientos SET caja_id=?, tipo=?, concepto=?, importe=?, fecha=? WHERE id=?")
        .run(b.caja_id || m.caja_id, b.tipo === "INGRESO" ? "INGRESO" : "GASTO", b.concepto !== undefined ? b.concepto : m.concepto,
          parseFloat(b.importe) > 0 ? parseFloat(b.importe) : m.importe, b.fecha || m.fecha, mMovDel[1]);
      return json(res, 200, { ok: true });
    }
    if (mMovDel && req.method === "DELETE") {
      if (yo.rol_app !== "admin") return json(res, 403, { error: "Solo administrador puede eliminar movimientos" });
      const m = db.prepare("SELECT archivo FROM movimientos WHERE id=?").get(mMovDel[1]);
      if (m && m.archivo) { try { fs.unlinkSync(path.join(DIR_ARCHIVOS, m.archivo)); } catch (_) {} }
      db.prepare("DELETE FROM movimientos WHERE id=?").run(mMovDel[1]);
      return json(res, 200, { ok: true });
    }
    const mFinImg = ruta.match(/^\/finimg\/(.+)$/);
    if (mFinImg && req.method === "GET") {
      return servirArchivo(res, path.join(DIR_ARCHIVOS, path.basename(mFinImg[1])));
    }

    // ---- Sincronización en vivo ----
    if (ruta === "/api/eventos" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.write("retry: 3000\n\n");
      clientesSSE.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 25000);
      req.on("close", () => { clearInterval(ping); clientesSSE.delete(res); });
      return;
    }

    // ---- Archivos estáticos ----
    if (ruta === "/" || ruta === "") return servirArchivo(res, path.join(DIR_PUBLIC, "index.html"));
    const archivoEstatico = path.join(DIR_PUBLIC, path.normalize(ruta).replace(/^([/\\])+/, ""));
    if (archivoEstatico.startsWith(DIR_PUBLIC) && fs.existsSync(archivoEstatico) && fs.statSync(archivoEstatico).isFile()) {
      return servirArchivo(res, archivoEstatico);
    }
    res.writeHead(404); res.end("No encontrado");
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

servidor.listen(PUERTO, "0.0.0.0", () => {
  const ips = ipsLocales();
  console.log("\n==================================================");
  console.log("   COMPRAS SGC DIGITAL  -  DINMEC SGC 2026");
  console.log("   Proceso PS-GDC-01 · FO-GDC-01 a FO-GDC-07");
  console.log("==================================================");
  console.log("   Servidor encendido. Para entrar abre en tu navegador:\n");
  console.log("   En esta misma PC:   http://localhost:" + PUERTO);
  for (const ip of ips) console.log("   Desde otro equipo/celular:   http://" + ip + ":" + PUERTO);
  console.log("\n   (Todos deben estar en la MISMA red / WiFi de la planta)");
  console.log("   Para apagar el servidor: cierra esta ventana.");
  console.log("==================================================\n");
});