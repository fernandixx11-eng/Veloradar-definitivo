// detector.js — VERSIÓN 2: detector híbrido del balón
//
// Lo ha escrito Claude (tutor) a petición de Fernando (2026-11-09).
// Parte de la versión 1 (la parte final de COCO-SSD 2.2.3, index.ts,
// licencia Apache 2.0) y le añade tres ayudas a la red neuronal:
//
//  1. LUPA. La red encoge SIEMPRE la foto a 300x300 antes de mirarla. Un balón
//     lejano se queda en unos pocos píxeles y no lo reconoce. La lupa recorta
//     un trozo de la foto y le da a la red solo ese trozo: el balón ocupa más
//     de los 300x300 y se ve mejor.
//  2. SEGUIMIENTO. Si en las fotos anteriores había balón, se sabe dónde estaba
//     y a qué velocidad iba. En la foto nueva se mira primero con la lupa donde
//     debería estar ahora.
//  3. MOVIMIENTO. Con la cámara quieta, lo único que cambia entre fotos seguidas
//     es lo que se mueve. Si la red no reconoce el balón (por ejemplo, porque
//     sale borroso), se busca una mancha que se mueva y que tenga el alto del
//     balón que la red sí vio antes.
//
// Se usa IGUAL que la versión 1 y devuelve lo mismo:
//   const detectando = await detectarBalon(deteccion, foto, 0.1, 0.5, 1);
//   -> [{ bbox: [x, y, ancho, alto], class: "sports ball", score, origen }]
// "origen" dice cómo se ha encontrado: "red", "lupa" o "movimiento".
// Si es "movimiento", score vale 0 (la red no lo ha visto: se ha deducido).
//
// MUY RECOMENDABLE: llamar a reiniciarDetector() justo antes del bucle que
// analiza el buffer, para que no se mezclen las fotos de un GOL con las del
// anterior. (Si se te olvida funciona igual casi siempre, pero mejor no.)
//
// El seguimiento y el movimiento necesitan que las fotos lleguen EN ORDEN
// (como en tu bucle, de la 0 a la última) y que la cámara esté QUIETA.

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

// "sports ball" es la clase 37 de COCO; el modelo cuenta desde 0 → posición 36.
const POSICION_BALON = 36;

// Para buscar movimiento, la foto se reduce a unos 320 píxeles de ancho
// (mucho más rápido y además quita ruido).
const ANCHO_MAPA = 320;
// Diferencia de brillo (de 0 a 255) a partir de la que un píxel "ha cambiado".
const UMBRAL_CAMBIO = 25;
// Si cambia más del 35 % de la foto de golpe, no es un balón: es otra escena
// (otro GOL, la cámara se ha movido...). Se olvida todo lo anterior.
const CAMBIO_ESCENA = 0.35;

// La lupa mira un cuadrado de 6 balones de lado, y nunca de menos de 96 px.
const ZOOM_LUPA = 6;
const LADO_MINIMO_LUPA = 96;

// Mientras no se haya visto nunca el balón, se busca "por trozos" (4 lupas
// que cubren toda la foto) una de cada 3 fotos, y como mucho 12 veces.
const CADA_CUANTAS_FOTOS_TROZOS = 3;
const MAXIMO_BUSQUEDAS_TROZOS = 12;

// ---------------------------------------------------------------------------
// Memoria del detector (lo que recuerda de las fotos anteriores)
// ---------------------------------------------------------------------------

const memoria = {};

const reiniciarDetector = () => {
  memoria.gris1 = null;          // foto anterior, en gris y en pequeño
  memoria.gris2 = null;          // la de antes de esa
  memoria.anchoMapa = 0;
  memoria.altoMapa = 0;
  memoria.anchoFoto = 0;
  memoria.altoFoto = 0;
  memoria.numeroFoto = 0;        // cuántas fotos se han analizado
  memoria.centro = null;         // último centro del balón {x, y, foto}
  memoria.centroAnterior = null; // el de antes {x, y, foto}
  memoria.altos = [];            // altos de los últimos balones que vio la red
  memoria.busquedasTrozos = 0;
  memoria.tiroEmpezado = false;  // ¿se ha visto ya el balón moverse?
  memoria.cuenta = { red: 0, lupa: 0, movimiento: 0, nada: 0, usosDeLaRed: 0 };
};
reiniciarDetector();

// Para tus contadores en pantalla: cuántas fotos se encontraron de cada forma
// y cuántas veces se usó la red neuronal (lo que más tarda).
const resumenDetector = () => ({ ...memoria.cuenta });

// Olvida dónde estaba el balón (pero no su tamaño). Se usa cuando cambia la escena.
const olvidarPosicion = () => {
  memoria.centro = null;
  memoria.centroAnterior = null;
};

// ---------------------------------------------------------------------------
// 1. Movimiento: diferencias entre fotos seguidas (sin red neuronal)
// ---------------------------------------------------------------------------

// Convierte la foto en un mapa pequeño en gris. Cada casilla es la media de un
// cuadrado de paso x paso píxeles. Solo funciona con ImageData (tus fotos).
const hacerMapaGris = (imagen) => {
  if (typeof ImageData === "undefined" || !(imagen instanceof ImageData)) {
    return null;
  }
  const paso = Math.max(1, Math.round(imagen.width / ANCHO_MAPA));
  const ancho = Math.floor(imagen.width / paso);
  const alto = Math.floor(imagen.height / paso);
  const gris = new Uint8Array(ancho * alto);
  const d = imagen.data;
  const n = paso * paso;
  for (let j = 0; j < alto; j++) {
    for (let i = 0; i < ancho; i++) {
      let suma = 0;
      for (let dy = 0; dy < paso; dy++) {
        let p = ((j * paso + dy) * imagen.width + i * paso) * 4;
        for (let dx = 0; dx < paso; dx++) {
          // Brillo = 0,30·rojo + 0,59·verde + 0,11·azul (como ve el ojo)
          suma += (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
          p += 4;
        }
      }
      gris[j * ancho + i] = suma / n;
    }
  }
  return { gris, ancho, alto, paso };
};

// Compara la foto actual con las dos anteriores y devuelve las "manchas" que se
// mueven, en píxeles de la foto: [{x, y, ancho, alto, casillas, relleno}].
//
// Por qué con DOS fotos anteriores: si solo se compara con la anterior, sale el
// balón dos veces (donde está ahora y el hueco donde estaba). Un píxel que es
// distinto de la foto anterior Y de la de antes tiene algo NUEVO ahora mismo:
// así solo queda la posición actual.
const buscarManchas = (mapa) => {
  const { gris, ancho, alto, paso } = mapa;
  let manchas = [];

  const mismoTamano = memoria.gris1 && memoria.anchoMapa === ancho && memoria.altoMapa === alto;
  if (mismoTamano) {
    const g1 = memoria.gris1;
    const g2 = memoria.gris2;
    const total = ancho * alto;
    const mascara = new Uint8Array(total);
    let cambiados = 0;
    for (let k = 0; k < total; k++) {
      const cambio1 = Math.abs(gris[k] - g1[k]) > UMBRAL_CAMBIO;
      if (cambio1) cambiados++;
      if (cambio1 && g2 && Math.abs(gris[k] - g2[k]) > UMBRAL_CAMBIO) mascara[k] = 1;
    }

    if (cambiados / total > CAMBIO_ESCENA) {
      // Otra escena: no se puede comparar con nada de lo anterior.
      olvidarPosicion();
      memoria.gris2 = null;
      memoria.gris1 = gris;
      return [];
    }
    if (g2) manchas = agruparManchas(mascara, ancho, alto, paso);
  } else {
    memoria.gris2 = null;
  }

  memoria.gris2 = mismoTamano ? memoria.gris1 : null;
  memoria.gris1 = gris;
  memoria.anchoMapa = ancho;
  memoria.altoMapa = alto;
  return manchas;
};

// Junta las casillas que han cambiado y se tocan en manchas (como el "cubo de
// pintura" de Paint). Antes se engorda la máscara una casilla para que un balón
// borroso que sale "a trozos" quede en una sola mancha.
const agruparManchas = (mascara, ancho, alto, paso) => {
  const gorda = new Uint8Array(ancho * alto);
  for (let j = 0; j < alto; j++) {
    for (let i = 0; i < ancho; i++) {
      if (!mascara[j * ancho + i]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const y = j + dy;
          const x = i + dx;
          if (x >= 0 && y >= 0 && x < ancho && y < alto) gorda[y * ancho + x] = 1;
        }
      }
    }
  }

  const visitada = new Uint8Array(ancho * alto);
  const pila = [];
  const manchas = [];
  for (let inicio = 0; inicio < ancho * alto; inicio++) {
    if (!gorda[inicio] || visitada[inicio]) continue;
    visitada[inicio] = 1;
    pila.push(inicio);
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, casillas = 0;
    while (pila.length > 0) {
      const k = pila.pop();
      const x = k % ancho;
      const y = (k - x) / ancho;
      if (mascara[k]) {
        // La caja se mide solo con las casillas de verdad (no las engordadas).
        casillas++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= ancho || ny >= alto) continue;
          const nk = ny * ancho + nx;
          if (gorda[nk] && !visitada[nk]) {
            visitada[nk] = 1;
            pila.push(nk);
          }
        }
      }
    }
    if (casillas < 2) continue; // ruido
    const anchoCasillas = maxX - minX + 1;
    const altoCasillas = maxY - minY + 1;
    manchas.push({
      x: minX * paso,
      y: minY * paso,
      ancho: anchoCasillas * paso,
      alto: altoCasillas * paso,
      casillas,
      relleno: casillas / (anchoCasillas * altoCasillas)
    });
  }
  manchas.sort((a, b) => b.casillas - a.casillas);
  return manchas.slice(0, 20);
};

// ---------------------------------------------------------------------------
// 2. La red neuronal mirando una zona de la foto (lo mismo que la versión 1)
// ---------------------------------------------------------------------------

// zona = {x, y, ancho, alto} en píxeles de la foto. Devuelve los candidatos a
// balón de esa zona, ya pasados a píxeles de la foto entera.
const mirarZona = async (modelo, tensorFoto, zona, puntuacionMinima) => {
  const entrada = tf.tidy(() => {
    const esEntera = zona.x === 0 && zona.y === 0 &&
      zona.ancho === tensorFoto.shape[1] && zona.alto === tensorFoto.shape[0];
    const trozo = esEntera
      ? tensorFoto
      : tf.slice(tensorFoto, [zona.y, zona.x, 0], [zona.alto, zona.ancho, 3]);
    return tf.expandDims(trozo);
  });

  const resultado = await modelo.model.executeAsync(entrada);
  memoria.cuenta.usosDeLaRed++;
  const numCajas = resultado[0].shape[1];
  const numClases = resultado[0].shape[2];
  // data() en vez de dataSync(): espera sin bloquear la página.
  const [puntuaciones, cajas] = await Promise.all([resultado[0].data(), resultado[1].data()]);
  entrada.dispose();
  tf.dispose(resultado);

  const candidatos = [];
  for (let i = 0; i < numCajas; i++) {
    const score = puntuaciones[i * numClases + POSICION_BALON];
    if (score < puntuacionMinima) continue;
    // La red da [arriba, izquierda, abajo, derecha] de 0 a 1 DENTRO de la zona.
    const limitar = (v) => Math.min(1, Math.max(0, v));
    candidatos.push({
      x1: zona.x + limitar(cajas[i * 4 + 1]) * zona.ancho,
      y1: zona.y + limitar(cajas[i * 4]) * zona.alto,
      x2: zona.x + limitar(cajas[i * 4 + 3]) * zona.ancho,
      y2: zona.y + limitar(cajas[i * 4 + 2]) * zona.alto,
      score
    });
  }
  return candidatos;
};

// Un cuadrado de "lado" píxeles centrado en (cx, cy), metido dentro de la foto.
const zonaCuadrada = (cx, cy, lado, anchoFoto, altoFoto) => {
  const l = Math.round(Math.min(lado, anchoFoto, altoFoto));
  const x = Math.max(0, Math.min(Math.round(cx - l / 2), anchoFoto - l));
  const y = Math.max(0, Math.min(Math.round(cy - l / 2), altoFoto - l));
  return { x, y, ancho: l, alto: l };
};

// Cuatro trozos que cubren la foto entera solapándose un poco.
const zonasTrozos = (anchoFoto, altoFoto) => {
  const a = Math.round(anchoFoto * 0.6);
  const h = Math.round(altoFoto * 0.6);
  return [
    { x: 0, y: 0, ancho: a, alto: h },
    { x: anchoFoto - a, y: 0, ancho: a, alto: h },
    { x: 0, y: altoFoto - h, ancho: a, alto: h },
    { x: anchoFoto - a, y: altoFoto - h, ancho: a, alto: h }
  ];
};

// ¿Cuánto se solapan dos cajas? (intersección / unión, de 0 a 1)
const solape = (a, b) => {
  const ancho = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const alto = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (ancho <= 0 || alto <= 0) return 0;
  const interseccion = ancho * alto;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - interseccion;
  return interseccion / union;
};

// Quita las cajas repetidas (non-max suppression), igual que la versión 1,
// pero en JavaScript normal porque ahora juntamos cajas de varias zonas.
const limpiarSolapes = (candidatos, solapamientoMaximo, maxBalones) => {
  const ordenados = [...candidatos].sort((a, b) => b.score - a.score);
  const elegidos = [];
  for (const c of ordenados) {
    if (elegidos.length >= maxBalones) break;
    if (elegidos.every((e) => solape(e, c) <= solapamientoMaximo)) elegidos.push(c);
  }
  return elegidos;
};

// ---------------------------------------------------------------------------
// 3. Seguimiento: dónde debería estar el balón ahora
// ---------------------------------------------------------------------------

// Alto "normal" del balón: la mediana de los últimos altos que vio la red.
// (La mediana no se deja engañar por una caja rara suelta; la media sí.)
const altoBalon = () => {
  if (memoria.altos.length === 0) return null;
  const ordenados = [...memoria.altos].sort((a, b) => a - b);
  return ordenados[Math.floor(ordenados.length / 2)];
};

// Posición prevista = última posición + velocidad × fotos que han pasado.
const predecir = () => {
  const c = memoria.centro;
  if (!c) return null;
  const fotosPasadas = memoria.numeroFoto - c.foto;
  if (fotosPasadas > 4) return null; // hace demasiado que no se ve: no fiarse
  const a = memoria.centroAnterior;
  let vx = 0;
  let vy = 0;
  if (a && c.foto - a.foto <= 3) {
    vx = (c.x - a.x) / (c.foto - a.foto);
    vy = (c.y - a.y) / (c.foto - a.foto);
  }
  return { x: c.x + vx * fotosPasadas, y: c.y + vy * fotosPasadas, vx, vy, fotosPasadas: Math.max(1, fotosPasadas) };
};

// A partir de cuántos píxeles por foto se considera que el balón se mueve:
// un cuarto de balón, y nunca menos de 6 px (lo que "baila" la caja quieta).
const umbralMovimiento = (ref) => Math.max(0.25 * ref, 6);
const estaQuieto = (prediccion, ref) => Math.hypot(prediccion.vx, prediccion.vy) <= umbralMovimiento(ref);

// Hasta qué distancia de la posición prevista se acepta un balón. Si iba
// rápido, la zona crece con la velocidad. Si estaba quieto (o casi), después
// del chut puede aparecer bastante lejos: 8 balones.
const radioBusqueda = (prediccion, ref) => {
  if (estaQuieto(prediccion, ref)) return 8 * ref;
  // Iba rápido: la duda crece un poco con cada foto en la que no se ha visto.
  const velocidad = Math.hypot(prediccion.vx, prediccion.vy);
  return Math.max(2 * ref, 0.5 * velocidad) + 0.5 * velocidad * (prediccion.fotosPasadas - 1);
};

// "Puerta": si se sabe dónde debería estar el balón, un candidato muy lejos de
// ahí es otra cosa (otro balón, un dibujo, una bota...) y se descarta.
const pasaLaPuerta = (cx, cy, prediccion, ref) => {
  if (!prediccion || !ref) return true;
  return Math.hypot(cx - prediccion.x, cy - prediccion.y) <= radioBusqueda(prediccion, ref);
};

// ¿La caja toca alguna mancha de movimiento?
const tocaMovimiento = (c, manchas, margen) => manchas.some((m) =>
  c.x1 - margen < m.x + m.ancho && c.x2 + margen > m.x &&
  c.y1 - margen < m.y + m.alto && c.y2 + margen > m.y);

// Reglas para aceptar un candidato de la red:
//  - Tiene que pasar la puerta.
//  - Si ya ha empezado el tiro, el balón vuela: solo vale un candidato que se
//    mueva. Así no se coge una bota o un cono que estaban quietos (por ejemplo,
//    cuando el balón ya ha salido de la foto).
//  - Si el balón estaba QUIETO y el candidato no está en su sitio, el balón
//    tiene que haberse movido: también tiene que tocar movimiento.
// (Las dos últimas solo se pueden comprobar con fotos ImageData.)
const filtrarCandidatos = (candidatos, prediccion, ref, manchas, hayMapa) =>
  candidatos.filter((c) => {
    const cx = (c.x1 + c.x2) / 2;
    const cy = (c.y1 + c.y2) / 2;
    if (!pasaLaPuerta(cx, cy, prediccion, ref)) return false;
    if (!hayMapa || !ref) return true;
    const margen = ref * 0.5;
    if (memoria.tiroEmpezado) return tocaMovimiento(c, manchas, margen);
    if (prediccion && estaQuieto(prediccion, ref) &&
        Math.hypot(cx - prediccion.x, cy - prediccion.y) > ref) {
      return tocaMovimiento(c, manchas, margen);
    }
    return true;
  });

// Los candidatos de la lupa tienen que tener un tamaño parecido al del balón
// (la lupa amplía, y a veces confunde cosas pequeñas con un balón).
const filtrarTamano = (candidatos, ref) => {
  if (!ref) return candidatos;
  return candidatos.filter((c) => {
    const alto = c.y2 - c.y1;
    return alto > ref * 0.5 && alto < ref * 2;
  });
};

// Entre las manchas que se mueven, la que más parece el balón: su alto se parece
// al del balón (el borroso estira a lo ancho, no a lo alto) y está cerca de
// donde debería estar.
const elegirManchaBalon = (manchas, ref, prediccion) => {
  let mejor = null;
  let mejorNota = Infinity;
  for (const m of manchas) {
    // Muy borroso, el balón es medio transparente y sus bordes casi no cambian
    // el brillo: la mancha sale más "delgada" que el balón. Por eso se acepta
    // desde un cuarto de su alto.
    if (m.alto < ref * 0.25 || m.alto > ref * 1.7) continue;
    if (m.ancho < ref * 0.6 || m.ancho > ref * 10) continue;
    if (m.casillas < 3 || m.relleno < 0.25) continue;
    const cx = m.x + m.ancho / 2;
    const cy = m.y + m.alto / 2;
    if (!pasaLaPuerta(cx, cy, prediccion, ref)) continue;
    const distancia = prediccion ? Math.hypot(cx - prediccion.x, cy - prediccion.y) : 0;
    // Si estaba quieto, una mancha justo en su sitio es el "hueco" que deja al
    // irse (el fondo que vuelve a verse), no el balón.
    if (prediccion && estaQuieto(prediccion, ref) && distancia < ref * 0.5) continue;
    const nota = distancia / ref + Math.abs(m.alto - ref) / ref;
    if (nota < mejorNota) {
      mejorNota = nota;
      mejor = m;
    }
  }
  return mejor;
};

// ---------------------------------------------------------------------------
// La función que usa tu programa
// ---------------------------------------------------------------------------

// modelo: lo que devuelve cocoSsd.load()
// imagen: una foto del buffer (ImageData). También vale un canvas o el vídeo,
//         pero entonces no se usa el movimiento.
// puntuacionMinima: de 0 a 1. Por debajo, la caja no cuenta como balón.
// solapamientoMaximo: de 0 a 1. Si dos cajas de balón se solapan más, se borra la de menos puntuación.
// maxBalones: cuántas cajas de balón como mucho (para tu programa, 1).
// opciones (no hace falta ponerlo): { lupa: false } o { seguimiento: false } o
//          { movimiento: false } para apagar una ayuda y comparar en el TdM.
const detectarBalon = async (modelo, imagen, puntuacionMinima, solapamientoMaximo, maxBalones, opciones = {}) => {
  const usarLupa = opciones.lupa !== false;
  const usarSeguimiento = opciones.seguimiento !== false;
  const usarMovimiento = opciones.movimiento !== false;

  // A. Movimiento (rápido, sin red neuronal). También detecta si ha cambiado la escena.
  const mapa = hacerMapaGris(imagen);
  const manchas = mapa ? buscarManchas(mapa) : [];
  const hayMapa = mapa !== null && usarMovimiento;

  // B. La foto se convierte en tensor UNA vez y se reutiliza para todas las zonas.
  const tensorFoto = tf.browser.fromPixels(imagen);
  const altoFoto = tensorFoto.shape[0];
  const anchoFoto = tensorFoto.shape[1];
  if (anchoFoto !== memoria.anchoFoto || altoFoto !== memoria.altoFoto) {
    olvidarPosicion();
    memoria.altos = [];
    memoria.anchoFoto = anchoFoto;
    memoria.altoFoto = altoFoto;
  }
  const ladoMaximoUtil = 0.8 * Math.min(anchoFoto, altoFoto);

  const ref = altoBalon();
  const prediccion = usarSeguimiento ? predecir() : null;

  let candidatos = [];
  let origen = "red";
  try {
    // 1. SEGUIMIENTO + LUPA: mirar primero donde debería estar.
    if (prediccion && ref && usarLupa) {
      const zona = zonaCuadrada(prediccion.x, prediccion.y,
        Math.max(ref * ZOOM_LUPA, LADO_MINIMO_LUPA), anchoFoto, altoFoto);
      const encontrados = await mirarZona(modelo, tensorFoto, zona, puntuacionMinima);
      candidatos = filtrarCandidatos(filtrarTamano(encontrados, ref), prediccion, ref, manchas, hayMapa);
      origen = "lupa";
    }

    // 2. LA FOTO ENTERA (lo que hacía la versión 1), pero pasando las reglas.
    if (candidatos.length === 0) {
      const entera = { x: 0, y: 0, ancho: anchoFoto, alto: altoFoto };
      const encontrados = await mirarZona(modelo, tensorFoto, entera, puntuacionMinima);
      candidatos = filtrarCandidatos(encontrados, prediccion, ref, manchas, hayMapa);
      origen = "red";
    }

    // 3. LUPA SOBRE LO QUE SE MUEVE (como mucho 2 manchas que puedan ser el balón,
    //    primero las más cercanas a donde debería estar).
    if (candidatos.length === 0 && usarLupa && usarMovimiento && manchas.length > 0) {
      const posibles = manchas.filter((m) => (ref
        ? m.alto > ref * 0.25 && m.alto < ref * 2
        : m.alto < altoFoto * 0.25 && m.casillas >= 4) &&
        pasaLaPuerta(m.x + m.ancho / 2, m.y + m.alto / 2, prediccion, ref));
      if (prediccion) {
        const distancia = (m) => Math.hypot(m.x + m.ancho / 2 - prediccion.x, m.y + m.alto / 2 - prediccion.y);
        posibles.sort((a, b) => distancia(a) - distancia(b));
      }
      for (const m of posibles.slice(0, 2)) {
        const lado = Math.max(Math.max(m.ancho, m.alto) * 3, (ref || 0) * ZOOM_LUPA, LADO_MINIMO_LUPA);
        if (lado >= ladoMaximoUtil) continue; // sería casi la foto entera: ya está mirada
        const zona = zonaCuadrada(m.x + m.ancho / 2, m.y + m.alto / 2, lado, anchoFoto, altoFoto);
        const encontrados = await mirarZona(modelo, tensorFoto, zona, puntuacionMinima);
        candidatos = candidatos.concat(filtrarCandidatos(filtrarTamano(encontrados, ref), prediccion, ref, manchas, hayMapa));
      }
      if (candidatos.length > 0) origen = "lupa";
    }

    // 4. LUPA POR TROZOS, solo mientras todavía no se ha visto nunca el balón
    //    (por ejemplo, un balón quieto pero muy lejos).
    if (candidatos.length === 0 && usarLupa && ref === null &&
        memoria.numeroFoto % CADA_CUANTAS_FOTOS_TROZOS === 0 &&
        memoria.busquedasTrozos < MAXIMO_BUSQUEDAS_TROZOS) {
      memoria.busquedasTrozos++;
      for (const zona of zonasTrozos(anchoFoto, altoFoto)) {
        candidatos = candidatos.concat(await mirarZona(modelo, tensorFoto, zona, puntuacionMinima));
      }
      if (candidatos.length > 0) origen = "lupa";
    }
  } finally {
    tensorFoto.dispose();
  }

  // Se devuelve lo mismo que la versión 1: [{bbox: [x, y, ancho, alto], class, score}]
  let balones = limpiarSolapes(candidatos, solapamientoMaximo, maxBalones).map((c) => ({
    bbox: [c.x1, c.y1, c.x2 - c.x1, c.y2 - c.y1],
    class: "sports ball",
    score: c.score,
    origen
  }));

  // 5. MOVIMIENTO: la red no lo ha visto, pero hay una mancha que se mueve con el
  //    alto del balón. La caja tiene el ancho de la mancha (incluye lo borroso) y
  //    el alto del balón que vio la red, centrada en la mancha.
  //    Solo si se sabe dónde debería estar (si no, cualquier pie que se mueva valdría).
  if (balones.length === 0 && usarMovimiento && ref && prediccion) {
    const mancha = elegirManchaBalon(manchas, ref, prediccion);
    if (mancha) {
      const centroY = mancha.y + mancha.alto / 2;
      balones = [{
        bbox: [mancha.x, centroY - ref / 2, mancha.ancho, ref],
        class: "sports ball",
        score: 0,
        origen: "movimiento"
      }];
    }
  }

  // 6. Actualizar la memoria para la foto siguiente.
  if (balones.length > 0) {
    const b = balones[0];
    const nuevo = { x: b.bbox[0] + b.bbox[2] / 2, y: b.bbox[1] + b.bbox[3] / 2, foto: memoria.numeroFoto };
    const a = memoria.centro;
    if (a && ref && nuevo.foto - a.foto <= 3 &&
        Math.hypot(nuevo.x - a.x, nuevo.y - a.y) / (nuevo.foto - a.foto) > umbralMovimiento(ref)) {
      memoria.tiroEmpezado = true;
    }
    memoria.centroAnterior = memoria.centro;
    memoria.centro = nuevo;
    if (b.origen !== "movimiento") {
      memoria.altos.push(b.bbox[3]);
      if (memoria.altos.length > 15) memoria.altos.shift();
    }
    memoria.cuenta[b.origen]++;
  } else {
    memoria.cuenta.nada++;
  }
  memoria.numeroFoto++;
  return balones;
};
