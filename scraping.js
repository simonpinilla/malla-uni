// scraping.js (versión con debug detallado)
// npm i axios cheerio tough-cookie axios-cookiejar-support
const fs = require('fs');
const path = require('path');
const axios = require('axios').default;
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

// ====== CONFIG via Secrets ======
const USER = (process.env.PORTAL_USER || '').trim();
const PASS = (process.env.PORTAL_PASS || '').trim();
const LOGIN_URL = (process.env.LOGIN_URL || '').trim();
const NOTAS_URL = (process.env.NOTAS_URL || '').trim();
const LOGIN_USER_FIELD = (process.env.LOGIN_USER_FIELD || '').trim();
const LOGIN_PASS_FIELD = (process.env.LOGIN_PASS_FIELD || '').trim();
const HOME_URL = (process.env.HOME_URL || new URL('/SituActual.asp', LOGIN_URL).toString()).trim();

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
  jar, withCredentials: true, timeout: 60000,
  headers:{
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36',
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }
}));

// ====== helpers ======
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const toNum = (s)=>{ if(s==null) return ''; const f=parseFloat(String(s).replace(',','.').trim()); return isNaN(f)?'':f.toFixed(1); };
const safeTrim = (s)=> (s==null)? '': String(s).trim();
const yearFromText = (t)=>{ const m=String(t||'').match(/20\d{2}/); return m?parseInt(m[0],10):new Date().getFullYear(); };

async function login(){
  console.log('[scraper] GET login:', LOGIN_URL);
  const resGet = await http.get(LOGIN_URL, { responseType:'text', validateStatus:()=>true });
  console.log(`[scraper] GET login status: ${resGet.status}`);

  const $ = cheerio.load(resGet.data);
  let $form = $('form').filter((_,f)=>$(f).find('input[type="password"]').length>0).first();
  if (!$form.length) $form = $('form').first();
  if (!$form.length) throw new Error('No se encontró <form> de login');

  const action = $form.attr('action') || LOGIN_URL;
  const postUrl = new URL(action, LOGIN_URL).toString();

  const payload = new URLSearchParams();
  $form.find('input').each((_, el)=>{
    const name = $(el).attr('name');
    const type = ($(el).attr('type') || '').toLowerCase();
    const val  = $(el).attr('value') || '';
    if (name && type === 'hidden') payload.set(name, val);
  });

  let userField = (process.env.LOGIN_USER_FIELD || '').trim();
  let passField = (process.env.LOGIN_PASS_FIELD || '').trim();
  if (!userField || !passField) {
    const $pass = $form.find('input[type="password"]').first();
    if ($pass.length && !passField) passField = $pass.attr('name');
    if (!userField) {
      const $cand = $form.find('input[type="email"], input[autocomplete="username"], input[type="text"]').first();
      if ($cand.length) userField = $cand.attr('name');
    }
  }
  userField = userField || 'usuario';
  passField = passField || 'contrasena';

  payload.set(userField, USER);
  payload.set(passField, PASS);

  console.log('[scraper] POST login a:', postUrl, `  campos: { ${userField}, ${passField} }`);
  const resPost = await http.post(postUrl, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': LOGIN_URL },
    maxRedirects: 5,
    validateStatus: ()=>true
  });
  console.log(`[scraper] POST login status: ${resPost.status}`);

  // ⛔️ ¡NO HAGAS PROBE A NOTAS AQUÍ!
  // ✅ VISITA LA HOME PARA FIJAR SESIÓN
  const HOME_URL = (process.env.HOME_URL || new URL('/SituActual.asp', LOGIN_URL).toString()).trim();
  const home = await http.get(HOME_URL, { validateStatus: ()=>true });
  console.log('[scraper] GET home:', HOME_URL, 'status:', home.status);
}


// ====== scrape ======
async function fetchNotasHTML(){
  console.log('[scraper] GET notas:', NOTAS_URL);
  const res = await http.get(NOTAS_URL, {
    responseType:'text',
    validateStatus:()=>true,
    headers: { Referer: HOME_URL } // ← muchos portales lo exigen
  });
  console.log('[scraper] GET notas status:', res.status);

  // Si devuelve la página de "sesión expirada", avisa y guarda debug
  if (/Sesion ha Expirado|Sesi\xf3n ha Expirado|window\.top\.location\s*=\s*["']alumnos\.asp/i.test(res.data)) {
    fs.writeFileSync(path.join(process.cwd(), 'debug_notas.html'), res.data, 'utf8');
    throw new Error('El portal devolvió "Sesión expirada" al entrar a NOTAS. Probé login→home→notas con Referer. Revisa debug_notas.html.');
  }
  return res.data;
}

function tryExtractEmbeddedJSON(html){
  const jsonRegex = /(?:var|let|const)\s+(?:data|notas|__DATA__)\s*=\s*(\{[\s\S]*?\}|\[[\s\S]*?\]);/i;
  const m = html.match(jsonRegex);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function absoluteUrl(src, base) {
  try { return new URL(src, base).toString(); } catch { return src; }
}

function extractFirstIframeSrc(html, baseUrl) {
  const $ = cheerio.load(html);
  const $iframe = $('iframe, frame').first();
  if ($iframe.length) {
    const src = $iframe.attr('src') || $iframe.attr('data-src');
    if (src) return absoluteUrl(src, baseUrl);
  }
  return null;
}

function extractMetaRefresh(html, baseUrl) {
  const $ = cheerio.load(html);
  const $meta = $('meta[http-equiv="refresh"], meta[http-equiv="Refresh"]').first();
  if ($meta.length) {
    const content = $meta.attr('content') || '';
    // ej: "0;URL=/alumnos/pagina.aspx"
    const m = content.match(/url=(.+)$/i);
    if (m && m[1]) return absoluteUrl(m[1].trim(), baseUrl);
  }
  return null;
}

async function followFramesAndRefresh(html, currentUrl) {
  // 1) meta refresh
  const refresh = extractMetaRefresh(html, currentUrl);
  if (refresh) {
    console.log('[scraper] Detectado meta refresh →', refresh);
    const r = await http.get(refresh, { responseType:'text', validateStatus:()=>true });
    return { html: r.data, url: refresh, status: r.status };
  }

  // 2) iframe/frame
  const iframe = extractFirstIframeSrc(html, currentUrl);
  if (iframe) {
    console.log('[scraper] Detectado iframe →', iframe);
    const r = await http.get(iframe, { responseType:'text', validateStatus:()=>true });
    return { html: r.data, url: iframe, status: r.status };
  }

  return { html, url: currentUrl, status: 200 };
}


function parseNotasFromTable(html){
  const $ = cheerio.load(html);
  const norm = (s)=> String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
                  .replace(/\s+/g,' ').trim().toLowerCase();

  let best = null, bestScore = -1, bestHeads = [];
  $('table').each((_, tbl)=>{
    const heads = $(tbl).find('thead th, tr:first th, tr:first td').map((i,el)=>norm($(el).text())).get();
    if (!heads.length) return;
    const wanted = ['codigo','cod','asignatura','ramo','curso','seccion','asistencia','examen','final','estado','periodo','anio','año'];
    const score = heads.reduce((acc,h)=> acc + (wanted.some(w=>h.includes(w))?1:0), 0);
    if (score > bestScore) { best = $(tbl); bestScore = score; bestHeads = heads; }
  });

  if (!best) { console.log('[scraper] No se encontró ninguna tabla candidata.'); return []; }
  console.log('[scraper] Tabla candidata. Encabezados:', bestHeads);

  const headCells = best.find('thead tr:first th, tr:first th, thead tr:first td, tr:first td').map((i,el)=>norm($(el).text())).get();
  const idxOf = (names)=> {
    let idx = -1;
    names.some(n=>{
      const i = headCells.findIndex(h=> h.includes(n));
      if (i !== -1) { idx = i; return true; }
      return false;
    });
    return idx;
  };

  const idx = {
    codigo:    idxOf(['codigo','cod']),
    nombre:    idxOf(['asignatura','ramo','curso','nombre']),
    seccion:   idxOf(['seccion','sec']),
    asistencia:idxOf(['asistencia','asis']),
    examen:    idxOf(['examen','exa']),
    final:     idxOf(['final','nf','nota final']),
    estado:    idxOf(['estado','resultado']),
    periodo:   idxOf(['periodo','semestre','anio','año','year'])
  };

  const cIdx = []; const lIdx = [];
  headCells.forEach((h,i)=>{
    const hs = h.replace(/\s+/g,'');
    if (/^(c|pp)\d+|certamen\d+$/i.test(hs)) cIdx.push(i);
    if (/^(l|lab)\d+$/i.test(hs)) lIdx.push(i);
  });

  const rows = best.find('tbody tr').length ? best.find('tbody tr') : best.find('tr').slice(1);
  const out = [];

  rows.each((_, tr)=>{
    const tds = $(tr).find('td');
    if (!tds.length) return;
    const cell = (i)=> safeTrim($(tds[i]||{}).text());

    const certamenes   = cIdx.map(i=>toNum(cell(i))).filter(x=>x!=='').map(Number);
    const laboratorios = lIdx.map(i=>toNum(cell(i))).filter(x=>x!=='').map(Number);

    out.push({
      codigo:     idx.codigo    >=0 ? cell(idx.codigo)    : '',
      nombre:     idx.nombre    >=0 ? cell(idx.nombre)    : '',
      seccion:    idx.seccion   >=0 ? cell(idx.seccion)   : 'Teórico',
      asistencia: idx.asistencia>=0 ? cell(idx.asistencia): '',
      certamenes,
      laboratorios,
      notaExamen: idx.examen    >=0 ? (toNum(cell(idx.examen)) || '') : '',
      notaFinal:  idx.final     >=0 ? (toNum(cell(idx.final))  || '') : '',
      estado:     idx.estado    >=0 ? cell(idx.estado)    : '',
      periodo:    idx.periodo   >=0 ? yearFromText(cell(idx.periodo)) : new Date().getFullYear()
    });
  });

  const cleaned = out.filter(r => r.codigo || r.nombre);
  console.log(`[scraper] Filas parseadas: ${cleaned.length}`);
  return cleaned;
}

async function run(){
  try{
    console.log('[scraper] Iniciando…');
    await login();
    await sleep(300);

    console.log('[scraper] Descargando página de notas…');
    let html = await fetchNotasHTML();
    // Seguir meta-refresh o iframe si existe
    const stepped = await followFramesAndRefresh(html, NOTAS_URL);
    html = stepped.html;
    if (stepped.url !== NOTAS_URL) {
      console.log('[scraper] Analizando contenido cargado desde:', stepped.url);
    }
    
    console.log('[scraper] Parseando…');
    let list = [];
    const embedded = tryExtractEmbeddedJSON(html);

    

    if (!Array.isArray(list) || list.length === 0) {
      const debugPath = path.join(process.cwd(), 'debug_notas.html');
      fs.writeFileSync(debugPath, html, 'utf8');
      throw new Error('No se pudo extraer información de notas. Guardado debug_notas.html para revisar.');
    }

    const outPath = path.join(process.cwd(), 'notas.json');
    fs.writeFileSync(outPath, JSON.stringify(list, null, 2), 'utf8');
    const bytes = fs.statSync(outPath).size;
    console.log(`[scraper] OK: notas.json actualizado (${list.length} ramos, ${bytes} bytes)`);
  }catch(err){
    console.error('[scraper] ERROR:', err && err.stack || err);
    process.exit(1);
  }
}

// Normalizador de JSON embebido
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

run();
