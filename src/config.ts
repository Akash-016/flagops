import { config as loadEnv } from "dotenv";

// Look for .env in the current folder first, then one level up.
loadEnv({ path: [".env", "../.env"], quiet: true });

export interface Config {
  apiUrl: string;
  adminKey: string;
}

export function getApiUrl(): string {
  return (process.env.FLAGSMITH_API_URL || "http://localhost:8000/api/v1").replace(/\/+$/, "");
}

export function getConfig(): Config {
  const adminKey = process.env.FLAGSMITH_ADMIN_KEY;
  if (!adminKey) {
    throw new Error(
      "FLAGSMITH_ADMIN_KEY is not set. Put it in a .env file or your environment.",
    );
  }
  return { apiUrl: getApiUrl(), adminKey };
}

// Server-side environment keys (one per environment), separated by spaces, commas or new lines.
// When set, plan and drift read flags with these instead of the admin key.
export function getEnvironmentKeys(): string[] {
  return (process.env.FLAGSMITH_ENVIRONMENT_KEYS ?? "").split(/[\s,]+/).filter(Boolean);
}
