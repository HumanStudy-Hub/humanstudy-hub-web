"use client";

import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

export type PlaygroundChart = {
  id: string;
  title: string;
  description: string;
  plotly: { data: Plotly.Data[]; layout?: Partial<Plotly.Layout> };
};

export type PlaygroundChartSet = {
  charts: PlaygroundChart[];
  interpretation?: string;
  source?: "agent" | "default";
};

const baseLayout: Partial<Plotly.Layout> = {
  autosize: true,
  paper_bgcolor: "white",
  plot_bgcolor: "white",
  font: { size: 11, color: "#334155" },
  margin: { t: 20, r: 16, b: 55, l: 55 },
  hovermode: "closest",
};

export default function PlaygroundCharts({ charts, interpretation, source }: PlaygroundChartSet) {
  return (
    <div className="space-y-6">
      {interpretation && (
        <section className="border border-gray-200 bg-white p-6">
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="font-serif text-lg font-bold text-gray-950">What this run shows</h3>
            <span className="text-[11px] text-gray-400">
              {source === "agent" ? "Written by the analysis agent" : "Generated from the run"}
            </span>
          </div>
          <div className="prose prose-sm mt-3 max-w-none text-gray-700 prose-headings:font-serif prose-headings:text-gray-950">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{interpretation}</ReactMarkdown>
          </div>
        </section>
      )}

      {charts.map((chart) => (
        <section key={chart.id} className="border border-gray-200 bg-white p-6">
          <h3 className="font-serif text-lg font-bold text-gray-950">{chart.title}</h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-500">{chart.description}</p>
          <div className="mt-4 overflow-x-auto">
            <Plot
              data={chart.plotly.data}
              layout={{ ...baseLayout, ...(chart.plotly.layout || {}) }}
              config={{ responsive: true, displayModeBar: false }}
              style={{ width: "100%", minHeight: 380 }}
              useResizeHandler
            />
          </div>
        </section>
      ))}
    </div>
  );
}
