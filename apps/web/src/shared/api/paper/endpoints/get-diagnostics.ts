import { paperDiagnosticsSchema } from '@hth/contracts';
import { paperRequest } from '../paper-http-client';
export async function getDiagnostics(signal?: AbortSignal) {
  return paperDiagnosticsSchema.parse(await paperRequest('/diagnostics', 'GET', signal));
}
