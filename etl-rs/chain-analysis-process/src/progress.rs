use chain_analysis_common::ProcessingMessage;
use eyre::Result;
use tracing::debug;

const TOPIC: &str = "processing_progress";

pub struct ProcessProgressReporter {
    conn: redis::aio::MultiplexedConnection,
    run_id: String,
}

impl ProcessProgressReporter {
    pub async fn new(redis_url: &str, run_id: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self {
            conn,
            run_id: run_id.to_string(),
        })
    }

    pub async fn report_stage(&mut self, stage: &str, processed: u64, total: u64) -> Result<()> {
        let msg = ProcessingMessage::Progress {
            run_id: self.run_id.clone(),
            stage: stage.into(),
            processed,
            total,
        };
        self.write(&msg).await
    }

    pub async fn report_complete(
        &mut self,
        entities: u64,
        transactions: u64,
    ) -> Result<()> {
        let msg = ProcessingMessage::Complete {
            run_id: self.run_id.clone(),
            entities_processed: entities,
            transactions_processed: transactions,
        };
        self.write(&msg).await
    }

    pub async fn report_error(&mut self, message: &str) -> Result<()> {
        let msg = ProcessingMessage::Error {
            run_id: self.run_id.clone(),
            message: message.into(),
        };
        self.write(&msg).await
    }

    async fn write(&mut self, msg: &ProcessingMessage) -> Result<()> {
        let json = serde_json::to_string(msg)?;
        let _: String = redis::cmd("XADD")
            .arg(TOPIC)
            .arg("*")
            .arg("data")
            .arg(&json)
            .query_async(&mut self.conn)
            .await?;
        debug!(topic = TOPIC, "Reported processing progress");
        Ok(())
    }
}
