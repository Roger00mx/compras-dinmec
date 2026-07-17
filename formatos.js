// =============================================================
//  COMPRAS SGC DIGITAL  (DINMEC - SGC 2026)
//  Catálogos y "moldes" de los formatos FO-GDC-01 a FO-GDC-07
//  -> Si cambia un formato del SGC, edita este archivo.
//  Basado en PS-GDC-01 Ver. 00 (Compras, selección y evaluación de proveedores)
// =============================================================

const VERSIONES = {
  requisicion: "FO-GDC-01 Ver. 00",
  oc: "FO-GDC-02 Ver. 00",
  seleccion: "FO-GDC-03 Ver. 00",
  evaluacion: "FO-GDC-04 Ver. 00",
  catalogo: "FO-GDC-05 Ver. 00",
  cxp: "FO-GDC-06 Ver. 00",
  recepcion: "FO-GDC-07 Ver. 00",
};

// Roles del PS-GDC-01 (para el alta de usuarios)
const ROLES = [
  "Dirección general",
  "Gerente de administración y finanzas",
  "Responsable de almacén",
  "Coordinador del SGC",
  "Gerente de proyectos",
  "Gerente comercial",
  "Gerente diseño",
  "Gerente de producción",
];

// ¿Quién puede AUTORIZAR (requisición, selección, OC, pago)?  PS-GDC-01: Dirección general.
// El administrador de la app también puede (respaldo operativo).
function puedeAutorizar(usuario) {
  if (!usuario) return false;
  if (usuario.rol_app === "admin") return true;
  return /direc/i.test(usuario.rol || "");
}

// Tipos de compra del FO-GDC-01
const TIPOS_COMPRA = ["Metales", "Herramientas", "Tornillería", "Servicios / Tratamientos", "Materiales auxiliares", "Consumibles"];
const CLASE_COMPRA = ["Directa", "Indirecta"]; // definiciones del PS-GDC-01
const UNIDADES = ["pz", "kg", "lt", "m", "m2", "juego", "caja", "rollo", "servicio", "lote", "hr"];

// Catálogos de la Orden de Compra (FO-GDC-02)
const USO_CFDI = ["G01 Adquisición de mercancías", "G03 Gastos en general", "I04 Equipo de cómputo", "I08 Otra maquinaria y equipo", "P01 Por definir"];
const FORMA_PAGO = ["01 Efectivo", "03 Transferencia electrónica", "04 Tarjeta de crédito", "28 Tarjeta de débito", "99 Por definir"];
const METODO_PAGO = ["PUE Pago en una sola exhibición", "PPD Pago en parcialidades o diferido"];
const CONDICIONES_PAGO = ["Contado", "Crédito 8 días", "Crédito 15 días", "Crédito 30 días", "Crédito 45 días", "Anticipo 50%", "Otro"];
const MONEDAS = ["MXN", "USD"];
const IVA_PORC = 16;

// Datos de facturación de DINMEC (encabezado del FO-GDC-02)
const FACTURACION = {
  razon: "ROGELIO RIVERA ROJAS",
  direccion1: "CALLE 10 PONIENTE No. 506-C, COL CENTRO",
  direccion2: "SAN PEDRO CHOLULA, PUE.  C.P. 72760",
  rfc: "RIRR-811007-3T1",
  tel: "01 (222) 129 13 18",
  email: "facturaciondinmec@gmail.com",
};

// Criterios de selección de proveedor (FO-GDC-03)
const CRITERIOS_SELECCION = ["Atención", "Calidad", "Disponibilidad", "Precio", "Condiciones de pago"];

// Evaluación de proveedor (FO-GDC-04). Puntajes tal como el formato.
// Nota SGC: el puntaje máximo real es 18 (4+3+3+4+4); los rangos de clasificación
// se ajustaron para eliminar el traslape del formato impreso (propuesta Ver. 01).
const CRITERIOS_EVALUACION = [
  { id: "disponibilidad", nombre: "Disponibilidad", opciones: [
    { p: 4, t: "EXCELENTE — Todas las entregas se efectuaron antes o en la fecha acordada." },
    { p: 3, t: "BUENO — Las entregas se efectuaron en la fecha acordada." },
    { p: 2, t: "REGULAR — Menos del 5% de las entregas del periodo con retraso." },
    { p: 1, t: "NO CUMPLE — Más del 5% de las entregas con retraso." } ] },
  { id: "calidad", nombre: "Calidad", opciones: [
    { p: 3, t: "EXCELENTE — Sin incidencias de calidad en el periodo." },
    { p: 2, t: "REGULAR — Incidencias de calidad menores al 5% del periodo." },
    { p: 1, t: "NO CUMPLE — Incidencias de calidad superan el 5%." } ] },
  { id: "condiciones_pago", nombre: "Condiciones de pago", opciones: [
    { p: 3, t: "EXCELENTE — Ofrece crédito de más de 45 días." },
    { p: 2, t: "REGULAR — Ofrece crédito de menos de 45 días." },
    { p: 1, t: "NO CUMPLE — No ofrece crédito." } ] },
  { id: "atencion", nombre: "Atención", opciones: [
    { p: 4, t: "EXCELENTE — Lleva control postventa sobre la compra." },
    { p: 3, t: "BUENO — Responde y atiende las peticiones a tiempo." },
    { p: 2, t: "REGULAR — Responde o atiende de forma desordenada." },
    { p: 1, t: "NO CUMPLE — Responde o atiende tardíamente." } ] },
  { id: "precio", nombre: "Precio", opciones: [
    { p: 4, t: "EXCELENTE — Precio más bajo que otros proveedores." },
    { p: 3, t: "BUENO — Precio competitivo, igual que otros proveedores." },
    { p: 2, t: "REGULAR — Precio más alto que la media." },
    { p: 1, t: "NO CUMPLE — Precio muy por arriba de la media." } ] },
];

// Clasificación del desempeño (rangos corregidos, sin traslape; máx = 18)
const CLASIFICACIONES = [
  { min: 16, max: 18, nombre: "Excelente", detalle: "Proveedor confiable y recomendado.", color: "verde" },
  { min: 11, max: 15, nombre: "Bueno", detalle: "Proveedor confiable.", color: "azul" },
  { min: 6,  max: 10, nombre: "Regular", detalle: "Poco confiable. Condicionado y/o sancionado.", color: "ambar" },
  { min: 0,  max: 5,  nombre: "No confiable", detalle: "Proveedor restringido.", color: "rojo" },
];
function clasificar(total) {
  for (const c of CLASIFICACIONES) if (total >= c.min && total <= c.max) return c;
  return CLASIFICACIONES[CLASIFICACIONES.length - 1];
}

// Etapas del expediente de compra (para tarjetas y progreso)
const PASOS_EXPEDIENTE = [
  { id: "requisicion", nombre: "Requisición", fo: "FO-GDC-01" },
  { id: "seleccion", nombre: "Selección de proveedor", fo: "FO-GDC-03" },
  { id: "oc", nombre: "Orden de compra", fo: "FO-GDC-02" },
  { id: "recepcion", nombre: "Recepción en almacén", fo: "FO-GDC-07" },
  { id: "cxp", nombre: "Facturas y pago", fo: "FO-GDC-06" },
];

module.exports = {
  VERSIONES, ROLES, puedeAutorizar,
  TIPOS_COMPRA, CLASE_COMPRA, UNIDADES,
  USO_CFDI, FORMA_PAGO, METODO_PAGO, CONDICIONES_PAGO, MONEDAS, IVA_PORC,
  FACTURACION, CRITERIOS_SELECCION, CRITERIOS_EVALUACION, CLASIFICACIONES, clasificar,
  PASOS_EXPEDIENTE,
};
