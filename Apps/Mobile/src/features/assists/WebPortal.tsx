import type { ReactNode } from 'react';

/** Native: the sheet portals itself (Gorhom's modal provider), so children render in place. */
export function WindowLayer({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
