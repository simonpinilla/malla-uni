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
    list = list.map(it => {
      // Parseamos valores numéricos seguros
      const certamenes = (it.certamenes || []).map(Number).filter(n => !isNaN(n));
      const laboratorios = (it.laboratorios || []).map(Number).filter(n => !isNaN(n));
      const notaExamen = it.notaExamen === '' ? null : Number(it.notaExamen);
    
      // Promedio de certámenes (teórico)
      const promedioCertamenes = certamenes.length > 0
        ? certamenes.reduce((a, b) => a + b, 0) / certamenes.length
        : null;
    
      // Promedio de laboratorios (práctico)
      const promedioLaboratorios = laboratorios.length > 0
        ? laboratorios.reduce((a, b) => a + b, 0) / laboratorios.length
        : null;
    
      // Cálculo del promedio ponderado Teórico (80%) + Práctico (20%)
      let promedioParcial = null;
      if (promedioCertamenes !== null) {
        promedioParcial = promedioCertamenes * 0.8 +
          (promedioLaboratorios !== null ? promedioLaboratorios * 0.2 : 0);
      }
    
      // Si hay examen, aplica 70% promedio + 30% examen
      let notaFinalCalculada = promedioParcial;
      if (notaExamen !== null && promedioParcial !== null) {
        notaFinalCalculada = promedioParcial * 0.7 + notaExamen * 0.3;
      }
    
      return {
        codigo: it.codigo,
        nombre: it.nombre,
        seccion: it.seccion || 'Teórico',
        asistencia: String(it.asistencia || '').replace('%', ''),
        certamenes,
        laboratorios,
        notaExamen,
        notaFinal: it.notaFinal === '' ? notaFinalCalculada : Number(it.notaFinal),
        estado: it.estado || '',
        periodo: it.periodo || new Date().getFullYear(),
        semestre: it.semestre || 1,
        periodoKey: it.periodoKey || `${it.periodo || new Date().getFullYear()}-${it.semestre || 1}`
      };
    });
    
        // ====== LIMPIEZA + UNIÓN TEÓRICO/LAB + CÁLCULO ======
    function normalizeStr(s){ return String(s||'').normalize('NFKC').trim(); }
    function isLabRow(r){
      const s = (r.seccion||'') + ' ' + (r.nombre||'');
      return /lab/i.test(s);
    }
    function asNum(x){
      const n = Number(String(x||'').replace(',','.').trim());
      return Number.isFinite(n) ? n : null;
    }
    function round1(n){ return Math.round(n*10)/10; }
    function avg(a){
      const v = a.filter(x=>Number.isFinite(x));
      return v.length ? v.reduce((p,c)=>p+c,0)/v.length : null;
    }
    
    // Intenta recuperar EXAMEN si no vino crudo, usando "N Ex 40%" ~ exam*0.4
    function inferExamFromWeighted(nEx40){
      const n = asNum(nEx40);
      if (!Number.isFinite(n)) return null;
      const ex = n/0.4;
      // valores razonables 1.0..7.0
      return (ex>=1 && ex<=7.0) ? round1(ex) : null;
    }
    
    function cleanAggregateAndWeight(rawList){
      // 1) Normaliza registros base
      const base = (rawList||[]).map(r=>{
        const codigo = normalizeStr(r.codigo).toUpperCase();
        const nombre = normalizeStr(r.nombre);
        const seccion= normalizeStr(r.seccion||'Teórico');
        const anio   = asNum(r.anio) || asNum(r.periodo) || new Date().getFullYear();
        const periodo= asNum(r.periodoSem) || asNum(r.periodoN) || asNum(r.periodoTexto) || null; // si no tienes semestre, quedará null
    
        // arregla arrays (PP/LAB)
        const certs = Array.isArray(r.certamenes) ? r.certamenes.map(asNum).filter(Number.isFinite) : [];
        const labs  = Array.isArray(r.laboratorios) ? r.laboratorios.map(asNum).filter(Number.isFinite) : [];
    
        // algunos portales traen "promedios ponderados" (PP Prom 100%, N Pr 70%, N Ex 30%)
        const ppProm100 = asNum(r.ppProm100 || r.ppProm || r.ppprom);
        const nPrPct    = asNum(r.nPr60 || r.nPr70 || r.npr);         // (nota presentación ponderada)
        const nExPct    = asNum(r.nEx40 || r.nEx30 || r.nex);         // (nota examen ponderada)
        const ex        = asNum(r.notaExamen) ?? inferExamFromWeighted(nExPct);
    
        const asistencia= asNum(r.asistencia);
        const notaFinal = asNum(r.notaFinal);
        const estadoTxt = normalizeStr(r.estado).toUpperCase();
    
        return {
          codigo, nombre, seccion, anio, periodo,
          certamenes: certs, laboratorios: labs,
          ppProm100, nPrPct, nExPct,
          examen: ex,
          asistencia,
          notaFinal,
          estado: estadoTxt
        };
      }).filter(r=>r.codigo);
    
      // 2) Une por código: separa teórico/lab y arma un sólo objeto por ramo
      //    (si hay más de un teórico/lab por código, conserva el "mejor" dato de cada parte)
      const byCode = new Map();
      for (const r of base) {
        if (!byCode.has(r.codigo)) {
          byCode.set(r.codigo, {
            codigo: r.codigo,
            nombre: r.nombre,
            anio: r.anio,
            periodo: r.periodo,
            teorico: { certs: [], ppProm100: null, nPrPct: null, examen: null, final: null },
            lab:     { labs:  [], labProm: null,                   final: null },
            asistencia: r.asistencia,
            finalPortal: r.notaFinal,
            estadoPortal: r.estado
          });
        }
        const acc = byCode.get(r.codigo);
        // preferimos mantener el nombre más largo (suele ser el correcto)
        if ((r.nombre||'').length > (acc.nombre||'').length) acc.nombre = r.nombre;
        if (r.anio && (!acc.anio || r.anio>acc.anio)) acc.anio = r.anio;
        if (r.periodo && !acc.periodo) acc.periodo = r.periodo;
    
        if (isLabRow(r)) {
          acc.lab.labs = (acc.lab.labs||[]).concat(r.laboratorios||[]);
          // si viene "final" del lab (pasa en algunos portales), consérvalo
          if (Number.isFinite(r.notaFinal)) acc.lab.final = r.notaFinal;
        } else {
          acc.teorico.certs = (acc.teorico.certs||[]).concat(r.certamenes||[]);
          acc.teorico.ppProm100 = acc.teorico.ppProm100 ?? r.ppProm100;
          acc.teorico.nPrPct    = acc.teorico.nPrPct    ?? r.nPrPct;
          acc.teorico.examen    = acc.teorico.examen    ?? r.examen;
          if (Number.isFinite(r.notaFinal)) acc.teorico.final = r.notaFinal;
        }
    
        // asistencia y final portal: conserva valores presentes
        if (!Number.isFinite(acc.asistencia) && Number.isFinite(r.asistencia)) acc.asistencia = r.asistencia;
        if (!Number.isFinite(acc.finalPortal) && Number.isFinite(r.notaFinal)) acc.finalPortal = r.notaFinal;
        if (!acc.estadoPortal && r.estado) acc.estadoPortal = r.estado;
      }
    
      // 3) Calcula promedios y final con tu regla
      const out = [];
      for (const [,acc] of byCode) {
        const ppProm  = avg(acc.teorico.certs||[]);
        const labProm = avg(acc.lab.labs||[]);
        const examen  = Number.isFinite(acc.teorico.examen) ? acc.teorico.examen : null;
    
        // Pesos por defecto
        let weights = { teo: 80, lab: 20, examInTeo: 30 };
        if (!Number.isFinite(labProm) && Number.isFinite(examen)) { weights = { teo:100, lab:0, examInTeo:30 }; }
        if ( Number.isFinite(labProm) && !Number.isFinite(examen)) { weights = { teo:80,  lab:20, examInTeo:0  }; }
        if (!Number.isFinite(labProm) && !Number.isFinite(examen)) { weights = { teo:100, lab:0, examInTeo:0  }; }
    
        const ppWeight = 100 - weights.examInTeo;   // 70
        const teoInside = (
          (Number.isFinite(ppProm)  ? ppProm  : 0) * ppWeight +
          (Number.isFinite(examen)  ? examen  : 0) * weights.examInTeo
        ) / 100;
    
        const finalCalc = round1(
          (teoInside * weights.teo + (Number.isFinite(labProm)?labProm:0) * weights.lab) / 100
        );
    
        // estado calculado (si portal trae estado/nota final, lo usamos para confirmar)
        let estado = 'CURSANDO';
        if (Number.isFinite(acc.finalPortal)) estado = acc.finalPortal >= 4.0 ? 'APROBADO' : 'REPROBADO';
        else if (Number.isFinite(finalCalc)) estado = finalCalc >= 4.0 ? 'APROBADO' : 'REPROBADO';
    
        out.push({
          codigo: acc.codigo,
          nombre: acc.nombre,
          anio: acc.anio,          // año académico (si lo tienes en el raw)
          semestre: acc.periodo,   // si lo detectas en el raw; si no, quedará null
          asistencia: Number.isFinite(acc.asistencia) ? acc.asistencia : null,
    
          // notas crudas agregadas
          pp: (acc.teorico.certs||[]),
          lab: (acc.lab.labs||[]),
          examen: Number.isFinite(examen) ? examen : null,
    
          // promedios
          promedioPP: Number.isFinite(ppProm) ? round1(ppProm) : null,
          promedioLab: Number.isFinite(labProm) ? round1(labProm) : null,
    
          // resultado
          finalCalculado: Number.isFinite(finalCalc) ? finalCalc : null,
          finalPortal: Number.isFinite(acc.finalPortal) ? acc.finalPortal : null,
          estadoPortal: acc.estadoPortal || null,
          estado       : estado,
    
          // pesos usados para el cálculo (útil para debug/UI)
          pesos: weights
        });
      }
    
      // ordena por año asc y por código
      out.sort((a,b)=> (a.anio||0)-(b.anio||0) || String(a.codigo).localeCompare(String(b.codigo)));
      return out;
    }


    
          // --- A) notas.json (lista limpia/unificada) ---
    const out = cleanAggregateAndWeight(list);
    const outA = path.join(process.cwd(), 'notas.json');
    fs.writeFileSync(outA, JSON.stringify(out, null, 2), 'utf8');
    console.log(`[scraper] OK: notas.json limpio (${out.length} ramos)`);

    // (opcional) valida diferencias entre finalPortal y finalCalculado
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

  }catch(err){
    console.error('[scraper] ERROR:', err && err.stack || err);
    process.exit(1);
  }
}

run();
