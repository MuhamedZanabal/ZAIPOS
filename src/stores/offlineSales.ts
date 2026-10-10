import { create } from 'zustand';

export type OfflineSaleFailure = { mutationId: string; error: string; createdAt: string };

interface OfflineSalesState {
  pending: number;
  failed: number;
  failures: OfflineSaleFailure[];
  serverReachable: boolean;
  set: (next: Partial<Omit<OfflineSalesState, 'set'>>) => void;
}

/** Sales held in the desktop's durable offline outbox (Electron main), per active branch. */
export const useOfflineSalesStore = create<OfflineSalesState>((set) => ({
  pending: 0,
  failed: 0,
  failures: [],
  serverReachable: true,
  set: (next) => set(next),
}));
