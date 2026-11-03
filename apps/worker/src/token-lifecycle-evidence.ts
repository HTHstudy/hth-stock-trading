import { observationManifestSchema, observationTokenLifecycleSchema } from '@hth/contracts';
import { contentHash } from '@hth/database';

// Pure verification only: no token issuance, DB, filesystem access or approval.
export function verifyTokenLifecycleEvidence(input: unknown, manifestInput: unknown) {
  const artifact = observationTokenLifecycleSchema.parse(input);
  const manifest = observationManifestSchema.parse(manifestInput);
  const { hash, ...body } = artifact;
  if (
    contentHash(body) !== hash ||
    contentHash(manifest) !== artifact.manifestHash ||
    artifact.runId !== manifest.id ||
    manifest.source !== 'toss-readonly'
  )
    throw new Error('INVALID_TOKEN_LIFECYCLE_EVIDENCE');
  if (!artifact.snapshot.clockUnverified) {
    const start = Date.parse(manifest.startedAt);
    if (
      artifact.snapshot.capturedAt === null ||
      Date.parse(artifact.snapshot.capturedAt) < start ||
      artifact.snapshot.events.some((event) => event.at === null || Date.parse(event.at) < start)
    )
      throw new Error('INVALID_TOKEN_LIFECYCLE_EVIDENCE');
  }
  return { snapshot: artifact.snapshot, executionEnabled: false as const, canResume: false as const };
}
