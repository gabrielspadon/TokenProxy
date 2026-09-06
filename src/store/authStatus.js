"use client";
import { create } from "zustand";

// GET /api/auth/status, read once per page load and after sign-in or sign-out.
export const useAuthStatus = create((set) => ({
  status: null,
  error: null,
  load: async () => {
    try {
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      const body = await res.json().catch(() => null);
      set(res.ok ? { status: body, error: null } : { error: body || {} });
    } catch (e) {
      set({ error: { error: e.message, code: "network" } });
    }
  },
}));
