"use client";
import { create } from "zustand";

// The latest frame of /api/usage/stream. A full frame replaces everything; a
// lightweight push carries only the four live keys and merges over the rest.
export const useUsageStream = create((set) => ({
  data: null,
  receivedAt: null,
  apply: (frame) => set((s) => ({ data: { ...(s.data || {}), ...frame }, receivedAt: Date.now() })),
}));
