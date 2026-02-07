use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, RwLock};
use tokio::time::interval;
use uuid::Uuid;

const BUFFER_CAPACITY: usize = 100;
const FLUSH_INTERVAL_MS: u64 = 500;
const MAX_BATCH_SIZE: usize = 50;

#[derive(Debug)]
struct LogEntry {
    execution_id: Uuid,
    jsonl_line: String,
    byte_size: i64,
}

enum BufferCommand {
    Append(LogEntry),
    FlushExecution(Uuid),
    Shutdown,
}

#[derive(Clone)]
pub struct LogBuffer {
    sender: mpsc::Sender<BufferCommand>,
    pending_counts: Arc<RwLock<HashMap<Uuid, usize>>>,
}

impl LogBuffer {
    pub fn new(pool: SqlitePool) -> Self {
        let (sender, receiver) = mpsc::channel(BUFFER_CAPACITY * 10);
        let pending_counts = Arc::new(RwLock::new(HashMap::new()));
        let pending_counts_clone = pending_counts.clone();

        tokio::spawn(Self::run_buffer_loop(pool, receiver, pending_counts_clone));

        Self {
            sender,
            pending_counts,
        }
    }

    pub async fn append(&self, execution_id: Uuid, jsonl_line: String) {
        let byte_size = jsonl_line.len() as i64;

        {
            let mut counts = self.pending_counts.write().await;
            *counts.entry(execution_id).or_insert(0) += 1;
        }

        let entry = LogEntry {
            execution_id,
            jsonl_line,
            byte_size,
        };

        if let Err(e) = self.sender.send(BufferCommand::Append(entry)).await {
            tracing::error!("Failed to send log entry to buffer: {}", e);
        }
    }

    pub async fn flush_execution(&self, execution_id: Uuid) {
        let _ = self
            .sender
            .send(BufferCommand::FlushExecution(execution_id))
            .await;

        let mut attempts = 0;
        while attempts < 100 {
            {
                let counts = self.pending_counts.read().await;
                if counts.get(&execution_id).copied().unwrap_or(0) == 0 {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            attempts += 1;
        }
    }

    pub async fn shutdown(&self) {
        let _ = self.sender.send(BufferCommand::Shutdown).await;
    }

    async fn run_buffer_loop(
        pool: SqlitePool,
        mut receiver: mpsc::Receiver<BufferCommand>,
        pending_counts: Arc<RwLock<HashMap<Uuid, usize>>>,
    ) {
        let mut buffers: HashMap<Uuid, Vec<LogEntry>> = HashMap::new();
        let mut flush_interval = interval(Duration::from_millis(FLUSH_INTERVAL_MS));
        flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = flush_interval.tick() => {
                    Self::flush_all_buffers(&pool, &mut buffers, &pending_counts).await;
                }
                cmd = receiver.recv() => {
                    match cmd {
                        Some(BufferCommand::Append(entry)) => {
                            let execution_id = entry.execution_id;
                            let buffer = buffers.entry(execution_id).or_insert_with(Vec::new);
                            buffer.push(entry);

                            if buffer.len() >= MAX_BATCH_SIZE {
                                Self::flush_buffer(&pool, execution_id, &mut buffers, &pending_counts).await;
                            }
                        }
                        Some(BufferCommand::FlushExecution(execution_id)) => {
                            Self::flush_buffer(&pool, execution_id, &mut buffers, &pending_counts).await;
                        }
                        Some(BufferCommand::Shutdown) | None => {
                            Self::flush_all_buffers(&pool, &mut buffers, &pending_counts).await;
                            break;
                        }
                    }
                }
            }
        }
    }

    async fn flush_all_buffers(
        pool: &SqlitePool,
        buffers: &mut HashMap<Uuid, Vec<LogEntry>>,
        pending_counts: &Arc<RwLock<HashMap<Uuid, usize>>>,
    ) {
        let execution_ids: Vec<Uuid> = buffers.keys().copied().collect();
        for execution_id in execution_ids {
            Self::flush_buffer(pool, execution_id, buffers, pending_counts).await;
        }
    }

    async fn flush_buffer(
        pool: &SqlitePool,
        execution_id: Uuid,
        buffers: &mut HashMap<Uuid, Vec<LogEntry>>,
        pending_counts: &Arc<RwLock<HashMap<Uuid, usize>>>,
    ) {
        let entries = match buffers.remove(&execution_id) {
            Some(e) if !e.is_empty() => e,
            _ => return,
        };

        let count = entries.len();

        let combined_logs: String = entries.iter().map(|e| e.jsonl_line.as_str()).collect();
        let total_bytes: i64 = entries.iter().map(|e| e.byte_size).sum();

        let result = sqlx::query!(
            r#"INSERT INTO execution_process_logs (execution_id, logs, byte_size, inserted_at)
               VALUES ($1, $2, $3, datetime('now', 'subsec'))"#,
            execution_id,
            combined_logs,
            total_bytes
        )
        .execute(pool)
        .await;

        if let Err(e) = result {
            tracing::error!(
                "Failed to batch insert {} log entries for execution {}: {}",
                count,
                execution_id,
                e
            );
        }

        {
            let mut counts = pending_counts.write().await;
            if let Some(pending) = counts.get_mut(&execution_id) {
                *pending = pending.saturating_sub(count);
                if *pending == 0 {
                    counts.remove(&execution_id);
                }
            }
        }
    }
}
