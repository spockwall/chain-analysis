use chain_analysis_common::IngestionMessage;
use eyre::Result;
use tracing::info;

const TOPIC_INGESTION_PROGRESS: &str = "ingestion_progress";

pub enum ProgressReporter {
    Redis {
        conn: redis::aio::MultiplexedConnection,
        run_id: String,
    },
    DryRun {
        run_id: String,
    },
}

impl ProgressReporter {
    pub async fn new_redis(redis_url: &str, run_id: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self::Redis {
            conn,
            run_id: run_id.to_string(),
        })
    }

    pub fn new_dry_run(run_id: &str) -> Self {
        Self::DryRun {
            run_id: run_id.to_string(),
        }
    }

    fn run_id(&self) -> &str {
        match self {
            Self::Redis { run_id, .. } | Self::DryRun { run_id } => run_id,
        }
    }

    pub async fn report_progress(
        &mut self,
        current_block: u64,
        total_blocks: u64,
        transactions_processed: u64,
    ) -> Result<()> {
        let msg = IngestionMessage::Progress {
            run_id: self.run_id().to_string(),
            current_block,
            total_blocks,
            transactions_processed,
        };
        self.write_message(&msg).await
    }

    pub async fn report_complete(
        &mut self,
        blocks_processed: u64,
        transactions_processed: u64,
    ) -> Result<()> {
        let msg = IngestionMessage::Complete {
            run_id: self.run_id().to_string(),
            blocks_processed,
            transactions_processed,
        };
        self.write_message(&msg).await
    }

    pub async fn report_error(&mut self, message: &str) -> Result<()> {
        let msg = IngestionMessage::Error {
            run_id: self.run_id().to_string(),
            message: message.to_string(),
        };
        self.write_message(&msg).await
    }

    async fn write_message(&mut self, msg: &IngestionMessage) -> Result<()> {
        let json = serde_json::to_string(msg)?;
        match self {
            Self::Redis { conn, .. } => {
                let _: String = redis::cmd("XADD")
                    .arg(TOPIC_INGESTION_PROGRESS)
                    .arg("*")
                    .arg("data")
                    .arg(&json)
                    .query_async(conn)
                    .await?;
            }
            Self::DryRun { .. } => {
                info!(progress = %json);
            }
        }
        Ok(())
    }
}
