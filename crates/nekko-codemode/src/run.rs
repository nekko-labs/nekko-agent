//! `run_code`: the model's JavaScript in a QuickJS sandbox.
//!
//! The sandbox is a bare QuickJS context: no module loader, no `std`/`os`
//! modules, no `fetch`, no timers, no filesystem. The only way out is
//! `tools.<name>(input)`, which hands the call back to the host through
//! `call`; the host runs it as if the model had called the tool directly, so
//! approvals, guardrails, hooks and the chat's tool switches all still apply.
//! Calls run one at a time (each `await` blocks the script on the host), a
//! deadline and the turn's Stop interrupt the script, and memory, stack, the
//! number of calls and the size of what comes back are capped.

use rquickjs::{CatchResultExt, Context, Function, Runtime, Value as JsValue};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

/// What one run may use.
#[derive(Clone, Debug)]
pub struct Limits {
    pub timeout: Duration,
    pub memory_bytes: usize,
    pub stack_bytes: usize,
    pub max_calls: usize,
    /// UTF-16 code units of output (return value plus console) kept.
    pub max_output: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // Tool calls are in this budget too: a script waiting on a slow
            // command is still running.
            timeout: Duration::from_secs(300),
            memory_bytes: 64 << 20,
            stack_bytes: 1 << 20,
            max_calls: 100,
            max_output: 40_000,
        }
    }
}

/// One tool call a run made.
#[derive(Clone, Debug, PartialEq)]
pub struct CallRecord {
    pub name: String,
    /// Estimated tokens of the call's input and of its result: what the model
    /// would have written and read had it made the call itself.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub is_error: bool,
}

/// How a run ended.
#[derive(Clone, Debug)]
pub struct Outcome {
    /// What goes back to the model: the return value, then anything logged.
    pub output: String,
    pub is_error: bool,
    pub calls: Vec<CallRecord>,
}

/// The host's side of a tool call: `(name, input)` to `(output, is_error)`.
pub type Call = Box<dyn FnMut(&str, Value) -> (String, bool)>;

const PRELUDE: &str = r#"
(() => {
  const call = globalThis.__nekko_call;
  delete globalThis.__nekko_call;
  const names = JSON.parse(globalThis.__nekko_names);
  delete globalThis.__nekko_names;
  const show = (v) => typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  const logs = [];
  globalThis.__nekko_logs = logs;
  const log = (prefix) => (...a) => { logs.push(prefix + a.map(show).join(' ')); };
  globalThis.console = { log: log(''), info: log(''), debug: log(''), warn: log('warn: '), error: log('error: ') };
  const tools = {};
  for (const name of names) {
    tools[name] = async (input) => {
      const r = JSON.parse(call(name, JSON.stringify(input === undefined ? {} : input)));
      if (r.isError) { const e = new Error(r.output); e.name = 'ToolError'; e.tool = name; throw e; }
      return r.output;
    };
  }
  globalThis.tools = Object.freeze(tools);
})();
"#;

/// Run `code` (the body of an async function) with `tools` bound to `names`.
pub fn run(code: &str, names: &[String], limits: &Limits, cancelled: Box<dyn Fn() -> bool>, call: Call) -> Outcome {
    let calls: Rc<RefCell<Vec<CallRecord>>> = Rc::default();
    let result = execute(code, names, limits, cancelled, call, calls.clone());
    let calls = calls.take();
    let (output, is_error) = match result {
        Ok((value, logs)) => (join(value, &logs), false),
        Err((message, logs)) => (join(message, &logs), true),
    };
    Outcome { output: cap(&output, limits.max_output), is_error, calls }
}

fn join(main: String, logs: &[String]) -> String {
    if logs.is_empty() {
        return main;
    }
    format!("{main}\n\nconsole:\n{}", logs.join("\n"))
}

fn cap(s: &str, max: usize) -> String {
    if nekko_js::len16(s) <= max {
        return s.to_string();
    }
    format!("{}\n… (output cut at {max} characters; return less, or summarize in code)", nekko_js::slice16(s, max))
}

type Run = Result<(String, Vec<String>), (String, Vec<String>)>;

fn execute(
    code: &str,
    names: &[String],
    limits: &Limits,
    cancelled: Box<dyn Fn() -> bool>,
    call: Call,
    records: Rc<RefCell<Vec<CallRecord>>>,
) -> Run {
    let fail = |m: String| Err((m, Vec::new()));
    let rt = Runtime::new().map_err(|e| (format!("Could not start the sandbox: {e}"), Vec::new()))?;
    rt.set_memory_limit(limits.memory_bytes);
    rt.set_max_stack_size(limits.stack_bytes);
    let deadline = Instant::now() + limits.timeout;
    let ctx = match Context::full(&rt) {
        Ok(c) => c,
        Err(e) => return fail(format!("Could not start the sandbox: {e}")),
    };
    let call = Rc::new(RefCell::new(call));
    let max_calls = limits.max_calls;
    let setup = ctx.with(|ctx| -> rquickjs::Result<()> {
        let globals = ctx.globals();
        let (records, call) = (records.clone(), call.clone());
        let host = Function::new(ctx.clone(), move |name: String, input: String| -> String {
            if records.borrow().len() >= max_calls {
                return json!({ "output": format!("This run already made {max_calls} tool calls, the most one run may make. Return what you have."), "isError": true }).to_string();
            }
            let parsed: Value = serde_json::from_str(&input).unwrap_or(json!({}));
            let (output, is_error) = (call.borrow_mut())(&name, parsed);
            records.borrow_mut().push(CallRecord {
                input_tokens: crate::tokens(&name) + crate::tokens(&input),
                output_tokens: crate::tokens(&output),
                name,
                is_error,
            });
            json!({ "output": output, "isError": is_error }).to_string()
        })?;
        globals.set("__nekko_call", host)?;
        globals.set("__nekko_names", Value::from(names.to_vec()).to_string())?;
        ctx.eval::<(), _>(PRELUDE)
    });
    if let Err(e) = setup {
        return fail(format!("Could not start the sandbox: {e}"));
    }
    // Armed once the prelude has run, so only the model's code is cut short.
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline || cancelled())));
    let out = ctx.with(|ctx| -> Run {
        // The model's code is an async function body: `return` is its result.
        let wrapped = format!(
            "(async () => {{\n{code}\n}})().then((v) => v === undefined ? '(no return value)' : typeof v === 'string' ? v : JSON.stringify(v, null, 2))"
        );
        let settled: Result<String, String> = match ctx.eval::<rquickjs::Promise, _>(wrapped.as_bytes()).catch(&ctx) {
            Ok(p) => p.finish::<JsValue>().catch(&ctx).map_err(|e| e.to_string()).map(|v| {
                v.as_string().and_then(|s| s.to_string().ok()).unwrap_or_else(|| "(no return value)".into())
            }),
            Err(e) => Err(e.to_string()),
        };
        let logged = ctx.globals().get::<_, Vec<String>>("__nekko_logs").unwrap_or_default();
        match settled {
            Ok(v) => Ok((v, logged)),
            Err(e) => Err((e, logged)),
        }
    });
    match out {
        Err((message, logs)) => {
            let message = if Instant::now() >= deadline {
                format!("Stopped: the code ran past its {}s limit.", limits.timeout.as_secs())
            } else if message.contains("interrupted") {
                "Stopped.".to_string()
            } else if message.contains("out of memory") {
                format!("Stopped: the code used more than {} MB.", limits.memory_bytes >> 20)
            } else if message.starts_with("Error") || message.contains("Error:") {
                message.trim_end().to_string()
            } else {
                format!("Error: {}", message.trim_end())
            };
            Err((message, logs))
        }
        ok => ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(n: &[&str]) -> Vec<String> {
        n.iter().map(|s| s.to_string()).collect()
    }

    fn host(log: Rc<RefCell<Vec<(String, Value)>>>) -> Call {
        Box::new(move |name, input| {
            log.borrow_mut().push((name.to_string(), input.clone()));
            match name {
                "list" => ("a.ts\nb.ts\nc.md".into(), false),
                "read" => (format!("contents of {}", input["path"].as_str().unwrap_or("?")), false),
                _ => ("no such thing".into(), true),
            }
        })
    }

    fn go(code: &str, limits: Limits) -> (Outcome, Vec<(String, Value)>) {
        let log: Rc<RefCell<Vec<(String, Value)>>> = Rc::default();
        let out = run(code, &names(&["list", "read", "boom"]), &limits, Box::new(|| false), host(log.clone()));
        let calls = log.take();
        (out, calls)
    }

    #[test]
    fn loops_over_calls_and_returns_only_the_result() {
        let (out, calls) = go(
            "const files = (await tools.list({})).split('\\n').filter((f) => f.endsWith('.ts'));\n\
             const bodies = [];\n\
             for (const path of files) bodies.push(await tools.read({ path }));\n\
             return { count: bodies.length, first: bodies[0] };",
            Limits::default(),
        );
        assert!(!out.is_error, "{}", out.output);
        assert_eq!(out.output, "{\n  \"count\": 2,\n  \"first\": \"contents of a.ts\"\n}");
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[1], ("read".to_string(), json!({ "path": "a.ts" })));
        assert_eq!(out.calls.len(), 3);
        assert!(out.calls.iter().all(|c| c.output_tokens > 0 && !c.is_error));
    }

    #[test]
    fn a_tool_error_throws_and_can_be_caught() {
        let (out, _) =
            go("try { await tools.boom(); } catch (e) { return `${e.name}: ${e.message}`; }", Limits::default());
        assert_eq!(out.output, "ToolError: no such thing");
        let (out, _) = go("await tools.boom();", Limits::default());
        assert!(out.is_error);
        assert!(out.output.contains("no such thing"), "{}", out.output);
    }

    #[test]
    fn console_output_follows_the_result() {
        let (out, _) = go("console.log('looked at', 3, { a: 1 }); return 'done';", Limits::default());
        assert_eq!(out.output, "done\n\nconsole:\nlooked at 3 {\"a\":1}");
        let (out, _) = go("console.log('only logs');", Limits::default());
        assert_eq!(out.output, "(no return value)\n\nconsole:\nonly logs");
    }

    #[test]
    fn nothing_but_tools_is_reachable() {
        let (out, _) = go(
            "return [typeof fetch, typeof require, typeof process, typeof std, typeof os, typeof setTimeout, typeof __nekko_call].join(',');",
            Limits::default(),
        );
        assert_eq!(out.output, "undefined,undefined,undefined,undefined,undefined,undefined,undefined");
        let (out, _) = go("tools.list = 1;", Limits::default());
        assert!(out.output.contains("read-only"), "{}", out.output);
    }

    #[test]
    fn a_runaway_loop_is_stopped() {
        let limits = Limits { timeout: Duration::from_millis(200), ..Limits::default() };
        let started = Instant::now();
        let (out, _) = go("while (true) {}", limits);
        assert!(out.is_error);
        assert!(out.output.contains("limit"), "{}", out.output);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn stop_interrupts_the_script() {
        let out =
            run("while (true) {}", &[], &Limits::default(), Box::new(|| true), Box::new(|_, _| (String::new(), false)));
        assert!(out.is_error);
        assert_eq!(out.output, "Stopped.");
    }

    #[test]
    fn memory_and_call_counts_are_capped() {
        let limits = Limits { memory_bytes: 8 << 20, ..Limits::default() };
        let (out, _) = go("const a = []; while (true) a.push('x'.repeat(1 << 16));", limits);
        assert!(out.is_error);
        let limits = Limits { max_calls: 2, ..Limits::default() };
        let (out, calls) = go("for (let i = 0; i < 5; i++) await tools.list(); return 'x';", limits);
        assert!(out.is_error);
        assert!(out.output.contains("2 tool calls"), "{}", out.output);
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn a_syntax_error_says_so() {
        let (out, _) = go("const x: number = 1; return x;", Limits::default());
        assert!(out.is_error);
        assert!(out.output.starts_with("Error:"), "{}", out.output);
    }

    #[test]
    fn long_output_is_cut() {
        let limits = Limits { max_output: 100, ..Limits::default() };
        let (out, _) = go("return 'y'.repeat(500);", limits);
        assert!(out.output.starts_with(&"y".repeat(100)));
        assert!(out.output.contains("output cut at 100"));
    }
}
