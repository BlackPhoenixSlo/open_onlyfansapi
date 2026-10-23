import { Outlet, createRootRoute } from '@tanstack/react-router';
import { Toaster } from '@/components/ui/sonner';

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      {/* Top-center: clear of the help launcher and its dock, both bottom-right. */}
      <Toaster position="top-center" />
    </>
  ),
});
