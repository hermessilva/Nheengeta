// Regression test for the math engine: evaluation, LaTeX, plot sampling.
const { EvaluateMath } = require("./out/Math/MathEngine");

let failures = 0;
function check(name, condition) {
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
    if (!condition) failures++;
}

const scope = {};

// evaluation + latex
const r1 = EvaluateMath("1/3 + 1/4\nderivative(\"x^3 + 2x^2\", \"x\")", scope);
check("no error", !r1.Error);
check("two result lines", r1.Lines.length === 2);
check("latex present", r1.Lines.every((l) => l.Latex && l.Latex.length > 0));

// persistent scope: define f, then plot it
const r2 = EvaluateMath("f(x) = x^2 - 4x + 3\nf(2)", scope);
check("f defined, f(2) = -1", !r2.Error && r2.Lines.some((l) => l.Text === "-1"));

const r3 = EvaluateMath('plot("f(x)", { from: -1, to: 5 })', scope);
check("plot no error", !r3.Error);
check("one plot", r3.Plots.length === 1);
const trace = r3.Plots[0] && r3.Plots[0].traces[0];
const finiteY = trace ? trace.y.filter((y) => typeof y === "number" && Number.isFinite(y)) : [];
check("sampled finite points > 300", finiteY.length > 300);
check("f(-1) sample = 8", trace && Math.abs(finiteY[0] - 8) < 0.1);

// builtin functions + singularity gaps
const r4 = EvaluateMath('plot(["sin(x)", "1/x"], { from: -3.14, to: 3.14 })', scope);
check("two traces from matrix arg", r4.Plots.length === 1 && r4.Plots[0].traces.length === 2);
const sinTrace = r4.Plots[0].traces[0];
const invTrace = r4.Plots[0].traces[1];
const sinFinite = sinTrace ? sinTrace.y.filter((y) => Number.isFinite(y)) : [];
check("sin sampled", sinFinite.length > 300);
const mid = sinTrace ? sinTrace.y[Math.floor(sinTrace.y.length / 2)] : null;
check("sin(0) ~ 0 midpoint", Number.isFinite(mid) && Math.abs(mid) < 0.05);
check("1/x has values", invTrace && invTrace.y.filter((y) => Number.isFinite(y)).length > 300);

console.log(failures === 0 ? "\nMATH TEST PASSED" : `\nMATH TEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
