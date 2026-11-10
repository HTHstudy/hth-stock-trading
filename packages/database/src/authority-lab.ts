import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';

const exec = promisify(execFile);

const phases = [
  'CREATE',
  'START',
  'TARGET',
  'SETUP',
  'PASSWORD',
  'PUBLIC',
  'CONNECT',
  'TERMINATE',
  'PREPARED',
  'SET_ROLE',
  'MEMBERSHIP',
] as const;
type Phase = (typeof phases)[number];
export function authorityLabErrorCode(error: unknown) {
  const allowed = new Set(['AUTHORITY_LAB_CLEANUP_FAILED', ...phases.map((phase) => `AUTHORITY_LAB_${phase}_FAILED`)]);
  return error instanceof Error && allowed.has(error.message) ? error.message : 'AUTHORITY_LAB_FAILED';
}

export const authorityLabSafety = {
  source: 'disposable-postgresql-lab',
  operatingEvidence: false,
  policyApplied: false,
  reservationExceptionsCreated: false,
  executionEnabled: false,
  canResume: false,
} as const;

export function authorityLabMode(args: string[], tradingMode: unknown) {
  paperModeSchema.parse(tradingMode);
  if (args.length === 0) return 'preview';
  if (args.length === 1 && args[0] === '--execute') return 'execute';
  throw new Error('AUTHORITY_LAB_ARGUMENT_INVALID');
}

// Only a receipt from the container created by this invocation is accepted.
export function authorityLabPort(input: unknown, id: string, nonce: string) {
  const value = z
    .strictObject({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      nonce: z.string().regex(/^[a-f0-9]{32}$/),
      ports: z
        .array(z.strictObject({ HostIp: z.literal('127.0.0.1'), HostPort: z.string().regex(/^[1-9][0-9]{3,4}$/) }))
        .length(1),
      mounts: z.array(z.unknown()).length(0),
      tmpfs: z.strictObject({ '/var/lib/postgresql/data': z.literal('rw,nosuid,size=256m') }),
    })
    .parse(input);
  const port = Number(value.ports[0]!.HostPort);
  if (value.id !== id || value.nonce !== nonce || port > 65535) throw new Error('AUTHORITY_LAB_TARGET_INVALID');
  return port;
}

// No caller-supplied URL, client, SQL, environment file or Docker context.
export async function runDatabaseAuthorityLab() {
  const nonce = randomBytes(16).toString('hex');
  const password = randomBytes(24).toString('hex');
  const replacement = randomBytes(24).toString('hex');
  const name = `hth-authority-lab-${randomUUID()}`;
  const config = await mkdtemp(join(tmpdir(), 'hth-authority-lab-'));
  const clients: pg.Client[] = [];
  let containerId: string | undefined;
  let created = false;
  let cleanupFailed = false;
  let phase: Phase = 'CREATE';
  let failure: string | undefined;
  const check = (condition: boolean) => {
    if (!condition) throw new Error('AUTHORITY_LAB_CHECK_FAILED');
  };
  const docker = async (args: string[]) => {
    try {
      const result = await exec('docker', ['--host', 'unix:///var/run/docker.sock', '--config', config, ...args], {
        env: { PATH: process.env.PATH, LANG: 'C' },
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.trim();
    } catch {
      throw new Error('AUTHORITY_LAB_DOCKER_FAILED');
    }
  };
  try {
    // A named target is never reused. No bind mounts, saved volumes or image pull.
    const id = await docker([
      'create',
      '--pull=never',
      '--name',
      name,
      '--label',
      `hth.authority-lab=${nonce}`,
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,nosuid,size=256m',
      '--env',
      'POSTGRES_USER=hth_test',
      '--env',
      'POSTGRES_DB=hth_readonly_test',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
      '--env',
      'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      'postgres:17-alpine',
      'postgres',
      '-c',
      'max_prepared_transactions=10',
    ]);
    created = true;
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('AUTHORITY_LAB_TARGET_INVALID');
    containerId = id;
    phase = 'START';
    await docker(['start', id]);
    let ready = false;
    const startupDeadline = Date.now() + 15000;
    for (let i = 0; i < 50 && Date.now() < startupDeadline; i++) {
      const status = await docker([
        'exec',
        id,
        'pg_isready',
        '-U',
        'hth_test',
        '-d',
        'hth_readonly_test',
        '-h',
        '127.0.0.1',
        '-t',
        '1',
      ]).then(
        () => true,
        () => false,
      );
      if (status) {
        ready = true;
        break;
      }
      await delay(100);
    }
    check(ready);
    phase = 'TARGET';
    const receipt: unknown = JSON.parse(
      await docker([
        'inspect',
        '--format',
        '{"id":{{json .Id}},"nonce":{{json (index .Config.Labels "hth.authority-lab")}},"ports":{{json (index .NetworkSettings.Ports "5432/tcp")}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}}}',
        id,
      ]),
    );
    const port = authorityLabPort(receipt, id, nonce);
    const connect = async (user: string, secret: string) => {
      const client = new pg.Client({
        host: '127.0.0.1',
        ssl: false,
        port,
        database: 'hth_readonly_test',
        user,
        password: secret,
        application_name: `authority-lab-${nonce}`,
        connectionTimeoutMillis: 3000,
        query_timeout: 5000,
        statement_timeout: 4000,
      });
      // Expected termination of owned sessions must not surface raw connection errors.
      client.on('error', () => {});
      clients.push(client);
      await client.connect();
      return client;
    };
    const denied = async (operation: () => Promise<unknown>, code: string) => {
      try {
        await operation();
      } catch (error) {
        check(typeof error === 'object' && error !== null && 'code' in error && error.code === code);
        return;
      }
      throw new Error('AUTHORITY_LAB_EXPECTED_DENIAL');
    };
    phase = 'SETUP';
    const admin = await connect('hth_test', password);
    const identity = (
      await admin.query<{ name: string; role: string; version: number }>(
        "SELECT current_database() AS name, current_user AS role, current_setting('server_version_num')::int AS version",
      )
    ).rows[0]!;
    check(
      identity.name === 'hth_readonly_test' &&
        identity.role === 'hth_test' &&
        Math.floor(identity.version / 10000) === 17,
    );
    await admin.query(`
      CREATE ROLE authority_lab_legacy LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}';
      CREATE ROLE authority_lab_alternate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}';
      CREATE SCHEMA authority_lab;
      CREATE TABLE authority_lab.ledger (id integer PRIMARY KEY, value integer NOT NULL);
      INSERT INTO authority_lab.ledger VALUES (1, 100);
      GRANT USAGE ON SCHEMA authority_lab TO authority_lab_legacy;
      GRANT SELECT, INSERT, UPDATE ON authority_lab.ledger TO authority_lab_legacy;
      GRANT CONNECT ON DATABASE hth_readonly_test TO authority_lab_legacy, authority_lab_alternate;
      GRANT authority_lab_legacy TO authority_lab_alternate WITH INHERIT FALSE, SET TRUE;
    `);
    const idle = await connect('authority_lab_legacy', password);
    const transaction = await connect('authority_lab_legacy', password);
    const idlePid = (await idle.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const transactionPid = (await transaction.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await transaction.query('BEGIN');
    await transaction.query('UPDATE authority_lab.ledger SET value = 200 WHERE id = 1');
    phase = 'PASSWORD';
    await admin.query(`ALTER ROLE authority_lab_legacy PASSWORD '${replacement}'`);
    await denied(() => connect('authority_lab_legacy', password), '28P01');
    const replacementClient = await connect('authority_lab_legacy', replacement);
    await replacementClient.end();
    check(
      (await idle.query<{ value: number }>('SELECT value FROM authority_lab.ledger WHERE id = 1')).rows[0]!.value ===
        100,
    );

    phase = 'PUBLIC';
    await admin.query('REVOKE CONNECT ON DATABASE hth_readonly_test FROM authority_lab_legacy');
    const publicBypass = await connect('authority_lab_legacy', replacement);
    await publicBypass.end();
    phase = 'CONNECT';
    await admin.query('REVOKE CONNECT ON DATABASE hth_readonly_test FROM PUBLIC');
    await denied(() => connect('authority_lab_legacy', replacement), '42501');
    check((await idle.query('SELECT 1')).rowCount === 1);
    check(
      (await transaction.query<{ value: number }>('SELECT value FROM authority_lab.ledger WHERE id = 1')).rows[0]!
        .value === 200,
    );
    const states = await admin.query<{ state: string }>(
      'SELECT state FROM pg_stat_activity WHERE datname = current_database() AND pid = ANY($1::int[])',
      [[idlePid, transactionPid]],
    );
    check(states.rows.some((r) => r.state === 'idle') && states.rows.some((r) => r.state === 'idle in transaction'));
    phase = 'TERMINATE';
    for (const pid of [idlePid, transactionPid]) {
      const stopped = await admin.query<{ stopped: boolean }>('SELECT pg_terminate_backend($1, 3000) AS stopped', [
        pid,
      ]);
      check(stopped.rows[0]!.stopped);
    }
    const legacySessions = async () =>
      Number(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = 'authority_lab_legacy'",
          )
        ).rows[0]!.count,
      );
    check((await legacySessions()) === 0);
    check(
      (await admin.query<{ value: number }>('SELECT value FROM authority_lab.ledger WHERE id = 1')).rows[0]!.value ===
        100,
    );

    phase = 'PREPARED';
    await admin.query('GRANT CONNECT ON DATABASE hth_readonly_test TO authority_lab_legacy');
    const preparer = await connect('authority_lab_legacy', replacement);
    const gid = `authority_lab_${nonce}`;
    await preparer.query('BEGIN');
    await preparer.query('INSERT INTO authority_lab.ledger VALUES (2, 25)');
    await preparer.query(`PREPARE TRANSACTION '${gid}'`);
    await preparer.end();
    await admin.query('REVOKE CONNECT ON DATABASE hth_readonly_test FROM authority_lab_legacy');
    await admin.query('ALTER ROLE authority_lab_legacy NOLOGIN');
    await denied(() => connect('authority_lab_legacy', replacement), '28000');
    check((await legacySessions()) === 0);
    const preparedCount = Number(
      (
        await admin.query<{ count: string }>(
          'SELECT count(*) FROM pg_prepared_xacts WHERE database = current_database() AND gid = $1',
          [gid],
        )
      ).rows[0]!.count,
    );
    check(preparedCount === 1);
    check((await admin.query('SELECT * FROM authority_lab.ledger WHERE id = 2')).rowCount === 0);
    // Only the transaction created above, in this owned disposable fixture, is rolled back.
    await admin.query(`ROLLBACK PREPARED '${gid}'`);
    check(
      Number((await admin.query<{ count: string }>('SELECT count(*) FROM pg_prepared_xacts')).rows[0]!.count) === 0,
    );

    phase = 'SET_ROLE';
    const alternate = await connect('authority_lab_alternate', password);
    await alternate.query('SET ROLE authority_lab_legacy');
    await alternate.query('UPDATE authority_lab.ledger SET value = 110 WHERE id = 1');
    check(
      (await admin.query<{ value: number }>('SELECT value FROM authority_lab.ledger WHERE id = 1')).rows[0]!.value ===
        110,
    );
    await alternate.end();
    phase = 'MEMBERSHIP';
    await admin.query('REVOKE authority_lab_legacy FROM authority_lab_alternate');
    const afterRevoke = await connect('authority_lab_alternate', password);
    await denied(() => afterRevoke.query('SET ROLE authority_lab_legacy'), '42501');
    await afterRevoke.end();
  } catch {
    failure = `AUTHORITY_LAB_${phase}_FAILED`;
  } finally {
    await Promise.all(
      clients.map((client) =>
        client.end().catch(() => {
          cleanupFailed = true;
        }),
      ),
    );
    // No delete by guessed name after an uncertain create. Never scan or prune other containers.
    if (created && containerId) {
      try {
        await docker(['rm', '--force', '--volumes', containerId]);
      } catch {
        cleanupFailed = true;
      }
    } else if (created) cleanupFailed = true;
    await rm(config, { recursive: true, force: true }).catch(() => {
      cleanupFailed = true;
    });
  }
  if (cleanupFailed) throw new Error('AUTHORITY_LAB_CLEANUP_FAILED');
  if (failure) throw new Error(failure);
  return {
    state: 'passed' as const,
    checks: {
      passwordRotationKeepsExistingSession: true,
      publicGrantBypassesDirectRevoke: true,
      connectRevocationKeepsExistingSessions: true,
      terminationRollsBackOpenTransaction: true,
      preparedTransactionOutlivesSessions: true,
      noLoginDoesNotBlockSetRole: true,
      membershipRemovalBlocksNewSetRole: true,
    },
    ...authorityLabSafety,
  };
}
