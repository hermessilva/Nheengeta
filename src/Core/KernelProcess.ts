//------------------------------------------------------------------------------
// KernelProcess — owns one `dotnet interactive stdio` child process.
//
// Sends command envelopes as single JSON lines on stdin; parses newline-
// delimited JSON events from stdout and routes them to the pending command
// (matched by token) plus any global listeners.
//------------------------------------------------------------------------------

import { ChildProcess, spawn } from "child_process";
import {
    XKernelCommandEnvelope,
    XKernelEventEnvelope,
    EventToken,
    EventTypes,
    IsTerminalEvent
} from "./KernelProtocol";

export interface XKernelProcessOptions {
    DotnetPath: string;
    ExtraArgs: string[];
    /** Extra/overridden environment variables for the kernel process. */
    Env?: Record<string, string>;
    WorkingDirectory?: string;
    /** Called for every event, before per-command routing. */
    OnEvent?: (pEvent: XKernelEventEnvelope) => void;
    OnExit?: (pCode: number | null) => void;
    OnStderr?: (pText: string) => void;
}

interface XPendingCommand {
    OnEvent: (pEvent: XKernelEventEnvelope) => void;
    Resolve: (pSucceeded: boolean, pError?: string) => void;
}

export class XKernelProcess {
    private _Process: ChildProcess | undefined;
    private _StdoutBuffer = "";
    private _Pending = new Map<string, XPendingCommand>();
    private _Ready: Promise<void> | undefined;
    private _Disposed = false;

    public constructor(private readonly _Options: XKernelProcessOptions) {
    }

    public get IsRunning(): boolean {
        return this._Process !== undefined && this._Process.exitCode === null && !this._Process.killed;
    }

    /** Spawn the kernel and wait for KernelReady. Idempotent while running. */
    public Start(): Promise<void> {
        if (this._Disposed)
            return Promise.reject(new Error("Kernel process has been disposed."));
        if (this.IsRunning && this._Ready)
            return this._Ready;

        const args = ["interactive", "stdio", ...this._Options.ExtraArgs];
        const proc = spawn(this._Options.DotnetPath, args, {
            cwd: this._Options.WorkingDirectory,
            env: this._Options.Env ? { ...process.env, ...this._Options.Env } : process.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true
        });
        this._Process = proc;
        this._StdoutBuffer = "";

        proc.stdout?.setEncoding("utf8");
        proc.stdout?.on("data", (pChunk: string) => this.OnStdout(pChunk));
        proc.stderr?.setEncoding("utf8");
        proc.stderr?.on("data", (pChunk: string) => this._Options.OnStderr?.(pChunk));
        proc.on("exit", (pCode) => {
            this.FailAllPending(`Kernel process exited (code ${pCode ?? "unknown"}).`);
            this._Options.OnExit?.(pCode);
        });

        this._Ready = new Promise<void>((pResolve, pReject) => {
            const timeout = setTimeout(() => {
                readyListener.Cancel();
                pReject(new Error("Timed out waiting for the kernel to become ready (30s)."));
            }, 30000);
            const readyListener = this.AddTransientListener((pEvent) => {
                if (pEvent.eventType === EventTypes.KernelReady) {
                    clearTimeout(timeout);
                    pResolve();
                    return true;
                }
                return false;
            });
            proc.on("error", (pErr) => {
                clearTimeout(timeout);
                readyListener.Cancel();
                pReject(new Error(`Could not start the kernel: ${pErr.message}`));
            });
            proc.on("exit", (pCode) => {
                clearTimeout(timeout);
                readyListener.Cancel();
                pReject(new Error(`Kernel exited during startup (code ${pCode ?? "unknown"}).`));
            });
        });
        return this._Ready;
    }

    /**
     * Send a command and stream its correlated events to `pOnEvent` until a
     * terminal event arrives. Resolves true on CommandSucceeded.
     */
    public async Execute(
        pEnvelope: XKernelCommandEnvelope,
        pOnEvent: (pEvent: XKernelEventEnvelope) => void
    ): Promise<{ Succeeded: boolean; Error?: string }> {
        await this.Start();
        const proc = this._Process;
        if (!proc?.stdin)
            throw new Error("Kernel process is not running.");

        return new Promise((pResolve) => {
            this._Pending.set(pEnvelope.token, {
                OnEvent: pOnEvent,
                Resolve: (pSucceeded, pError) => pResolve({ Succeeded: pSucceeded, Error: pError })
            });
            proc.stdin!.write(JSON.stringify(pEnvelope) + "\n");
        });
    }

    /** Kill the process. Pending commands fail. */
    public Stop(): void {
        const proc = this._Process;
        this._Process = undefined;
        this._Ready = undefined;
        this.FailAllPending("Kernel was stopped.");
        if (proc && proc.exitCode === null)
            proc.kill();
    }

    public async Restart(): Promise<void> {
        this.Stop();
        await this.Start();
    }

    public Dispose(): void {
        this._Disposed = true;
        this.Stop();
    }

    // ─── internals ──────────────────────────────────────────────────────────

    private _TransientListeners: Array<(pEvent: XKernelEventEnvelope) => boolean> = [];

    /** Listener consulted for every event; return true to unsubscribe. */
    private AddTransientListener(pListener: (pEvent: XKernelEventEnvelope) => boolean): { Cancel: () => void } {
        this._TransientListeners.push(pListener);
        return {
            Cancel: () => {
                this._TransientListeners = this._TransientListeners.filter((l) => l !== pListener);
            }
        };
    }

    private OnStdout(pChunk: string): void {
        this._StdoutBuffer += pChunk;
        let newlineIndex = this._StdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = this._StdoutBuffer.slice(0, newlineIndex).trim();
            this._StdoutBuffer = this._StdoutBuffer.slice(newlineIndex + 1);
            if (line.length > 0)
                this.OnLine(line);
            newlineIndex = this._StdoutBuffer.indexOf("\n");
        }
    }

    private OnLine(pLine: string): void {
        let envelope: XKernelEventEnvelope;
        try {
            envelope = JSON.parse(pLine) as XKernelEventEnvelope;
        }
        catch {
            return; // non-JSON noise on stdout (e.g. first-run banner)
        }
        if (!envelope.eventType)
            return;

        this._Options.OnEvent?.(envelope);
        this._TransientListeners = this._TransientListeners.filter((l) => !l(envelope));

        const token = EventToken(envelope);
        if (!token)
            return;
        const pending = this._Pending.get(token);
        if (!pending)
            return;

        pending.OnEvent(envelope);
        if (IsTerminalEvent(envelope.eventType)) {
            this._Pending.delete(token);
            const failed = envelope.eventType === EventTypes.CommandFailed;
            const message = failed ? String(envelope.event?.message ?? "Command failed.") : undefined;
            pending.Resolve(!failed, message);
        }
    }

    private FailAllPending(pReason: string): void {
        for (const pending of this._Pending.values())
            pending.Resolve(false, pReason);
        this._Pending.clear();
    }
}
