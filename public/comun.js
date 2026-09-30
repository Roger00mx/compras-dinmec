// ============ Utilidades compartidas ============

// --- Sesión: exige usuario logueado, si no, manda al login ---
async function exigirSesion() {
  try {
    const est = await fetch("/api/estado").then(r => r.json());
    if (!est.yo) { location.href = "login.html"; return null; }
    return est.yo; // { usuario, nombre, rol, rol_app }
  } catch {
    location.href = "login.html"; return null;
  }
}
async function cerrarSesion() {
  await fetch("/api/logout", { method: "POST" });
  location.href = "login.html";
}

// --- Avisos rápidos (toast) ---
let _toastT;
function aviso(txt) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = txt; t.classList.add("ver");
  clearTimeout(_toastT); _toastT = setTimeout(() => t.classList.remove("ver"), 2200);
}

// --- API helpers ---
const api = {
  get: (u) => fetch(u).then(r => r.json()),
  post: (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  put: (u, b) => fetch(u, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  del: (u) => fetch(u, { method: "DELETE" }).then(r => r.json()),
};

// --- Sincronización en vivo (SSE) ---
function conectarEnVivo(alCambiar) {
  try {
    const ev = new EventSource("/api/eventos");
    ev.onmessage = (e) => { try { alCambiar(JSON.parse(e.data)); } catch {} };
    return ev;
  } catch { return null; }
}

// --- Firma con el dedo / mouse (canvas) ---
function crearFirma(caja) {
  const canvas = caja.querySelector("canvas");
  const ph = caja.querySelector(".ph");
  const ctx = canvas.getContext("2d");
  let pintando = false, vacio = true;
  function ajustar() {
    const r = caja.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#13284a";
  }
  setTimeout(ajustar, 0);
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  }
  function ini(e) { e.preventDefault(); pintando = true; const { x, y } = pos(e); ctx.beginPath(); ctx.moveTo(x, y); }
  function mov(e) { if (!pintando) return; e.preventDefault(); const { x, y } = pos(e); ctx.lineTo(x, y); ctx.stroke(); if (vacio) { vacio = false; if (ph) ph.style.display = "none"; } }
  function fin() { pintando = false; }
  canvas.addEventListener("mousedown", ini); canvas.addEventListener("mousemove", mov);
  window.addEventListener("mouseup", fin);
  canvas.addEventListener("touchstart", ini, { passive: false });
  canvas.addEventListener("touchmove", mov, { passive: false });
  canvas.addEventListener("touchend", fin);
  return {
    estaVacio: () => vacio,
    limpiar: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); vacio = true; if (ph) ph.style.display = "flex"; },
    aDataURL: () => vacio ? "" : canvas.toDataURL("image/png"),
  };
}

function escaparHTML(s) { return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function paramURL(n) { return new URL(location.href).searchParams.get(n); }

// --- PWA: instalar como app con ícono ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
let _promptInstalar = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); _promptInstalar = e;
  document.querySelectorAll("[data-instalar]").forEach(b => b.style.display = "inline-flex");
});
window.addEventListener("appinstalled", () => {
  document.querySelectorAll("[data-instalar]").forEach(b => b.style.display = "none");
});
async function instalarApp() {
  if (!_promptInstalar) {
    aviso("En tu navegador: menú ⋮ → \"Instalar app\" o \"Agregar a inicio\".");
    return;
  }
  _promptInstalar.prompt();
  await _promptInstalar.userChoice;
  _promptInstalar = null;
}

// --- Helpers de Compras SGC ---
function dinero(n, moneda){ const v=parseFloat(n)||0; return "$"+v.toLocaleString("es-MX",{minimumFractionDigits:2,maximumFractionDigits:2})+(moneda?(" "+moneda):""); }
function fechaCorta(iso){ try{ if(!iso) return ""; return new Date(iso).toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"}); }catch{ return ""; } }
function hoyISO(){ return new Date().toISOString().slice(0,10); }
function sumaDias(fechaISO, dias){ try{ const d=new Date(fechaISO+"T12:00:00"); d.setDate(d.getDate()+(parseInt(dias)||0)); return d.toISOString().slice(0,10);}catch{ return ""; } }

// --- Proveedores: pestañas compartidas (Tablero · Calificaciones · Directorio · Fichas) ---
function navProveedores(activa){
  const t=[["tablero","📊 Tablero","tablero-proveedores.html"],["evaluaciones","⭐ Calificaciones","evaluaciones.html"],
    ["directorio","📇 Directorio de contactos","directorio-proveedores.html"],["fichas","🏭 Fichas / alta","proveedores.html"]];
  const n=document.getElementById("subnav");
  if(n) n.innerHTML=t.map(([id,et,url])=>`<a href="${url}" class="${id===activa?"activa":""}">${et}</a>`).join("");
}
// Tipo de pago del proveedor según su ficha
function tipoPago(p){
  const c=(p.condicion_pago||"").toLowerCase(), d=parseInt(p.credito_dias)||0;
  if(/anticipo/.test(c)) return {id:"anticipo",et:"Anticipo",color:"ambar"};
  if(d>0||/cr[eé]dito/.test(c)) return {id:"credito",et:"Crédito "+(d||(c.match(/\d+/)||[""])[0])+" días",dias:d||parseInt((c.match(/\d+/)||[0])[0])||0,color:"verde"};
  if(/contado/.test(c)) return {id:"contado",et:"Solo contado",color:"rojo"};
  return {id:"sd",et:"Sin definir",color:"gris"};
}
// Estado de evaluación: sin evaluar / vencida (> 6 meses, PS-GDC-01 8.3) / vigente
function estadoEval(p){
  const u=p.ultima_eval;
  if(!u) return {id:"sin",et:"⚠️ EVALUAR LO ANTES POSIBLE"};
  const f=new Date((u.fecha||"")+"T12:00:00"), lim=new Date(); lim.setMonth(lim.getMonth()-6);
  if(!isNaN(f)&&f<lim) return {id:"vencida",et:"Reevaluación vencida"};
  return {id:"vigente",et:"Vigente"};
}
function colorClasifEval(c){
  if(!c) return "gris";
  if(/excelente/i.test(c)) return "verde";
  if(/bueno/i.test(c)) return "azul";
  if(/regular/i.test(c)) return "ambar";
  return "rojo";
}
function telLimpio(t){ return (t||"").replace(/[^\d+]/g,""); }
function waLink(t){ let d=(t||"").replace(/\D/g,""); if(d.length===10) d="52"+d; return d.length>=10?"https://wa.me/"+d:""; }
function encabezadoDinmec(titulo, fo){
  return `<div class="doc-cab-imp"><div><img src="/logo.png" alt="DINMEC GROUP"><div class="emp"><b>DINMEC GROUP SRL DE CV</b> · Calle 10 Poniente No. 506-C, Col. Centro, San Pedro Cholula, Pue. C.P. 72760</div></div>
    <div class="fo"><b>${titulo}</b>${fo}<br>Impreso: ${new Date().toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"})}</div></div>`;
}
