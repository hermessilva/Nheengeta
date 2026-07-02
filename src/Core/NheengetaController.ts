//------------------------------------------------------------------------------
// NheengetaController — the NotebookController that executes cells through the
// dotnet-interactive kernel (or a host subkernel matched by magic).
//------------------------------------------------------------------------------

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { XKernelProcess } from "./KernelProcess";
import { XKernelInstaller } from "./KernelInstaller";
import { XSubkernelRegistry } from "./SubkernelRegistry";
import { KernelNameForLanguage } from "./NheengetaSerializer";
import {
    CreateCommand,
    CreateSubmitCode,
    EventTypes,
    XKernelEventEnvelope,
    XValueProducedEvent,
    XDiagnosticsProducedEvent
} from "./KernelProtocol";

export interface XVariableInfo {
    Name: string;
    TypeName: string;
    Value: string;
}

import { EvaluateMath } from "../Math/MathEngine";
import { XDependencyManager } from "./DependencyManager";

export const NotebookType = "nheengeta";
const SupportedLanguages = ["csharp", "fsharp", "powershell", "javascript", "sql", "kql", "html", "mermaid", "python", "r", "math"];

export const MermaidMimeType = "text/vnd.mermaid";
export const PlotMimeType = "application/vnd.nheengeta.plot+json";
export const MathMimeType = "application/vnd.nheengeta.math+json";

/** Connector nuget packages loaded on demand when #!connect <name> is used. */
const ConnectorPackages: Record<string, string> = {
    mssql: "Microsoft.DotNet.Interactive.SqlServer, *-*",
    kusto: "Microsoft.DotNet.Interactive.Kusto, *-*"
};

/** Error whose rendered output is just the message — no extension-host stack. */
function CleanError(pMessage: string): Error {
    const error = new Error(pMessage);
    error.name = "";
    error.stack = pMessage;
    return error;
}

export class XNheengetaController {
    private readonly _Controller: vscode.NotebookController;
    private readonly _Output: vscode.OutputChannel;
    private _Kernel: XKernelProcess | undefined;
    private _ExecutionOrder = 0;
    private readonly _KernelsUsed = new Set<string>();
    private readonly _OnDidExecute = new vscode.EventEmitter<void>();

    /** Fires after each cell execution — variable views refresh on it. */
    public readonly OnDidExecute = this._OnDidExecute.event;

    /** Kernel names that executed code in this session (csharp, fsharp, ...). */
    public get KernelsUsed(): string[] {
        return [...this._KernelsUsed];
    }

    public constructor(
        private readonly _Context: vscode.ExtensionContext,
        private readonly _Subkernels: XSubkernelRegistry
    ) {
        this._Output = vscode.window.createOutputChannel("Nheengetá Kernel");
        this._Controller = vscode.notebooks.createNotebookController(
            "nheengeta-dotnet-interactive",
            NotebookType,
            "Nheengetá (.NET Interactive)");
        this._Controller.supportedLanguages = SupportedLanguages;
        this._Controller.supportsExecutionOrder = true;
        this._Controller.description = "Polyglot execution via the dotnet-interactive kernel";
        this._Controller.executeHandler = (pCells, _pNotebook, _pController) => this.ExecuteCells(pCells);

        _Context.subscriptions.push(this._Controller, this._Output, { dispose: () => this._Kernel?.Dispose() });

        // Preferred affinity auto-selects this controller when a .nhg opens.
        // Without a selected controller the cell toolbar renders only a
        // minimal action set until the first execution.
        const preferController = (pNotebook: vscode.NotebookDocument): void => {
            if (pNotebook.notebookType === NotebookType)
                this._Controller.updateNotebookAffinity(pNotebook, vscode.NotebookControllerAffinity.Preferred);
        };
        for (const notebook of vscode.workspace.notebookDocuments)
            preferController(notebook);
        _Context.subscriptions.push(vscode.workspace.onDidOpenNotebookDocument(preferController));
    }

    public async RestartKernel(): Promise<void> {
        if (this._Kernel) {
            this._LoadedConnectors.clear();
            await this._Kernel.Restart();
            void vscode.window.showInformationMessage("Nheengetá: kernel restarted.");
        }
    }

    // ─── local math execution (mathjs) ───────────────────────────────────────

    private readonly _MathScopes = new Map<string, Record<string, unknown>>();

    private async ExecuteMath(pCode: string, pCell: vscode.NotebookCell, pExecution: vscode.NotebookCellExecution): Promise<boolean> {
        const key = pCell.notebook.uri.toString();
        let scope = this._MathScopes.get(key);
        if (!scope) {
            scope = {};
            this._MathScopes.set(key, scope);
        }
        const result = EvaluateMath(pCode, scope);
        if (result.Lines.length > 0) {
            await pExecution.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.json({ Lines: result.Lines }, MathMimeType),
                vscode.NotebookCellOutputItem.text(result.Lines.map((l) => l.Text).join("\n"), "text/plain")
            ]));
        }
        for (const plot of result.Plots) {
            await pExecution.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.json(plot, PlotMimeType)
            ]));
        }
        if (result.Error) {
            await pExecution.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.error(CleanError(result.Error))
            ]));
            return false;
        }
        return true;
    }

    // ─── local JavaScript execution (Node) ───────────────────────────────────

    /** Run a JS cell in Node — the extension host binary in node mode, so no
     *  PATH dependency. Returns true on exit code 0. */
    private async ExecuteJavaScript(pCode: string, pExecution: vscode.NotebookCellExecution, pEnv?: Record<string, string>): Promise<boolean> {
        const directory = path.join(os.tmpdir(), "nheengeta-run");
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
        const file = path.join(directory, "cell.js");
        await vscode.workspace.fs.writeFile(vscode.Uri.file(file), new TextEncoder().encode(pCode));

        return new Promise<boolean>((pResolve) => {
            const proc = spawn(process.execPath, [file], {
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...pEnv },
                windowsHide: true
            });
            let stdout = "";
            let stderr = "";
            proc.stdout.setEncoding("utf8");
            proc.stdout.on("data", (pChunk: string) => { stdout += pChunk; });
            proc.stderr.setEncoding("utf8");
            proc.stderr.on("data", (pChunk: string) => { stderr += pChunk; });
            proc.on("error", (pErr) => {
                void pExecution.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error(CleanError(pErr.message))
                ]));
                pResolve(false);
            });
            proc.on("exit", (pCodeExit) => {
                void (async () => {
                    if (stdout.length > 0) {
                        await pExecution.appendOutput(new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text(stdout, "text/plain")
                        ]));
                    }
                    if (pCodeExit !== 0 && stderr.length > 0) {
                        await pExecution.appendOutput(new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.error(CleanError(stderr.trim()))
                        ]));
                    }
                    else if (stderr.length > 0) {
                        await pExecution.appendOutput(new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text(stderr, "text/plain")
                        ]));
                    }
                    pResolve(pCodeExit === 0);
                })();
            });
        });
    }

    // ─── connector preload ───────────────────────────────────────────────────

    private readonly _LoadedConnectors = new Set<string>();

    /** Load the nuget connector package(s) referenced by a #!connect cell. */
    private async EnsureConnectors(
        pKernel: XKernelProcess,
        pCode: string,
        pExecution: vscode.NotebookCellExecution
    ): Promise<void> {
        for (const [name, packageRef] of Object.entries(ConnectorPackages)) {
            if (!new RegExp(`#!connect\\s+${name}\\b`).test(pCode) || this._LoadedConnectors.has(name))
                continue;
            await pExecution.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text(`Loading ${name} connector (nuget)…`, "text/plain")
            ]));
            const load = await pKernel.Execute(
                CreateSubmitCode(`#r "nuget:${packageRef}"`, "csharp"),
                () => { /* progress events ignored */ });
            if (load.Succeeded)
                this._LoadedConnectors.add(name);
        }
    }

    // ─── execution ──────────────────────────────────────────────────────────

    private async ExecuteCells(pCells: vscode.NotebookCell[]): Promise<void> {
        for (const cell of pCells)
            await this.ExecuteCell(cell);
    }

    private async ExecuteCell(pCell: vscode.NotebookCell): Promise<void> {
        const execution = this._Controller.createNotebookCellExecution(pCell);
        execution.executionOrder = ++this._ExecutionOrder;
        execution.start(Date.now());
        await execution.clearOutput();

        try {
            let code = pCell.document.getText();
            const languageId = pCell.document.languageId;

            // Host subkernel (e.g. #!dase) takes precedence over the kernel.
            const subkernelMatch = this._Subkernels.Match(code);
            if (subkernelMatch) {
                const outputs = await subkernelMatch.Subkernel.Execute(subkernelMatch.Body, pCell);
                for (const output of outputs)
                    await execution.appendOutput(output);
                execution.end(true, Date.now());
                return;
            }

            // `#!use pkg` lines: resolve dependencies with the right package
            // manager for the cell language, then run the remaining code.
            let cellEnv: Record<string, string> | undefined;
            if (/^[ \t]*#!use[ \t]/m.test(code)) {
                const prepared = await XDependencyManager.Prepare(languageId, code);
                code = prepared.Code;
                cellEnv = prepared.Env;
                if (prepared.Notes.length > 0) {
                    await execution.appendOutput(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(prepared.Notes.join("\n"), "text/plain")
                    ]));
                }
            }

            // Math cells evaluate in-process with mathjs; scope persists per
            // notebook, plots render through the PlotRenderer.
            if (languageId === "math") {
                const ok = await this.ExecuteMath(code, pCell, execution);
                if (ok)
                    this._OnDidExecute.fire();
                execution.end(ok, Date.now());
                return;
            }

            // JavaScript runs locally in Node (same runtime Debug Cell uses).
            // The dotnet-interactive javascript kernel only executes in a
            // browser client, so stdio submissions to it always fail.
            if (languageId === "javascript") {
                const ok = await this.ExecuteJavaScript(code, execution, cellEnv);
                if (ok)
                    this._OnDidExecute.fire();
                execution.end(ok, Date.now());
                return;
            }

            // Presentational cells render locally — no kernel round-trip.
            if (languageId === "mermaid") {
                await execution.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(code, MermaidMimeType)
                ]));
                execution.end(true, Date.now());
                return;
            }
            if (languageId === "html") {
                await execution.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(code, "text/html")
                ]));
                execution.end(true, Date.now());
                return;
            }

            const kernel = await this.EnsureKernel();
            if (!kernel) {
                execution.end(false, Date.now());
                return;
            }

            // #!connect is a root-kernel directive; connectors for mssql/kusto
            // live in nuget packages that must be loaded once per kernel session.
            let targetKernel = KernelNameForLanguage(languageId);
            if (/^\s*#!connect\b/m.test(code)) {
                targetKernel = ".NET";
                await this.EnsureConnectors(kernel, code, execution);
            }

            const envelope = CreateSubmitCode(code, targetKernel);
            const result = await kernel.Execute(envelope, (pEvent) => {
                void this.RenderEvent(pEvent, execution);
            });

            if (!result.Succeeded && result.Error) {
                await execution.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error(CleanError(result.Error))
                ]));
            }
            if (result.Succeeded && targetKernel && targetKernel !== ".NET")
                this._KernelsUsed.add(targetKernel);
            execution.end(result.Succeeded, Date.now());
            this._OnDidExecute.fire();
        }
        catch (err) {
            await execution.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.error(CleanError(err instanceof Error ? err.message : String(err)))
            ]));
            execution.end(false, Date.now());
        }
    }

    private async RenderEvent(pEvent: XKernelEventEnvelope, pExecution: vscode.NotebookCellExecution): Promise<void> {
        switch (pEvent.eventType) {
            case EventTypes.StandardOutputValueProduced:
            case EventTypes.StandardErrorValueProduced:
            case EventTypes.ReturnValueProduced:
            case EventTypes.DisplayedValueProduced:
            case EventTypes.DisplayedValueUpdated: {
                const value = pEvent.event as XValueProducedEvent;
                const items = (value.formattedValues ?? []).map((fv) =>
                    fv.mimeType === "text/html"
                        ? vscode.NotebookCellOutputItem.text(fv.value, "text/html")
                        : vscode.NotebookCellOutputItem.text(fv.value, fv.mimeType));
                if (items.length > 0)
                    await pExecution.appendOutput(new vscode.NotebookCellOutput(items));
                break;
            }
            case EventTypes.ErrorProduced: {
                const message = String(pEvent.event?.message ?? "Error");
                await pExecution.appendOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error(CleanError(message))
                ]));
                break;
            }
            case EventTypes.DiagnosticsProduced: {
                const diag = pEvent.event as XDiagnosticsProducedEvent;
                const errors = (diag.diagnostics ?? []).filter((d) => d.severity === "error");
                if (errors.length > 0) {
                    const text = errors.map((d) => `${d.code}: ${d.message}`).join("\n");
                    await pExecution.appendOutput(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.error(CleanError(text))
                    ]));
                }
                break;
            }
        }
    }

    // ─── variables (watch / edit) ────────────────────────────────────────────

    /** List variables of a subkernel via RequestValueInfos. */
    public async QueryVariables(pKernelName: string): Promise<XVariableInfo[]> {
        const kernel = this._Kernel;
        if (!kernel?.IsRunning)
            return [];
        const variables: XVariableInfo[] = [];
        await kernel.Execute(
            CreateCommand("RequestValueInfos", { targetKernelName: pKernelName, mimeType: "text/plain" }),
            (pEvent) => {
                if (pEvent.eventType !== "ValueInfosProduced")
                    return;
                const infos = (pEvent.event as { valueInfos?: Array<{ name: string; typeName?: string; formattedValue?: { value?: string } }> }).valueInfos ?? [];
                for (const info of infos) {
                    variables.push({
                        Name: info.name,
                        TypeName: info.typeName ?? "",
                        Value: info.formattedValue?.value ?? ""
                    });
                }
            });
        return variables;
    }

    /** Full value of one variable via RequestValue. */
    public async QueryVariableValue(pKernelName: string, pName: string): Promise<string | undefined> {
        const kernel = this._Kernel;
        if (!kernel?.IsRunning)
            return undefined;
        let value: string | undefined;
        await kernel.Execute(
            CreateCommand("RequestValue", { name: pName, mimeType: "text/plain", targetKernelName: pKernelName }),
            (pEvent) => {
                if (pEvent.eventType !== "ValueProduced")
                    return;
                const ev = pEvent.event as { formattedValue?: { value?: string }; formattedValues?: Array<{ value?: string }> };
                value = ev.formattedValue?.value ?? ev.formattedValues?.[0]?.value;
            });
        return value;
    }

    /** Assign a new value by submitting language-appropriate code. */
    public async SetVariable(pKernelName: string, pName: string, pExpression: string): Promise<{ Succeeded: boolean; Error?: string }> {
        const kernel = this._Kernel;
        if (!kernel?.IsRunning)
            return { Succeeded: false, Error: "Kernel is not running." };
        const assignments: Record<string, string> = {
            csharp: `${pName} = ${pExpression};`,
            fsharp: `${pName} <- ${pExpression}`,
            javascript: `${pName} = ${pExpression};`,
            pwsh: `$${pName.replace(/^\$/, "")} = ${pExpression}`
        };
        const code = assignments[pKernelName] ?? `${pName} = ${pExpression}`;
        const result = await kernel.Execute(CreateSubmitCode(code, pKernelName), () => { /* outputs ignored */ });
        if (result.Succeeded)
            this._OnDidExecute.fire();
        return result;
    }

    // ─── kernel lifecycle ────────────────────────────────────────────────────

    private async EnsureKernel(): Promise<XKernelProcess | undefined> {
        if (this._Kernel?.IsRunning)
            return this._Kernel;

        const ready = await XKernelInstaller.EnsureReady();
        if (!ready)
            return undefined;

        if (!this._Kernel) {
            const config = vscode.workspace.getConfiguration("nheengeta");
            this._Kernel = new XKernelProcess({
                DotnetPath: XKernelInstaller.DotnetPath(),
                ExtraArgs: config.get<string[]>("kernelArgs") ?? [],
                WorkingDirectory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                OnStderr: (pText) => this._Output.append(pText),
                OnExit: (pCode) => {
                    this._LoadedConnectors.clear();
                    this._Output.appendLine(`[kernel exited: ${pCode}]`);
                }
            });
        }
        await this._Kernel.Start();
        return this._Kernel;
    }
}
