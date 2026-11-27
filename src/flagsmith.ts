// Small client for the Flagsmith Admin API (only the calls FlagOps needs).

export type FlagValue = string | number | boolean | null;

export interface Project {
  id: number;
  name: string;
}

export interface Environment {
  id: number;
  name: string;
  api_key: string;
  project: number;
}

export interface Feature {
  id: number;
  name: string;
  is_archived: boolean;
  tags?: number[];
  created_date?: string;
}

export interface FeatureState {
  id: number;
  feature: number;
  enabled: boolean;
  feature_state_value: FlagValue;
  identity: number | null;
  feature_segment: number | null;
  updated_at?: string;
}

export interface Tag {
  id: number;
  label: string;
}

// What a server-side environment key (ser....) can read: one environment's flags.
// Read-only: the Admin API rejects these keys, so plan and drift can run without the admin key.
export interface EnvironmentDocument {
  id: number;
  name: string;
  api_key: string;
  project: { id: number; name: string };
  feature_states: {
    django_id: number;
    feature: { id: number; name: string };
    enabled: boolean;
    feature_state_value: FlagValue;
    feature_segment: unknown;
  }[];
}

// A Flagsmith that never answers should fail the run, not hang it.
const TIMEOUT_MS = 30_000;

export async function readEnvironmentDocument(apiUrl: string, serverKey: string): Promise<EnvironmentDocument> {
  const res = await fetch(`${apiUrl}/environment-document/`, {
    headers: { "X-Environment-Key": serverKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Flagsmith rejected an environment key starting "${serverKey.slice(0, 8)}". Use a server-side key (starts with "ser."): Environment settings -> SDK Keys.`,
    );
  }
  if (!res.ok) throw new Error(`Flagsmith GET ${apiUrl}/environment-document/ failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as EnvironmentDocument;
}

interface Page<T> {
  next: string | null;
  results: T[];
}

export class FlagsmithClient {
  constructor(
    private apiUrl: string,
    private adminKey: string,
  ) {}

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...init,
      headers: {
        Authorization: `Api-Key ${this.adminKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`Flagsmith ${init.method ?? "GET"} ${url} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  // Follows "next" links so we get every item, not just the first page.
  private async getAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = this.apiUrl + path;
    while (url) {
      const page: Page<T> = await this.request<Page<T>>(url);
      items.push(...page.results);
      url = page.next;
    }
    return items;
  }

  async listProjects(): Promise<Project[]> {
    // This endpoint returns a plain list, not pages.
    return this.request<Project[]>(`${this.apiUrl}/projects/`);
  }

  listEnvironments(projectId: number): Promise<Environment[]> {
    return this.getAll<Environment>(`/environments/?project=${projectId}`);
  }

  listFeatures(projectId: number): Promise<Feature[]> {
    return this.getAll<Feature>(`/projects/${projectId}/features/`);
  }

  listTags(projectId: number): Promise<Tag[]> {
    return this.getAll<Tag>(`/projects/${projectId}/tags/`);
  }

  // Only the environment-wide state of each flag: no segment or identity overrides.
  async listEnvironmentStates(envApiKey: string): Promise<FeatureState[]> {
    const states = await this.getAll<FeatureState>(`/environments/${envApiKey}/featurestates/`);
    return states.filter((s) => s.identity === null && s.feature_segment === null);
  }

  // Creates the flag in every environment of the project, switched off with no value.
  createFeature(projectId: number, name: string): Promise<Feature> {
    return this.request<Feature>(`${this.apiUrl}/projects/${projectId}/features/`, {
      method: "POST",
      body: JSON.stringify({ name, default_enabled: false, initial_value: null }),
    });
  }

  async findEnvironmentState(envApiKey: string, featureId: number): Promise<FeatureState | undefined> {
    const states = await this.getAll<FeatureState>(`/environments/${envApiKey}/featurestates/?feature=${featureId}`);
    return states.find((s) => s.feature === featureId && s.identity === null && s.feature_segment === null);
  }

  updateState(envApiKey: string, stateId: number, change: { enabled?: boolean; feature_state_value?: FlagValue }) {
    return this.request(`${this.apiUrl}/environments/${envApiKey}/featurestates/${stateId}/`, {
      method: "PATCH",
      body: JSON.stringify(change),
    });
  }
}
