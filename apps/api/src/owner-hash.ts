import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { hashOwnerPassword } from './owner-auth.js';

async function main() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('OWNER_TERMINAL_REQUIRED');
  const { values } = parseArgs({ options: { output: { type: 'string', default: '../../.env.owner' } } });
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    process.stderr.write('소유자 비밀번호 (16~256자, 입력 숨김): ');
    const password = await input.question('');
    process.stderr.write('\n비밀번호 확인: ');
    const confirmation = await input.question('');
    process.stderr.write('\n');
    if (password !== confirmation) throw new Error('OWNER_PASSWORD_MISMATCH');
    const hash = await hashOwnerPassword(password);
    await writeFile(resolve(values.output!), `OWNER_PASSWORD_HASH=${hash}\n`, { flag: 'wx', mode: 0o600 });
    console.info('소유자 인증 설정 파일을 생성했습니다. 기존 파일은 덮어쓰지 않습니다. API를 재시작해 주세요.');
  } finally {
    input.close();
    muted.destroy();
  }
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && ['OWNER_TERMINAL_REQUIRED', 'OWNER_PASSWORD_MISMATCH'].includes(error.message)
      ? error.message
      : 'OWNER_SETUP_FAILED';
  console.error(code);
  process.exitCode = 1;
});
