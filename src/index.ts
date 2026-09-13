/**
 * agentctl public library surface.
 *
 * Prefer importing from `agentctl` (or `agentctl/api`) in Node/pi/Hermes integrations.
 * Use `--format json` on the CLI when shelling out instead of parsing human text.
 */

export {
  agentAsk,
  agentRoute,
  agentDelegate,
  agentOrchestrate,
  agentHealth,
  agentStatus,
} from './api.js';

export type {
  AskOptions,
  AskCommandResult,
  RouteOptions,
  RouteCommandResult,
  DelegateOptions,
  OrchestrateOptions,
  OrchestrateCommandResult,
  AgentsHealthResult,
  StatusResult,
  AskResult,
  RouteDecision,
  OrchestrationResult,
  StepOutcome,
  AgentStatus,
} from './api.js';

export {
  loadRegistry,
  askOne,
  askAll,
  runOrchestrateGoal,
  createOrchestrateDeps,
  resolveSession,
  collectStatus,
  fanoutTargets,
} from './commands.js';

export type { RegistryOptions, IO, ResolvedSession, RunOrchestrateGoalOpts } from './commands.js';

export { route, suggestModel, suggestRouteEffort, classifyCostPerformance } from './core/router.js';
export type { RouterAgent, RankedAgent, CostPerformanceTier } from './core/router.js';

export { AdapterRegistry } from './adapters/registry.js';
export type { AgentAdapter } from './adapters/protocol.js';

export { agentctlHome } from './core/agentHome.js';
export { buildProgram } from './cli.js';

export { buildJsonEnvelope, emitJson, stripAnsi } from './format/output.js';
export type { OutputFormat, JsonEnvelope } from './format/output.js';

export * from './schema/index.js';
