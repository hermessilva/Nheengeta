//------------------------------------------------------------------------------
// CellCommands — commands behind Nheengetá's own cell-toolbar buttons.
// Menu invocations pass the target NotebookCell; palette invocations fall back
// to the active notebook selection.
//------------------------------------------------------------------------------

import * as vscode from "vscode";

export class XCellCommands {

    private static _ExtensionUri: vscode.Uri;

    public static Register(pContext: vscode.ExtensionContext): void {
        this._ExtensionUri = pContext.extensionUri;
        pContext.subscriptions.push(
            vscode.commands.registerCommand("Nheengeta.CopyCellOutput", (pCell?: vscode.NotebookCell) => this.CopyOutput(pCell)),
            vscode.commands.registerCommand("Nheengeta.SelectCellLanguage", (pCell?: vscode.NotebookCell) => this.SelectLanguage(pCell)),
            vscode.commands.registerCommand("Nheengeta.RunToHere", (pCell?: vscode.NotebookCell) => this.RunToHere(pCell)),
            vscode.commands.registerCommand("Nheengeta.ExportCellOutput", (pCell?: vscode.NotebookCell) => this.ExportOutput(pCell)));
    }

    /** Cell from the menu context, or the active selection as fallback. */
    private static TargetCell(pCell?: vscode.NotebookCell): vscode.NotebookCell | undefined {
        if (pCell)
            return pCell;
        const editor = vscode.window.activeNotebookEditor;
        if (!editor || editor.selection.isEmpty)
            return undefined;
        return editor.notebook.cellAt(editor.selection.start);
    }

    // ─── Select language ─────────────────────────────────────────────────────

    private static async SelectLanguage(pCell?: vscode.NotebookCell): Promise<void> {
        const cell = this.TargetCell(pCell);
        if (!cell)
            return;

        interface XLanguagePick extends vscode.QuickPickItem { LanguageId?: string; Native?: boolean; }
        const icon = (pName: string): vscode.Uri =>
            vscode.Uri.joinPath(this._ExtensionUri, "media", "langs", `${pName}.svg`);
        // $(bug) marks languages with Debug Cell support.
        const picks: XLanguagePick[] = [
            { label: "C#", description: "#!csharp", LanguageId: "csharp", iconPath: icon("csharp") },
            { label: "F#", description: "#!fsharp", LanguageId: "fsharp", iconPath: icon("fsharp") },
            { label: "PowerShell $(bug)", description: "#!pwsh — debuggable", LanguageId: "powershell", iconPath: icon("powershell") },
            { label: "JavaScript $(bug)", description: "#!javascript — debuggable", LanguageId: "javascript", iconPath: icon("javascript") },
            { label: "Python $(bug)", description: "#!python — debuggable · needs #!connect jupyter", LanguageId: "python", iconPath: icon("python") },
            { label: "R", description: "#!r — needs #!connect jupyter", LanguageId: "r", iconPath: icon("r") },
            { label: "SQL", description: "#!sql — needs #!connect mssql", LanguageId: "sql", iconPath: icon("sql") },
            { label: "KQL", description: "#!kql — needs #!connect kusto", LanguageId: "kql", iconPath: icon("kql") },
            { label: "HTML", description: "#!html — rendered inline", LanguageId: "html", iconPath: icon("html") },
            { label: "Mermaid", description: "#!mermaid — diagram", LanguageId: "mermaid", iconPath: icon("mermaid") },
            { label: "", kind: vscode.QuickPickItemKind.Separator },
            { label: "$(list-selection) All languages…", description: "native language picker", Native: true }
        ];

        const pick = await vscode.window.showQuickPick(picks, {
            title: "Nheengetá — cell language ($(bug) = debuggable)",
            placeHolder: `Current: ${cell.document.languageId}`
        });
        if (!pick)
            return;

        if (pick.Native) {
            const editor = vscode.window.activeNotebookEditor;
            if (editor && editor.notebook === cell.notebook)
                editor.selection = new vscode.NotebookRange(cell.index, cell.index + 1);
            await vscode.commands.executeCommand("notebook.cell.changeLanguage");
            return;
        }
        if (pick.LanguageId)
            await vscode.languages.setTextDocumentLanguage(cell.document, pick.LanguageId);
    }

    // ─── Run to here ─────────────────────────────────────────────────────────

    private static async RunToHere(pCell?: vscode.NotebookCell): Promise<void> {
        const cell = this.TargetCell(pCell);
        if (!cell)
            return;
        await vscode.commands.executeCommand("notebook.cell.execute", {
            ranges: [{ start: 0, end: cell.index + 1 }],
            document: cell.notebook.uri
        });
    }

    // ─── Copy / export output ────────────────────────────────────────────────

    /** Preferred textual representation of a cell's outputs. */
    private static OutputText(pCell: vscode.NotebookCell): { Text: string; IsHtml: boolean } | undefined {
        const decoder = new TextDecoder("utf-8");
        const parts: string[] = [];
        let isHtml = false;
        for (const output of pCell.outputs) {
            const plain = output.items.find((i) => i.mime === "text/plain");
            const html = output.items.find((i) => i.mime === "text/html");
            const item = plain ?? html ?? output.items[0];
            if (!item)
                continue;
            if (!plain && item === html)
                isHtml = true;
            parts.push(decoder.decode(item.data));
        }
        if (parts.length === 0)
            return undefined;
        return { Text: parts.join("\n"), IsHtml: isHtml };
    }

    private static async CopyOutput(pCell?: vscode.NotebookCell): Promise<void> {
        const cell = this.TargetCell(pCell);
        if (!cell)
            return;
        const output = this.OutputText(cell);
        if (!output) {
            void vscode.window.showInformationMessage("Nheengetá: cell has no output to copy.");
            return;
        }
        await vscode.env.clipboard.writeText(output.Text);
        void vscode.window.showInformationMessage("Nheengetá: cell output copied.");
    }

    private static async ExportOutput(pCell?: vscode.NotebookCell): Promise<void> {
        const cell = this.TargetCell(pCell);
        if (!cell)
            return;
        const output = this.OutputText(cell);
        if (!output) {
            void vscode.window.showInformationMessage("Nheengetá: cell has no output to export.");
            return;
        }
        const extension = output.IsHtml ? "html" : "txt";
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        const target = await vscode.window.showSaveDialog({
            defaultUri: workspaceRoot ? vscode.Uri.joinPath(workspaceRoot, `cell-output.${extension}`) : undefined,
            filters: output.IsHtml
                ? { "HTML": ["html"], "Text": ["txt"] }
                : { "Text": ["txt"], "HTML": ["html"] },
            title: "Export Cell Output"
        });
        if (!target)
            return;
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(output.Text));
        void vscode.window.showInformationMessage(`Nheengetá: output exported to ${target.fsPath}`);
    }
}
