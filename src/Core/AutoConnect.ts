//------------------------------------------------------------------------------
// AutoConnect — zero-setup connections for novice users. When a sql/python/r
// cell runs with no prior #!connect, this class works out the connection by
// itself: detects LocalDB instances, detects (or pip-installs) Jupyter, and
// returns the #!connect line the controller should submit.
//
// pip --user installs jupyter into a Scripts directory that is NOT on PATH
// (e.g. %APPDATA%\Python\Python310\Scripts). PythonPathAdditions() exposes
// those directories; the controller adds them to the kernel process PATH so
// the jupyter connector finds the CLI without any user action.
//------------------------------------------------------------------------------

import { execFile } from "child_process";
import * as path from "path";

export class XAutoConnect {

    private static _PythonCommand: string | null | undefined;
    private static _PathAdditions: string[] | undefined;

    /** Note callback so progress lands in the cell output. */
    public static async ConnectCode(
        pLanguageId: string,
        pNote: (pText: string) => Promise<void>
    ): Promise<string | undefined> {
        switch (pLanguageId) {
            case "sql": return this.SqlConnectCode(pNote);
            case "python": return this.PythonConnectCode(pNote);
            case "r": return this.RConnectCode(pNote);
            default: return undefined; // kql needs cluster/database from the user
        }
    }

    /** Python Scripts dirs (user + venv) to prepend to the kernel PATH. */
    public static async PythonPathAdditions(): Promise<string[]> {
        if (this._PathAdditions)
            return this._PathAdditions;
        const python = await this.FindPython();
        if (!python) {
            this._PathAdditions = [];
            return this._PathAdditions;
        }
        const script = "import sysconfig\n" +
            "print(sysconfig.get_path('scripts', 'nt_user'))\n" +
            "print(sysconfig.get_path('scripts'))";
        const output = await this.Run(python, ["-c", script.replace(/\n/g, ";")], 20000);
        this._PathAdditions = (output ?? "")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && path.isAbsolute(l));
        return this._PathAdditions;
    }

    /** PATH value with the python Scripts dirs prepended. */
    public static async AugmentedPath(): Promise<string> {
        const additions = await this.PythonPathAdditions();
        return [...additions, process.env["PATH"] ?? ""].join(path.delimiter);
    }

    // ─── SQL: LocalDB auto-discovery ─────────────────────────────────────────

    private static async SqlConnectCode(pNote: (pText: string) => Promise<void>): Promise<string | undefined> {
        const info = await this.Run("sqllocaldb", ["info"], 30000);
        if (info === undefined)
            return undefined;
        const instances = info.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
        if (instances.length === 0)
            return undefined;
        const instance = instances.includes("MSSQLLocalDB") ? "MSSQLLocalDB" : instances[0];
        await pNote(`🔌 No connection yet — auto-connecting to (localdb)\\${instance}…`);
        return `#!connect mssql --kernel-name auto "Server=(localdb)\\${instance};Integrated Security=true;TrustServerCertificate=true"`;
    }

    // ─── Python: Jupyter auto-detect / auto-install ──────────────────────────

    private static async PythonConnectCode(pNote: (pText: string) => Promise<void>): Promise<string | undefined> {
        if (await this.HasKernelSpec("python"))
            return "#!connect jupyter --kernel-name python --kernel-spec python3";

        const python = await this.FindPython();
        if (!python) {
            await pNote("Python not found. Install it from https://www.python.org/downloads (check \"Add to PATH\") and run the cell again.");
            return undefined;
        }

        await pNote(`🐍 Jupyter not found — installing automatically with ${python} -m pip (first time only, a few minutes)…`);
        // ipykernel 7 changed the ZMQ handshake and hangs the dotnet-interactive
        // jupyter connector — pin to the 6.x line, which connects fine.
        const install = await this.Run(python, ["-m", "pip", "install", "--user", "jupyter", "ipykernel<7"], 600000);
        if (install === undefined) {
            await pNote("pip install failed — check your network and try again.");
            return undefined;
        }
        await pNote("✅ Jupyter installed.");
        if (await this.HasKernelSpec("python"))
            return "#!connect jupyter --kernel-name python --kernel-spec python3";
        await pNote("Jupyter installed but the python3 kernelspec is still not visible — restart VS Code and run the cell again.");
        return undefined;
    }

    private static async RConnectCode(pNote: (pText: string) => Promise<void>): Promise<string | undefined> {
        if (await this.HasKernelSpec("ir"))
            return "#!connect jupyter --kernel-name r --kernel-spec ir";
        await pNote("R needs the IRkernel registered in Jupyter. In an R console run: install.packages('IRkernel'); IRkernel::installspec()");
        return undefined;
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    /** `jupyter kernelspec list` with the python Scripts dirs on PATH. */
    private static async HasKernelSpec(pSpecPrefix: string): Promise<boolean> {
        const output = await this.Run("jupyter", ["kernelspec", "list"], 30000, await this.AugmentedPath());
        return output !== undefined && new RegExp(`^\\s*${pSpecPrefix}`, "mi").test(output);
    }

    private static async FindPython(): Promise<string | undefined> {
        if (this._PythonCommand !== undefined)
            return this._PythonCommand ?? undefined;
        for (const candidate of ["py", "python", "python3"]) {
            const version = await this.Run(candidate, ["--version"], 15000);
            if (version !== undefined && /Python 3/i.test(version)) {
                this._PythonCommand = candidate;
                return candidate;
            }
        }
        this._PythonCommand = null;
        return undefined;
    }

    /** Run a process; resolve stdout+stderr on exit 0, undefined otherwise. */
    private static Run(pFile: string, pArgs: string[], pTimeoutMs: number, pPath?: string): Promise<string | undefined> {
        return new Promise((pResolve) => {
            const env = pPath ? { ...process.env, PATH: pPath, Path: pPath } : process.env;
            // shell:true concatenates args — quote the ones cmd would mangle
            const args = pArgs.map((a) => /[\s;()&^|<>"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
            execFile(pFile, args, { timeout: pTimeoutMs, windowsHide: true, shell: true, env }, (pErr, pStdout, pStderr) => {
                pResolve(pErr ? undefined : `${pStdout}\n${pStderr}`);
            });
        });
    }
}
