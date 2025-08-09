// scraping.js
// npm i axios cheerio tough-cookie axios-cookiejar-support
const fs = require('fs');
const path = require('path');
const axios = require('axios').default;
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

// ====== CONFIG ======
const USER = process.env.PORTAL_USER || '';
const PASS = process.env.PORTAL_PASS || '';
if (!USER || !PASS) {
  console.error('Faltan variables de entorno PORTAL_USER / PORTAL_PASS');
  process.exit(1);
}

// TODO: ajusta estas URLs a tu portal real
const PORTAL_BASE = 'https://portal.ejemplo.cl';
const LOGIN_URL   = PORTAL_BASE + '/login';              // endpoint de login
const NOTAS_URL   = PORTAL_BASE + '/concent-notas.asp';  // página donde aparecen las notas

// ====== HTTP client con cookies ======
const jar = new CookieJar();
const http = wrapper(axios.create({
  jar,
  withCredentials: true,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  },
  timeout: 60000
}));

// ====== helpers ======
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const toNum = (s)=> {
  if (s == null) return '';
  const n = String(s).replace(',', '.').trim();
  const f = parseFloat(n);
  return isNaN(f) ? '' : f.toFixed(1);
};
function safeTrim(s){ return (s==null)? '' : String(s).trim(); }
function yearFromText(t){
  const m = String(t||'').match(/20\d{2}/);
  return m ? parseInt(m[0],10) : (new Date().getFullYear());
}

// ====== login ======
async function login(){
  // TODO: ajusta payload y campos (user/pass) a los de tu portal
  const payload = new URLSearchParams();
  payload.set('usuario', USER);
  payload.set('contrasena', PASS);

  const res = await http.post(LOGIN_URL, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
    validateStatus: s => s === 200 || s === 302
  });
  if (res.status !== 200 && res.status !== 302) {
    throw new Error('Login falló con status ' + res.status);
  }
}

// ====== scrape ======
async function fetchNotasHTML(){
  const res = await http.get(NOTAS_URL, { responseType: 'text' });
  return res.data;
}

// 1) Intenta JSON embebido en <script> (si existe)
function tryExtractEmbeddedJSON(html){
  const jsonRegex = /(?:var|let|const)\s+(?:data|notas|__DATA__)\s*=\s*(\{[\s\S]*?\}|\[[\s\S]*?\]);/i;
  const m = html.match(jsonRegex);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    return null;
  }
}

// 2) Parseo por tabla HTML (ajusta selectores/índices)
function parseNotasFromTable(html){
  const $ = cheerio.load(html);

  // TODO: ajusta el selector a tu tabla real
  // ejemplo: una tabla con cabeceras: Código | Nombre | Sección | Asistencia | C1 | C2 | C3 | C4 | L1 | L2 | L3 | L4 | Examen | Final | Estado | Periodo
  const rows = $('table#notas tbody tr');
  const out = [];
  rows.each((_, tr)=>{
    const tds = $(tr).find('td').map((i,td)=>$(td).text().trim()).get();
    if (!tds.length) return;

    // TODO: ajusta los índices según tu estructura real
    const codigo      = tds[0] || '';
    const nombre      = tds[1] || '';
    const seccion     = tds[2] || 'Teórico';
    const asistencia  = tds[3] || '';
    const certamenes  = [tds[4], tds[5], tds[6], tds[7]].map(toNum).filter(x=>x!=='');
    const laboratorios= [tds[8], tds[9], tds[10], tds[11]].map(toNum).filter(x=>x!=='');
    const notaExamen  = toNum(tds[12]);
    const notaFinal   = toNum(tds[13]);
    const estado      = tds[14] || '';
    const periodo     = tds[15] || ''; // puede venir como "2025-1" o "2025"; usa yearFromText si necesitas sola el año

    out.push({
      codigo,
      nombre,
      seccion,
      asistencia,
      certamenes,
      laboratorios,
      notaExamen,
      notaFinal,
      estado,
      periodo: yearFromText(periodo)
    });
  });
  return out;
}

function normalizeFromEmbedded(data){
  // TODO: adapta si el embebido viene con otra forma
  // Aquí intentamos mapear un arreglo de ramos con campos razonables
  const arr = Array.isArray(data) ? data : (Array.isArray(data.ramos) ? data.ramos : []);
  return arr.map(r=>({
    codigo: safeTrim(r.codigo || r.cod || ''),
    nombre: safeTrim(r.nombre || r.asignatura || ''),
    seccion: safeTrim(r.seccion || 'Teórico'),
    asistencia: safeTrim(r.asistencia || r.att || ''),
    certamenes: (r.certamenes || r.pp || []).map(toNum).filter(x=>x!==''),
    laboratorios: (r.laboratorios || r.lab || []).map(toNum).filter(x=>x!==''),
    notaExamen: toNum(r.notaExamen || r.examen),
    notaFinal: toNum(r.notaFinal || r.final),
    estado: safeTrim(r.estado || ''),
    periodo: r.periodo ? yearFromText(r.periodo) : (r.anio || r.year || new Date().getFullYear())
  }));
}

async function run(){
  console.log('Iniciando login…');
  await login();
  await sleep(500);

  console.log('Descargando página de notas…');
  const html = await fetchNotasHTML();

  // Estrategia 1: JSON embebido
  let data = tryExtractEmbeddedJSON(html);
  let list = [];
  if (data) {
    console.log('Detectado JSON embebido. Normalizando…');
    list = normalizeFromEmbedded(data);
  } else {
    console.log('No hay JSON embebido. Intentando parsear tabla…');
    list = parseNotasFromTable(html);
  }

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('No se pudo extraer información de notas. Ajusta los selectores/índices en scraping.js');
  }

  // Validación mínima y limpieza de tipos
  list = list.map(it=>({
    codigo: it.codigo,
    nombre: it.nombre,
    seccion: it.seccion || 'Teórico',
    asistencia: String(it.asistencia || '').replace('%',''),
    certamenes: (it.certamenes || []).map(Number).filter(n=>!isNaN(n)),
    laboratorios: (it.laboratorios || []).map(Number).filter(n=>!isNaN(n)),
    notaExamen: it.notaExamen === '' ? '' : Number(it.notaExamen),
    notaFinal:  it.notaFinal  === '' ? '' : Number(it.notaFinal),
    estado: it.estado || '',
    periodo: it.periodo || new Date().getFullYear()
  }));

  const outPath = path.join(process.cwd(), 'notas.json');
  fs.writeFileSync(outPath, JSON.stringify(list, null, 2), 'utf8');
  console.log(`OK: notas.json actualizado (${list.length} ramos)`);
}

// Run
run().catch(err=>{
  console.error('ERROR scraping:', err && err.stack || err);
  process.exit(1);
});
