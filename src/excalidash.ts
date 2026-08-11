export type ExcaliDashConfig = {
  url: string;
  token: string;
  drawingId?: string;
};

export type DrawingSummary = {
  id: string;
  name: string;
  engine: "excalidraw" | "tldraw";
  collectionId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DrawingList = {
  drawings: DrawingSummary[];
  totalCount: number;
  limit: number;
  offset: number;
};

export type Fetch = typeof globalThis.fetch;

export class ExcaliDashError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ExcaliDashError";
  }
}

const apiBase = (url: string): string => {
  const base = url.trim().replace(/\/+$/, "");
  if (!base) throw new Error("EXCALIDASH_URL is required");
  return base.endsWith("/api") ? base : `${base}/api`;
};

export const configFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): ExcaliDashConfig => {
  const url = env.EXCALIDASH_URL?.trim();
  const token =
    env.EXCALIDASH_API_KEY?.trim() || env.EXCALIDASH_TOKEN?.trim();
  const drawingId = env.EXCALIDASH_DRAWING_ID?.trim() || undefined;

  if (!url) throw new Error("EXCALIDASH_URL is required");
  if (!token) {
    throw new Error(
      "EXCALIDASH_API_KEY is required (EXCALIDASH_TOKEN is accepted for compatibility)",
    );
  }

  return { url, token, drawingId };
};

export class ExcaliDashClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: ExcaliDashConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.baseUrl = apiBase(config.url);
  }

  listDrawings(options: {
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<DrawingList> {
    const query = new URLSearchParams({
      limit: String(options.limit ?? 50),
      offset: String(options.offset ?? 0),
    });
    if (options.search) query.set("search", options.search);
    return this.request(`drawings?${query}`);
  }

  createDrawing(name: string): Promise<DrawingSummary> {
    return this.request("drawings", {
      method: "POST",
      body: JSON.stringify({
        name,
        engine: "excalidraw",
        elements: [],
        appState: {},
        files: {},
      }),
    });
  }
  getDrawing(drawingId: string): Promise<DrawingSummary> {
    return this.request(`drawings/${encodeURIComponent(drawingId)}`);
  }

  getSummary(drawingId: string): Promise<string> {
    return this.request(
      `drawings/${encodeURIComponent(drawingId)}/summary`,
      { responseType: "text" },
    );
  }

  inspectElement(drawingId: string, elementId: string): Promise<unknown> {
    return this.request(
      `drawings/${encodeURIComponent(drawingId)}/elements/${encodeURIComponent(elementId)}`,
    );
  }

  applyOps(
    drawingId: string,
    ops: unknown[],
    clientBatchId?: string,
  ): Promise<unknown> {
    return this.request(`drawings/${encodeURIComponent(drawingId)}/ops`, {
      method: "POST",
      body: JSON.stringify({ ops, ...(clientBatchId ? { clientBatchId } : {}) }),
    });
  }

  private async request<T = unknown>(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: string;
      responseType?: "json" | "text";
    } = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept:
          options.responseType === "text" ? "text/plain" : "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2000);
      throw new ExcaliDashError(
        `ExcaliDash request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }

    if (options.responseType === "text") return (await response.text()) as T;
    return (await response.json()) as T;
  }
}
