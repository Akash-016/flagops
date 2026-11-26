import { config as loadEnv } from "dotenv";

// Look for .env in the current folder first, then one level up.
loadEnv({ path: [".env", "../.env"], quiet: true });

export interface Config {
  apiUrl: string;
  adminKey: string;
}

export function getConfig(): Config {
  const apiUrl = process.env.FLAGSMITH_API_URL ?? "http://localhost:8000/api/v1";
  const adminKey = process.env.FLAGSMITH_ADMIN_KEY;
  if (!adminKey) {
    throw new Error(
      "FLAGSMITH_ADMIN_KEY is not set. Put it in a .env file or your environment.",
    );
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ""), adminKey };
}
