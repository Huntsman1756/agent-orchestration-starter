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

La ruta mixta no es universal. `routing-gate.yaml` exige al menos 30 observaciones estratificadas y compara coste por tarea finalmente aceptada, aceptación al primer intento, escalado y defectos posteriores contra `frontier_execution`.

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

Cada línea JSONL representa el coste total de una tarea intentada por una ruta. Si economy falla y frontier la rescata, `firstPassAccepted` sigue siendo `false`, `escalated` es `true` y `totalCostUsd` incluye ambas fases.

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
