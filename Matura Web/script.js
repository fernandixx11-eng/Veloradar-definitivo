console.log(cocoSsd);

const botoninicio = document.getElementById("BotonStart");

const botonfinal = document.getElementById("BotonEnd");
botonfinal.style.display = "none";

const video = document.getElementById("video");

const golito = document.getElementById("Gol");
golito.style.display = "none";

let deteccion = null;
const cargar = async () => {
  deteccion = await cocoSsd.load({base: "mobilenet_v2"});
  console.log("Ya esta cargado");
  alert("Ya esta cargado");
};
cargar();

let buffer = [];
let metrosxpixel = 0

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d",{willReadFrequently: true});

const lafoto = (now) => {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video,0,0);
  const foto = ctx.getImageData(0,0,canvas.width,canvas.height);
  video.requestVideoFrameCallback(lafoto);
    if (buffer.length >= 150) {
          buffer.shift();
        }
      buffer.push({foto: foto, time: now});
      console.log("Fotos:" + buffer.length);
};

botoninicio.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: "environment" }}});  //AI
    video.srcObject = stream;                                                                                     //IA
    botoninicio.style.display = "none";
    botonfinal.style.display = "block";
    golito.style.display = "block";
    video.requestVideoFrameCallback(lafoto);
    console.log("Segundo:" + buffer.length);
  } catch (err) {
    console.error("Error al abrir la cámara", err);
  }
});

botonfinal.addEventListener("click", async () => {
  try {
    video.srcObject.getTracks().forEach(track => track.stop()); //Corrección con AI
    video.srcObject = null;                                     //Corrección con AI
    botoninicio.style.display = "block";
    botonfinal.style.display = "none";
    golito.style.display = "none";
    buffer = [];
  } catch (err) {
    console.error("Error al cerrar la cámara", err);
  };
});

golito.addEventListener("click", async () => {
  try{
    alert("Empieza")
    golito.disabled = true
    const copiadelbuffer = buffer.slice()
    let datosdelbalon = [];
    async function elección_del_primero_y_el_ultimo(datosdelbalon) {
      for(let i = 0; i < copiadelbuffer.length; i++) {
        const  detectando = await detectarBalon(deteccion, copiadelbuffer[i].foto, 0.1, 0.5, 1);
        if(detectando.length > 1) {
        datosdelbalon.push({time: copiadelbuffer[i].time, x: detectando[0].bbox[0], ancho: detectando[0].bbox[2], alto: detectando[0].bbox[3]});
      } else{
        datosdelbalon.push(null);
      }};

      let balonanterior = null;
      let balonesenmov = []
      let umbral = 3
      for(let i = 0; i < datosdelbalon.length; i++){
        if (datosdelbalon[i] !== null){
          let balonenanalisis = datosdelbalon[i].x + datosdelbalon[i].ancho/2
          if (balonanterior !== null) {
            let diferencia = Math.abs(balonenanalisis - balonanterior)
            if(diferencia > umbral){
              balonesenmov.push(datosdelbalon[i]);
            }
            balonanterior = balonenanalisis
          } else {
            balonanterior = balonenanalisis
          };
        };
      };
      return balonesenmov
    };
    const balonesenmov = await elección_del_primero_y_el_ultimo(datosdelbalon);

    if(balonesenmov.length > 0) {
      let altos = 0
      for (let i = 0; i < balonesenmov.length; i++) {
        let altura = balonesenmov[i].alto;
        altos += altura
      }
      const alturamed = altos/balonesenmov.length
      metrosxpixel = 0.22/alturamed;
      function calculo_de_la_distancia(metrosxpixel) {
            const ballmed1 = balonesenmov[0].x + balonesenmov[0].ancho/2;
            const ballmed2 = balonesenmov[balonesenmov.length - 1].x + balonesenmov[balonesenmov.length - 1].ancho/2;
            const distanciaenpixeles = ballmed1 - ballmed2
            const distanciatotal = Math.abs(distanciaenpixeles) * metrosxpixel;
            return distanciatotal
          };
          const distanciatotal = calculo_de_la_distancia(metrosxpixel);

          function calculo_del_tiempo() {
            const tiempo = (balonesenmov[balonesenmov.length - 1].time - balonesenmov[0].time)/1000
            return tiempo
          };
          const tiempo = calculo_del_tiempo();

          function mediciondevelocidad(distanciatotal,tiempo) {
            const velocidad = distanciatotal/tiempo;
            return velocidad
          };
          const velocidad = mediciondevelocidad(distanciatotal,tiempo)
          if (velocidad > 6) {
          const velocidadkxh = velocidad * 3.6
          alert("El tiro va a:"+ velocidadkxh.toFixed(1) +" km/h");
          } else {
            alert("Eso parece un pase, dale más fuerte");
          };
        } else {
          alert("¡No se ha movido el balón!");
        };
    buffer = []
    golito.disabled = false
  } catch (err) {
    console.error("No hay acceso al video", err);
    alert("algo anda mal")
    golito.disabled = false
  };
});