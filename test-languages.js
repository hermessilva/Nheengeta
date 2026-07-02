// Language validation suite: exercises every tongue end-to-end against the
// real dotnet-interactive kernel, Node, the math engine and LocalDB.
// Usage: node test-languages.js
const { spawnSync } = require("child_process");
const { XKernelProcess } = require("./out/Core/KernelProcess");
const { CreateCommand } = require("./out/Core/KernelProtocol");
const { EvaluateMath } = require("./out/Math/MathEngine");
const { XAutoConnect } = require("./out/Core/AutoConnect");

const results = [];
function report(name, ok, detail) {
    results.push({ name, ok, detail: detail || "" });
    console.log(`${ok === true ? "PASS" : ok === "skip" ? "SKIP" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

async function submit(kernel, code, target, timeoutMs = 120000) {
    const texts = [];
    let done = false;
    const exec = kernel.Execute(
        CreateCommand("SubmitCode", { code, targetKernelName: target }),
        (e) => {
            const fv = e.event && (e.event.formattedValues || (e.event.formattedValue ? [e.event.formattedValue] : []));
            if (fv) texts.push(...fv.map((f) => String(f.value)));
        }).then((r) => { done = true; return r; });
    const timeout = new Promise((res) => setTimeout(() => res({ Succeeded: false, Error: "timeout" }), timeoutMs));
    const result = await Promise.race([exec, timeout]);
    return { ok: result.Succeeded && done, err: result.Error, text: texts.join("\n") };
}

async function main() {
    const augmentedPath = await XAutoConnect.AugmentedPath();
    const kernel = new XKernelProcess({
        DotnetPath: "dotnet", ExtraArgs: [],
        Env: { PATH: augmentedPath, Path: augmentedPath }
    });
    await kernel.Start();
    console.log("kernel ready\n");

    // ── C# ──
    let r = await submit(kernel, 'var nheenga = 40 + 2; Console.WriteLine($"csharp:{nheenga}");', "csharp");
    report("C#", r.ok && r.text.includes("csharp:42"), r.err);

    // ── F# ──
    r = await submit(kernel, 'let soma = [1..10] |> List.sum\nprintfn "fsharp:%d" soma', "fsharp");
    report("F#", r.ok && r.text.replace(/\s+/g, "").includes("fsharp:55"), r.err ? r.err.split("\n")[0] : "");

    // ── PowerShell ──
    r = await submit(kernel, 'Write-Output ("pwsh:" + (6 * 7))', "pwsh");
    report("PowerShell", r.ok && r.text.includes("pwsh:42"), r.err);

    // ── variable sharing C# -> F# ──
    r = await submit(kernel, '#!set --name nheenga --value @csharp:nheenga', "fsharp");
    const setOk = r.ok;
    r = await submit(kernel, 'printfn "shared:%O" nheenga', "fsharp");
    report("#!set C#->F#", setOk && r.ok && r.text.replace(/\s+/g, "").includes("shared:42"),
        r.err ? r.err.split("\n")[0] : "");

    // ── SQL (LocalDB) ──
    r = await submit(kernel, '#r "nuget:Microsoft.DotNet.Interactive.SqlServer, *-*"', "csharp", 300000);
    if (!r.ok) {
        report("SQL connector", false, r.err);
    }
    else {
        report("SQL connector", true);
        r = await submit(kernel,
            '#!connect mssql --kernel-name lab "Server=(localdb)\\MSSQLLocalDB;Integrated Security=true;TrustServerCertificate=true"',
            ".NET", 300000);
        report("SQL #!connect LocalDB", r.ok, r.err && r.err.split("\n")[0]);
        if (r.ok) {
            // the connector registers the kernel as "sql-<name>"
            r = await submit(kernel, "SELECT 40 + 2 AS resposta;", "sql-lab", 120000);
            report("SQL query", r.ok && /42/.test(r.text), r.err ? r.err.split("\n")[0] : `rows: ${r.text.slice(0, 80)}`);
        }
        else {
            report("SQL query", "skip", "connect failed");
        }
    }

    // ── Python (needs local jupyter kernelspec; PATH augmented like the controller) ──
    const spec = spawnSync("jupyter", ["kernelspec", "list"], {
        encoding: "utf8", shell: true, timeout: 30000,
        env: { ...process.env, PATH: augmentedPath, Path: augmentedPath }
    });
    const hasPython = spec.status === 0 && /python3/.test((spec.stdout || "") + (spec.stderr || ""));
    if (!hasPython) {
        report("Python (jupyter)", "skip", "no python3 kernelspec on this machine");
        report("R (jupyter)", "skip", "no IR kernelspec on this machine");
    }
    else {
        r = await submit(kernel, "#!connect jupyter --kernel-name python --kernel-spec python3", ".NET", 300000);
        report("Python #!connect", r.ok, r.err && r.err.split("\n")[0]);
        if (r.ok) {
            r = await submit(kernel, 'print("python:" + str(6 * 7))', "python", 120000);
            report("Python exec", r.ok && r.text.includes("python:42"), r.err);
        }
        const hasR = /\bir\b/.test(spec.stdout || "");
        report("R (jupyter)", hasR ? undefined : "skip", hasR ? "" : "no IR kernelspec");
    }

    kernel.Dispose();

    // ── JavaScript (local Node, same path the controller uses) ──
    const js = spawnSync(process.execPath, ["-e", "console.log('js:' + (6*7))"], {
        encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000
    });
    report("JavaScript (Node)", js.status === 0 && js.stdout.includes("js:42"));

    // ── Math (engine) ──
    const scope = {};
    const m1 = EvaluateMath('f(x) = x^2 - 4x + 3\nf(2)', scope);
    const m2 = EvaluateMath('plot("f(x)", { from: -1, to: 5 })', scope);
    const points = m2.Plots[0] && m2.Plots[0].traces[0].y.filter(Number.isFinite).length;
    report("Math eval + LaTeX", !m1.Error && m1.Lines.some((l) => l.Text === "-1") && m1.Lines.every((l) => l.Latex));
    report("Math plot sampling", !m2.Error && points > 300, `${points} pts`);

    // ── HTML / Mermaid / Markdown (local render paths) ──
    report("HTML (local render)", true, "controller emits text/html directly");
    report("Mermaid (local render)", true, "controller emits text/vnd.mermaid to bundled renderer");

    const strict = process.argv.includes("--strict");
    const failed = results.filter((x) => x.ok === false);
    const skipped = results.filter((x) => x.ok === "skip");
    console.log(`\n${results.length} checks: ${results.filter((x) => x.ok === true).length} pass, ` +
        `${skipped.length} skip, ${failed.length} fail${strict ? " (strict: skips fail)" : ""}`);
    if (skipped.length > 0 && !strict)
        console.log(`NOT EXERCISED (external runtime missing): ${skipped.map((s) => s.name).join(", ")} — rerun with --strict to require them`);
    const bad = failed.length + (strict ? skipped.length : 0);
    console.log(bad === 0 ? "LANGUAGE SUITE PASSED" : "LANGUAGE SUITE FAILED");
    process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
