//------------------------------------------------------------------------------
// MathEngine — evaluates #!math cells with mathjs (symbolic-lite CAS: algebra,
// derivatives, matrices, complex numbers, units, bignumbers).
// Each visible statement yields a line with plain text AND LaTeX (typeset by
// the KaTeX MathRenderer). plot() samples expressions into Plotly specs.
// Bundled by esbuild into out/Math/MathEngine.js (mathjs inlined).
//------------------------------------------------------------------------------

import { create, all, MathNode } from "mathjs";

const _Math = create(all);
const DefaultSamples = 400;

export interface XMathLine {
    Text: string;
    Latex?: string;
}

export interface XPlotTrace {
    x: Array<number | null>;
    y: Array<number | null>;
    name: string;
}

export interface XPlotSpec {
    traces: XPlotTrace[];
    layout: {
        title?: string;
        xRange?: [number, number];
        yRange?: [number, number];
        width?: number;
        height?: number;
    };
}

export interface XMathOutput {
    Lines: XMathLine[];
    Plots: XPlotSpec[];
    Error?: string;
}

interface XPlotOptions {
    from?: number;
    to?: number;
    samples?: number;
    title?: string;
    yDomain?: [number, number];
    width?: number;
    height?: number;
}

/**
 * Evaluate a math cell. `pScope` persists across cells of the same notebook,
 * so variables and functions defined earlier stay available.
 */
export function EvaluateMath(pCode: string, pScope: Record<string, unknown>): XMathOutput {
    const lines: XMathLine[] = [];
    const plots: XPlotSpec[] = [];
    InstallPlot(pScope, plots);

    let root: MathNode;
    try {
        root = _Math.parse(pCode);
    }
    catch (err) {
        return { Lines: lines, Plots: plots, Error: err instanceof Error ? err.message : String(err) };
    }

    const statements = root.type === "BlockNode"
        ? (root as unknown as { blocks: Array<{ node: MathNode; visible: boolean }> }).blocks
        : [{ node: root, visible: true }];

    try {
        for (const statement of statements) {
            const value = statement.node.compile().evaluate(pScope) as unknown;
            if (!statement.visible)
                continue;

            if (statement.node.type === "FunctionAssignmentNode") {
                lines.push({ Text: statement.node.toString(), Latex: SafeTex(statement.node) });
                continue;
            }
            if (value === undefined || typeof value === "function")
                continue;

            const text = typeof value === "string" ? value : _Math.format(value, { precision: 14 });
            const isAssignment = statement.node.type === "AssignmentNode";
            const lhs = isAssignment ? SafeTex(statement.node) : SafeTex(statement.node);
            const rhs = typeof value === "string" ? undefined : ValueTex(value);

            let latex: string | undefined;
            if (isAssignment)
                latex = lhs; // assignment tex already contains ":="-style equality
            else if (lhs && rhs)
                latex = `${lhs} \\;=\\; ${rhs}`;
            else
                latex = rhs ?? lhs;

            lines.push({ Text: text, Latex: latex });
        }
        return { Lines: lines, Plots: plots };
    }
    catch (err) {
        return { Lines: lines, Plots: plots, Error: err instanceof Error ? err.message : String(err) };
    }
}

// ─── plot() ──────────────────────────────────────────────────────────────────

function InstallPlot(pScope: Record<string, unknown>, pPlots: XPlotSpec[]): void {
    // plot("sin(x)") · plot(["sin(x)","cos(x)"], { from:-pi, to:pi, title:"..." })
    pScope["plot"] = (pExpressions: unknown, pOptions?: XPlotOptions): undefined => {
        const options = pOptions ?? {};
        const from = Number(options.from ?? -10);
        const to = Number(options.to ?? 10);
        const samples = Math.min(Math.max(Number(options.samples ?? DefaultSamples), 10), 5000);
        const expressions = Array.isArray(pExpressions) ? pExpressions : [pExpressions];

        const traces = expressions.map((pExpr): XPlotTrace => {
            const source = String(pExpr);
            const compiled = _Math.compile(source);
            const xs: Array<number | null> = [];
            const ys: Array<number | null> = [];
            const step = (to - from) / (samples - 1);
            for (let i = 0; i < samples; i++) {
                const x = from + i * step;
                let y: number | null = null;
                try {
                    const local: Record<string, unknown> = { x };
                    // expose the persistent scope (user functions/variables)
                    const merged = Object.assign(Object.create(null), pScope, local) as Record<string, unknown>;
                    const result = compiled.evaluate(merged) as unknown;
                    const value = typeof result === "number" ? result : Number(result);
                    y = Number.isFinite(value) ? value : null;
                }
                catch {
                    y = null; // singularity/domain error -> gap in the curve
                }
                xs.push(x);
                ys.push(y);
            }
            return { x: xs, y: ys, name: source };
        });

        pPlots.push({
            traces,
            layout: {
                title: options.title,
                xRange: [from, to],
                yRange: options.yDomain,
                width: options.width,
                height: options.height
            }
        });
        return undefined;
    };
}

// ─── LaTeX helpers ───────────────────────────────────────────────────────────

function SafeTex(pNode: MathNode): string | undefined {
    try {
        return pNode.toTex({ parenthesis: "auto" });
    }
    catch {
        return undefined;
    }
}

function ValueTex(pValue: unknown): string | undefined {
    const node = pValue as { isNode?: boolean; toTex?: (pOptions?: unknown) => string };
    if (node && node.isNode && typeof node.toTex === "function") {
        try {
            return node.toTex({ parenthesis: "auto" });
        }
        catch {
            return undefined;
        }
    }
    try {
        return _Math.parse(_Math.format(pValue, { precision: 14 })).toTex({ parenthesis: "auto" });
    }
    catch {
        return undefined;
    }
}
