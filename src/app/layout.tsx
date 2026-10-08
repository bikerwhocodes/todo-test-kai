import type { ReactNode } from "react";

export const metadata = {
  title: "NextUp",
  description: "A private task planner that helps you decide what to do next.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          lineHeight: 1.6,
          margin: "0 auto",
          maxWidth: "42rem",
          padding: "3rem 1.5rem",
        }}
      >
        {children}
      </body>
    </html>
  );
}
