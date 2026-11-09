import type { MetadataRoute } from "next";

// Makes the site installable ("Add to Home Screen"): opens full screen, no browser bars, starts on My Team.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FPL Selector",
    short_name: "FPL Selector",
    description: "Fantasy Premier League decision tool: projected points, live scores, transfers and chips.",
    start_url: "/team",
    scope: "/",
    display: "standalone",
    background_color: "#0a0f0e",
    theme_color: "#0a0f0e",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
