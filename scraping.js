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
const norm = s => String(s || '').normalize('NFKC').trim();
const lower = s => norm(s).toLowerCase();
const asNum = (x) => {
  const n = Number(String(x ?? '').replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
};
const round1 = n => Math.round(n * 10) / 10;
const avg = arr => {
  const v = (arr || []).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

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

// ====== parseo tablas ======
function parseNotasFromTable(html) {
  console.log('[scraper] Parseando…');
  const $ = cheerio.load(html);

  // Selecciona tablas candidatas: busco cabeceras “Código del Ramo” y “Nombre del Ramo”
  const tables = $('table').filter((_, t) => {
    const txt = lower($(t).text());
    return txt.includes('código del ramo') && txt.includes('nombre del ramo');
  });

  const rowsOut = [];

  tables.each((_, table) => {
    const $t = $(table);
    // Encuentra la fila de cabeceras (la primera que tenga muchos TH/TD)
    const $hdrRow = $t.find('tr').filter((_, tr) => $(tr).find('th,td').length >= 10).first();
    if (!$hdrRow.length) return;

    const headers = $hdrRow.find('th,td').map((i, el) => lower($(el).text())).get();

    // índices útiles
    const idx = (needle) => headers.findIndex(h => h.includes(needle));
    const idxs = {
      codigo: idx('código del ramo'),
      nombre: idx('nombre del ramo'),
      seccion: idx('sección'),
      periodo: idx('periodo'),  // a veces dice "Periodo"
      anio: idx('año'),
      asistencia: idx('asist')
    };

    // detecta columnas PP 1..4 / LAB 1..4 / PP Prom / LAB Prom / N Ex 40%/30% / Final / Estado
    const findCol = (...needles) => headers.findIndex(h => needles.some(n => h.includes(n)));

    const colPP = [
      findCol('pp 1', 'pp1'),
      findCol('pp 2', 'pp2'),
      findCol('pp 3', 'pp3'),
      findCol('pp 4', 'pp4')
    ].filter(i => i >= 0);

    const colLAB = [
      findCol('lab 1', 'lab1'),
      findCol('lab 2', 'lab2'),
      findCol('lab 3', 'lab3'),
      findCol('lab 4', 'lab4')
    ].filter(i => i >= 0);

    const colPPProm = findCol('pp prom', 'pp prom 100%');
    const colLABProm = findCol('lab prom', 'lab prom 100%');
    const colNExPct  = findCol('n ex 40', 'n ex 30', 'n ex 40%', 'n ex 30%'); // ponderado
    const colExamen  = findCol('examen');   // si aparece explícito
    const colFinal   = findCol('final');
    const colEstado  = findCol('estado');

    // Recorre filas de datos (después de la cabecera)
    $hdrRow.nextAll('tr').each((__, tr) => {
      const tds = $(tr).find('td');
      if (!tds.length) return;

      const cells = tds.map((i, el) => norm($(el).text())).get();
      const get = (i) => (i >= 0 && i < cells.length) ? cells[i] : '';

      // Filtros básicos
      const codigo = get(idxs.codigo);
      const nombre = get(idxs.nombre);
      if (!codigo || !nombre) return;

      const seccion = get(idxs.seccion) || '3 - Teórico';
      const periodo = asNum(get(idxs.periodo)); // 1/2
      const anio    = asNum(get(idxs.anio));
      const asistencia = asNum(get(idxs.asistencia));

      const certs = [];
      if (colPP.length) colPP.forEach(i => { const v = asNum(get(i)); if (Number.isFinite(v)) certs.push(v); });
      const labs = [];
      if (colLAB.length) colLAB.forEach(i => { const v = asNum(get(i)); if (Number.isFinite(v)) labs.push(v); });

      const ppProm100  = asNum(get(colPPProm));
      const labProm100 = asNum(get(colLABProm));
      const nExPct     = asNum(get(colNExPct));
      const examen     = asNum(get(colExamen));
      const final      = asNum(get(colFinal));
      const estado     = norm(get(colEstado)).toUpperCase();

      const row = {
        codigo: codigo.toUpperCase(),
        nombre,
        seccion,
        periodo,
        anio,
        asistencia,
        certamenes: certs,
        laboratorios: labs,
        ppProm100,
        labProm100,
        nExPct,
        notaExamen: examen,
        notaFinal: final,
        estado
      };

      rowsOut.push(row);
    });
  });

  // Si nada, guardo HTML para revisar
  if (!rowsOut.length) {
    console.log('[scraper] No se encontró ninguna tabla candidata.');
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
    fs.writeFileSync(outB,fs.writeFileSync(outB, JSON.stringify(grouped, null, 2), 'utf8');

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
