import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { SetupWizard } from '@/components/setup/SetupWizard';
import { saveBasics } from '@/lib/setupApply';
import { FIRST_IN_APP_STEP, saveWizard, type WizardState } from '@/lib/setupWizard';
import { localClient } from '@/backend/local-client';

type Props = { configured: boolean; onReady: () => void };

function localServiceWaitingCopy(reason?: string | null): string {
  switch (reason) {
    case 'DATABASE_STARTING':
      return 'ZAIPOS Local Service is starting the shop database on this computer. This screen continues automatically. Database passwords are not entered here.';
    case 'POSTGRES_PROVISIONING_FAILED':
    case 'DATABASE_CONNECTION_FAILED':
      return 'ZAIPOS Local Service could not start the local database. Restart ZAIPOS Local Service. This screen checks again automatically. Database passwords are not entered here.';
    case 'MIGRATION_FAILED':
      return 'The local database could not be prepared. Restart ZAIPOS Local Service. This screen checks again automatically. Database passwords are not entered here.';
    case 'PROFILE_UNREADABLE':
      return 'ZAIPOS Local Service is installed, but Windows is blocking this user from reading it. Run the ZAIPOS installer again, then leave this screen open. Database passwords are not entered here.';
    case 'SERVICE_NOT_RUNNING':
      return 'ZAIPOS Local Service is not running. Close ZAIPOS, run the installer again, then leave this screen open. Database passwords are not entered here.';
    case 'TLS_FAILED':
    case 'PROFILE_FAILED':
    case 'RUNTIME_FAILED':
      return 'ZAIPOS Local Service failed while starting. Restart ZAIPOS Local Service. This screen checks again automatically. Database passwords are not entered here.';
    default:
      return 'The ZAIPOS local service is not ready yet. This screen checks again automatically. Database passwords are not entered here.';
  }
}

export default function LocalServerSetup({ configured, onReady }: Props) {
  const [ready, setReady] = useState(configured);
  const [reason, setReason] = useState<string | null>(null);

  const checkService = useCallback(() => {
    void window.electron?.localStatus?.().then((status) => {
      if (!status) return;
      if (status.state === 'configured') setReady(true);
      else setReason(status.reason ?? null);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (ready) return undefined;
    checkService();
    const timer = window.setInterval(checkService, 2000);
    return () => window.clearInterval(timer);
  }, [ready, checkService]);

  const createBusiness = async (state: WizardState) => {
    const result = await localClient.auth.bootstrapOwner({
      email: state.account.email.trim(),
      password: state.account.password,
      tenantName: state.basics.businessName.trim(),
      branchName: state.basics.branchName.trim(),
      businessMode: state.mode ?? 'RETAIL',
    });
    if (result.error?.message === 'already_initialized') throw new Error('This computer already has an owner. Use "I already have an account" to sign in.');
    if (result.error || !result.data.session) throw new Error(result.error?.message ?? 'Local owner setup failed');
    const { data: roles } = await (supabase as any).from('user_roles').select('tenant_id').limit(1);
    const tenantId = roles?.[0]?.tenant_id as string | undefined;
    if (tenantId) await saveBasics(tenantId, state, FIRST_IN_APP_STEP);
    saveWizard({ ...state, step: FIRST_IN_APP_STEP });
    onReady();
  };

  return (
    <main className="min-h-screen bg-[#071832] text-white grid place-items-center p-6">
      <section className="w-full max-w-3xl rounded-2xl border border-cyan-900 bg-[#102849] p-8 shadow-2xl">
        <p className="mb-2 text-sm font-bold tracking-[0.18em] text-cyan-400">ZAIPOS THIS COMPUTER</p>
        <h1 className="mb-3 text-3xl font-bold">Set up the local server</h1>
        <p className="mb-7 leading-7 text-slate-300">
          ZAIPOS keeps the shop database on this computer. The first owner, branch, register, and server terminal are created here. No hosted project key is required.
        </p>
        {!ready ? (
          <div className="space-y-4">
            <p role="status" className="rounded-lg border border-amber-800 bg-amber-950/70 p-3 text-sm text-amber-100">
              {localServiceWaitingCopy(reason)}
            </p>
            <button type="button" className="w-full rounded-lg border border-slate-500 px-4 py-3 font-semibold text-slate-200" onClick={checkService}>
              Check again
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <SetupWizard local onCreateBusiness={createBusiness} />
            <button type="button" className="w-full rounded-lg border border-slate-500 px-4 py-3 font-semibold text-slate-200" onClick={onReady}>
              I already have an account
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
