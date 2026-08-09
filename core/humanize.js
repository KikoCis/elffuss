// Human-readable phrase for a tool call ("leyendo app.js…"). Shared by the CEO
// brain (ceo.js) and by the live chat streaming — so the user is never shown
// raw JSON, and always the same wording. Covers the tool names of Elffuss Code
// (code.*, terminal.*) and Elffuss Claw (fs.*, app.*, web.*, skill.*, memory.*,
// tasks.*) — an unknown tool falls back to a generic "name argument" without
// breaking anything.
// NOTE: the returned strings are user-facing product copy and stay in Spanish.
export function humanizeTool(name, args) {
  const p = args?.path, q = args?.query, c = args?.command, n = args?.name;
  switch (name) {
    case 'code.read': case 'fs.read': return `leyendo ${p}…`;
    case 'code.write': case 'fs.write': return `escribiendo ${p}…`;
    case 'code.tree': return `explorando ${p || 'el proyecto'}…`;
    case 'fs.list': return `explorando ${p || 'la carpeta'}…`;
    case 'code.search': return `buscando «${q}»…`;
    case 'fs.pick_folder': return 'pidiendo acceso a una carpeta…';
    case 'fs.copy': return `copiando ${args?.pattern || 'archivos'}…`;
    case 'fs.watch': return `vigilando ${args?.from || 'una carpeta'}…`;
    case 'terminal.run': return `ejecutando: ${c}`;
    case 'app.create': return `creando la app «${n}»…`;
    case 'app.open': return `abriendo la app «${n}»…`;
    case 'skill.create': return `creando la skill «${n}»…`;
    case 'memory.save': return `recordando: ${args?.fact}…`;
    case 'tasks.add': return 'programando una tarea…';
    case 'web.search': return `buscando en internet «${q}»…`;
    case 'web.images': return `buscando imágenes de «${q}»…`;
    case 'web.fetch': return `leyendo ${p || args?.url}…`;
    default: return name + (p || q || c || n ? ' ' + (p || q || c || n) : '');
  }
}

// Detects whether the buffer arriving IN STREAM has entered a tool-call block
// (```tool { … }) and, if so, returns a human phrase instead of the raw JSON —
// "preparando una acción…" until the tool name is legible, then "leyendo
// app.js…" as soon as the field shows up, even if the JSON has not closed yet.
export function humanizeStreamPreview(buf) {
  if (buf.search(/```/) === -1 && !/^\s*\{\s*"tool"/.test(buf)) return null;
  const toolM = buf.match(/"tool"\s*:\s*"([\w.]+)"/);
  if (!toolM) return 'preparando una acción…';
  const pathM = buf.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const queryM = buf.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const cmdM = buf.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const nameM = buf.match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const out = humanizeTool(toolM[1], { path: pathM?.[1], query: queryM?.[1], command: cmdM?.[1], name: nameM?.[1] });
  // the tool name is already visible but its field (path/query/…) has not
  // arrived yet: better the generic one than a half-streamed "leyendo undefined…"
  return /undefined/.test(out) ? 'preparando una acción…' : out;
}
