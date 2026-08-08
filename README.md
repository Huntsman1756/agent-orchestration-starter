# Agent Orchestration Starter

Plantilla y compilador para reservar un modelo *frontier* a planificación y revisión, y delegar la implementación acotada a un modelo económico. La política estable habla de roles y capacidades; proveedores y modelos viven en perfiles reemplazables.

## Qué genera

- Codex: `.codex/config.toml` y agentes en `.codex/agents/`.
- OpenCode: agentes en `.opencode/agents/` con modelo y permisos explícitos.
- Hermes: distribución en `hermes-profile/`, con padre *frontier* y modelo delegado económico.
- Todos: `AGENTS.md`, manifiesto resuelto e inventario SHA-256 de archivos gestionados.

El orquestador y el revisor son de solo lectura. El ejecutor es el único rol con escritura. Los fallos de autenticación, política, salida inválida, *grounding* o validación cierran el flujo; solo una indisponibilidad tipada permite recurrir a otro modelo.

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
  --harnesses codex,opencode,hermes
```

Antes de escribir, se puede inspeccionar el resultado con `--dry-run`. Para detectar deriva:

```powershell
node dist/cli/main.js check --target G:\_Proyectos\mi-proyecto --policy orchestration.yaml --profile profiles/chatgpt-subscription.yaml
node dist/cli/main.js doctor --harnesses codex,opencode,hermes
```

La CLI no escribe credenciales ni configuración global. La autenticación se hace en cada herramienta. El perfil de suscripción incluido es una fotografía fechada: cuando cambien los modelos o identificadores, se sustituye el perfil, no la política ni los contratos.

## Cambiar de proveedor

Copia `profiles/open-compatible.yaml`, cambia los tres modelos y declara las capacidades reales. `provider` es la identidad lógica. Si una herramienta usa otro identificador, añade un alias sin alterar el contrato:

```yaml
provider: openai
harnessProviders:
  hermes: openai-codex
```

El ejecutor debe ser explícitamente `economy`; nunca hereda el modelo del orquestador. El revisor no puede reutilizar la combinación proveedor/modelo del ejecutor. Hermes v1 requiere que orquestador y revisor sean el mismo padre *frontier*, porque su delegación no representa un tercer agente independiente.

## Actualizaciones seguras

`init` y `render` son idempotentes. Un archivo existente no gestionado produce conflicto. Un archivo gestionado pero modificado localmente también queda intacto. Para aceptar la sustitución de un único archivo, usa `--force ruta/relativa/exacta`; no existe un borrado o sobrescritura global silenciosa.

El contrato de trabajo de ejemplo está en `examples/work-contract.yaml`. Incluye objetivo, archivos permitidos, entradas, restricciones, validación, criterios de éxito, presupuesto y formato de respuesta; el ejecutor no necesita recibir toda la conversación.

## Límites conocidos

Hermes hereda la superficie de herramientas del padre a los hijos, así que no puede imponer simultáneamente padre de solo lectura e hijo con escritura. El adaptador lo documenta en `PERMISSION_BOUNDARY.md`; usa un *worktree*, revisión Git y validaciones deterministas como límites duros.

## Diseño e investigación

- `docs/plans/2026-08-08-provider-agnostic-orchestration-design.md`
- `docs/research/architecture-review.md`

Licencia MIT.
