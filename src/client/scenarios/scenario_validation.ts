import path from 'node:path';

export type StepKeyInput = {
  id?: string;
  name?: string;
  tool: string;
};

export type ScenarioSummary = {
  name?: string;
  description?: string;
  path?: string;
  snapshot_path?: string;
};

export function resolveStepKey(step: StepKeyInput, index: number): string {
  return step.id ?? step.name ?? `${step.tool}-${index + 1}`;
}

export function validateScenario(scenario: { transport?: string; steps?: unknown[]; command?: string; url?: string }): void {
  if (!scenario.transport) {
    throw new Error('Scenario is missing transport configuration.');
  }
  if (!scenario.steps || scenario.steps.length === 0) {
    throw new Error('Scenario must include at least one step.');
  }
  if (scenario.transport === 'stdio') {
    if (!scenario.command) {
      throw new Error('Scenario missing command for stdio transport.');
    }
  } else if (!scenario.url) {
    throw new Error('Scenario missing URL for HTTP transport.');
  }
}

export function resolveSnapshotPath(
  scenario: { snapshot_path?: string },
  scenarioPath?: string,
): string | undefined {
  if (scenario.snapshot_path) {
    if (scenarioPath) {
      return path.resolve(path.dirname(scenarioPath), scenario.snapshot_path);
    }
    return scenario.snapshot_path;
  }
  if (scenarioPath) {
    return `${scenarioPath}.snapshots.json`;
  }
  return undefined;
}

export function usesSnapshots(scenario: { steps: Array<{ snapshot?: boolean | string }> }): boolean {
  return scenario.steps.some((step) => Boolean(step.snapshot));
}

export function buildScenarioSummary(
  scenario: { name?: string; description?: string },
  scenarioPath?: string,
  snapshotPath?: string,
): ScenarioSummary {
  return {
    ...(scenario.name !== undefined ? { name: scenario.name } : {}),
    ...(scenario.description !== undefined ? { description: scenario.description } : {}),
    ...(scenarioPath !== undefined ? { path: scenarioPath } : {}),
    ...(snapshotPath !== undefined ? { snapshot_path: snapshotPath } : {}),
  };
}
