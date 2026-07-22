import type { ProbeStep } from '../../report.js';
import { describeError } from './errors.js';
import { extractResourceMetadataUrl } from './auth.js';
import { fetchWithTimeout } from './probe_http.js';

const ACCEPT_STREAM = 'text/event-stream';

type StreamableSseOutcomeKind =
  | 'sse-compatible'
  | 'auth-required'
  | 'method-not-supported'
  | 'path-mismatch'
  | 'incompatible';

type StreamableSseCandidate = {
  url: string;
  status: number | null;
  reason: string;
  resourceMetadataUrl?: string;
  bodyPreview?: string;
  kind: StreamableSseOutcomeKind;
};

type StreamableSseProbeResult = {
  ok: boolean;
  steps: ProbeStep[];
};

function buildComparableVariants(url: string): string[] {
  const parsed = new URL(url);
  const path = parsed.pathname;

  if (!path || path === '/') {
    return [url];
  }

  const slashPath = path.endsWith('/') ? path : `${path}/`;
  const noSlashPath = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;

  const variants = new Set<string>([url]);

  const slashUrl = new URL(url);
  slashUrl.pathname = slashPath;
  variants.add(slashUrl.toString());

  if (noSlashPath !== path) {
    const noSlashUrl = new URL(url);
    noSlashUrl.pathname = noSlashPath;
    variants.add(noSlashUrl.toString());
  }

  return [...variants];
}

function parseBodyTextForSessionError(text: string): boolean {
  const normalized = text.toLowerCase();
  if (normalized.includes('missing session id')) {
    return true;
  }
  try {
    const value = JSON.parse(text) as unknown;
    return extractStrings(value).some((entry) => entry.includes('missing session id'));
  } catch {
    return false;
  }
}

function extractStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value.toLowerCase()];
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractStrings);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(extractStrings);
  }
  return [];
}

async function probeSseCandidate(url: string, timeoutMs: number): Promise<StreamableSseCandidate> {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          Accept: ACCEPT_STREAM,
        },
      },
      timeoutMs,
    );

    const status = response.status;
    if (status === 200) {
      return {
        url,
        status,
        kind: 'sse-compatible',
        reason: 'SSE endpoint returned 200.',
      };
    }

    if (status === 400) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        // ignore body read issues, continue from status code.
      }
      if (parseBodyTextForSessionError(body)) {
        return {
          url,
          status,
          kind: 'sse-compatible',
          reason: 'SSE endpoint returned 400 Missing session ID; session initialization is required.',
          bodyPreview: body.slice(0, 400),
        };
      }
      return {
        url,
        status,
        kind: 'incompatible',
        reason: `SSE endpoint returned HTTP ${status} without session-id hint.`,
        bodyPreview: body.slice(0, 400),
      };
    }

    if (status === 401) {
      const resourceMetadataUrl = extractResourceMetadataUrl(response.headers.get('www-authenticate'));
      return {
        url,
        status,
        kind: 'auth-required',
        reason: resourceMetadataUrl
          ? `SSE endpoint returned 401 and requires auth. WWW-Authenticate resource_metadata=${resourceMetadataUrl}.`
          : 'SSE endpoint returned 401 and requires auth, but resource_metadata was not advertised.',
        ...(resourceMetadataUrl !== undefined
          ? { resourceMetadataUrl }
          : {}),
      };
    }

    if (status === 405) {
      return {
        url,
        status,
        kind: 'method-not-supported',
        reason:
          'SSE endpoint returned 405 (GET not supported). The transport may not follow the standard GET+session model.',
      };
    }

    if (status === 404) {
      return {
        url,
        status,
        kind: 'path-mismatch',
        reason: `SSE probe returned 404 at ${url}.`,
      };
    }

    return {
      url,
      status,
      kind: 'incompatible',
      reason: `SSE probe returned HTTP ${status}.`,
    };
  } catch (error) {
    const details = describeError(error);
    return {
      url,
      status: null,
      kind: 'incompatible',
      reason: details.message,
    };
  }
}

function buildStep(candidate: StreamableSseCandidate, targetUrl: string): ProbeStep {
  const isTarget = candidate.url === targetUrl;
  const status =
    candidate.kind === 'path-mismatch' ? 'error' :
    candidate.kind === 'incompatible' ? 'error' :
    'ok';

  const detail = isTarget
    ? candidate.kind === 'path-mismatch'
      ? `${candidate.reason}`
      : candidate.reason
    : candidate.reason;

  return {
    name: isTarget ? 'streamable-http.sse.target' : 'streamable-http.sse.alternate',
    status: isTarget ? status : 'ok',
    ...(candidate.bodyPreview !== undefined ? { detail: `${detail} Body: ${candidate.bodyPreview}` } : { detail }),
    data: {
      url: candidate.url,
      ...(candidate.status !== null ? { http_status: candidate.status } : {}),
      ...(candidate.resourceMetadataUrl ? { resource_metadata_url: candidate.resourceMetadataUrl } : {}),
    },
  };
}

export async function checkStreamableHttpSseCompatibility(
  url: string,
  timeoutMs: number,
): Promise<StreamableSseProbeResult> {
  const variants = buildComparableVariants(url);
  const results = await Promise.all(variants.map((variant) => probeSseCandidate(variant, timeoutMs)));
  if (results.length === 0) {
    return {
      ok: false,
      steps: [
        {
          name: 'streamable-http.sse.target',
          status: 'error',
          detail: 'No candidate SSE URLs to probe.',
        },
      ],
    };
  }

  const requestedUrl = new URL(url).toString();
  const targetResult = results.find((result) => result.url === requestedUrl) ?? results[0]!;
  const alternateResult =
    results.length > 1 ? results.find((result) => result.url !== targetResult.url) : undefined;

  const steps: ProbeStep[] = [];
  steps.push(buildStep(targetResult, requestedUrl));

  if (alternateResult) {
    steps.push(buildStep(alternateResult, requestedUrl));
  }

  const targetCompatible =
    targetResult.kind === 'sse-compatible' ||
    targetResult.kind === 'auth-required' ||
    targetResult.kind === 'method-not-supported';

  if (!targetCompatible && alternateResult && alternateResult.kind === 'sse-compatible') {
    steps.push({
      name: 'streamable-http.sse.suggestion',
      status: 'ok',
      detail: `Target path appears misconfigured. Alternate variant responded with SSE-compatible status: ${alternateResult.url}`,
      data: {
        requested_url: requestedUrl,
        alternate_url: alternateResult.url,
        alternate_kind: alternateResult.kind,
      },
    });
  }

  if (targetResult.kind === 'path-mismatch' && alternateResult && alternateResult.kind === 'sse-compatible') {
    const suggestionStepIndex = steps.findIndex((step) => step.name === 'streamable-http.sse.target');
    if (suggestionStepIndex >= 0) {
      const suggestionStep = steps[suggestionStepIndex];
      if (suggestionStep) {
        suggestionStep.detail = `${suggestionStep.detail} Try ${alternateResult.url} instead.`;
      }
    }
  }

  return {
    ok: targetCompatible,
    steps,
  };
}
