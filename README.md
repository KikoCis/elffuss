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
| `context.js` | **ACE-lite**: gestión de contexto por relevancia (BM25-lite + IDF) con presupuesto de tokens y tope por mensaje. Evita el «Too many tokens». |
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
