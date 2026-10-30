import { expect, it, vi } from 'vitest';
import { createDatabase } from './index.js';
it('idle 접속 장애로 프로세스를 종료하거나 오류/클라이언트의 비밀 정보를 출력하지 않는다', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const database = createDatabase('postgresql://unused:PRIVATE_PASSWORD@localhost/unused');
  try {
    expect(() =>
      database.db.$client.emit('error', new Error('PRIVATE_TOKEN'), { password: 'PRIVATE_PASSWORD' }),
    ).not.toThrow();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ service: 'database', code: 'DATABASE_IDLE_CONNECTION_LOST' }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE_/);
  } finally {
    await database.close();
  }
});
