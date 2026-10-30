import { z } from 'zod';

// Explicit local Compose boundary; never inferred from credentials alone.
export function localComposeEnvironment(
  environment: Record<string, string | undefined>,
): Partial<
  Record<
    | 'DATABASE_URL'
    | 'PAPER_DEMO_DATABASE_URL'
    | 'PAPER_MARKET_DATABASE_URL'
    | 'PAPER_MARKET_ACCOUNT_ID'
    | 'PAPER_DEMO_ACCOUNT_ID',
    string
  >
> {
  if (environment.LOCAL_CONTAINER_MODE !== 'true') return {};
  if (environment.NODE_ENV !== 'production') throw new Error('LOCAL_DATABASE_CONFIGURATION_INVALID');
  const password = z.string().min(1).max(256).parse(environment.LOCAL_DB_PASSWORD);
  const paperPassword = z.string().min(1).max(256).parse(environment.LOCAL_PAPER_DB_PASSWORD);
  const url = (role: string, name: string, secret: string) => {
    const result = new URL(`postgresql://db:5432/${name}`);
    result.username = role;
    result.password = encodeURIComponent(secret);
    return result.href;
  };
  return {
    DATABASE_URL: url('hth', 'hth_trading', password),
    PAPER_DEMO_DATABASE_URL: url('hth_test', 'hth_readonly_test', paperPassword),
    PAPER_MARKET_DATABASE_URL: url('hth_test', 'hth_readonly_test', paperPassword),
    ...(environment.LOCAL_PAPER_ACCOUNT_ID
      ? environment.LOCAL_PAPER_KIND === 'market'
        ? { PAPER_MARKET_ACCOUNT_ID: environment.LOCAL_PAPER_ACCOUNT_ID }
        : { PAPER_DEMO_ACCOUNT_ID: environment.LOCAL_PAPER_ACCOUNT_ID }
      : {}),
  };
}

export function dedicatedPaperDatabaseUrl(value: string | undefined, localCompose = false) {
  if (!value) throw new Error('UNSAFE_TEST_DATABASE');
  const target = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    target.search ||
    target.hash ||
    !['localhost', '127.0.0.1', ...(localCompose ? ['db'] : [])].includes(target.hostname) ||
    target.pathname !== '/hth_readonly_test' ||
    target.username !== 'hth_test' ||
    (target.hostname === 'db' && target.port !== '' && target.port !== '5432')
  )
    throw new Error('UNSAFE_TEST_DATABASE');
  return value;
}
