// scraping.js – UDALBA (login ValidaClave.asp + home + concentración de notas)
// deps: npm i axios cheerio tough-cookie axios-cookiejar-support
const fs = require('fs');
const path = require('path');
const axios = require('axios').default;
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

// ====== ENV ======
const USER      = (process.env.PORTAL_USER || '').trim();
const PASS      = (process.env.PORTAL_PASS || '').trim();
const LOGIN_URL = (process.env.LOGIN_URL   || '').trim(); // ej: https://alumnos.udalba.cl/alumnos.asp
const NOTAS_URL = (process.env.NOTAS_URL   || '').trim(); // ej: https://alumnos.udalba.cl/concent-notas.asp
const HOME_URL  = (process.env.HOME_URL    || (LOGIN_URL ? new URL('/SituActual.asp', new URL(LOGIN_URL).origin).toString() : '')).trim();

function requireEnv(name, v){ if(!v){ console.error(`[scraper] Falta ${name}`); process.exit(1); } }
requireEnv('PORTAL_USER', USER);
requireEnv('PORTAL_PASS', PASS);
requireEnv('LOGIN_URL', LOGIN_URL);
requireEnv('NOTAS_URL', NOTAS_URL);

// ====== HTTP ======
const jar = new CookieJar();
const http = wrapper(axios.create({
  jar, withCredentials:true, timeout:60000,
  headers:{
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }
}));

// ====== Helpers ======
const toNum = s => { if(s==null) return ''; const f = parseFloat(String(s).replace(',','.').trim()); return isNaN(f)?'':f.toFixed(1); };
const yearFromText = t => { const m = String(t||'').match(/20\d{2}/); return m ? parseInt(m[0],10) : new Date().getFullYear(); };
const semesterFromText = t => {
  const s = String(t || '');
  let m = s.match(/(?:periodo|semestre)\s*([12])/i);
  if (!m) m = s.match(/\b([12])\b/);
  return m ? parseInt(m[1], 10) : 1;
};
const norm = s => String(s||'')
  .replace(/<!--[\s\S]*?-->/g, '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/\s+/g,' ').trim().toLowerCase();

// ====== LOGIN (UDALBA) ======
async function login(){
  const base = new URL(LOGIN_URL).origin;

  // 1) GET login (cookies iniciales)
  console.log('[scraper] GET login:', LOGIN_URL);
  const resGet = await http.get(LOGIN_URL, { responseType:'text', validateStatus:()=>true });
  console.log('[scraper] GET login status:', resGet.status);
  fs.writeFileSync('debug_login.html', resGet.data, 'utf8');

  // 2) POST credenciales a ValidaClave.asp (names reales: logrut / logclave)
  const postUrl = new URL('/ValidaClave.asp', base).toString();
  const form = new URLSearchParams({ logrut: USER, logclave: PASS });
  console.log('[scraper] POST login a:', postUrl, 'campos: { logrut, logclave }');
  const resPost = await http.post(postUrl, form.toString(), {
    headers: { 'Content-Type':'application/x-www-form-urlencoded', 'Referer': LOGIN_URL },
    maxRedirects: 5, validateStatus:()=>true
  });
  console.log('[scraper] POST login status:', resPost.status);

  // 3) HOME para fijar sesión
  if (HOME_URL) {
    const home = await http.get(HOME_URL, { validateStatus:()=>true });
    console.log('[scraper] GET home:', HOME_URL, 'status:', home.status);
    if (home.status >= 400) throw new Error('No se pudo abrir la HOME después del login.');
  }
}

// ====== NOTAS ======
async function fetchNotasHTML(){
  console.log('[scraper] GET notas:', NOTAS_URL);
  const res = await http.get(NOTAS_URL, {
    responseType:'text',
    validateStatus:()=>true,
    headers: { Referer: HOME_URL || LOGIN_URL }
  });
  console.log('[scraper] GET notas status:', res.status);

  // si responde "sesión expirada", guardar para debug
  if (/Sesi[oó]n ha Expirado|window\.top\.location\s*=\s*["']alumnos\.asp/i.test(res.data)) {
    fs.writeFileSync('debug_notas.html', res.data, 'utf8');
    throw new Error('Sesión expirada al pedir NOTAS. (Login→HOME→NOTAS con Referer). Revisa debug_notas.html.');
  }
  return res.data;
}

// ====== Parser por encabezados (tabla de concentración completa) ======
function parseNotasFromTable(html){
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  // elegir la mejor tabla por cabeceras
  let best=null, bestHeads=[], bestScore=-1;
  $('table').each((_,tbl)=>{
    const heads = $(tbl).find('thead th, tr:first th, tr:first td')
      .map((i,el)=>norm($(el).text())).get();
    if (!heads.length) return;

    let score = 0;
    // fuerte pista: contiene "codigo del ramo" y "nombre del ramo"
    if (heads.some(h=>h.includes('codigo del ramo')) && heads.some(h=>h.includes('nombre del ramo'))) score += 100;
    const wanted = ['codigo','ramo','asignatura','seccion','periodo','final','estado','anio','año','semestre'];
    score += heads.reduce((a,h)=> a + (wanted.some(w=>h.includes(w))?1:0), 0);

    if (score>bestScore){ best=$(tbl); bestHeads=heads; bestScore=score; }
  });

  if(!best){ console.log('[scraper] No se encontró tabla candidata.'); return []; }
  console.log('[scraper] Tabla candidata. Encabezados:', bestHeads);

  const head = best.find('thead tr:first th, tr:first th, thead tr:first td, tr:first td')
    .map((i,el)=>norm($(el).text())).get();

  const findIdx = (alts)=> {
    for (const a of alts){
      const i = head.findIndex(h=>h.includes(a));
      if (i>=0) return i;
    }
    return -1;
  };

  const idx = {
    codigo:     findIdx(['codigo del ramo','codigo','cod']),
    nombre:     findIdx(['nombre del ramo','asignatura','ramo','curso','nombre']),
    seccion:    findIdx(['seccion','sec']),
    asistencia: findIdx(['asist','asistencia']),
    examen:     findIdx(['examen','exa']),
    final:      findIdx(['final','nf','nota final']),
    estado:     findIdx(['estado','resultado','concepto']),
    periodo:    findIdx(['periodo','semestre','anio','año','year']),
  };

  // índices dinámicos para PP/LAB
  const cIdx=[], lIdx=[];
  head.forEach((h,i)=>{
    const hs=h.replace(/\s+/g,'');
    if (/^(pp|c|certamen)\s*\d+|^pp\d+$/i.test(hs)) cIdx.push(i);
    if (/^(lab|l)\s*\d+|^lab\d+$/i.test(hs))        lIdx.push(i);
  });

  const rows = best.find('tbody tr').length ? best.find('tbody tr') : best.find('tr').slice(1);
  const out=[];
  const codigoRe = /^[A-ZÁÉÍÓÚÑ0-9]{3,6}-\d{4}$/i; // ej: TECM-2402, FCSA-2401, NIV0-2403

  rows.each((_, tr)=>{
    const $row = $(tr);
    const $tds = $row.find('td');
    const tdCount = $tds.length;
    if (!tdCount) return;
    const cell = (i)=> (i>=0 && i<tdCount) ? String($tds.eq(i).text()).trim() : '';

    const codigo = cell(idx.codigo);
    const nombre = cell(idx.nombre);
    if (!codigo || !codigoRe.test(codigo)) return;
    if (!nombre || /nombre del alumno/i.test(nombre)) return;

    const periodoTxt = idx.periodo>=0 ? cell(idx.periodo) : '';
    const anio = periodoTxt ? yearFromText(periodoTxt) : new Date().getFullYear();
    const semestre = semesterFromText(periodoTxt);
    const periodoKey = `${anio}-${semestre}`;

    out.push({
      codigo,
      nombre,
      seccion:     cell(idx.seccion) || 'Teórico',
      asistencia:  cell(idx.asistencia),
      certamenes:  cIdx.filter(i=>i<tdCount).map(i=>toNum(cell(i))).filter(x=>x!=='').map(Number),
      laboratorios:lIdx.filter(i=>i<tdCount).map(i=>toNum(cell(i))).filter(x=>x!=='').map(Number),
      notaExamen:  idx.examen>=0 ? (toNum(cell(idx.examen))||'') : '',
      notaFinal:   idx.final >=0 ? (toNum(cell(idx.final)) ||'') : '',
      estado:      cell(idx.estado),
      // campos de periodo
      periodo:     anio,       // compat con tu front actual (año)
      semestre,                 // 1 o 2
      periodoKey                // "YYYY-1" o "YYYY-2"
    });
  });

  console.log(`[scraper] Filas parseadas (limpias): ${out.length}`);
  return out;
}

// ====== Run ======
async function run(){
  try{
    console.log('[scraper] Iniciando…');
    await login();

    console.log('[scraper] Descargando página de notas…');
    const html = await fetchNotasHTML();

    console.log('[scraper] Parseando…');
    let list = parseNotasFromTable(html);

    if (!Array.isArray(list) || list.length===0) {
      fs.writeFileSync('debug_notas.html', html, 'utf8');
      throw new Error('No se pudo extraer información de notas. Guardado debug_notas.html para revisar.');
    }

    // limpieza tipado + compat
    list = list.map(it=>({
      codigo: it.codigo,
      nombre: it.nombre,
      seccion: it.seccion || 'Teórico',
      asistencia: String(it.asistencia||'').replace('%',''),
      certamenes: (it.certamenes||[]).map(Number).filter(n=>!isNaN(n)),
      laboratorios:(it.laboratorios||[]).map(Number).filter(n=>!isNaN(n)),
      notaExamen: it.notaExamen==='' ? '' : Number(it.notaExamen),
      notaFinal:  it.notaFinal ==='' ? '' : Number(it.notaFinal),
      estado: it.estado || '',
      periodo: it.periodo || new Date().getFullYear(), // año para UI actual
      semestre: it.semestre || 1,
      periodoKey: it.periodoKey || `${it.periodo || new Date().getFullYear()}-${it.semestre || 1}`
    }));

    // --- A) notas.json (lista plana) ---
    const outA = path.join(process.cwd(),'notas.json');
    fs.writeFileSync(outA, JSON.stringify(list, null, 2), 'utf8');

    // --- B) notas_periodos.json (agrupado por "YYYY-S") ---
    const grouped = {};
    for (const it of list) {
      const k = it.periodoKey;
      if (!grouped[k]) grouped[k] = [];
      grouped[k].push(it);
    }
    const outB = path.join(process.cwd(),'notas_periodos.json');
    fs.writeFileSync(outB, JSON.stringify(grouped, null, 2), 'utf8');

    const bytesA = fs.statSync(outA).size;
    const bytesB = fs.statSync(outB).size;
    console.log(`[scraper] OK: notas.json (${list.length} ramos, ${bytesA} bytes)`);
    console.log(`[scraper] OK: notas_periodos.json (${Object.keys(grouped).length} periodos, ${bytesB} bytes)`);
  }catch(err){
    console.error('[scraper] ERROR:', err && err.stack || err);
    process.exit(1);
  }
}

run();
