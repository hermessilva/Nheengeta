declare module "plotly.js-dist-min" {
    const Plotly: {
        newPlot(pTarget: HTMLElement, pData: unknown, pLayout?: unknown, pConfig?: unknown): Promise<unknown>;
    };
    export default Plotly;
}
declare module "*.css" {
    const content: string;
    export default content;
}
