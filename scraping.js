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
const LOGIN_URL = (process.env.LOGIN_URL || '').trim();   // p.ej. https://alumnos.udalba.cl/alumnos.asp
const NOTAS_URL = (process.env.NOTAS_URL || '').trim();   // p.ej. https://alumnos.udalba.cl/concent-notas.asp

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
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8'
  },
  timeout: 60000,
  validateStatus: () => true
}));

// ====== helpers ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cleanText(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')     // NBSP
    .replace(/\s+/g, ' ')
    .trim();
}
const norm  = (s) => cleanText(s);
const lower = (s) => cleanText(s).toLowerCase();

// Parse genérico (conserva 0)
function asNumStrict(x) {
  const t = cleanText(x);
  if (!t || t === '-') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Parse para NOTAS: '', '-', '0', '0.0', '0,0' => null (0 es “vacío”)
function asGrade(x) {
  const t = cleanText(x).toLowerCase();
  if (!t || t === '-' || t === 'nan') return null;
  if (t === '0' || t === '0.0' || t === '0,0') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Entero opcional (para año/semestre)
function asIntOrNull(x) {
  const t = cleanText(x);
  if (!t || t === '-') return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

const round1 = n => Math.round(n * 10) / 10;
const avg = (arr) => {
  const v = (arr || []).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
// Quita diacríticos y pasa a minúsculas (robusto a ISO-8859-1)
const lowerPlain = (s) =>
  cleanText(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();


// ====== login ======
async function login() {
  console.log('[scraper] Iniciando…');
  console.log('[scraper] GET login:', LOGIN_URL);
  const resGet = await http.get(LOGIN_URL);
  console.log('[scraper] GET login status:', resGet.status);
  fs.writeFileSync('debug_login.html', resGet.data, 'utf8');

  const $ = cheerio.load(resGet.data);

  // Localiza formulario que contenga un password
  let $form = $('form').filter((_, f) => $(f).find('input[type="password"]').length > 0).first();
  if (!$form.length) $form = $('form').first();

  // action: si está vacío, postea al mismo LOGIN_URL
  let action = $form.attr('action') || LOGIN_URL;
  const postUrl = new URL(action, LOGIN_URL).toString();

  // copia hidden inputs
  const formData = new URLSearchParams();
  $form.find('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    const val = $(el).attr('value') || '';
    if (name) formData.set(name, val);
  });

  // nombres de campos (UDA: logrut / logclave). Si no, detecta heurístico.
  let userField = 'logrut';
  let passField = 'logclave';

  // Si en la página no existen, heurística
  const hasUser = $form.find(`input[name="${userField}"]`).length > 0;
  const hasPass = $form.find(`input[name="${passField}"]`).length > 0;
  if (!hasUser || !hasPass) {
    const $pass = $form.find('input[type="password"]').first();
    if ($pass.length) passField = $pass.attr('name') || passField;

    const $cand = $form.find('input[type="email"], input[autocomplete="username"], input[type="text"]').first();
    if ($cand.length) userField = $cand.attr('name') || userField;
  }

  formData.set(userField, USER);
  formData.set(passField, PASS);

  console.log(`[scraper] POST login a: ${postUrl} campos: { ${userField}, ${passField} }`);
  const resPost = await http.post(postUrl, formData.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': LOGIN_URL }
  });
  console.log('[scraper] POST login status:', resPost.status);

  // Algunas instalaciones redirigen al home.
  // Intentamos abrir una página “interna” conocida.
  const homeUrl = new URL('SituActual.asp', LOGIN_URL).toString();
  const probe = await http.get(homeUrl);
  console.log('[scraper] GET home:', homeUrl, 'status:', probe.status);
  // Si quieres, puedes validar algo del DOM aquí.
}

// ====== descarga html ======
async function fetchNotasHTML() {
  console.log('[scraper] Descargando página de notas…');
  console.log('[scraper] GET notas:', NOTAS_URL);
  const res = await http.get(NOTAS_URL);
  console.log('[scraper] GET notas status:', res.status);
  return res.data;
}

function parseNotasFromTable(html) {
  console.log('[scraper] Parseando…');
  const $ = cheerio.load(html);

  // --- utilidades locales ---
  const cleanText = (s) => String(s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  const norm      = (s) => cleanText(s);
  const lower     = (s) => cleanText(s).toLowerCase();
  const lowerPlain= (s) => cleanText(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const asInt     = (x) => { const t = cleanText(x); if (!t || t==='-') return null; const n = parseInt(t,10); return Number.isFinite(n)?n:null; };
  const asGrade   = (x) => {
    const t = cleanText(x).toLowerCase();
    if (!t || t==='-' || t==='nan' || t==='0' || t==='0.0' || t==='0,0') return null;
    const n = Number(t.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  // 1) tablas candidatas por cabecera
  let tables = $('table').filter((_, t) => {
    const txt = lowerPlain($(t).text());
    return txt.includes('codigo del ramo') && txt.includes('nombre del ramo');
  });

  // 1b) fallback por patrón de código (si no encontró por cabecera)
  if (tables.length === 0) {
    const codeRe = /\b[A-Z]{3,5}-\d{3,4}\b/;
    tables = $('table').filter((_, t) => codeRe.test($(t).text()));
  }

  const rowsOut = [];

  tables.each((_, table) => {
    const $t = $(table);

    // Fila cabecera: preferimos una con muchos th/td
    let $hdrRow = $t.find('tr').filter((_, tr) => $(tr).find('th,td').length >= 8).first();
    if (!$hdrRow.length) {
      $hdrRow = $t.find('tr').filter((_, tr) => lower($(tr).text()).includes('código del ramo') || lowerPlain($(tr).text()).includes('codigo del ramo')).first();
    }
    if (!$hdrRow.length) return;

    const headersRaw   = $hdrRow.find('th,td').map((i, el) => norm($(el).text())).get();
    const headersPlain = headersRaw.map(lowerPlain);

    const idx   = (needle) => headersPlain.findIndex(h => h.includes(needle));
    const findC = (...needles) => headersPlain.findIndex(h => needles.some(n => h.includes(n)));

    const col = {
      codigo : idx('codigo del ramo'),
      nombre : idx('nombre del ramo'),
      seccion: idx('seccion'),
      periodo: idx('periodo'),
      anio   : (idx('año') >= 0 ? idx('año') : idx('anio')),
      asist  : (() => { const i = headersPlain.findIndex(h => h.startsWith('asist')); return i >= 0 ? i : idx('asistencia'); })(),

      // PP y LAB por columnas sueltas
      pp1: findC('pp 1','pp1'), pp2: findC('pp 2','pp2'), pp3: findC('pp 3','pp3'), pp4: findC('pp 4','pp4'),
      lb1: findC('lab 1','lab1'), lb2: findC('lab 2','lab2'), lb3: findC('lab 3','lab3'), lb4: findC('lab 4','lab4'),

      ppProm : findC('pp prom', 'pp prom 100%'),
      labProm: findC('lab prom', 'lab prom 100%'),
      nExPct : findC('n ex 40', 'n ex 30', 'n ex 40%', 'n ex 30%', 'n pr 70%', 'n pr 60%', 'n pr 30%'),
      examen : findC('examen'),
      final  : findC('final'),
      estado : findC('estado'),
    };

    const ppCols  = [col.pp1, col.pp2, col.pp3, col.pp4].filter(i => i >= 0);
    const labCols = [col.lb1, col.lb2, col.lb3, col.lb4].filter(i => i >= 0);

    // Filas de datos
    $hdrRow.nextAll('tr').each((__, tr) => {
      const $tds = $(tr).find('td');
      if (!$tds.length) return;

      const cells = $tds.map((i, el) => norm($(el).text())).get();
      const get   = (i) => (i >= 0 && i < cells.length) ? cells[i] : '';

      const codigoTxt = get(col.codigo);
      const nombreTxt = get(col.nombre);
      if (!codigoTxt || !nombreTxt) return;

      const codigo = cleanText(codigoTxt).toUpperCase();
      const nombre = cleanText(nombreTxt);
      if (!/\b[A-Z]{3,5}-\d{3,4}\b/.test(codigo)) return; // filas separadoras

      const seccion    = get(col.seccion) || '3 - Teórico';
      const periodo    = asInt(get(col.periodo));
      const anio       = asInt(get(col.anio));
      const asistencia = asInt(get(col.asist));

      const certs = [];
      ppCols.forEach(i => { const v = asGrade(get(i)); if (v != null) certs.push(v); });

      const labs = [];
      labCols.forEach(i => { const v = asGrade(get(i)); if (v != null) labs.push(v); });

      const ppProm100  = asGrade(get(col.ppProm));
      const labProm100 = asGrade(get(col.labProm));
      const nExPct     = asGrade(get(col.nExPct));
      const examen     = asGrade(get(col.examen));
      const final      = asGrade(get(col.final));

      let estado = '';
      if (col.estado >= 0) {
        const e = cleanText(get(col.estado));
        // evita casos donde la “celda de estado” trae el mismo código (p.ej. FCSA-2202)
        if (e && !/^[A-Z]{3,5}-\d{3,4}$/.test(e)) estado = e.toUpperCase();
      }

      // descarta filas total/basura sin datos reales
      const tieneNotas = (certs.length + labs.length) > 0 || ppProm100 != null || labProm100 != null || nExPct != null || examen != null || final != null;
      if (!tieneNotas) return;

      rowsOut.push({
        codigo, nombre, seccion, periodo, anio, asistencia,
        certamenes: certs,
        laboratorios: labs,
        ppProm100, labProm100,
        nExPct,
        notaExamen: examen,
        notaFinal: final,
        estado
      });
    });
  });

  if (!rowsOut.length) {
    console.log('[scraper] No se encontraron tablas con filas de ramos.');
  }
  return rowsOut;
}


// ====== fns de normalización/union/pesos ======
function isLabRow(r) {
  const s = `${r.seccion || ''} ${r.nombre || ''}`;
  return /lab/i.test(s);
}
function inferExamFromWeighted(nExPct) {
  const n = asNum(nExPct);
  if (!Number.isFinite(n)) return null;
  const ex = n / 0.4; // suponiendo 40% examen en el portal
  return (ex >= 1 && ex <= 7) ? round1(ex) : null;
}

function cleanAggregateAndWeight(rawList) {
  // 1) Normaliza
  const base = (rawList || []).map(r => ({
    codigo: norm(r.codigo).toUpperCase(),
    nombre: norm(r.nombre),
    seccion: norm(r.seccion || '3 - Teórico'),
    periodo: asNum(r.periodo),     // 1/2 si viene
    anio: asNum(r.anio) || new Date().getFullYear(),
    asistencia: asNum(r.asistencia),

    certamenes: Array.isArray(r.certamenes) ? r.certamenes.map(asNum).filter(Number.isFinite) : [],
    laboratorios: Array.isArray(r.laboratorios) ? r.laboratorios.map(asNum).filter(Number.isFinite) : [],

    ppProm100: asNum(r.ppProm100),
    labProm100: asNum(r.labProm100),
    nExPct: asNum(r.nExPct),
    examen: asNum(r.notaExamen) ?? inferExamFromWeighted(r.nExPct),

    finalPortal: asNum(r.notaFinal),
    estadoPortal: norm(r.estado).toUpperCase() || null
  })).filter(r => r.codigo);

  // 2) Une por código, separando teórico/lab
  const byCode = new Map();
  for (const r of base) {
    if (!byCode.has(r.codigo)) {
      byCode.set(r.codigo, {
        codigo: r.codigo,
        nombre: r.nombre,
        anio: r.anio,
        periodo: r.periodo,
        asistencia: r.asistencia,

        teorico: { certs: [], ppProm100: null, examen: null, final: null },
        lab: { labs: [], labProm100: null, final: null },

        finalPortal: r.finalPortal,
        estadoPortal: r.estadoPortal
      });
    }
    const acc = byCode.get(r.codigo);
    if (r.nombre.length > (acc.nombre || '').length) acc.nombre = r.nombre;
    if (r.anio && (!acc.anio || r.anio > acc.anio)) acc.anio = r.anio;
    if (r.periodo && !acc.periodo) acc.periodo = r.periodo;

    if (isLabRow(r)) {
      acc.lab.labs = acc.lab.labs.concat(r.laboratorios);
      if (Number.isFinite(r.labProm100)) acc.lab.labProm100 = r.labProm100;
      if (Number.isFinite(r.finalPortal)) acc.lab.final = r.finalPortal;
    } else {
      acc.teorico.certs = acc.teorico.certs.concat(r.certamenes);
      if (Number.isFinite(r.ppProm100)) acc.teorico.ppProm100 = r.ppProm100;
      if (Number.isFinite(r.examen) && !Number.isFinite(acc.teorico.examen)) acc.teorico.examen = r.examen;
      if (Number.isFinite(r.finalPortal)) acc.teorico.final = r.finalPortal;
    }

    if (!Number.isFinite(acc.asistencia) && Number.isFinite(r.asistencia)) acc.asistencia = r.asistencia;
    if (!Number.isFinite(acc.finalPortal) && Number.isFinite(r.finalPortal)) acc.finalPortal = r.finalPortal;
    if (!acc.estadoPortal && r.estadoPortal) acc.estadoPortal = r.estadoPortal;
  }

  // 3) Calcula con pesos
  const out = [];
  for (const [, acc] of byCode) {
    const promPP  = Number.isFinite(acc.teorico.ppProm100) ? acc.teorico.ppProm100 : avg(acc.teorico.certs);
    const promLAB = Number.isFinite(acc.lab.labProm100) ? acc.lab.labProm100 : avg(acc.lab.labs);
    const examen  = Number.isFinite(acc.teorico.examen) ? acc.teorico.examen : null;

    // pesos por defecto
    let weights = { teo: 80, lab: 20, examInTeo: 30 };
    if (!Number.isFinite(promLAB) && Number.isFinite(examen)) weights = { teo:100, lab:0, examInTeo:30 };
    if ( Number.isFinite(promLAB) && !Number.isFinite(examen)) weights = { teo:80,  lab:20, examInTeo:0  };
    if (!Number.isFinite(promLAB) && !Number.isFinite(examen)) weights = { teo:100, lab:0, examInTeo:0  };

    const ppWeight = 100 - weights.examInTeo; // p.ej. 70
    const teoInside = (
      (Number.isFinite(promPP)  ? promPP  : 0) * ppWeight +
      (Number.isFinite(examen)  ? examen  : 0) * weights.examInTeo
    ) / 100;

    const finalCalc = round1(
      (teoInside * weights.teo + (Number.isFinite(promLAB) ? promLAB : 0) * weights.lab) / 100
    );

    let estado = 'CURSANDO';
    if (Number.isFinite(acc.finalPortal)) estado = acc.finalPortal >= 4.0 ? 'APROBADO' : 'REPROBADO';
    else if (Number.isFinite(finalCalc)) estado = finalCalc >= 4.0 ? 'APROBADO' : 'REPROBADO';

    out.push({
      codigo: acc.codigo,
      nombre: acc.nombre,
      anio: acc.anio,
      semestre: acc.periodo || 1,
      asistencia: Number.isFinite(acc.asistencia) ? acc.asistencia : null,

      // crudo agregado
      pp: acc.teorico.certs,
      lab: acc.lab.labs,
      examen: Number.isFinite(examen) ? examen : null,

      // promedios
      promedioPP: Number.isFinite(promPP) ? round1(promPP) : null,
      promedioLab: Number.isFinite(promLAB) ? round1(promLAB) : null,

      // resultado
      finalCalculado: Number.isFinite(finalCalc) ? finalCalc : null,
      finalPortal: Number.isFinite(acc.finalPortal) ? acc.finalPortal : null,
      estadoPortal: acc.estadoPortal || null,
      estado,

      // pesos usados
      pesos: weights
    });
  }

  out.sort((a, b) => (a.anio || 0) - (b.anio || 0) || String(a.codigo).localeCompare(String(b.codigo)));
  return out;
}

// ====== Run ======
async function run() {
  try {
    await login();
    await sleep(300);

    const html = await fetchNotasHTML();
    const listRaw = parseNotasFromTable(html);

    if (!Array.isArray(listRaw) || listRaw.length === 0) {
      fs.writeFileSync('debug_notas.html', html, 'utf8');
      throw new Error('No se pudo extraer información de notas. Guardado debug_notas.html para revisar.');
    }

    // Limpieza/Unificación + Cálculo
    const out = cleanAggregateAndWeight(listRaw);

    // --- A) notas.json (lista limpia/unificada) ---
    const outA = path.join(process.cwd(), 'notas.json');
    fs.writeFileSync(outA, JSON.stringify(out, null, 2), 'utf8');
    console.log(`[scraper] OK: notas.json limpio (${out.length} ramos)`);

    // Aviso de diferencias entre final del portal y calculado
    const dif = out.filter(x =>
      Number.isFinite(x.finalPortal) &&
      Number.isFinite(x.finalCalculado) &&
      Math.abs(x.finalPortal - x.finalCalculado) > 0.2
    );
    if (dif.length) {
      console.log(`[scraper] Aviso: ${dif.length} ramos con diferencia > 0.2 entre finalPortal y finalCalculado (revisar pesos).`);
    }
    // --- B) notas_periodos.json (agrupado por "YYYY-S") ---
    const grouped = {};
    for (const it of out) {
      const y = it.anio || new Date().getFullYear();
      const s = it.semestre || 1;
      const k = `${y}-${s}`;
      (grouped[k] ||= []).push(it);
    }
    const outB = path.join(process.cwd(), 'notas_periodos.json');
    fs.writeFileSync(outB, JSON.stringify(grouped, null, 2), 'utf8');



    // logs de tamaños correctos
    const bytesA = fs.statSync(outA).size;
    const bytesB = fs.statSync(outB).size;
    console.log(`[scraper] OK: notas.json (${out.length} ramos, ${bytesA} bytes)`);
    console.log(`[scraper] OK: notas_periodos.json (${Object.keys(grouped).length} periodos, ${bytesB} bytes)`);
  } catch (err) {
    console.error('[scraper] ERROR:', err && err.stack || err);
    process.exit(1);
  }
}

run();

