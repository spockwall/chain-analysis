use chain_analysis_common::EntityFeatures;
use eyre::Result;
use sqlx::PgPool;
use tracing::{debug, info};

pub struct PostgresWriter {
    pool: PgPool,
}

impl PostgresWriter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Upsert entity features into postgres `entity_features` table.
    /// Only writes the columns that the Rust process actually computes;
    /// unmapped columns (AML flags, balance stats, etc.) keep their defaults.
    pub async fn upsert_entity_features(&self, features: &[EntityFeatures]) -> Result<u64> {
        if features.is_empty() {
            return Ok(0);
        }

        let mut total = 0u64;

        for chunk in features.chunks(500) {
            let mut addresses: Vec<String> = Vec::with_capacity(chunk.len());
            let mut out_degrees: Vec<i32> = Vec::with_capacity(chunk.len());
            let mut in_degrees: Vec<i32> = Vec::with_capacity(chunk.len());
            let mut unique_interacted: Vec<i32> = Vec::with_capacity(chunk.len());
            let mut volume_in_strs: Vec<String> = Vec::with_capacity(chunk.len());
            let mut volume_out_strs: Vec<String> = Vec::with_capacity(chunk.len());
            let mut is_labeled_vals: Vec<bool> = Vec::with_capacity(chunk.len());
            let mut first_seen_epochs: Vec<Option<i64>> = Vec::with_capacity(chunk.len());
            let mut last_seen_epochs: Vec<Option<i64>> = Vec::with_capacity(chunk.len());

            for f in chunk {
                addresses.push(f.address.clone());
                out_degrees.push(f.tx_count_out as i32);
                in_degrees.push(f.tx_count_in as i32);
                unique_interacted
                    .push((f.unique_counterparties_in + f.unique_counterparties_out) as i32);
                volume_in_strs.push(f.volume_in.clone());
                volume_out_strs.push(f.volume_out.clone());
                is_labeled_vals.push(f.label.is_some());
                first_seen_epochs.push(f.first_seen.map(|v| v as i64));
                last_seen_epochs.push(f.last_seen.map(|v| v as i64));
            }

            let result = sqlx::query(
                r#"
                INSERT INTO entity_features (
                    address, chain_id, out_degree, in_degree,
                    unique_interacted_entities, volume_in_wei, volume_out_wei,
                    is_labeled, first_seen_at, last_seen_at,
                    computed_at, updated_at
                )
                SELECT
                    addr,
                    1,
                    out_deg,
                    in_deg,
                    unique_int,
                    vol_in::numeric(78,0),
                    vol_out::numeric(78,0),
                    labeled,
                    CASE WHEN fs IS NOT NULL
                         THEN TO_TIMESTAMP(fs)
                         ELSE NULL END,
                    CASE WHEN ls IS NOT NULL
                         THEN TO_TIMESTAMP(ls)
                         ELSE NULL END,
                    NOW(),
                    NOW()
                FROM UNNEST(
                    $1::text[],
                    $2::int[],
                    $3::int[],
                    $4::int[],
                    $5::text[],
                    $6::text[],
                    $7::bool[],
                    $8::bigint[],
                    $9::bigint[]
                ) AS t(addr, out_deg, in_deg, unique_int, vol_in, vol_out, labeled, fs, ls)
                ON CONFLICT (address) DO UPDATE SET
                    out_degree = EXCLUDED.out_degree,
                    in_degree = EXCLUDED.in_degree,
                    unique_interacted_entities = EXCLUDED.unique_interacted_entities,
                    volume_in_wei = EXCLUDED.volume_in_wei,
                    volume_out_wei = EXCLUDED.volume_out_wei,
                    is_labeled = EXCLUDED.is_labeled,
                    first_seen_at = COALESCE(
                        LEAST(entity_features.first_seen_at, EXCLUDED.first_seen_at),
                        EXCLUDED.first_seen_at
                    ),
                    last_seen_at = COALESCE(
                        GREATEST(entity_features.last_seen_at, EXCLUDED.last_seen_at),
                        EXCLUDED.last_seen_at
                    ),
                    computed_at = NOW(),
                    updated_at = NOW()
                "#,
            )
            .bind(&addresses)
            .bind(&out_degrees)
            .bind(&in_degrees)
            .bind(&unique_interacted)
            .bind(&volume_in_strs)
            .bind(&volume_out_strs)
            .bind(&is_labeled_vals)
            .bind(&first_seen_epochs)
            .bind(&last_seen_epochs)
            .execute(&self.pool)
            .await?;

            total += result.rows_affected();
            debug!(batch_size = chunk.len(), "Upserted entity_features batch");
        }

        info!(total, "Entity features upserted to PostgreSQL");
        Ok(total)
    }

    pub async fn insert_ingestion_run(
        &self,
        run_id: &str,
        start_block: i64,
        end_block: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO ingestion_runs
                (run_id, chain_id, start_block, end_block, data_source, status)
            VALUES
                ($1, 1, $2, $3, 'rust-process', 'running'::ingestionstatus)
            ON CONFLICT (run_id) DO NOTHING
            "#,
        )
        .bind(run_id)
        .bind(start_block)
        .bind(end_block)
        .execute(&self.pool)
        .await?;

        info!(run_id, "Ingestion run inserted (running)");
        Ok(())
    }

    pub async fn update_ingestion_run(
        &self,
        run_id: &str,
        status: &str,
        transactions_processed: i64,
        traces_processed: i64,
        nodes_created: i64,
        error_message: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE ingestion_runs
            SET status = $2::ingestionstatus,
                transactions_processed = $3,
                traces_processed = $4,
                nodes_created = $5,
                error_message = $6,
                completed_at = CASE
                    WHEN $2 IN ('completed', 'failed') THEN NOW()
                    ELSE completed_at
                END
            WHERE run_id = $1
            "#,
        )
        .bind(run_id)
        .bind(status)
        .bind(transactions_processed as i32)
        .bind(traces_processed as i32)
        .bind(nodes_created as i32)
        .bind(error_message)
        .execute(&self.pool)
        .await?;

        info!(run_id, status, "Ingestion run updated");
        Ok(())
    }
}
