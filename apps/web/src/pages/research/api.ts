import { queryOptions } from '@tanstack/react-query';
import { reportHashSchema, strategyResearchListSchema, strategyResearchSnapshotSchema } from '@hth/contracts';
import { ENV } from '@shared/config/env';
import { notifyUnauthorized } from '@shared/lib/auth-events';

// This transport belongs to this page; shared clients currently expose domain-specific endpoints only.
async function researchRequest(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${ENV.API_URL}/v1/strategy-research${path}`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  notifyUnauthorized(response.status);
  if (!response.ok) throw new Error('RESEARCH_UNAVAILABLE');
  return response.json();
}

export const researchListOptions = () =>
  queryOptions({
    queryKey: ['strategy-research-list'],
    queryFn: async ({ signal }) => strategyResearchListSchema.parse(await researchRequest('', signal)),
    staleTime: 5000,
    retry: false,
  });

export const researchSnapshotOptions = (hash: string) =>
  queryOptions({
    queryKey: ['strategy-research-snapshot', hash],
    queryFn: async ({ signal }) => {
      const id = reportHashSchema.parse(hash);
      const snapshot = strategyResearchSnapshotSchema.parse(await researchRequest(`/${id}`, signal));
      if (snapshot.snapshotHash !== id) throw new Error('RESEARCH_HASH_MISMATCH');
      return snapshot;
    },
    enabled: Boolean(hash),
    staleTime: Infinity,
    retry: false,
  });
