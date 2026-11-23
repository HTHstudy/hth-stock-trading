import { createPublicKey, verify } from 'node:crypto';
import type { OrderAttemptContext, OrderAttemptEventData, StoredOrderAttemptEvent } from '@hth/contracts';
import { canonicalJson } from './content-hash.js';

export function checkOrderAttemptProof(
  context: OrderAttemptContext,
  journal: readonly StoredOrderAttemptEvent[],
  operationId: string,
  data: OrderAttemptEventData,
) {
  if (data.kind !== 'recovery-ack') return;
  const { receipt, signature } = data;
  const claim = journal.find((event) => event.eventHash === receipt.claimEventHash);
  const unknown = journal.find((event) => event.eventHash === receipt.unknownEventHash);
  if (
    !context.recoveryPublicKey ||
    operationId !== receipt.proofId ||
    claim?.data.kind !== 'attempt' ||
    claim.data.attemptId !== receipt.attemptId ||
    unknown?.data.kind !== 'result' ||
    unknown.data.attemptId !== receipt.attemptId ||
    unknown.data.result.outcome !== 'unknown' ||
    unknown.sequence <= claim.sequence
  )
    throw new Error('ORDER_ATTEMPT_RECOVERY_PROOF_INVALID');

  let valid = false;
  try {
    const key = createPublicKey({
      // RFC 8410 Ed25519 SubjectPublicKeyInfo prefix followed by the pinned raw public key.
      key: Buffer.from('302a300506032b6570032100' + context.recoveryPublicKey, 'hex'),
      type: 'spki',
      format: 'der',
    });
    valid = verify(null, Buffer.from(canonicalJson(receipt)), key, Buffer.from(signature, 'hex'));
  } catch {
    // Only a fixed error crosses the storage boundary.
  }
  if (!valid) throw new Error('ORDER_ATTEMPT_RECOVERY_PROOF_INVALID');
}
