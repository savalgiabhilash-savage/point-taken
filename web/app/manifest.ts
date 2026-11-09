import type { MetadataRoute } from "next";

// Makes the site installable ("Add to Home Screen"): opens full screen, no browser bars, starts on My Team.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Point Taken: FPL Captain Picks & Transfer Planner",
    short_name: "Point Taken",
    description: "Independent Fantasy Premier League assistant: captain picks, transfer planner, chips, live points and ranks.",
    start_url: "/team",
    scope: "/",
    display: "standalone",
    background_color: "#0a1024",
    theme_color: "#0a1024",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
