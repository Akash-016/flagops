// Sets up a fresh self-hosted Flagsmith for the integration test in CI:
// signs up a user, creates an organisation, a project and an admin API key.
// Writes FLAGSMITH_ADMIN_KEY and FLAGSMITH_PROJECT to $GITHUB_ENV for later steps.
//
// Only for throwaway instances: it uses a fixed test password.

import { appendFile } from "node:fs/promises";

const base = process.env.FLAGSMITH_API_URL ?? "http://localhost:8000/api/v1";

async function call<T>(method: string, path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Token ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const password = "FlagOps-ci-Test-2026!";
const user = await call<{ key: string }>("POST", "/auth/users/", {
  email: "ci@example.com",
  password,
  re_password: password,
  first_name: "FlagOps",
  last_name: "CI",
});

const org = await call<{ id: number }>("POST", "/organisations/", { name: "FlagOps CI" }, user.key);
const project = await call<{ id: number }>("POST", "/projects/", { name: "FlagOps CI", organisation: org.id }, user.key);
const apiKey = await call<{ key: string }>(
  "POST",
  `/organisations/${org.id}/master-api-keys/`,
  { name: "flagops-ci", is_admin: true },
  user.key,
);

console.log(`::add-mask::${apiKey.key}`);
console.log(`Organisation ${org.id}, project ${project.id}, admin API key created.`);

const envFile = process.env.GITHUB_ENV;
if (envFile) {
  await appendFile(envFile, `FLAGSMITH_ADMIN_KEY=${apiKey.key}\nFLAGSMITH_PROJECT=${project.id}\n`);
}
