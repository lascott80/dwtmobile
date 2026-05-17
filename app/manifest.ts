import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Disney Wait Times Mobile",
    short_name: "DWT Mobile",
    description: "Cached wait times and showtimes for all four Walt Disney World parks.",
    start_url: "/",
    display: "standalone",
    background_color: "#f2f2ef",
    theme_color: "#f2f2ef",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable"
      }
    ]
  };
}
