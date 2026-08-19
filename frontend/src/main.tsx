import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App";
import { Toaster } from "@/components/ui/sonner";
import { startMockStreams, isTauri } from "@/lib/api";
import "@/styles/globals.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// init theme
document.documentElement.dataset.theme = "dark";

// start mock event streams in browser preview mode
if (!isTauri) startMockStreams();

// NOTE: no <StrictMode> — xterm.js + Radix primitives are not strictly
// double-mount-safe in dev; effects that throw on the 2nd mount would
// unmount the whole root (black screen).
ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider delayDuration={300}>
      <App />
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>
);
