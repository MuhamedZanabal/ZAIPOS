import { FormEvent, useState } from 'react';

type Props = { onConfigured: () => void };

export default function SupabaseConnector({ onConfigured }: Props) {
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabasePublishableKey, setSupabasePublishableKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!window.electron?.saveInitialBackendConfig) {
      setError('First-run configuration is available in the ZAIPOS desktop application.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await window.electron.saveInitialBackendConfig({ supabaseUrl, supabasePublishableKey });
      onConfigured();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Supabase connection failed');
    } finally {
      setBusy(false);
    }
  };

  const openSupabase = async () => {
    const url = 'https://supabase.com/dashboard/projects';
    if (window.electron?.openExternal) await window.electron.openExternal(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <main className="min-h-screen bg-[#071832] text-white grid place-items-center p-6">
      <section className="w-full max-w-2xl rounded-2xl border border-cyan-900 bg-[#102849] p-8 shadow-2xl">
        <p className="mb-2 text-sm font-bold tracking-[0.18em] text-cyan-400">ZAIPOS FIRST-RUN SETUP</p>
        <h1 className="mb-3 text-3xl font-bold">Connect your Supabase project</h1>
        <p className="mb-7 leading-7 text-slate-300">
          Enter only the project URL and public publishable key. ZAIPOS validates the connection before storing it locally. Never enter a service-role key here.
        </p>

        <button type="button" onClick={openSupabase} className="mb-6 w-full rounded-lg border border-cyan-500 px-4 py-3 font-semibold text-cyan-300 hover:bg-cyan-950">
          Open Supabase in browser
        </button>

        <form onSubmit={submit} className="space-y-5">
          <label className="block">
            <span className="mb-2 block text-sm font-medium">Project URL</span>
            <input required type="url" placeholder="https://your-project.supabase.co" value={supabaseUrl} onChange={(event) => setSupabaseUrl(event.target.value)} className="w-full rounded-lg border border-slate-600 bg-slate-950 px-4 py-3 outline-none focus:border-cyan-400" />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-medium">Publishable key</span>
            <input required type="password" autoComplete="off" value={supabasePublishableKey} onChange={(event) => setSupabasePublishableKey(event.target.value)} className="w-full rounded-lg border border-slate-600 bg-slate-950 px-4 py-3 outline-none focus:border-cyan-400" />
          </label>
          {error && <p role="alert" className="rounded-lg border border-red-800 bg-red-950/70 p-3 text-sm text-red-200">{error}</p>}
          <button disabled={busy} className="w-full rounded-lg bg-cyan-500 px-4 py-3 font-bold text-slate-950 hover:bg-cyan-400 disabled:opacity-50">
            {busy ? 'Testing connection…' : 'Connect and continue'}
          </button>
        </form>

        <p className="mt-6 text-xs leading-5 text-slate-400">
          Automatic account/project import requires the registered ZAIPOS Supabase OAuth integration. Until that external registration is configured, the browser button opens the official project dashboard and manual public-key connection remains available.
        </p>
      </section>
    </main>
  );
}
