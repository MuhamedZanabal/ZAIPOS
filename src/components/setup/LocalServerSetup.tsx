import { FormEvent, useState } from 'react';
import { localClient } from '@/backend/local-client';

type Props = { configured: boolean; onReady: () => void };

export default function LocalServerSetup({ configured, onReady }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const result = await localClient.auth.bootstrapOwner({ email, password, tenantName, branchName });
    setBusy(false);
    if (result.error?.message === 'already_initialized') {
      setError('This computer already has an owner. Continue to sign in.');
      return;
    }
    if (result.error || !result.data.session) {
      setError(result.error?.message ?? 'Local owner setup failed');
      return;
    }
    onReady();
  };

  return (
    <main className="min-h-screen bg-[#071832] text-white grid place-items-center p-6">
      <section className="w-full max-w-2xl rounded-2xl border border-cyan-900 bg-[#102849] p-8 shadow-2xl">
        <p className="mb-2 text-sm font-bold tracking-[0.18em] text-cyan-400">ZAIPOS THIS COMPUTER</p>
        <h1 className="mb-3 text-3xl font-bold">Set up the local server</h1>
        <p className="mb-7 leading-7 text-slate-300">
          ZAIPOS keeps the shop database on this computer. The first owner, branch, register, and server terminal are created here. No hosted project key is required.
        </p>
        {!configured ? (
          <p role="alert" className="rounded-lg border border-amber-800 bg-amber-950/70 p-3 text-sm text-amber-100">
            The ZAIPOS local service is not ready. Install or start ZAIPOS Local Service, then reopen this screen. Database passwords are not entered here.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">Shop name</span>
              <input required maxLength={80} value={tenantName} onChange={(event) => setTenantName(event.target.value)} className="w-full rounded-lg border border-slate-600 bg-slate-950 px-4 py-3 outline-none focus:border-cyan-400" />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">Branch</span>
              <input required maxLength={80} value={branchName} onChange={(event) => setBranchName(event.target.value)} className="w-full rounded-lg border border-slate-600 bg-slate-950 px-4 py-3 outline-none focus:border-cyan-400" />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">Owner email</span>
              <input required type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} className="w-full rounded-lg border border-slate-600 bg-slate-950 px-4 py-3 outline-none focus:border-cyan-400" />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium">Owner password</span>
              <input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-full rounded-lg border border-slate-600 bg-slate-950 px-4 py-3 outline-none focus:border-cyan-400" />
            </label>
            {error && <p role="alert" className="rounded-lg border border-red-800 bg-red-950/70 p-3 text-sm text-red-200">{error}</p>}
            <button disabled={busy} className="w-full rounded-lg bg-cyan-500 px-4 py-3 font-bold text-slate-950 hover:bg-cyan-400 disabled:opacity-50">
              {busy ? 'Creating the local shop…' : 'Create owner and continue'}
            </button>
            <button type="button" className="w-full rounded-lg border border-slate-500 px-4 py-3 font-semibold text-slate-200" onClick={onReady}>
              I already have an account
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
