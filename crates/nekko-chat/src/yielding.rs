//! A background turn on a local model steps aside for the person at the
//! computer: a [`ModelClient`] that holds each request until its [`YieldGate`]
//! lets it run, and stops the one under way when the gate says to yield. The
//! stopped call ends with [`YIELDED`], which the loop sends again from where
//! it stood (`stream_with_retry`), so nothing the model said twice reaches the
//! transcript. The model stays loaded: the next attempt's prompt is mostly in
//! llama-server's cache.

use nekko_loop::{Cancel, ChatRequest, Chunk, ChunkStream, ModelClient, YIELDED};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub type GateFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// When background work may use the model.
pub trait YieldGate: Send + Sync + 'static {
    /// Resolves once the work may run (at once, if it may now).
    fn wait_turn(&self) -> GateFuture<'_>;
    /// Resolves once the work must step aside.
    fn must_yield(&self) -> GateFuture<'_>;
}

/// With no gate (a person's turn, a cloud model), the inner client as it is.
pub struct YieldingClient<C> {
    inner: C,
    gate: Option<Arc<dyn YieldGate>>,
}

impl<C> YieldingClient<C> {
    pub fn new(inner: C, gate: Option<Arc<dyn YieldGate>>) -> Self {
        Self { inner, gate }
    }
}

const ABORTED: &str = "This operation was aborted";

impl<C: ModelClient> ModelClient for YieldingClient<C> {
    type Stream = YieldingStream<C::Stream>;

    async fn chat(&self, req: ChatRequest, cancel: Cancel) -> Result<Self::Stream, String> {
        let Some(gate) = &self.gate else {
            let inner = self.inner.chat(req, cancel.clone()).await?;
            let yielded = Arc::new(AtomicBool::new(false));
            return Ok(YieldingStream { inner, yielded, call: cancel, _watcher: None, done: false });
        };
        tokio::select! {
            _ = gate.wait_turn() => {}
            _ = cancel.cancelled() => return Err(ABORTED.into()),
        }
        // The call's own stop: the turn's Stop reaches it, and so does a yield,
        // without stopping the turn.
        let call = Cancel::default();
        {
            let call = call.clone();
            cancel.on_cancel(move || call.cancel());
        }
        let yielded = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (gate, call, yielded) = (gate.clone(), call.clone(), yielded.clone());
            tokio::spawn(async move {
                tokio::select! {
                    _ = gate.must_yield() => {
                        yielded.store(true, Ordering::SeqCst);
                        call.cancel();
                    }
                    _ = call.cancelled() => {}
                }
            })
        };
        let watcher = Some(AbortOnDrop(watcher));
        match self.inner.chat(req, call.clone()).await {
            Ok(inner) => Ok(YieldingStream { inner, yielded, call, _watcher: watcher, done: false }),
            Err(_) if yielded.load(Ordering::SeqCst) => Err(YIELDED.into()),
            Err(e) => Err(e),
        }
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The inner stream, ended with [`YIELDED`] when the gate stopped it.
pub struct YieldingStream<S> {
    inner: S,
    yielded: Arc<AtomicBool>,
    call: Cancel,
    _watcher: Option<AbortOnDrop>,
    done: bool,
}

impl<S: ChunkStream> ChunkStream for YieldingStream<S> {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        if self.done {
            return None;
        }
        if self._watcher.is_none() {
            return self.inner.next().await;
        }
        let item = tokio::select! {
            item = self.inner.next() => Some(item),
            // A stream waiting on a long prompt notices the stop at once.
            _ = self.call.cancelled() => None,
        };
        let yielded = self.yielded.load(Ordering::SeqCst);
        match item {
            Some(item) if !yielded => item,
            _ => {
                self.done = true;
                Some(Err(if yielded { YIELDED } else { ABORTED }.into()))
            }
        }
    }
}
