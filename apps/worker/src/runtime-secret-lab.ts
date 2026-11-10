import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';

const exec = promisify(execFile);
export const runtimeSecretLabSafety = {
  source: 'disposable-runtime-secret-lab',
  syntheticOnly: true,
  hostIsolationVerified: false,
  daemonAccessRevoked: false,
  operatingEvidence: false,
  policyApplied: false,
  reservationExceptionsCreated: false,
  executionEnabled: false,
  canResume: false,
} as const;
const phases = ['VOLUME', 'CREATE', 'TARGET', 'SEED', 'SAME_UID', 'OTHER_UID', 'NO_MOUNT', 'READ_ONLY'] as const;
type Phase = (typeof phases)[number];
export function runtimeSecretLabErrorCode(error: unknown) {
  const allowed = new Set([
    'RUNTIME_SECRET_LAB_CLEANUP_FAILED',
    ...phases.map((p) => `RUNTIME_SECRET_LAB_${p}_FAILED`),
  ]);
  return error instanceof Error && allowed.has(error.message) ? error.message : 'RUNTIME_SECRET_LAB_FAILED';
}
export function runtimeSecretLabMode(args: string[], mode: unknown) {
  paperModeSchema.parse(mode);
  if (args.length === 0) return 'preview';
  if (args.length === 1 && args[0] === '--execute') return 'execute';
  throw new Error('RUNTIME_SECRET_LAB_ARGUMENT_INVALID');
}
const hexId = z.string().regex(/^[a-f0-9]{64}$/);
const nonceSchema = z.string().regex(/^[a-f0-9]{32}$/);
export function assertRuntimeLabVolume(input: unknown, name: string, nonce: string) {
  const receipt = z
    .strictObject({
      name: z.string(),
      nonce: nonceSchema,
      driver: z.literal('local'),
      options: z.union([z.null(), z.strictObject({})]),
    })
    .parse(input);
  if (receipt.name !== name || receipt.nonce !== nonce) throw new Error('RUNTIME_SECRET_LAB_TARGET_INVALID');
}
export function assertRuntimeLabContainer(
  input: unknown,
  id: string,
  nonce: string,
  volume: string | null,
  writable: boolean,
) {
  const receipt = z
    .strictObject({
      id: hexId,
      nonce: nonceSchema,
      network: z.literal('none'),
      privileged: z.literal(false),
      readOnly: z.literal(true),
      pidMode: z.literal(''),
      capDrop: z.array(z.literal('ALL')).length(1),
      mounts: z.array(
        z.object({ Type: z.literal('volume'), Name: z.string(), Destination: z.literal('/lab'), RW: z.boolean() }),
      ),
    })
    .parse(input);
  if (receipt.id !== id || receipt.nonce !== nonce || receipt.mounts.length !== (volume === null ? 0 : 1))
    throw new Error('RUNTIME_SECRET_LAB_TARGET_INVALID');
  if (volume !== null && (receipt.mounts[0]!.Name !== volume || receipt.mounts[0]!.RW !== writable))
    throw new Error('RUNTIME_SECRET_LAB_TARGET_INVALID');
}
const seedScript = `
const fs = require('node:fs'); const crypto = require('node:crypto');
for (const name of ['shared','private']) { fs.mkdirSync('/lab/'+name,{mode:name==='private'?0o700:0o755}); }
const fake = crypto.randomBytes(32).toString('hex');
for (const [name,mode] of [['shared/secret',0o600],['shared/public-secret',0o644],['private/secret',0o600]]) {
 fs.writeFileSync('/lab/'+name,fake,{flag:'wx',mode});
}
console.log(JSON.stringify({hash:crypto.createHash('sha256').update(fake).digest('hex')}));
`;
const probeScript = `
const fs = require('node:fs'); const crypto = require('node:crypto');
const [operation,target,expected,uid] = process.argv.slice(1);
const status = fs.readFileSync('/proc/self/status','utf8');
const caps = status.match(/^CapEff:\\s*([0-9a-f]+)$/m);
if(!/^NoNewPrivs:\\s*1$/m.test(status)) process.exit(9);
if(process.getuid()!==Number(uid)||process.getgid()!==Number(uid)||!caps||BigInt('0x'+caps[1])!==0n||process.getgroups().includes(0)) process.exit(9);
if(Number(uid)===1001&&process.getgroups().includes(1000)) process.exit(9);
let outcome;
try {
 if(operation==='write') { fs.appendFileSync(target,'blocked-write'); outcome='written'; }
 else { const content=fs.readFileSync(target); outcome=content.length===64&&crypto.createHash('sha256').update(content).digest('hex')===expected?'readable':'mismatch'; }
} catch(error) { outcome=['EACCES','ENOENT','EROFS'].includes(error.code)?error.code:'unexpected'; }
console.log(JSON.stringify({outcome}));
`;

// All targets are created here. No host secret/file/URL/container/volume parameters.
export async function runRuntimeSecretLab() {
  const nonce = randomBytes(16).toString('hex');
  const volume = `hth-runtime-secret-lab-${randomUUID()}`;
  const config = await mkdtemp(join(tmpdir(), 'hth-runtime-secret-lab-'));
  const ids: string[] = [];
  let volumeOwned = false,
    cleanupFailed = false;
  let phase: Phase = 'VOLUME';
  let failure: string | undefined;
  const docker = async (args: string[]) => {
    try {
      return (
        await exec('docker', ['--host', 'unix:///var/run/docker.sock', '--config', config, ...args], {
          env: { PATH: process.env.PATH, LANG: 'C' },
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout.trim();
    } catch {
      throw new Error('RUNTIME_SECRET_LAB_DOCKER_FAILED');
    }
  };
  const check = (ok: boolean) => {
    if (!ok) throw new Error('RUNTIME_SECRET_LAB_CHECK_FAILED');
  };
  try {
    const createdVolume = await docker([
      'volume',
      'create',
      '--driver',
      'local',
      '--label',
      `hth.runtime-secret-lab=${nonce}`,
      volume,
    ]);
    check(createdVolume === volume);
    assertRuntimeLabVolume(
      JSON.parse(
        await docker([
          'volume',
          'inspect',
          '--format',
          '{"name":{{json .Name}},"nonce":{{json (index .Labels "hth.runtime-secret-lab")}},"driver":{{json .Driver}},"options":{{json .Options}}}',
          volume,
        ]),
      ),
      volume,
      nonce,
    );
    volumeOwned = true;
    const create = async (kind: 'owner' | 'shared' | 'isolated') => {
      phase = 'CREATE';
      const mount =
        kind === 'isolated'
          ? []
          : ['--mount', `type=volume,src=${volume},dst=/lab,volume-nocopy${kind === 'shared' ? ',readonly' : ''}`];
      const id = await docker([
        'create',
        '--pull=never',
        '--name',
        `hth-runtime-secret-lab-${randomUUID()}`,
        '--label',
        `hth.runtime-secret-lab=${nonce}`,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--user',
        kind === 'owner' ? '0:0' : '1000:1000',
        ...(kind === 'owner' ? ['--cap-add', 'CHOWN'] : []),
        ...mount,
        'node:24-slim',
        'node',
        '-e',
        'setInterval(()=>{},60000)',
      ]);
      hexId.parse(id);
      ids.push(id);
      await docker(['start', id]);
      phase = 'TARGET';
      assertRuntimeLabContainer(
        JSON.parse(
          await docker([
            'inspect',
            '--format',
            '{"id":{{json .Id}},"nonce":{{json (index .Config.Labels "hth.runtime-secret-lab")}},"network":{{json .HostConfig.NetworkMode}},"privileged":{{json .HostConfig.Privileged}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"pidMode":{{json .HostConfig.PidMode}},"capDrop":{{json .HostConfig.CapDrop}},"mounts":{{json .Mounts}}}',
            id,
          ]),
        ),
        id,
        nonce,
        kind === 'isolated' ? null : volume,
        kind === 'owner',
      );
      return id;
    };
    const owner = await create('owner');
    phase = 'SEED';
    await docker([
      'exec',
      '--user',
      '0:0',
      owner,
      'node',
      '-e',
      "const fs=require('node:fs');fs.chmodSync('/lab',0o755);fs.chownSync('/lab',1000,1000);",
    ]);
    const { hash } = z
      .strictObject({ hash: hexId })
      .parse(JSON.parse(await docker(['exec', '--user', '1000:1000', owner, 'node', '-e', seedScript])));
    const shared = await create('shared');
    const isolated = await create('isolated');
    const probe = async (id: string, uid: 1000 | 1001, path: string, expected: string, operation = 'read') => {
      const value = z
        .strictObject({
          outcome: z.enum(['readable', 'EACCES', 'ENOENT', 'EROFS', 'written', 'mismatch', 'unexpected']),
        })
        .parse(
          JSON.parse(
            await docker([
              'exec',
              '--user',
              `${uid}:${uid}`,
              id,
              'node',
              '-e',
              probeScript,
              operation,
              path,
              hash,
              String(uid),
            ]),
          ),
        );
      check(value.outcome === expected);
    };
    phase = 'SAME_UID';
    await probe(owner, 1000, '/lab/shared/secret', 'readable');
    await probe(shared, 1000, '/lab/shared/secret', 'readable');
    await probe(shared, 1000, '/lab/private/secret', 'readable');
    phase = 'OTHER_UID';
    await probe(shared, 1001, '/lab/shared/secret', 'EACCES');
    await probe(shared, 1001, '/lab/private/secret', 'EACCES');
    await probe(shared, 1001, '/lab/shared/public-secret', 'readable');
    phase = 'NO_MOUNT';
    await probe(isolated, 1000, '/lab/shared/secret', 'ENOENT');
    phase = 'READ_ONLY';
    await probe(shared, 1000, '/lab/shared/secret', 'EROFS', 'write');
    await probe(owner, 1000, '/lab/shared/secret', 'readable');
  } catch {
    failure = `RUNTIME_SECRET_LAB_${phase}_FAILED`;
  } finally {
    for (const id of [...ids].reverse()) {
      try {
        await docker(['rm', '--force', '--volumes', id]);
      } catch {
        cleanupFailed = true;
      }
    }
    if (volumeOwned && !cleanupFailed) {
      try {
        await docker(['volume', 'rm', volume]);
      } catch {
        cleanupFailed = true;
      }
    }
    await rm(config, { recursive: true, force: true }).catch(() => {
      cleanupFailed = true;
    });
  }
  if (cleanupFailed) throw new Error('RUNTIME_SECRET_LAB_CLEANUP_FAILED');
  if (failure) throw new Error(failure);
  return {
    state: 'passed' as const,
    checks: {
      sameUidSharedRead: true,
      sameUidPrivateDirectoryRead: true,
      differentUidFileDenied: true,
      differentUidDirectoryDenied: true,
      worldReadableBypassesUidSeparation: true,
      unmountedSecretAbsent: true,
      readOnlyMountStillReadable: true,
      readOnlyWriteDeniedAndContentPreserved: true,
    },
    ...runtimeSecretLabSafety,
  };
}
