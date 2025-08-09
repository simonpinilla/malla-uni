// scraping.js
// Dependencias: npm i axios cheerio tough-cookie axios-cookiejar-support
const fs = require('fs');
const path = require('path');
const axios = require('axios').default;
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

// ====== CONFIG via Secrets ======
const USER = (process.env.PORTAL_USER || '').trim();
const PASS = (process.env.PORTAL_PASS || '').trim();
const LOGIN_URL = (process.env.LOGIN_URL || '').trim();   // URL completa login
const NOTAS_URL = (process.env.NOTAS_URL || '').trim();   // URL completa concentración de notas

function requireEnv(name, val) {
  if (!val) { console.error(`[scraper] Falta secret ${name}`); process.exit(1); }
}
requireEnv('PORTAL_USER', USER);
requireEnv('PORTAL_PASS', PASS);
requireEnv('LOGIN_URL', LOGIN_URL);
requireEnv('NOTAS_URL', NOTAS_URL);

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toNum = (s) => {
  if (s == null) return '';
  const n = String(s).replace(',', '.').trim();
  const f = parseFloat(n);
  return isNaN(f) ? '' : f.toFixed(1);
};
function safeTrim(s) { return (s == null) ? '' : String(s).trim(); }
function yearFromText(t) {
  const m = String(t || '').match(/20\d{2}/);
  return m ? parseInt(m[0], 10) : (new Date().getFullYear());
}

// ====== login ======
async function login(){
  // 1) GET login page (para capturar hidden tokens y detectar names)
  const resGet = await http.get(LOGIN_URL, { responseType: 'text' });
  const $ = cheerio.load(resGet.data);

  // intenta detectar el form correcto (con un input password adentro)
  let $form = $('form').filter((_,f)=>$(f).find('input[type="password"]').length>0).first();
  if (!$form.length) $form = $('form').first();

  // acción del formulario (si usa action relativo)
  let action = $form.attr('action') || LOGIN_URL;
  const postUrl = new URL(action, LOGIN_URL).toString();

  // payload base: todos los hidden + cualquier input con value preset
  const payload = new URLSearchParams();
  $form.find('input').each((_, el)=>{
    const name = $(el).attr('name');
    const type = ($(el).attr('type') || '').toLowerCase();
    const val  = $(el).attr('value') || '';
    if (!name) return;
    // preserva tokens/hidden
    if (type === 'hidden') payload.set(name, val);
  });

  // nombres de campos usuario/clave
  let userField = LOGIN_USER_FIELD;
  let passField = LOGIN_PASS_FIELD;

  if (!userField || !passField) {
    // heurística: toma el primer input password y el primer input text/email antes de él
    const $pass = $form.find('input[type="password"]').first();
    if ($pass.length && !passField) passField = $pass.attr('name');

    if (!userField) {
      // intenta email, text o el primer input con autocomplete username
      const $cand = $form.find('input[type="email"], input[autocomplete="username"], input[type="text"]').first();
      if ($cand.length) userField = $cand.attr('name');
    }
  }

  // fallback si siguen vacíos
  userField = userField || 'usuario';
  passField = passField || 'contrasena';

  payload.set(userField, USER);
  payload.set(passField, PASS);

  // 2) POST credenciales
  const resPost = await http.post(postUrl, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': LOGIN_URL }
  });

  // heurística de éxito: si después del POST podemos acceder a NOTAS_URL sin redirigir a login
  const probe = await http.get(NOTAS_URL, { validateStatus: ()=>true });
  const redirectedToLogin =
    (probe.request?.res?.responseUrl || '').startsWith(LOGIN_URL) ||
    (probe.status === 401 || probe.status === 403);

  if (redirectedToLogin) {
    throw new Error(`Login falló: revisa user/pass o nombres de campos (userField='${userField}', passField='${passField}')`);
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
  try { return JSON.parse(m[1]); } catch { return null; }
}

// 2) Parseo por tabla HTML (ajusta selectores/índices a tu portal)
function parseNotasFromTable(html){
  const $ = cheerio.load(html);

  // ⚠️ AJUSTA este selector a tu tabla real
  const rows = $('table#notas tbody tr, table.concentracion tbody tr, table tbody tr');
  const out = [];

  rows.each((_, tr)=>{
    const tds = $(tr).find('td').map((i,td)=>$(td).text().trim()).get();
    if (!tds.length) return;

    // ⚠️ AJUSTA los índices a tu estructura
    const codigo       = tds[0] || '';
    const nombre       = tds[1] || '';
    const seccion      = tds[2] || 'Teórico';
    const asistencia   = tds[3] || '';
    const certamenes   = [tds[4], tds[5], tds[6], tds[7]].map(toNum).filter(x=>x!=='');
    const laboratorios = [tds[8], tds[9], tds[10], tds[11]].map(toNum).filter(x=>x!=='');
    const notaExamen   = toNum(tds[12]);
    const notaFinal    = toNum(tds[13]);
    const estado       = tds[14] || '';
    const periodoTxt   = tds[15] || '';

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
      periodo: yearFromText(periodoTxt)
    });
  });

  return out;
}

function normalizeFromEmbedded(data){
  const arr = Array.isArray(data) ? data : (Array.isArray(data.ramos) ? data.ramos : []);
  return arr.map(r=>({
    codigo: safeTrim(r.codigo || r.cod || ''),
    nombre: safeTrim(r.nombre || r.asignatura || ''),
    seccion: safeTrim(r.seccion || 'Teórico'),
    asistencia: safeTrim(r.asistencia || r.att || ''),
    certamenes: (r.certamenes || r.pp || []).map(toNum).filter(x=>x!==''),
    laboratorios: (r.laboratorios || r.lab || []).map(toNum).filter(x=>x!==''),
    notaExamen: toNum(r.notaExamen || r.examen),
    notaFinal:  toNum(r.notaFinal  || r.final),
    estado: safeTrim(r.estado || ''),
    periodo: r.periodo ? yearFromText(r.periodo) : (r.anio || r.year || new Date().getFullYear())
  }));
}

async function run(){
  console.log('[scraper] Iniciando login…');
  await login();
  await sleep(300);

  console.log('[scraper] Descargando página de notas…');
  const html = await fetchNotasHTML();

  let list = [];
  const embedded = tryExtractEmbeddedJSON(html);
  if (embedded) {
    console.log('[scraper] JSON embebido detectado. Normalizando…');
    list = normalizeFromEmbedded(embedded);
  } else {
    console.log('[scraper] Parseando tabla HTML…');
    list = parseNotasFromTable(html);
  }

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('No se pudo extraer información de notas. Ajusta selector/índices en parseNotasFromTable().');
  }

  // Limpieza de tipos
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
  console.log(`[scraper] OK: notas.json actualizado (${list.length} ramos)`);
}

// Run
run().catch(err=>{
  console.error('[scraper] ERROR:', err && err.stack || err);
  process.exit(1);
});
