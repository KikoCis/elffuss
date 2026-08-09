# ✳ Elffuss — core

Núcleo compartido de la familia **Elffuss**: un runtime de agente que vive
**entero en el navegador**, sin build ni backend obligatorio. Los productos que
lo usan:

- **[Elffuss Claw](https://elffuss-claw.utopiaia.com)** — un SO web agéntico: el
  chat es la interfaz, las apps se crean como HTML al vuelo.
- **[Elffuss Code](https://elffuss-code.utopiaia.com)** — un IDE web tipo VS Code
  con la elfa de agente de código.

## Qué hay en el core (`core/`)

ES modules vanilla, sin dependencias, sin build:

| Módulo | Qué hace |
|---|---|
| `context.js` | **Selección de contexto por relevancia** frente a la pregunta viva: BM25 real (saturación + normalización por longitud) con **IDF endógena** —sin lista de parada, funciona en cualquier idioma—, granularidad de línea, control de redundancia y presupuesto de tokens garantizado. Las perillas salen de la presión de compresión medida, no de constantes. Opcionalmente fusiona una segunda opinión semántica por rangos. Medido: recall de hechos **15,1 % → 65,3 %** con el mismo gasto. |
| `skills.js` | **Skills de Claude Code**: instala SKILL.md desde `anthropics/skills`, `claude-plugins-official` o cualquier repo público; se inyectan al system prompt. |
| `md.js` | Renderizador de markdown seguro (escape total) para el chat, estilo plugin de Claude Code. |
| `splash-gl.js` | Galaxia de partículas WebGL (GL_POINTS + blending aditivo, todo en el vertex shader) para las pantallas de bienvenida. |
| `providers/api.js` | Proveedor genérico para APIs externas: OpenAI-compatible (OpenAI, Ollama, llama.cpp) y Anthropic Messages, con streaming SSE y llamadas directas desde el navegador. |

## Filosofía

- **Todo en el navegador.** Los modelos corren en local (WebGPU vía transformers.js
  / LiteRT-LM); los proveedores externos son opt-in y sus claves nunca salen del
  navegador del usuario.
- **Sin build.** ES modules que se sirven tal cual. Clonar y abrir.

## Uso

Los productos **vendorizan** el core en `web/js/` (mismos nombres de archivo) y
lo sincronizan con su `sync-core.sh`. Así cada repo es autocontenido y se puede
clonar y abrir sin instalar nada.

## Licencia

Apache License 2.0 — ver [LICENSE](LICENSE).

## Cómo se mide el gestor de contexto

No se elige por intuición. Todo a **igual presupuesto de tokens**.

**Sesiones reales de agente** — 25 sesiones sobre proyectos reales, 174 sondas, recuerdo de hechos, sin juez LLM:

| | recuerdo |
|---|---|
| truncar por la cola | 7,0 % |
| versión anterior | 15,1 % |
| **esta** | **65,3 % ± 8,5** |

Y con el presupuesto barrido, porque una sola cifra engaña:

| contexto ÷ presupuesto | truncar | versión anterior | esta |
|---|---|---|---|
| 15,8× *(agobio)* | 8,2 % | 13,2 % | **70,7 %** |
| 5,9× | 15,7 % | 13,2 % | **73,2 %** |
| 3,0× | 31,8 % | 13,2 % | **83,6 %** |
| 1,5× *(casi cabe)* | 72,5 % | 13,2 % | **94,6 %** |

La columna del medio no es un error: la versión anterior recuperaba **lo mismo con diez veces más sitio**, porque tiraba material antes de puntuarlo.

**Memoria a largo plazo** — 200 preguntas, F1 del propio repo del banco, modelo real respondiendo, ~8 % del contexto:

| | F1 |
|---|---|
| **el contexto COMPLETO, sin comprimir** | **22,56** |
| truncar por la cola | 6,62 |
| heurísticas escritas a mano | 6,07 |
| BM25 sin IDF | 20,34 |
| BM25 | 23,59 |
| embeddings | 23,95 |
| **fusión por rangos** | **28,09** |

**Recuperar bien bate a tenerlo todo**: 28,09 contra 22,56 con el 8 % de los tokens. Lo irrelevante no es lastre neutro, distrae.

### Lo que se midió y no se supuso
- Activar las heurísticas costaba **−3,02 F1**. No es que no aportaran: restaban.
- Quitar la IDF cuesta **−3,25 F1**. La rareza endógena hace trabajo real, y sustituye a cualquier lista de parada escrita a mano — en cualquier idioma.
- Lo semántico **no sustituye** al léxico, le cubre el punto ciego: sin solape de vocabulario entre pregunta y respuesta ganan los embeddings (24,28 vs 18,60); con solape gana BM25 (29,33 vs 23,58); la fusión se queda con los dos.
- El encargo original pasa de perderse **siempre** a conservarse **siempre** con una reserva de cabecera del 5 %.
- Contenido obsoleto: sin control de caducidad, la versión **falsa** de un fichero editado sobrevivía **8/8**; con él, **0/8**.

### Referencias
BM25 — Robertson, Walker, Jones, Hancock-Beaulieu & Gatford, *Okapi at TREC-3*, 1994; formulación moderna en Robertson & Zaragoza, FnTIR 3(4), 2009 · IDF — Spärck Jones, *Journal of Documentation* 28(1), 1972 · RRF — Cormack, Clarke & Buettcher, SIGIR 2009 · MMR — Carbonell & Goldstein, SIGIR 1998 · sumideros de atención — Xiao, Tian, Chen, Han & Lewis, ICLR 2024 · tiempo de validez — Snodgrass & Ahn, SIGMOD 1985.

**Estos números son reproducibles con una orden**, sobre el propio código de este repositorio:

```bash
node bench/run.mjs --root core --ext .js --seeds 8
```

El banco está en [`bench/`](bench/) y no usa ningún modelo para juzgar — es una comprobación de presencia determinista. El porqué de esa decisión, y la condición `tail` que hay que batir, están explicados ahí.

La historia completa, incluido lo que salió mal: **<https://bitacora.utopiaia.com/posts/16-beaten-by-doing-nothing.html>**
