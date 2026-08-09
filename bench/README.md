# Banco de recuerdo de hechos

Mide un empaquetador de contexto contestando a **una sola pregunta**, sin ningún modelo de por medio:

> El agente leyó una definición a mitad de sesión. Al final se la piden.
> **¿Sigue esa definición dentro del contexto empaquetado?**

## Por qué no hay un modelo juzgando

Porque un banco cuyo resultado depende de qué juez elijas **no sirve para decidir entre dos empaquetadores**.

Puntuando exactamente las mismas respuestas, con las mismas preguntas, tres jueces distintos nos dieron:

| juez | resultado |
|---|---|
| un modelo de razonamiento de 11 GB | **WRONG a todo** — razonaba bien, pero escribía en otro campo |
| un 7B con el prompt permisivo | **CORRECT a todo**, incluido *"enfermera"* contra la referencia *"maestra"* |
| el mismo 7B con el prompt endurecido | 8/8 en el control |

Los dos primeros no eran modelos malos: uno estaba razonando correctamente y el otro contestaba por inercia. **La diferencia entre el segundo y el tercero fue solo el prompt.** Un número que se mueve así no puede arbitrar una decisión de ingeniería.

Este banco no tiene ese problema: es una comprobación de presencia, determinista, y da el mismo resultado dos veces seguidas.

## Cómo se generan las sesiones

**No son sintéticas.** Se abre un proyecto real y se ejecutan herramientas de verdad sobre él —listar el árbol, leer ficheros paginados, buscar—, y cada resultado que entra en el historial es la salida auténtica de esa herramienta, con su formato real: sus miles de líneas de ruido, sus rutas, sus números de línea.

Eso importa porque el fallo que se busca solo aparece con material real. Un resultado de herramienta es mayoritariamente ruido con dos líneas útiles dentro; con texto sintético uniforme, cualquier empaquetador parece bueno.

Lo único guionizado es **qué herramienta llama el agente a continuación** —la parte que decidiría un modelo—, sacado de un generador con semilla para tener muchas sesiones distintas y poder reportar media entre semillas en vez de una tirada afortunada.

## Uso

```bash
node run.mjs --root <ruta-de-un-repo>
```

Opciones: `--ext .js` · `--budget 3000` · `--seeds 8` · `--packer <fichero.js>`

`--packer` debe exportar `packHistory(history, budgetTokens)`. Por defecto usa el core de este mismo repositorio, así que los números de abajo se reproducen sin configurar nada.

## Las tres condiciones

Todas reciben **el mismo presupuesto de tokens**. Lo único que cambia es la política de selección.

| | qué hace |
|---|---|
| `full` | el historial entero, sin comprimir — el techo, y no respeta el presupuesto |
| `tail` | los últimos mensajes hasta llenar el presupuesto, tirar el resto |
| `packer` | el empaquetador que se está midiendo |

**`tail` es el listón que hay que batir, y es el motivo de que este banco exista.** Cuatro generaciones de nuestro empaquetador se midieron cada una contra la anterior, todas ganando, y ninguna contra `tail`. Cuando por fin se puso, resultó que una de esas versiones **puntuaba por debajo**: comprimir con ella era peor que no comprimir. Si tu empaquetador no le gana a *"quédate lo último y tira el resto"*, nada más de lo que midas de él significa nada.

## Resultado sobre este mismo repositorio

```
node run.mjs --root ../core --ext .js --seeds 8
```

| presupuesto | `tail` | **`packer`** | `full` (techo) |
|---|---|---|---|
| 3.000 | 45,3 % | **92,2 %** · 2.073 tok | 100 % · 29.462 tok |
| 8.000 | 68,8 % | **95,3 %** · 5.253 tok | 100 % · 29.462 tok |

8 sesiones, 64 sondas. El corpus es el propio `core/` de este repositorio, así que cualquiera reproduce estas cifras clonando y ejecutando una orden.

## Qué NO mide

- **Que el modelo use bien lo que recibe.** Presencia es condición necesaria, no suficiente: tener la evidencia delante no garantiza acertar. Para eso hace falta un banco con un modelo respondiendo, con todos los problemas de arbitraje descritos arriba.
- **Preguntas cuya respuesta no está en ninguna línea.** *"¿Cuántos ficheros has tocado?"* está repartida en cuarenta mensajes y ninguna selección top-k la alcanza por construcción.
- **Conversación.** Está hecho sobre sesiones de agente con herramientas. Un empaquetador ajustado aquí puede perder en diálogo: nos pasó, y la causa resultó ser el partidor de palabras, no la política de empaquetado.

Apache-2.0, como el resto del repositorio.
