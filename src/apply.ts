// Make the planned changes in Flagsmith.

import { archiveConflicts, isAction, safe, type Change } from "./diff.js";
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
  let segmentIds: Map<string, number> | undefined;
  const featureIdOf = (plan: PlannedEnvironment, flag: string) => {
    const id = created.get(flag) ?? plan.featureIds.get(flag);
    if (id === undefined) throw new Error("flag not found in Flagsmith");
    return id;
  };

  for (const plan of plans) {
    const touched = new Set<string>(); // flags whose overrides changed here: check their order after
    for (const change of plan.changes) {
      if (!isAction(change)) continue; // only reported, never applied
      const what = `${safe(plan.environment)}: ${describeAction(change)}`;
      try {
        if (change.kind === "update" || change.kind === "create") {
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
        } else if (change.kind === "override") {
          const featureId = featureIdOf(plan, change.flag);
          if (!change.live) {
            segmentIds ??= new Map((await fs.listSegments(projectId)).map((s) => [s.name, s.id]));
            const segmentId = segmentIds.get(change.segment);
            if (segmentId === undefined) throw new Error(`segment "${change.segment}" not found`);
            await fs.createOverride(plan.env.api_key, featureId, segmentId, change.after!.enabled, change.after!.value);
          } else if (!change.after) {
            await fs.deleteOverride(change.live.featureSegmentId);
          } else {
            const o = { stateId: change.live.stateId, featureId, environmentId: plan.env.id, featureSegmentId: change.live.featureSegmentId };
            await fs.updateOverride(o, change.after.enabled, change.after.value);
          }
        }
        if (change.kind === "override" || change.kind === "order") touched.add(change.flag);
        if (change.kind !== "order") applied.push(what);
      } catch (err) {
        // Stop at the first failure so the person can see exactly what did and didn't happen.
        return { applied, failed: { what, error: (err as Error).message } };
      }
    }

    // New overrides go to the end of the list, so set the order YAML gives once the set is right.
    for (const flag of touched) {
      const wanted = plan.segmentOrder.get(flag) ?? [];
      const what = `${safe(plan.environment)}: ~ ${safe(flag)} segment order ${wanted.map(safe).join(", ")}`;
      try {
        const live = (await fs.listFeatureSegments(plan.env.id, featureIdOf(plan, flag))).sort((a, b) => a.priority - b.priority);
        if (live.map((l) => l.segment_name).join("\n") === wanted.join("\n")) continue;
        const ids = new Map(live.map((l) => [l.segment_name, l.id]));
        await fs.setPriorities(wanted.map((name, priority) => ({ id: ids.get(name)!, priority })));
        applied.push(what);
      } catch (err) {
        return { applied, failed: { what, error: (err as Error).message } };
      }
    }
  }
  return { applied };
}

function describeAction(c: Change): string {
  if (c.kind === "override") {
    const mark = c.before === null ? "+" : c.after === null ? "-" : "~";
    return `${mark} ${safe(c.flag)} [segment ${safe(c.segment)}]`;
  }
  return `${c.kind === "create" ? "+" : "~"} ${safe(c.flag)}`;
}
