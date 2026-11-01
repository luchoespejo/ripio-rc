# Ripio RC

Juego de rally arcade en el navegador: autos que derrapan sobre ripio, etapas armadas a partir de caminos reales de tierra (OpenStreetMap) y circuitos conocidos. Hecho con Three.js, Rapier (física) y Vite + TypeScript. Funciona en PC y en celular (controles táctiles).

> Es un proyecto en construcción, hecho a ojo y a pura prueba. Cualquier mejora es bienvenida.

## Probarlo

```bash
npm install
npm run dev        # http://localhost:5173
```

Elegir una pista: `http://localhost:5173/?track=<id>`  
Etapas de rally: `minaclavero`, `carlospaz`, `sma`. Circuitos: los CSV de `src/trackdata/` (por ejemplo `monza`, `spa`).  
`?arcade=0` apaga la ayuda arcade y deja la física más cruda.

Para jugar desde el celular, abrí la IP de tu PC en la red local (`npm run dev -- --host`).

## Controles

| | Teclado | Celular |
|---|---|---|
| Gas / freno | `W` `S` | gas automático, botón FRENO |
| Dirección | `A` `D` | deslizar el dedo |
| Freno de mano | `Espacio` | botón MANO |
| Volver a la largada | `R` | — |
| Cámara | `C` (seguir / piloto) | botón |
| Repetición | `T` | botón |

## Cómo está armado

```
src/
  main.ts       bucle principal, lógica de pista, guardarraíl
  vehicle.ts    física del auto: neumáticos, suspensión y la capa arcade (derrape, asistencia a la ruta)
  world.ts      terreno, camino, árboles, rocas, colisiones
  tracks.ts     lectura de pistas (JSON de rally, CSV de circuitos)
  cam.ts        cámaras (seguir, piloto, repetición)
  fx.ts         huellas y polvo
  audio.ts      sonido (motor grabado + ruidos sintetizados)
  input.ts      teclado y táctil
  config.ts     parámetros de manejo y presets
tools/
  osm-stage.mjs   baja un camino de OpenStreetMap y lo convierte en etapa
  elev.mjs        arma el relieve a partir de mosaicos de elevación
  impostor.html   fotografía modelos 3D de árboles para usarlos como sprites
  slim-glb.mjs    reduce polígonos de un modelo glTF
```

Para sumar una etapa:

```bash
node tools/osm-stage.mjs --api --bbox SUR,OESTE,NORTE,ESTE --id <id> --name "<nombre>" --len 6000
```

Necesita conexión: baja datos de la API de OpenStreetMap y mosaicos de elevación.

## Ideas para contribuir

- Más etapas y pistas, y editor de pistas.
- Sonido: ripio, derrape, golpes (hoy son sintéticos).
- Daño en el auto, campeonato, fantasma de la mejor vuelta.
- Más realismo en el terreno y la vegetación; rendimiento en celulares.
- Tests y revisión de la física.

## Licencias

Código: MIT (`LICENSE`). Modelos, texturas, sonido y trazados de terceros: ver [`CREDITS.md`](CREDITS.md).
