import { create } from 'zustand';

interface NetworkState {
  isOnline: boolean;
  pendingSyncCount: number;
  syncAttentionCount: number;
  setOnline: (status: boolean) => void;
  setPendingSyncCount: (count: number) => void;
  setSyncAttentionCount: (count: number) => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  pendingSyncCount: 0,
  syncAttentionCount: 0,
  setOnline: (status) => set({ isOnline: status }),
  setPendingSyncCount: (count) => set({ pendingSyncCount: count }),
  setSyncAttentionCount: (count) => set({ syncAttentionCount: count }),
}));
