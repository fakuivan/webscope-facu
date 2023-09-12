# Osciloscopio web

Este repositorio contiene prototipos y experimentos para realizar el graficado
y la transmisión en modo de osciloscopio. Los archivos más significativos son los
siguientes:

* [`main.py`](./backend/main.py): Señalización WebRTC y empaquetado
* [`DoscPlot.tsx`](./src/DoscPlot.tsx): Renderizado con WebGL
* [`webrtc_connection.ts`](./src/webrtc_connection.ts): Establecimiento de la conexión WebRTC y canales de datos
* [`scope_frame.ts`](./src/scope_frame.ts): Empaquetado, desempaquetado
y corrección de transmisión fuera de orden de paquetes
* [`App.tsx`](./src/App.tsx): Prototipado con las partes mencionadas

Para correr el servidor HTTP primero se debe compilar la webapp, esto se
puede realizar con la tarea de visual studio code "npm: build".

En un desarrollo futuro sería recomendable utilizar otra librería más
activa que aiortc, en el desarrollo del proyecto se descubrió este
[problema](https://github.com/aiortc/aiortc/issues/913), que sigue abierto al
día de esta redacción. Preferentemente utilizar JavaScript/TypeScript con Bun
o algún lenguaje compilado como Go, Rust o C++ para obtener los datos del
microcontrolador por UDP y hacer broadcast a todos los dispositivos
conectados por WebRTC.
