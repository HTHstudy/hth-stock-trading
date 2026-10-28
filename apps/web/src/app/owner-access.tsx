import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AUTH_API } from '@shared/api/auth';
import { OWNER_EXPIRED_EVENT } from '@shared/lib/auth-events';
import { SignInPage } from '@pages/sign-in';

export function OwnerAccess({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState(false);
  const session = useQuery({
    queryKey: ['owner-session'],
    queryFn: ({ signal }) => AUTH_API.session(signal),
    refetchInterval: 30_000,
  });
  useEffect(() => {
    const expired = () => {
      void client.cancelQueries();
      client.clear();
      client.setQueryData(['owner-session'], { configured: true, authenticated: false, expiresAt: null });
    };
    window.addEventListener(OWNER_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(OWNER_EXPIRED_EVENT, expired);
  }, [client]);
  useEffect(() => {
    if (session.isError || session.data?.authenticated === false) {
      const privateData = {
        predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== 'owner-session',
      };
      void client.cancelQueries(privateData);
      client.removeQueries(privateData);
    }
  }, [client, session.data?.authenticated, session.isError]);
  async function logout() {
    setLeaving(true);
    setError(false);
    try {
      const state = await AUTH_API.logout();
      await client.cancelQueries();
      client.clear();
      client.setQueryData(['owner-session'], state);
    } catch {
      setError(true);
    } finally {
      setLeaving(false);
    }
  }
  if (session.isPending)
    return (
      <p role="status" className="p-12 text-center text-sm text-slate-400">
        소유자 세션을 확인하고 있습니다…
      </p>
    );
  if (session.isError)
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="text-center">
          <p role="alert" className="text-sm text-slate-400">
            소유자 세션을 확인할 수 없습니다.
          </p>
          <button
            onClick={() => {
              void session.refetch();
            }}
            className="mt-5 rounded-lg border border-slate-700 px-5 py-3 text-sm"
          >
            다시 확인
          </button>
        </div>
      </main>
    );
  if (!session.data.authenticated) return <SignInPage configured={session.data.configured} />;
  return (
    <>
      <div className="flex items-center justify-end gap-4 border-b border-slate-800 px-5 py-2 text-[11px] text-slate-500 xl:ml-56">
        <span>소유자 세션</span>
        {error && (
          <span role="alert" className="text-rose-200">
            로그아웃을 확인하지 못했습니다.
          </span>
        )}
        <button
          disabled={leaving}
          onClick={() => {
            void logout();
          }}
          className="rounded-md px-3 py-2 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          {leaving ? '확인 중…' : '로그아웃'}
        </button>
      </div>
      {children}
    </>
  );
}
