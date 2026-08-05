"use client";

import { useEffect, useRef } from "react";
import type { Config, Data, Layout } from "plotly.js";

const collaborators = [
  { name: "University of California San Diego", city: "San Diego, United States", lat: 32.8801, lon: -117.234 },
  { name: "University of Lausanne", city: "Lausanne, Switzerland", lat: 46.5197, lon: 6.6323 },
  { name: "Carnegie Mellon University", city: "Pittsburgh, United States", lat: 40.4433, lon: -79.9436 },
  { name: "The University of Hong Kong", city: "Hong Kong", lat: 22.283, lon: 114.1371 },
  { name: "IRIDeS, Tohoku University", city: "Sendai, Japan", lat: 38.2506, lon: 140.856 },
  { name: "Stanford University", city: "Stanford, United States", lat: 37.4275, lon: -122.1697 },
  { name: "Massachusetts Institute of Technology", city: "Cambridge, United States", lat: 42.3601, lon: -71.0942 },
];

const hub = collaborators[0];
const partnershipLongitudes = collaborators.slice(1).flatMap((item) => [hub.lon, item.lon, null]);
const partnershipLatitudes = collaborators.slice(1).flatMap((item) => [hub.lat, item.lat, null]);

const data: Data[] = [
  {
    type: "scattergeo",
    mode: "lines",
    lon: partnershipLongitudes,
    lat: partnershipLatitudes,
    line: { width: 1, color: "rgba(8, 145, 178, 0.35)" },
    hoverinfo: "skip",
  },
  {
    type: "scattergeo",
    mode: "markers",
    lon: collaborators.map((item) => item.lon),
    lat: collaborators.map((item) => item.lat),
    text: collaborators.map((item) => `<b>${item.name}</b><br>${item.city}`),
    hoverinfo: "text",
    marker: {
      size: collaborators.map((_, index) => index === 0 ? 15 : 11),
      color: collaborators.map((_, index) => index === 0 ? "#0e7490" : "#06b6d4"),
      line: { color: "#ffffff", width: 2 },
      opacity: 0.95,
    },
  },
];

const layout: Partial<Layout> = {
  autosize: true,
  margin: { l: 0, r: 0, t: 0, b: 0 },
  paper_bgcolor: "#f7f9fa",
  plot_bgcolor: "#f7f9fa",
  showlegend: false,
  hoverlabel: {
    bgcolor: "#ffffff",
    bordercolor: "#d1d5db",
    font: { color: "#111827", size: 12, family: "Inter, system-ui, sans-serif" },
  },
  geo: {
    projection: { type: "natural earth" },
    bgcolor: "#f7f9fa",
    showframe: false,
    showcoastlines: true,
    coastlinecolor: "#9ca3af",
    coastlinewidth: 0.7,
    showland: true,
    landcolor: "#e5e7eb",
    showocean: true,
    oceancolor: "#f7f9fa",
    showcountries: true,
    countrycolor: "#ffffff",
    countrywidth: 0.5,
    lataxis: { range: [-58, 82] },
  },
};

const config: Partial<Config> = {
  responsive: true,
  displayModeBar: false,
};

export default function CollaborationMap() {
  const mapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let plotly: typeof import("plotly.js") | null = null;
    const mapElement = mapRef.current;

    async function renderMap() {
      const plotlyModule = await import("plotly.js-dist-min");
      plotly = plotlyModule.default;
      if (!mapElement || disposed) return;
      await plotly.newPlot(mapElement, data, layout, config);
    }

    void renderMap();
    return () => {
      disposed = true;
      if (plotly && mapElement) plotly.purge(mapElement);
    };
  }, []);

  return (
    <div className="h-[430px] w-full sm:h-[560px]">
      <div ref={mapRef} className="h-full w-full" aria-label="World map of HumanStudy-Hub partnerships" />
    </div>
  );
}
