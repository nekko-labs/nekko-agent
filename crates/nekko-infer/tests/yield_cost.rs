//! What it costs a background reply to step aside for the user and come back
//! (B2), on a real llama-server behind the router:
//!
//! - **yield**: from the client hanging up mid-reply to no slot generating;
//! - **resume, paused**: the same request again with the model still loaded:
//!   how much of the prompt is processed again, and how long that takes;
//! - **resume, unloaded**: the model stopped and loaded again, then the
//!   same request: load time, and the whole prompt processed again.
//!
//! `NEKKO_BENCH_LLAMA=<llama-server> NEKKO_BENCH_MODEL=<model.gguf> cargo test
//! -p nekko-infer --release --test yield_cost -- --ignored --nocapture`

use nekko_infer::{BoxFuture, EngineRouter, Kind, Policy, ServeConfig, SpawnOutcome, SpawnSpec, Supervisor};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MODEL: &str = "bench";

/// The engine's own launch for a chat model (`nekko-engine`'s `build_args`
/// with its defaults: 32k context, prompt cache reuse, idle slots not cached).
fn spec(bin: &str, model: &str) -> SpawnSpec {
    let args = [
        "--model",
        model,
        "--alias",
        MODEL,
        "--host",
        "127.0.0.1",
        "--port",
        "{port}",
        "--ctx-size",
        "32768",
        "--cache-reuse",
        "256",
        "--no-cache-idle-slots",
    ];
    SpawnSpec {
        model_id: MODEL.into(),
        bin: bin.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: Default::default(),
        kind: Kind::Chat,
        health_path: "/health".into(),
        health_expect: Some("\"ok\"".into()),
        budget_secs: Some(600),
    }
}

struct Loader {
    sup: Arc<Supervisor>,
    bin: String,
    model: String,
}

impl Policy for Loader {
    fn load(&self, _model: String, _image: bool) -> BoxFuture<Result<(), (u16, String)>> {
        let (sup, spec) = (self.sup.clone(), spec(&self.bin, &self.model));
        let started = Instant::now();
        Box::pin(async move {
            let out = sup.spawn(spec).await;
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            match out {
                SpawnOutcome::Ready { .. } => {
                    LOADS.lock().unwrap().push(ms);
                    Ok(())
                }
                SpawnOutcome::Failed { message, .. } => Err((503, message)),
            }
        })
    }
    fn models(&self) -> BoxFuture<Result<Value, String>> {
        Box::pin(async { Ok(json!({ "object": "list", "data": [{ "id": MODEL }] })) })
    }
    fn model(&self, id: String) -> BoxFuture<Result<Option<Value>, String>> {
        Box::pin(async move { Ok((id == MODEL).then(|| json!({ "id": MODEL }))) })
    }
}

/// How long each load took, from spawn to healthy.
static LOADS: std::sync::Mutex<Vec<f64>> = std::sync::Mutex::new(Vec::new());

/// About 3,000 tokens of prompt that does not repeat itself.
fn prompt() -> Vec<Value> {
    let text: String = (0..120)
        .map(|i| {
            format!(
                "Note {i}: the build on machine {} took {} seconds and left {} warnings in module m{}. ",
                i * 7 % 13,
                40 + i * 3 % 17,
                i % 5,
                i * 11 % 29
            )
        })
        .collect();
    vec![
        json!({ "role": "system", "content": "You summarize build logs." }),
        json!({ "role": "user", "content": format!("{text}\n\nWrite a long, detailed report on every note above.") }),
    ]
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

async fn processing(port: u16) -> bool {
    let slots: Value = reqwest::get(format!("http://127.0.0.1:{port}/slots")).await.unwrap().json().await.unwrap();
    slots.as_array().unwrap().iter().any(|s| s["is_processing"] == json!(true))
}

/// One request, non-streamed, one token out: its `timings` say how much
/// prompt was processed and how long that took.
async fn one_token(port: u16) -> (f64, f64, f64) {
    let started = Instant::now();
    let body: Value = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&json!({ "model": MODEL, "messages": prompt(), "max_tokens": 1, "cache_prompt": true }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let t = &body["timings"];
    (t["prompt_n"].as_f64().unwrap(), t["prompt_ms"].as_f64().unwrap(), started.elapsed().as_secs_f64() * 1000.0)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "a measurement on a real model, not a check"]
async fn yield_cost() {
    let (Ok(bin), Ok(model)) = (std::env::var("NEKKO_BENCH_LLAMA"), std::env::var("NEKKO_BENCH_MODEL")) else {
        panic!("set NEKKO_BENCH_LLAMA and NEKKO_BENCH_MODEL");
    };
    let sup = Arc::new(Supervisor::new());
    let loader = Arc::new(Loader { sup: sup.clone(), bin, model });
    let router = EngineRouter::new(sup.clone(), loader);
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    router.serve(ServeConfig { port, host: "127.0.0.1".into(), api_key: None, cors_origins: vec![] }).await.unwrap();
    // Load, and warm the prompt once.
    let cold = one_token(port).await;
    println!("first request: load + prompt {} tokens in {:.0} ms (total {:.0} ms)", cold.0, cold.1, cold.2);

    let (mut yields, mut paused_ms, mut paused_n) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..7 {
        let child = sup.get(MODEL).unwrap().port;
        let mut res = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .json(&json!({ "model": MODEL, "messages": prompt(), "stream": true, "max_tokens": 4000, "cache_prompt": true }))
            .send()
            .await
            .unwrap();
        let mut chunks = 0;
        while chunks < 40 {
            res.chunk().await.unwrap().unwrap();
            chunks += 1;
        }
        assert!(processing(child).await, "generating before the hang-up");
        // The client hangs up, as a yielding turn's request does.
        let t0 = Instant::now();
        drop(res);
        while processing(child).await {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        yields.push(t0.elapsed().as_secs_f64() * 1000.0);
        // Resume with the model loaded.
        let (n, ms, _) = one_token(port).await;
        paused_n.push(n);
        paused_ms.push(ms);
    }
    println!("yield (hang-up to no slot generating), ms: {yields:.1?}, median {:.1}", median(&mut yields.clone()));
    println!(
        "resume, paused: prompt tokens processed {paused_n:?}; prompt ms {paused_ms:.1?}, median {:.1}",
        median(&mut paused_ms.clone())
    );

    let (mut reload_n, mut reload_ms, mut reload_total) = (Vec::new(), Vec::new(), Vec::new());
    LOADS.lock().unwrap().clear();
    for _ in 0..5 {
        sup.kill(MODEL);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (n, ms, total) = one_token(port).await;
        reload_n.push(n);
        reload_ms.push(ms);
        reload_total.push(total);
    }
    let mut loads = LOADS.lock().unwrap().clone();
    println!("resume, unloaded: load ms {loads:.0?}, median {:.0}", median(&mut loads));
    println!(
        "resume, unloaded: prompt tokens processed {reload_n:?}; prompt ms {reload_ms:.0?}, median {:.0}",
        median(&mut reload_ms.clone())
    );
    println!(
        "resume, unloaded: total to first token ms {reload_total:.0?}, median {:.0}",
        median(&mut reload_total.clone())
    );
    router.stop();
    sup.kill_all();
}
