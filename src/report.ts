export type ProbeStepStatus = 'ok' | 'error';

export type ProbeStep = {
  name: string;
  status: ProbeStepStatus;
  detail?: string;
  data?: unknown;
};

export type TraceEntry = {
  direction: 'client->server' | 'server->client';
  timestamp: string;
  message: unknown;
  method?: string;
  id?: string | number;
};

export type AuthDiscovery = {
  resource_metadata_url?: string;
  resource_metadata?: unknown;
  authorization_server?: string;
  oauth_metadata_url?: string;
  oauth_metadata?: unknown;
};

export type ProbeReport = {
  ok: boolean;
  started_at: string;
  finished_at: string;
  steps: ProbeStep[];
  auth?: AuthDiscovery;
  server_info?: unknown;
  capabilities?: unknown;
  tools?: unknown;
  resources?: unknown;
  prompts?: unknown;
  trace?: TraceEntry[];
};

export type ReplayProbeReport = {
  ok: boolean;
  started_at: string;
  finished_at: string;
  steps: ProbeStep[];
  session_id?: string;
  event_id?: string;
  last_event_id?: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export type ReportVerbosity = 'summary' | 'full';

function summarizeAuth(auth: AuthDiscovery | undefined): AuthDiscovery | undefined {
  if (!auth) return undefined;
  const summary: AuthDiscovery = {};
  if (auth.resource_metadata_url) {
    summary.resource_metadata_url = auth.resource_metadata_url;
  }
  if (auth.authorization_server) {
    summary.authorization_server = auth.authorization_server;
  }
  if (auth.oauth_metadata_url) {
    summary.oauth_metadata_url = auth.oauth_metadata_url;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

export function applyReportVerbosity(
  report: ProbeReport,
  verbosity?: ReportVerbosity,
): ProbeReport {
  if (verbosity === 'full') {
    return report;
  }
  const {
    tools: _tools,
    resources: _resources,
    prompts: _prompts,
    auth: _auth,
    trace: _trace,
    ...rest
  } = report;
  const authSummary = summarizeAuth(report.auth);
  return {
    ...rest,
    ...(authSummary ? { auth: authSummary } : {}),
  } as ProbeReport;
}
