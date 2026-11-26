// Fills a Flagsmith project with demo environments and sample flags for trying FlagOps.
// Safe to run more than once: it reuses what already exists and resets the sample flags.
// Flags it doesn't know about are left alone.
//
//   npm run seed      (uses FLAGSMITH_API_URL, FLAGSMITH_ADMIN_KEY, optional FLAGSMITH_PROJECT)

import { getConfig } from "../src/config.js";

type Value = string | number | boolean | null;
type Setting = [enabled: boolean, value: Value];

const ENVIRONMENTS = ["Development", "Staging", "Production"] as const;

// flag -> [Development, Staging, Production]
const FLAGS: Record<string, [Setting, Setting, Setting]> = {
  checkout_v2: [[true, "v2"], [true, "v2"], [false, null]],
  new_search: [[true, null], [false, null], [false, null]],
  banner_message: [[true, "Welcome (dev)"], [true, "Welcome"], [true, "Diwali sale: 20% off"]],
  max_cart_items: [[true, 50], [true, 10], [true, 10]],
  dark_mode: [[true, null], [true, null], [true, null]],
  legacy_payments: [[false, null], [false, null], [false, null]],
  maintenance_mode: [[false, null], [false, null], [false, null]],
};

const { apiUrl, adminKey } = getConfig();

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl + path, {
    method,
    headers: { Authorization: `Api-Key ${adminKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const list = async <T>(path: string): Promise<T[]> => {
  const data = await api<T[] | { results: T[] }>("GET", path);
  return Array.isArray(data) ? data : data.results;
};

// API keys can't create projects, and free organisations get only one, so we fill an
// existing project: FLAGSMITH_PROJECT (id or name), else the only project there is.
const projects = await list<{ id: number; name: string }>("/projects/");
const wanted = process.env.FLAGSMITH_PROJECT;
const project = wanted
  ? projects.find((p) => String(p.id) === wanted || p.name === wanted)
  : projects.length === 1
    ? projects[0]
    : undefined;
if (!project) {
  console.error(
    projects.length === 0
      ? "No project found. Create one in the Flagsmith dashboard, then run this again."
      : `Pick a project with FLAGSMITH_PROJECT. Available: ${projects.map((p) => `${p.id} (${p.name})`).join(", ")}`,
  );
  process.exit(1);
}
console.log(`Project "${project.name}" (id ${project.id})`);

const existingEnvs = await list<{ id: number; name: string; api_key: string }>(`/environments/?project=${project.id}`);
const envs = [];
for (const name of ENVIRONMENTS) {
  let env = existingEnvs.find((e) => e.name === name);
  if (!env) env = await api("POST", "/environments/", { name, project: project.id });
  envs.push(env!);
}
console.log(`Environments: ${envs.map((e) => e.name).join(", ")}`);

const existingFlags = await list<{ id: number; name: string }>(`/projects/${project.id}/features/?page_size=999`);
for (const [name, settings] of Object.entries(FLAGS)) {
  let flag = existingFlags.find((f) => f.name === name);
  if (!flag) flag = await api("POST", `/projects/${project.id}/features/`, { name, default_enabled: false });
  for (let i = 0; i < envs.length; i++) {
    const [enabled, value] = settings[i];
    const states = await list<{ id: number; identity: number | null; feature_segment: number | null }>(
      `/environments/${envs[i].api_key}/featurestates/?feature=${flag!.id}`,
    );
    const state = states.find((s) => s.identity === null && s.feature_segment === null);
    if (!state) throw new Error(`No state for ${name} in ${envs[i].name}`);
    await api("PATCH", `/environments/${envs[i].api_key}/featurestates/${state.id}/`, {
      enabled,
      feature_state_value: value,
    });
  }
  console.log(`  ${name}`);
}
console.log("Done. Try: flagops pull");
