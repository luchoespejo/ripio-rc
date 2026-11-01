# Créditos y licencias de terceros

El código de este repositorio es MIT (ver `LICENSE`). Lo siguiente **no** es de este proyecto y mantiene su licencia.

| Qué | Dónde | Autor / fuente | Licencia |
|---|---|---|---|
| Autos de rally (12 modelos) | `public/models/rally/` | jsa201077 | CC BY 4.0 (hay que mantener la atribución) |
| Texturas (ripio, asfalto, pasto), cielo HDRI | `public/tex/` | [Poly Haven](https://polyhaven.com) | CC0 |
| Rocas, arbustos, helechos, abetos 3D | `public/models/ph/` | Poly Haven (`fir_sapling`, `rock_09`, `rock_07`, `shrub_03`, `fern_02`) | CC0 |
| Sprites de árboles | `public/tex/trees/` | Generados desde modelos Poly Haven (`fir_sapling`, `pine_sapling_small`, `island_tree_01`, `tree_small_02`) con `tools/impostor.html` | CC0 |
| Sonido del motor | `public/sfx/engine.ogg` | "Car Engine Loop" de qubodup, [Freesound](https://freesound.org/people/qubodup/sounds/147242/) | CC BY 4.0 (hay que mantener la atribución) |
| Circuitos reales (CSV) | `src/trackdata/*.csv` | [TUMFTM/racetrack-database](https://github.com/TUMFTM/racetrack-database) | LGPL-3.0 |
| Etapas de rally (JSON) | `src/trackdata/*.json` | © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright), relieve de mosaicos Terrarium (AWS Open Data) | ODbL (la base de datos derivada hay que compartirla igual) |
| Three.js, Rapier, Vite | dependencias npm | — | MIT / Apache-2.0 |

## Pendiente de revisar
- Los autos de `public/models/rally/` traen decoraciones inspiradas en marcas reales. Antes de usar el juego con fines comerciales hay que revisarlas.
- Las muestras de motor las publica su autor bajo CC BY 4.0; si agregás sonidos nuevos, usá CC0 o CC BY y sumalos a esta tabla.
