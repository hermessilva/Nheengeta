//------------------------------------------------------------------------------
// PlotRenderer — renders "application/vnd.nheengeta.plot+json" outputs with
// Plotly (interactive hover, zoom, pan, PNG export). Bundled by esbuild.
//------------------------------------------------------------------------------

import Plotly from "plotly.js-dist-min";
import type { ActivationFunction } from "vscode-notebook-renderer";

interface XPlotTrace {
    x: Array<number | null>;
    y: Array<number | null>;
    name: string;
}

interface XPlotSpec {
    traces: XPlotTrace[];
    layout: {
        title?: string;
        xRange?: [number, number];
        yRange?: [number, number];
        width?: number;
        height?: number;
    };
}

export const activate: ActivationFunction = () => {
    return {
        renderOutputItem(pItem, pElement) {
            const spec = pItem.json() as XPlotSpec;
            pElement.replaceChildren();
            const target = document.createElement("div");
            pElement.appendChild(target);

            const foreground = getComputedStyle(document.body).color || "#cccccc";
            const grid = "rgba(127,127,127,0.25)";

            const traces = spec.traces.map((pTrace) => ({
                x: pTrace.x,
                y: pTrace.y,
                name: pTrace.name,
                type: "scatter" as const,
                mode: "lines" as const,
                connectgaps: false,
                line: { width: 2 }
            }));

            const layout: Record<string, unknown> = {
                title: spec.layout.title
                    ? { text: spec.layout.title, font: { color: foreground, size: 16 } }
                    : undefined,
                width: spec.layout.width ?? 680,
                height: spec.layout.height ?? 400,
                paper_bgcolor: "rgba(0,0,0,0)",
                plot_bgcolor: "rgba(0,0,0,0)",
                font: { color: foreground },
                margin: { t: spec.layout.title ? 48 : 24, r: 20, b: 44, l: 52 },
                showlegend: traces.length > 1,
                legend: { font: { color: foreground } },
                xaxis: {
                    gridcolor: grid,
                    zerolinecolor: "rgba(127,127,127,0.6)",
                    range: spec.layout.xRange
                },
                yaxis: {
                    gridcolor: grid,
                    zerolinecolor: "rgba(127,127,127,0.6)",
                    range: spec.layout.yRange
                }
            };

            try {
                void Plotly.newPlot(target, traces as never, layout as never, {
                    displaylogo: false,
                    responsive: false,
                    modeBarButtonsToRemove: ["lasso2d", "select2d"]
                } as never);
            }
            catch (err) {
                const pre = document.createElement("pre");
                pre.style.color = "var(--vscode-errorForeground, #f48771)";
                pre.textContent = `Plot: ${err instanceof Error ? err.message : String(err)}`;
                pElement.replaceChildren(pre);
            }
        }
    };
};
