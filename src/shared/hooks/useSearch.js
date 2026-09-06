"use client";
import { useSyncExternalStore } from "react";

const none = () => () => {};
const read = () => window.location.search;
const server = () => null;

// The query string, null until hydrated. The surface never rewrites the URL in place.
export const useSearch = () => useSyncExternalStore(none, read, server);
