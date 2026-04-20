//! Producer-consumer pipeline: fetch tasks send `WriterCommand`s into an mpsc
//! channel; a single writer task drains them and pipelines XADDs to Redis.
//!
//! This decouples Etherscan I/O from Redis I/O so they can overlap.

use sinks::redis_stream::TransactionWriter;
use types::{Trace, Transaction, Transfer};
use eyre::Result;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{debug, info};

/// One unit of work for the writer task.
pub enum WriterCommand {
    /// One block's worth of data. Cursor advances after flush; ack is sent back.
    Block {
        block_num: u64,
        txs: Vec<Transaction>,
        traces: Vec<Trace>,
        transfers: Vec<Transfer>,
    },
    /// Address-mode batch (no cursor semantics). Ack is sent back with tx_count.
    Address {
        txs: Vec<Transaction>,
        traces: Vec<Trace>,
        transfers: Vec<Transfer>,
    },
    /// Mark a block as failed (after fetch retries exhausted).
    FailedBlock(u64),
}

/// Sent from writer task back to driver after a flush succeeds.
pub struct FlushAck {
    pub block_num: Option<u64>,
    pub tx_count: usize,
    pub trace_count: usize,
    pub transfer_count: usize,
}

pub struct WriterHandles {
    pub cmd_tx: mpsc::Sender<WriterCommand>,
    pub ack_rx: mpsc::UnboundedReceiver<FlushAck>,
    pub join: JoinHandle<Result<Box<dyn TransactionWriter>>>,
}

/// Spawn a writer task. The task lives until `cmd_tx` is dropped and the
/// channel drains. Returns the writer back via `join.await?` so callers can
/// reuse it (e.g. across multiple ranges or follow-mode iterations).
///
/// The command channel is bounded (gives natural backpressure on the fetcher);
/// the ack channel is unbounded (acks are tiny and must never block the writer
/// task, otherwise we'd deadlock with the driver).
pub fn spawn_writer(mut writer: Box<dyn TransactionWriter>, capacity: usize) -> WriterHandles {
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<WriterCommand>(capacity);
    let (ack_tx, ack_rx) = mpsc::unbounded_channel::<FlushAck>();

    let join = tokio::spawn(async move {
        while let Some(cmd) = cmd_rx.recv().await {
            match cmd {
                WriterCommand::Block {
                    block_num,
                    txs,
                    traces,
                    transfers,
                } => {
                    let tx_count = txs.len();
                    let trace_count = traces.len();
                    let transfer_count = transfers.len();

                    writer.write_transactions_batch(&txs).await?;
                    writer.write_traces_batch(&traces).await?;
                    writer.write_transfers_batch(&transfers).await?;
                    writer.save_cursor(block_num).await?;

                    debug!(block = block_num, tx_count, trace_count, transfer_count, "Flushed block");

                    if ack_tx
                        .send(FlushAck {
                            block_num: Some(block_num),
                            tx_count,
                            trace_count,
                            transfer_count,
                        })
                        .is_err()
                    {
                        debug!("Ack receiver dropped; continuing without acks");
                    }
                }
                WriterCommand::Address {
                    txs,
                    traces,
                    transfers,
                } => {
                    let tx_count = txs.len();
                    let trace_count = traces.len();
                    let transfer_count = transfers.len();

                    writer.write_transactions_batch(&txs).await?;
                    writer.write_traces_batch(&traces).await?;
                    writer.write_transfers_batch(&transfers).await?;

                    info!(tx_count, trace_count, transfer_count, "Flushed address batch");

                    let _ = ack_tx.send(FlushAck {
                        block_num: None,
                        tx_count,
                        trace_count,
                        transfer_count,
                    });
                }
                WriterCommand::FailedBlock(block_num) => {
                    writer.record_failed_block(block_num).await?;
                }
            }
        }
        Ok(writer)
    });

    WriterHandles {
        cmd_tx,
        ack_rx,
        join,
    }
}
