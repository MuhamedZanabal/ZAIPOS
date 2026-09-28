import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LocalServerSetup from '@/components/setup/LocalServerSetup';

afterEach(() => {
  cleanup();
  delete window.electron;
});

describe('local server setup', () => {
  it('does not echo a service reason that is not on the allowlist', async () => {
    window.electron = {
      localStatus: vi.fn(async () => ({ state: 'not_configured' as const, reason: 'postgres://zaipos_service:secret@127.0.0.1/zaipos' as never })),
    } as unknown as Window['electron'];
    render(<LocalServerSetup configured={false} onReady={() => undefined} />);
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/checks again automatically/);
    expect(status).not.toHaveTextContent(/secret/);
  });

  it('shows the owner form once the installed service profile is visible', async () => {
    window.electron = {
      localStatus: vi.fn(async () => ({ state: 'configured' as const, origin: 'https://127.0.0.1:58321' })),
    } as unknown as Window['electron'];
    render(<LocalServerSetup configured={false} onReady={() => undefined} />);
    expect(await screen.findByLabelText('Shop name')).toBeInTheDocument();
    expect(screen.queryByText(/not ready/)).not.toBeInTheDocument();
  });

  it('shows a bounded starting message while the service is still provisioning', async () => {
    window.electron = {
      localStatus: vi.fn(async () => ({ state: 'not_configured' as const, reason: 'DATABASE_STARTING' as const })),
    } as unknown as Window['electron'];
    render(<LocalServerSetup configured={false} onReady={() => undefined} />);
    expect(await screen.findByRole('status')).toHaveTextContent(/starting the shop database/);
  });
});
