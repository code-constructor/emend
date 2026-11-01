import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { TooltipProvider } from "./components/ui/Tooltip.tsx";
import { createWebRouter } from "./router.tsx";

export function App({ queryClient, history }: { queryClient?: QueryClient; history?: RouterHistory } = {}) {
  const [client] = useState(() => queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [router] = useState(() => createWebRouter(history));
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
