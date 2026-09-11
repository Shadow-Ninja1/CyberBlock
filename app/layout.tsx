import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CyberBlock",
  description:
    "An on-chain market for supply-chain threat intel that buyers cannot inspect before paying. Findings are graded by a signed oracle before listing and publicly disclosed after an embargo.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
