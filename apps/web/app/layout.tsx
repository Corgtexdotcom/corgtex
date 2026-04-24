import { ReactNode } from 'react';

// Since we have moved the main layout to app/[locale]/layout.tsx,
// Next.js still requires a root layout if there are any top-level pages
// or error boundaries (like global-error.tsx).
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
