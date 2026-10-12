# autoharness

Diseño. Estado: propuesta, sin código. Rutas relativas: `core/` es este repo; `code/` y `claw/` son elffuss-code y elffuss-claw; `engine/` es el motor (repo aparte); `improve/` es elffuss-improve.

## 1. Qué es y qué problema resuelve

El arnés es lo que rodea al modelo: prompt de sistema, catálogo de herramientas, parsers, validadores, skills y límite de pasos. autoharness lo convierte en un dato con hash que se endurece con los errores reales del usuario, en código y no en prompt, y que solo cambia para un modelo si gana en banco al arnés actual de ese modelo. Todo en el dispositivo.

Con E2B/E4B a ~4096 de contexto, Qwen3.5-0.8B y un 27B de prefill lento, cada token del sistema se paga en cada turno y cada reintento es otro prefill. Elffuss ya lo ha resuelto a mano donde más dolía:

- Gramática cerrada del copiloto: vocabulario (`claw/web/js/copilot-grammar.js:22`), validador por ranura (:38-42), anclaje en la transcripción (:51-59), `parse` con `rejected[]` (:86-132), respaldo determinista (:144-160), prompt y validador de una misma fuente (:164-168).
- Extractores que mandan sobre el modelo (`claw/web/js/kernel.js:899-956`).
- Guardias de Code: truncado (`code/web/js/tools/code.js:218-225`), sintaxis (:289-307), `quitaNumerosDeLinea` (:271).
- Decisiones medidas a mano: router apagado porque E4B empata (42→44) y Qwen 0.8B cae (29→23) (`claw/web/js/agent.js:104-121`); recorte de ejemplos apagado (:38); compacto por declaración del proveedor (`claw/web/js/agent.js:313-314`, `code/web/js/agent.js:310`).

Lo que falta:

- Registro de trayectorias: el historial es `{role, content, ts}` con tope de 80 (`code/web/js/conversations.js:22,87`) y no guarda `exhausted` ni `error`.
- Presupuesto de skills: entran todas y enteras, hasta 12.000 caracteres cada una (`claw/web/js/skills.js:11,175-191`, `code/web/js/skills.js:159-170`), y Code dice a la vez que no existen (`code/web/js/agent.js:49`).
- Verificación: el modo Objetivo da una tarea por hecha si usó herramientas sin error (`code/web/js/goal.js:124-146`).
- Fidelidad al proveedor: los envoltorios `{chat}` pierden `prefiereCompacto` y `setSampling` (`ceo.js:178` en las dos apps, `code/tests/swe_bench.mjs:65`, `code/web/js/lab.js:353`).
- Límites del CEO: todas las herramientas, el «no modifiques» solo en el prompt (`ceo.js:199-202`) y `Promise.all` sobre un único modelo (`ceo.js:203`) sin el cerrojo de inferencia (`code/web/js/conversations.js:180-212`).
- Estabilidad del prefijo: Code mete `CONTEXTO AHORA`, con la hora, también en el compacto (`code/web/js/agent.js:56-59`, `code/web/js/tools/index.js:39`), y el motor asume que el compacto no cambia entre turnos para reutilizar prefijo (`engine/js/provider.js:664-670`). No verificado en ejecución; E0 (§5) lo detectaría.

## 2. Las tres piezas y cómo encajan

| pieza | canal | coste en contexto | origen |
|---|---|---|---|
| Guardas | la llamada y su `[resultado …]` | cero | release, oráculos observados, specs aprendidas |
| Lecciones | el mensaje de usuario del turno | ≤ presupuesto | el usuario; después, minado |
| Compuerta | ninguno: elige el spec campeón | cero | bancos |

**Guardas (validadores sintetizados).** La idea de AutoHarness (DeepMind): la validez sale del modelo y pasa a código. Tres verbos, del más barato al más caro: `reparar` (corrige sin volver al modelo), `enumerar` (3-5 opciones legales para elegir por índice) y `bloquear` (por el canal `ERROR` existente, `code/web/js/agent.js:336-341`). Cada bloqueo es un paso y un prefill más. Actúan en ejecución, así que funcionan aunque LiteRT congele el sistema (`claw/web/js/providers/litert.js:187-199`) y no tocan el prefijo del motor.

- Solo endurecen, en orden fijo: permisos → fábrica → aprendidas. Una aprendida no desactiva una de fábrica ni salta un permiso.
- Una intervención por paso; si la misma guarda bloquea dos veces la misma firma, deja pasar y lo anota, para no agotar `MAX_STEPS`.
- En el dispositivo solo hay specs declarativas, sin `eval`, sobre una biblioteca cerrada de formas (`ruta-proyecto`, `email`, `telefono`, `fecha-iso`, `anclado`, `html-cerrado`…) que empieza portando `VALIDADOR` y `anclado` de copilot-grammar. El JS de una guarda solo llega con la release.
- Oráculos observados: cada `code.run` que termina bien deja `{path, expr, valor}`; tras editar ese fichero se reejecutan hasta 3 en el Worker de `code.run` (`code/web/js/tools/code.js:616-634`). Si uno que pasaba ahora lanza, el resultado lleva un AVISO; un cambio de valor solo se anota, porque puede ser el arreglo pedido. Cero llamadas al modelo.
- Guarda de fábrica `ceo`: el ciclo autónomo solo lee (bloquea `fs.write`, `code.write/edit`, `terminal.run`, `web.*`, `vault.get`, `skill.*`, `memory.forget`).

**Lecciones (skills aprendidas).** SKILL.md con `CUANDO` ≤ 90 caracteres y `HAZ` ≤ 3 líneas (≤ 60 tokens). Van antepuestas al mensaje de usuario del turno, no al sistema: LiteRT envía los mensajes de usuario nuevos (`claw/web/js/providers/litert.js:201-203`) y el motor los añade tras el prefijo. Recuperación BM25 con el esquema de `crearRouter` (`claw/web/js/tool-router.js:119-156`): como mucho 2 por turno, dentro de `clamp(0,05·ctx, 60, 300)` tokens, y **si hay duda no se inyecta nada**. Un validador determinista es el único camino de escritura: herramientas que existen, identificadores anclados en la evidencia (como `anclado` y la cita obligatoria de `juryReview`, `code/web/js/rlm.js:223-235`), sin rutas absolutas, URLs ni secretos. Solo se aprende de señales del usuario, nombres de herramientas, claves de argumentos y la primera línea de un `ERROR`; nunca de ficheros o páginas, que sería una inyección persistente. Las skills instaladas pasan por el mismo índice: una línea estable por skill en el sistema y el cuerpo, recortado, en el turno cuando encaja. Lo que se pueda expresar como guarda va como guarda.

**Compuerta campeón/candidato por modelo.** El arnés es un spec con hash. El campeón 0 de cada modelo es el comportamiento actual byte a byte: instalar el módulo no cambia nada. Todo cambio (activar una guarda, pasar las skills a índice, el umbral del router, `maxSteps`) es un candidato que solo entra si gana al campeón de ese modelo (§5). Lo que gana en E4B no se hereda a otro modelo.

Las tres comparten una traza y una función pura `perfil(provider)` que unifica las dos lógicas de `compacto` y normaliza el contexto con `contextTokens?.() ?? ctxTokens ?? 0` (LiteRT expone `ctxTokens` como variable, `claw/web/js/providers/litert.js:66`).

```
turno → perfil → lección → chat → parse → guarda.antes → runTool → guarda.despues → traza
                                                                                      │
campeón(app, modelo, perfil) ← compuerta E0-E3 ← candidatos ← traza, release, Improve ┘
```

## 3. Dónde vive y formatos

Fuente en `core/`, Apache-2.0, sin build: `autoharness.js` (init, perfil, ganchos, traza, libro), `ah-guardas.js`, `ah-lecciones.js` y `ah-compuerta.js`. No importan `agent.js`, `db.js`, `tools/` ni `engine/`; todo se inyecta como en `workspace.init` (`core/workspace.js:27`):

```js
ah.init({ app, kv: { get, set }, herramientas: () => toolHelp(), proyecto: () => ({ id, stack }),
          isBusy, lock, provider: () => prov })
```

El único import es `./acer-core.js` (`estimateTokens`, `terms`, `buildBM25`; `code/web/js/acer-core.js:1340-1347`), que hay que subir antes a `core/`. Del modelo solo se leen los ganchos del proveedor; nunca un import estático de `engine/registro.js`.

**Distribución.** `sync-core.sh:9` copia una lista fija y hoy pisaría `context.js`, `embed.js`, `humanize.js` y `skills.js` de las apps con versiones viejas: que acepte una lista de ficheros y sincronice solo `autoharness.js` y `ah-*.js` hasta reconciliar core. `deploy.sh` solo versiona los `src` de `index.html` (`code/deploy.sh:42`); los imports anidados también tienen que llevar versión. Enganche: tres líneas en `Agent.handle` (`code/web/js/agent.js:300-343`, `claw/web/js/agent.js:284-351`).

**Almacenamiento.** Estado canónico en IndexedDB, store `kv`, prefijo `autoharness:`, sin subir `VERSION` (`code/web/js/db.js:2-3`). No en OPFS: en iOS no hay `createWritable` en el hilo principal (`code/web/js/runtime/opfs-worker.js:1-11`) y Lab borra la raíz de OPFS, modelos incluidos (`code/web/js/lab.js:287-290`). OPFS solo para `autoharness/banco/`, y `limpiarOPFS` pasa a tocar solo esa carpeta. Exportar y borrar van con la carpeta de trabajo, añadiendo entradas al manifiesto (`claw/web/js/kernel.js:658-672`) en `.elffuss/autoharness/`.

```jsonc
// autoharness:guardas
{ "id":"code.edit/ruta-existe", "entorno":"tool:code.edit", "verbo":"enumerar",
  "origen":"fabrica|oraculo|aprendida", "estado":"sombra|activa|archivada",
  "spec":{"requiere":["path","search"],"forma":{"path":"ruta-proyecto"}},
  "mensaje":"No existe {path}. Opciones: {opciones}", "hash":"sha256:…",
  "stats":{"oport":0,"reparaciones":0,"bloqueos":0,"aciertos":0,"falsosBloqueos":0} }

// autoharness:lecciones — vista reconstruible desde el libro; se exporta como SKILL.md
{ "id":"l12", "ambito":"proyecto:<hash>", "cuando":"Cuando renombres un export",
  "haz":"code.search del nombre; code.edit en cada uso", "estado":"propuesta|activa|fijada|archivada",
  "evidencia":["t4812"], "stats":{"oport":0,"mostrada":0,"seguida":0,"noSirvio":0} }

// autoharness:tr:<segmento> — anillo de 1000 turnos en segmentos de 50
{ "n":4812, "app":"code", "proy":"<hash>", "modelo":"litert:gemma-e4b", "specHash":"…",
  "pet":"≤300 car., redactada", "llamadas":[{"tool":"code.edit","claves":["path","search"],
  "ok":false,"familia":"no-encontrado","guarda":"reparada"}], "fin":"texto|exhausted|error",
  "pasos":4, "lecciones":["l12"], "senal":{"correccion":false,"noSirvio":false} }

// autoharness:libro:<seq> — solo añadir, encadenado con crypto.subtle
{ "seq":57, "prev":"sha256:…", "tipo":"crear|activar|archivar|olvidar|promover|revertir",
  "objeto":"guarda|leccion|campeon", "id":"…", "modelo":"…", "motivo":"…",
  "evidencia":["t4812"], "origen":"fabrica|oraculo|usuario|modelo:gemma-e4b|improve" }

// spec del arnés; specHash = sha256(JCS(spec))
{ "v":1, "app":"claw", "modelo":"onnx:qwen3.5-0.8b", "prompt":{"ejemplos":"todos"},
  "herramientas":{"router":"off","umbral":1.0}, "skills":{"modo":"todas|indice","topeTok":0},
  "guardas":["…"], "lecciones":"off|on", "maxSteps":6 }

// autoharness:campeon:<app>/<modelo>/<perfilHash>
{ "specHash":"…", "nivel":"defecto|firmado|local", "anterior":"…", "informe":"<hash>" }
```

La traza no guarda duraciones, contenido de ficheros ni resultados de herramientas; la redacción quita claves, correos y rutas absolutas, y el vault no entra. «Olvidar» deja una lápida en el libro y borra la evidencia. Con varias pestañas, se escribe bajo Web Lock.

## 4. Cuándo corre y qué ve el usuario

| disparador | qué | modelo |
|---|---|---|
| cada turno | perfil, lección, guardas, traza | ninguno |
| tras `code.run` / `code.edit` | registrar y reejecutar oráculos (≤ 3) | ninguno, Worker |
| al abrir la app | ciclo de vida (sin daemon), E0 de los campeones de la release | ninguno |
| «Guardar como lección», «Revisar guardas» | proponer lecciones o specs desde la traza | plantilla; E4B opcional |
| «Medir ahora» | E1-E3 de un candidato | el ya cargado |
| ocio (opt-in, apagado) | lo mismo, con presupuesto | el ya cargado |

**Modelo.** E2B y Qwen 0.8B no reflexionan: plantillas deterministas rellenadas desde la evidencia, como `fallbackAdvice`, que el usuario edita. E4B rellena una plantilla rígida (entrada ≤ 900 tokens, salida ≤ 120, temperatura 0); si no valida, plantilla determinista, sin reintento. El 27B, solo E0 y acción explícita. `ext:*`, solo con botón y enseñando antes el texto exacto que sale. Autocrítica libre, nunca: `code/web/js/rlm.js:558-561` documenta que a este tamaño empeora.

**Coste.** Nunca carga ni descarga un modelo para medir. Toma el cerrojo de inferencia, un caso cada vez, con el proveedor real y no `{chat}`, abortable con `signal` ante cualquier actividad y con punto de control por caso. Con LiteRT no hay trabajo de modelo en segundo plano: una llamada ajena recrea la conversación (`claw/web/js/providers/litert.js:40,187-199`) y el siguiente turno del usuario paga el prefill entero. El ocio tiene presupuesto diario en llamadas, no en tiempo: 30 para E2B/E4B/0.8B y 0 para el 27B; en móvil no existe. Corte anticipado: en `ruta` al cerrarse el primer bloque de herramienta, en `swe` al pasar el test. Los resultados del campeón se cachean por `(specHash, bancoHash, modelo, versión)`.

**Control del usuario.**

- Ajustes → «Arnés»: Guardas, Lecciones y Campeón por modelo, con estado, origen, contadores y enlace a los turnos de evidencia. Acciones: activar, sombra, archivar, restaurar, editar, olvidar y exportar (SKILL.md o JSON, sin evidencia).
- Bajo la respuesta, un chip cuando algo intervino («guarda: ruta corregida», «lección usada: X») con «no me sirvió» o «esto estaba bien»; lo segundo anula el bloqueo y cuenta como falso bloqueo.
- Resumen de la última revisión: qué entró, qué se rechazó y por qué.
- `elffuss.autoharness = off | sombra | on` (por defecto `sombra`) y un interruptor por pieza, leídos en try/catch.
- Nada pasa por `telemetry.js`.

## 5. Métricas y puertas

Solo cuentas y razones: aciertos, pasos, llamadas inválidas, tokens de prompt. Nunca tiempos ni hardware.

| banco | fuente | modelo | criterio |
|---|---|---|---|
| `dorado` | `systemPrompt` con spec0 | no | 0 diferencias en E2B, E4B, 0.8B y 27B |
| `arnes` | solver de guion (`code/tests/swe_bench.mjs:44-56`) | no | 11/11 |
| `guardas` | guion y mutaciones: clave ausente, ruta inexistente, `search` con números de línea, `write` que trunca, `edit` que rompe la sintaxis | no | 0 falsos bloqueos; 100 % de malas atrapadas o reparadas |
| `lecciones` | 40 lecciones × 120 consultas (paráfrasis ES/EN, faltas, charla) | no | recall@2 ≥ 0,9; charla con lección ≤ 5 %; nunca sobre el presupuesto |
| `litert-contexto` | `claw/tests/litert-contexto.mjs` ampliado | falso | la lección de los turnos 2 y 5 llega sin recrear la conversación |
| `swe` | `code/web/js/swe-tasks.js`, 11 tareas | sí | pareado por tarea |
| `ruta` | `claw/tests/enrutado-herramientas*.cases.json` (61 y 60 a ciegas) | sí | pareado por caso |
| `regresion` | fallos ya arreglados en tus sesiones | sí | privado, nunca se exporta |

**Prerrequisitos**, o la compuerta mide falso: `solution` para las 5 tareas SWE que no la tienen (`swe_bench.mjs:50,119` no llega a N/N); que el envoltorio de Lab reenvíe `setSampling` y `prefiereCompacto` (`lab.js:353`); la misma pista en Lab (`code.edit`, `lab.js:333`) y en `swe_bench` (`code.write`, `swe_bench.mjs:67`), llevada al spec; verificar en Worker con límite y no con `import` en el hilo principal (`lab.js:307-313`); traza por tarea sin `secs` (`lab.js:338`).

**Etapas.**

- **E0, estática, sin modelo**: esquema; que el sistema quepa en `ctx − reserva` con el tokenizador del proveedor o `estimateTokens`; sistema estable entre turnos si `prefiereCompacto`; que el proveedor admita la variante (router con LiteRT: `enrutaHerramientas() === false`, `claw/web/js/providers/litert.js:38`); `dorado` y `arnes`.
- **Doctor**: el campeón corre dos veces 5 casos a temperatura 0; si difieren, el banco es inestable para ese modelo y solo valen comparaciones con 3 semillas, donde haya `setSampling` (ONNX no lo tiene).
- **E1, cribado**: los casos que el campeón falla más 3 centinelas que acierta. Fuera si pierde un centinela o no gana ninguno.
- **E2, pareado**: cada caso es G, P o E; `n = G + P`.
- **E3, holdout**: el banco ciego y las 5 tareas SWE difíciles, nunca usados para elegir.

**Decisión, en enteros:**

- PROMOVER: `G − P ≥ 2`, `10 · Σ_{k≥G} C(n,k) ≤ 2^n` (binomial exacta, p ≤ 0,10), 0 pérdidas en `regresion`, holdout sin pérdida neta.
- EMPATE BARATO: `P ≤ G`, 0 pérdidas en `regresion`, `100 · tokCand ≤ 85 · tokCamp`.
- RECHAZAR: `P > G` o cualquier pérdida en `regresion`.
- INCONCLUSO: lo demás; se amplía una vez y, si sigue, se descarta.

Cordura: el router en Qwen 0.8B (29→23) da RECHAZAR, y en E4B/LiteRT cae en E0 sin gastar una llamada. Un cambio cada vez: un segundo ganador vuelve a pasar contra el nuevo campeón.

**Puertas por pieza.**

- Guarda aprendida: `sombra` durante 20 oportunidades; `activa` con 0 falsos bloqueos y ≥ 1 acierto en el tercio apartado. Un falso bloqueo la devuelve a sombra; dos, la archivan. Tope de 40 activas por app, contando las que están en prueba.
- Lección: `activa` solo con el clic del usuario, y `lecciones:on` pasa la compuerta por modelo en `swe` y `ruta`. Se archiva con 2 «no me sirvió» o sin oportunidades en 300 turnos de su ámbito. Tope de 40 por proyecto y 20 globales, contando las de prueba.
- Campeón adoptado: si en 50 turnos reales sus `tool_error + exhausted` superan a los del anterior en más de 5, se revierte.

## 6. Relación con Improve

- Los cambios de arnés llegan como propuestas `MEJORA` (`improve/core/tipos.mjs:24`): un spec y, si hace falta, guardas de fábrica. El hash usa `canonicalizar` (`improve/core/jcs.mjs:111`), el mismo en navegador, sandbox y firma.
- El sandbox corre E0 y los bancos sin modelo (`InformeValidacion`, `tipos.mjs:155`). Los workers corren E1-E3 con el modelo objetivo y el `bancoHash` fijado, y firman `Veredicto` (`tipos.mjs:110`), que aprueba solo con PROMOVER o EMPATE BARATO; sin el modelo, `Declino` (`tipos.mjs:122`). Para sortear workers que corran el 27B, `Latido.capacidades` (`tipos.mjs:108`) tiene que declarar modelos: pendiente.
- `InformeBanco = {specHash, campeonHash, bancoHash, modelo, runtime, casos:[{id, r, salidaHash}], G, P, E, tokRatio1000}`, sin tiempos ni hardware. Canarios (`improve/ESPEC.md:105`) para detectar a quien firma sin correr el banco; holdout rotativo que revalida lo ya fusionado.
- La síntesis con modelo fuerte (refinar guardas contra la señal de error hasta 0 falsos bloqueos) ocurre aquí, sobre bancos públicos, nunca sobre datos de usuarios. Lo fusionado llega con la release como campeón `firmado` y se adopta tras pasar E0 en local.
- Del usuario hacia Improve: una guarda o lección aprendida solo se comparte con consentimiento explícito, elemento a elemento, enseñando el texto exacto, sin evidencia y repasada por el validador. `regresion` y la traza nunca salen.

## 7. Primer entregable y hoja de ruta

**Entregable 0: guardas en sombra en Code.**

- `autoharness.js` (init, perfil, traza, libro) y `ah-guardas.js`.
- Guardas de fábrica de esquema para las 9 herramientas de `code/web/js/tools/index.js:12-22`: claves obligatorias, tipos, `path` existente en `read/edit/run` con `enumerar` sobre el árbol, y `search` sin números de línea como `reparar`.
- Oráculos observados de `code.run`, solo aviso.
- Modo `sombra` por defecto: evalúa y anota, no actúa.
- Tests `dorado`, `arnes` y `guardas` en Node, y los prerrequisitos de Lab.

Medida:

1. Sin modelo: `guardas` con 0 falsos bloqueos y 100 % de malas atrapadas o reparadas; un oráculo sembrado detecta una edición rota; `dorado` sin diferencias; `arnes` 11/11.
2. Con modelo: Lab SWE, 11 tareas × 3 semillas × {E4B, Qwen 0.8B en pasada voraz}, `sombra` frente a `on`, pareado por tarea. Pasa si ninguna tarea empeora, los falsos bloqueos en sombra son 0 y baja la tasa de llamadas inválidas por tarea.
3. Aislamiento: 0 peticiones de red nuevas (PerformanceObserver de recursos) y 0 escrituras fuera de `kv autoharness:*`.

Si pasa, `on` por defecto en Code para esos dos modelos; si no, sigue en sombra con el informe del porqué.

**Hoja de ruta.**

1. **Compuerta y Claw.** `ah-compuerta.js` con E0-E3, doctor y libro; campeón 0 por modelo; banco `ruta` con el modelo cargado. Guardas de fábrica para Claw (`claw/web/js/tools/index.js:13-41`: `app.open` existente, `tasks.add` con fecha válida, HTML cerrado) y la guarda `ceo`. Antes, reconciliar core con las apps.
2. **Lecciones.** «Guardar como lección», importación de SKILL.md por el validador, índice con presupuesto para las skills instaladas, inyección en el turno; solo en los modelos que pasen la compuerta, empezando por E4B. Las ranuras del copiloto pasan a guardas, lo que da efecto a la auto-edición que hoy no lo tiene (`claw/web/js/kernel.js:764` frente a `:965-975`).
3. **Síntesis e Improve.** Minado con ≥ 3 observaciones: specs de guarda en sombra y lecciones propuestas con la plantilla de E4B. Propuestas `MEJORA` con `InformeBanco`, workers y canarios; campeón del 27B medido por workers.

## 8. Riesgos y qué no hacer

De los proyectos externos:

- No «capturar con generosidad» con un reflector débil (tigerless): llena la biblioteca de ruido. Aquí, ≥ 3 observaciones o clic del usuario; y nada de reflectores que necesitan ventanas grandes.
- No dejar fuera del tope lo que está en prueba ni lo leído y no usado (el fallo del ciclo de vida de tigerless).
- No fiar la seguridad a regex: las guardas solo endurecen y una lección no concede herramientas ni permisos.
- No decidir con una pasada y `≥` (neosigma deja pasar empates), ni usar el mismo conjunto como puerta y como cifra publicada.
- No apilar mejoras sin volver a pasar la puerta: kayba midió −26 % al combinar dos que ganaban por separado.
- No dar por bueno un ahorro de tokens sin el tokenizador real (softwaresalt).
- En tareas abiertas la legalidad es parcial (límite que declara DeepMind): sombra obligatoria y oráculos que avisan, no bloquean.

De Elffuss:

- No correr en segundo plano por defecto: batería, calor y temporizadores frenados en pestañas ocultas.
- No envolver el proveedor como `{chat}`, ni lanzar llamadas en paralelo sobre el único modelo, ni tocar la conversación de LiteRT a mitad de chat.
- No meter nada que cambie por turno en el sistema de un modelo `prefiereCompacto`.
- No ejecutar en el dispositivo JS sintetizado por el modelo: que la CSP de un iframe `srcdoc` sin same-origin corte toda la red en Safari de iOS no está verificado en este entorno.
- No reutilizar la arena de Lab con `allow-same-origin` (`code/web/lab.html:94`) ni borrar la raíz de OPFS.
- No ejecutar `sync-core.sh` completo mientras core y apps diverjan.
- Riesgo residual: con bancos tan pequeños casi todo saldrá INCONCLUSO. La respuesta es ampliar los bancos en cada versión, no relajar la puerta.
