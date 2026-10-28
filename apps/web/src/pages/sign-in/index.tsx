import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_API } from '@shared/api/auth';

export function SignInPage({ configured }: { configured: boolean }) {
  const client = useQueryClient();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login() {
    const value = password;
    setPassword('');
    setBusy(true);
    setError('');
    try {
      client.setQueryData(['owner-session'], await AUTH_API.login(value));
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message === 'OWNER_RATE_LIMITED'
          ? '로그인 시도가 제한되었습니다. 잠시 후 다시 시도해 주세요.'
          : '로그인을 확인하지 못했습니다. 비밀번호와 서버 연결을 확인해 주세요.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="grid min-h-screen place-items-center bg-[#0b1120] px-5 py-12">
      <section className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#0d1424] p-8 shadow-2xl">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-teal-300 font-bold text-slate-950">H</span>
        <p className="mt-7 text-[10px] font-semibold tracking-[0.2em] text-teal-200">HTH TRADING · OWNER ACCESS</p>
        <h1 className="mt-3 text-2xl font-semibold">
          {configured ? '소유자 로그인' : '소유자 인증 설정이 필요합니다'}
        </h1>
        <p className="mt-3 text-sm leading-7 text-slate-400">
          {configured
            ? '계좌와 모의 거래 기록은 로그인한 소유자만 확인할 수 있습니다.'
            : '서버에서 소유자 비밀번호를 먼저 등록해 주세요. 설정 전에는 계좌와 거래 데이터에 접근할 수 없습니다.'}
        </p>
        {configured ? (
          <form
            className="mt-7"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void login();
            }}
          >
            <label htmlFor="owner-password" className="text-xs text-slate-400">
              비밀번호
            </label>
            <input
              id="owner-password"
              type="password"
              autoComplete="current-password"
              minLength={16}
              maxLength={256}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-sm outline-none focus:border-teal-300 disabled:opacity-50"
            />
            {error && (
              <p role="alert" className="mt-4 text-xs leading-6 text-rose-200">
                {error}
              </p>
            )}
            <button
              disabled={busy || password.length < 16}
              className="mt-6 w-full rounded-lg bg-teal-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-40"
            >
              {busy ? '확인 중…' : '로그인'}
            </button>
          </form>
        ) : (
          <div className="mt-7 rounded-xl border border-slate-700/70 bg-slate-950/50 p-4 text-xs leading-7 text-slate-400">
            <p>프로젝트 터미널에서 비밀번호를 등록합니다.</p>
            <code className="mt-2 block text-teal-200">corepack pnpm owner:hash</code>
            <p className="mt-2">등록 후 API 서버를 재시작해 주세요.</p>
          </div>
        )}
        <p className="mt-7 border-t border-slate-800 pt-5 text-[11px] leading-6 text-slate-500">
          로그인은 실행을 재개하지 않습니다. 실제 주문은 계속 비활성입니다.
        </p>
      </section>
    </main>
  );
}
