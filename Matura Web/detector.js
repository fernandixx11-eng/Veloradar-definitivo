// detector.js — Sustituye a deteccion.detect() para buscar SOLO el balón.
//
// Lo ha escrito Claude (tutor) a petición de Fernando. Es la parte final de
// COCO-SSD 2.2.3 (tfjs-models/coco-ssd/src/index.ts, licencia Apache 2.0),
// copiada y cambiada en dos puntos:
//
//  1. COCO-SSD se queda solo con la clase más alta de cada caja. Aquí se lee
//     directamente la puntuación de "sports ball" de cada caja, así que un
//     "frisbee" o un "toothbrush" ya no le pueden robar la caja al balón.
//  2. COCO-SSD usa el mismo número como puntuación mínima y como umbral de
//     solapamiento, y compara cajas de cualquier clase. Aquí los dos umbrales
//     van por separado y solo se comparan balones con balones, así que la
//     caja de una persona ya no puede borrar la del balón.
//
// La librería no se toca: este archivo usa el modelo que ya carga cocoSsd.load().

// "sports ball" es la clase 37 de COCO. El modelo empieza a contar en 0,
// así que su puntuación está en la posición 36 de cada caja.
const POSICION_BALON = 36;

// modelo: lo que devuelve cocoSsd.load()
// imagen: una foto (ImageData), un canvas o el vídeo
// puntuacionMinima: de 0 a 1. Por debajo, la caja no cuenta como balón
// solapamientoMaximo: de 0 a 1. Si dos cajas de balón se solapan más, se borra la de menos puntuación
// maxBalones: cuántas cajas de balón como mucho
const detectarBalon = async (modelo, imagen, puntuacionMinima, solapamientoMaximo, maxBalones) => {
  // 1. La foto se convierte en un tensor: una tabla de números [1, alto, ancho, 3]
  //    (3 = rojo, verde y azul de cada píxel). Es lo mismo que hace detect() por dentro.
  const entrada = tf.tidy(() => tf.expandDims(tf.browser.fromPixels(imagen)));
  const alto = entrada.shape[1];
  const ancho = entrada.shape[2];

  // 2. La red neuronal analiza la foto y devuelve dos tensores:
  //    - resultado[0], puntuaciones [1, numCajas, 90]: para cada caja, una puntuación por cada clase
  //    - resultado[1], cajas [1, numCajas, 1, 4]: para cada caja, [arriba, izquierda, abajo, derecha] de 0 a 1
  const resultado = await modelo.model.executeAsync(entrada);
  const numCajas = resultado[0].shape[1];
  const numClases = resultado[0].shape[2];
  const puntuaciones = resultado[0].dataSync(); // lista plana: caja 0 (90 números), caja 1 (90 números)...
  const cajas = resultado[1].dataSync();         // lista plana: caja 0 (4 números), caja 1 (4 números)...
  entrada.dispose();
  tf.dispose(resultado);

  // 3. De cada caja nos quedamos SOLO con su puntuación de balón.
  //    La puntuación de la clase c de la caja i está en la posición i * numClases + c.
  const puntuacionesBalon = [];
  for (let i = 0; i < numCajas; i++) {
    puntuacionesBalon.push(puntuaciones[i * numClases + POSICION_BALON]);
  }

  // 4. Limpieza de cajas solapadas (non-max suppression), solo entre balones
  //    y con los dos umbrales separados.
  const tensorCajas = tf.tensor2d(cajas, [numCajas, 4]);
  const tensorPuntuaciones = tf.tensor1d(puntuacionesBalon);
  const tensorIndices = await tf.image.nonMaxSuppressionAsync(
    tensorCajas, tensorPuntuaciones, maxBalones, solapamientoMaximo, puntuacionMinima);
  const indices = tensorIndices.dataSync();
  tf.dispose([tensorCajas, tensorPuntuaciones, tensorIndices]);

  // 5. Se devuelve lo mismo que daba detect(): una lista de {bbox, class, score},
  //    con la bbox en píxeles [x, y, ancho, alto] y la de más puntuación primero.
  const balones = [];
  for (const i of indices) {
    const arriba = cajas[i * 4] * alto;
    const izquierda = cajas[i * 4 + 1] * ancho;
    const abajo = cajas[i * 4 + 2] * alto;
    const derecha = cajas[i * 4 + 3] * ancho;
    balones.push({
      bbox: [izquierda, arriba, derecha - izquierda, abajo - arriba],
      class: "sports ball",
      score: puntuacionesBalon[i]
    });
  }
  return balones;
};
