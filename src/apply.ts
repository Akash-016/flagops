// Make the planned changes in Flagsmith.

import { archiveConflicts, safe } from "./diff.js";
import type { FlagsmithClient } from "./flagsmith.js";
import type { PlannedEnvironment } from "./state.js";

export interface ApplyResult {
  applied: string[];
  failed?: { what: string; error: string };
}

export async function applyPlans(
  fs: FlagsmithClient,
  projectId: number,
  plans: PlannedEnvironment[],
): Promise<ApplyResult> {
  // A flag archived on one side only: Git and Flagsmith disagree about which flags are live,
  // so change nothing until a person settles it.
  const conflicts = archiveConflicts(plans);
  if (conflicts.length > 0) throw new Error(conflicts.join("\n"));

  const applied: string[] = [];
  // A new flag is created once for the whole project, even if several environment files list it.
  const created = new Map<string, number>();

  for (const plan of plans) {
    for (const change of plan.changes) {
      if (change.kind !== "update" && change.kind !== "create") continue; // only reported, never applied
      const what = `${safe(plan.environment)}: ${change.kind === "create" ? "+" : "~"} ${safe(change.flag)}`;
      try {
        let stateId: number;
        if (change.kind === "update") {
          stateId = change.stateId;
        } else {
          let featureId = created.get(change.flag);
          if (featureId === undefined) {
            featureId = (await fs.createFeature(projectId, change.flag)).id;
            created.set(change.flag, featureId);
          }
          const state = await fs.findEnvironmentState(plan.env.api_key, featureId);
          if (!state) throw new Error("flag was created but has no state in this environment");
          stateId = state.id;
        }
        await fs.updateState(plan.env.api_key, stateId, {
          enabled: change.after.enabled,
          feature_state_value: change.after.value,
        });
        applied.push(what);
      } catch (err) {
        // Stop at the first failure so the person can see exactly what did and didn't happen.
        return { applied, failed: { what, error: (err as Error).message } };
      }
    }
  }
  return { applied };
}
