//------------------------------------------------------------------------------
// MathRenderer — renders "application/vnd.nheengeta.math+json" outputs with
// KaTeX: LaTeX-quality typeset mathematics. KaTeX CSS (fonts inlined as data
// URLs by the build) is injected once into the outputs webview.
//------------------------------------------------------------------------------

import katex from "katex";
import KatexCss from "./generated/katex-inline.css";
import type { ActivationFunction } from "vscode-notebook-renderer";

interface XMathLine {
    Text: string;
    Latex?: string;
}

const StyleId = "nheengeta-katex-style";

function EnsureStyles(): void {
    if (document.getElementById(StyleId))
        return;
    const style = document.createElement("style");
    style.id = StyleId;
    style.textContent = KatexCss + `
.nheengeta-math-line { margin: 6px 0; }
.nheengeta-math-line .katex { font-size: 1.15em; }
.nheengeta-math-text { font-family: var(--vscode-editor-font-family, monospace); opacity: 0.9; }
`;
    document.head.appendChild(style);
}

export const activate: ActivationFunction = () => {
    return {
        renderOutputItem(pItem, pElement) {
            EnsureStyles();
            const lines = (pItem.json() as { Lines: XMathLine[] }).Lines ?? [];
            pElement.replaceChildren();

            for (const line of lines) {
                const container = document.createElement("div");
                container.className = "nheengeta-math-line";
                if (line.Latex) {
                    try {
                        katex.render(line.Latex, container, { displayMode: true, throwOnError: true });
                        pElement.appendChild(container);
                        continue;
                    }
                    catch {
                        // fall back to plain text below
                    }
                }
                const pre = document.createElement("div");
                pre.className = "nheengeta-math-text";
                pre.textContent = line.Text;
                container.appendChild(pre);
                pElement.appendChild(container);
            }
        }
    };
};
