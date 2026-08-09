# Agent Orchestration Starter

Plantilla, compilador y evaluador offline para elegir entre ejecución económica, orquestación mixta y ejecución *frontier* según evidencia. La política estable habla de roles y capacidades; proveedores y modelos viven en perfiles reemplazables.

## Qué genera

- Codex: `.codex/config.toml` y agentes en `.codex/agents/`.
- OpenCode: agentes en `.opencode/agents/` con modelo y permisos explícitos.
- Hermes: distribución en `hermes-profile/`, con padre *frontier* y modelo delegado económico.
- Todos: `AGENTS.md`, manifiesto resuelto e inventario SHA-256 de archivos gestionados.

El orquestador y el revisor son de solo lectura. Los ejecutores economy/frontier son los únicos agentes con escritura. Los fallos de autenticación, política, salida inválida, *grounding* o validación cierran el flujo; solo una indisponibilidad tipada permite recurrir a otro modelo.

## Estrategias

- `economy_only`: cambio mecánico, modelo económico y validación determinista.
- `orchestrated`: planificación *frontier*, implementación económica, validación y revisión *frontier* con contexto limpio.
- `frontier_execution`: ejecutor *frontier* para trabajo transversal, debugging ambiguo, arquitectura, seguridad o migraciones delicadas.

La ruta mixta no es universal. `routing-gate.yaml` exige al menos 30 pares comparables por `taskClass × ruta candidata × frontier_execution` y calcula las métricas únicamente sobre la intersección exacta de `taskId + caseFingerprint`. Así, seis pares de una clase nunca se convierten en `n=30` sumando otras clases o tareas no comparables. Una ruta tampoco puede reducir la aceptación final frente al baseline (`maxFinalAcceptanceDropRate: 0`), aunque iguale la aceptación inicial y sea más barata.

## Inicio rápido

Requiere Node.js 20 o posterior.

```powershell
npm install
npm run validate
npm run build
node dist/cli/main.js init `
  --target G:\_Proyectos\mi-proyecto `
  --policy orchestration.yaml `
  --profile profiles/chatgpt-subscription.yaml `
  --harnesses codex,opencode,hermes `
  --accept-degraded-isolation hermes
```

Antes de escribir, se puede inspeccionar el resultado con `--dry-run`. Para detectar deriva:

```powershell
node dist/cli/main.js check --target G:\_Proyectos\mi-proyecto --policy orchestration.yaml --profile profiles/chatgpt-subscription.yaml
node dist/cli/main.js doctor --harnesses codex,opencode,hermes --policy orchestration.yaml --profile profiles/chatgpt-subscription.yaml --accept-degraded-isolation hermes
```

La CLI no escribe credenciales ni configuración global. La autenticación se hace en cada herramienta. El perfil de suscripción incluido es una fotografía fechada: cuando cambien los modelos o identificadores, se sustituye el perfil, no la política ni los contratos.

### Linux native broker helper

The V4 Unix broker is supported in production on Linux only. `npm run build` invokes `npm run build:native`, which compiles `native/linux/renameat2-helper.c` with the fixed compiler `/usr/bin/cc` and writes the architecture-specific helper plus its manifest under `dist/native/linux-<arch>/`. Linux runtime packages must be built or prepacked on the matching Linux architecture. Windows skips this native step; a package produced on Windows has no helper, is not deployable as a Linux broker package, and fails closed if used there. Other Unix platforms fail closed.

Build the release artifact on the target Linux architecture; never compile the helper at broker runtime. The installed JavaScript module, every helper-parent component, the helper, and its manifest must be root-owned or owned by the same trusted installation UID and must not be group/world writable; the helper must remain executable. The build writes modes `0555` and `0444`, while package tools may safely normalize the owner-write bits to `0755` and `0644`. A missing, symlinked, relocated, modified, incorrectly owned, untrusted-writable, or non-executable artifact makes backend construction fail before broker state or socket effects.

The helper accepts no arguments or environment configuration. Runtime executes the already-open, identity- and digest-verified helper through an inherited descriptor; the only other inherited capabilities are the proven state-directory and selected fixed quarantine-slot directory descriptors. Deployment must provide Linux `renameat2(..., RENAME_NOREPLACE)` support and `/proc/self/fd`. There is no pathname fallback. See `docs/runtime-broker-quarantine-remediation.md` for the offline-only retained-socket procedure.

## Cambiar de proveedor

Copia `profiles/open-compatible.yaml`, cambia los tres modelos y declara las capacidades reales. `provider` es la identidad lógica. Si una herramienta usa otro identificador, añade un alias sin alterar el contrato:

```yaml
provider: openai
harnessProviders:
  hermes: openai-codex
```

El ejecutor económico debe ser explícito; nunca hereda accidentalmente el modelo del orquestador. El compilador crea además un `frontier-executor` writable a partir de la asignación *frontier*. El revisor no puede reutilizar la combinación proveedor/modelo del ejecutor económico. Hermes requiere que orquestador y revisor sean el mismo padre *frontier*, porque su delegación no representa un tercer agente independiente.

## Actualizaciones seguras

`init` y `render` son idempotentes. Un archivo existente no gestionado produce conflicto. Un archivo gestionado pero modificado localmente también queda intacto. Para aceptar la sustitución de un único archivo, usa `--force ruta/relativa/exacta`; no existe un borrado o sobrescritura global silenciosa.

El contrato de trabajo está en `examples/work-contract.yaml`. La revisión recibe un sobre independiente como `examples/review-envelope.yaml`: contrato original, diff completo, resultados deterministas y archivos pedidos bajo demanda; nunca la argumentación del planner o executor.

## Benchmark y routing gate

Cada línea JSONL v2 representa el coste total de una tarea intentada por una ruta. Si economy falla y frontier la rescata, `firstPassAccepted` sigue siendo `false`, `escalated` es `true` y `totalCostUsd` incluye ambas fases.

El pairing exige la misma combinación `taskId + caseFingerprint`. Importa `computeCaseFingerprint` desde `agent-orchestration-starter/fingerprint` y pásale `{ workContract, baseSha, fixtures, policy }`; `baseSha` debe ser un SHA Git completo de 40 o 64 caracteres hexadecimales. El SHA-256 canónico cambia si cambia el contrato, la revisión base, cualquier fixture/input o la política relevante. Compartir `taskId` ya no basta para declarar dos runs comparables. `examples/case-fingerprint-input.json` produce el fingerprint utilizado por las observaciones de ejemplo.

Los defectos posteriores separan incidencia de detalle: `postAcceptanceDefective` indica si la tarea aceptada tuvo alguna incidencia, mientras `postAcceptanceDefects[]` conserva cada defecto con severidad `low`, `medium`, `high` o `critical`. El gate limita tanto la incidencia agregada (`maxPostAcceptanceDefectIncidenceRate`) como los recuentos absolutos de severidad alta y crítica; el informe conserva además la cantidad total y el desglose por severidad.

```powershell
node dist/cli/main.js benchmark `
  --observations examples/benchmark-observations.jsonl `
  --routing-policy routing-gate.yaml
```

El resultado JSON devuelve `promote`, `reject` o `insufficient_evidence` por clase de tarea y candidato. Es una recomendación determinista y portable; esta versión no invoca proveedores ni modifica el routing automáticamente.

## Límites conocidos

`writeIsolation` forma parte del contrato. Codex y OpenCode ofrecen `hard`; Hermes ofrece `degraded` porque hereda la superficie de herramientas del padre. Una política `hard` rechaza Hermes salvo aceptación exacta con `--accept-degraded-isolation hermes`. El manifiesto registra aislamiento requerido y efectivo.

## Diseño e investigación

- `docs/plans/2026-08-08-provider-agnostic-orchestration-design.md`
- `docs/plans/2026-08-08-evidence-based-routing-design.md`
- `docs/research/architecture-review.md`

Licencia MIT.
