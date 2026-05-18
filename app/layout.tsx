import type { Metadata, Viewport } from "next";
import { PwaRegister } from "@/components/pwa-register";
import { VisitTracker } from "@/components/visit-tracker";
import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Disney Wait Times Mobile",
  description: "Mobile-first Walt Disney World wait times, hours, and showtimes.",
  applicationName: "Disney Wait Times Mobile",
  formatDetection: {
    telephone: false
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "DWT Mobile"
  },
  icons: {
    icon: "/icon.svg",
    apple: "/apple-icon"
  },
  other: {
    "apple-mobile-web-app-title": "DWT Mobile"
  }
};

export const viewport: Viewport = {
  themeColor: "#f2f2ef",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <PwaRegister />
        <VisitTracker />
        {children}
      </body>
    </html>
  );
}
