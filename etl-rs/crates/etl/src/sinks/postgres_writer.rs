use crate::types::EntityFeatures;
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

    /// Read `entity_features.last_synced_block` for the given addresses.
    /// Missing rows are returned as `0` so callers can use the result as a
    /// per-address delta cursor without special-casing unseen addresses.
    pub async fn read_last_synced_blocks(
        &self,
        addresses: &[String],
    ) -> Result<std::collections::HashMap<String, u64>> {
        let mut out: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for addr in addresses {
            out.insert(addr.to_lowercase(), 0);
        }
        if addresses.is_empty() {
            return Ok(out);
        }

        let rows: Vec<(String, i64)> = sqlx::query_as(
            r#"
            SELECT address, COALESCE(last_synced_block, 0)
              FROM entity_features
             WHERE chain_id = 1
               AND address = ANY($1::text[])
            "#,
        )
        .bind(addresses)
        .fetch_all(&self.pool)
        .await?;

        for (addr, blk) in rows {
            out.insert(addr.to_lowercase(), blk.max(0) as u64);
        }
        Ok(out)
    }

    /// Advance `entity_features.last_synced_block` per address using the
    /// maximum of the existing and incoming block numbers. Used by the
    /// worker's stream consumer after a successful batch to keep the
    /// refresh-loop's delta cursor current.
    pub async fn bump_last_synced_block(&self, updates: &[(String, u64)]) -> Result<u64> {
        if updates.is_empty() {
            return Ok(0);
        }

        let addresses: Vec<String> = updates.iter().map(|(a, _)| a.clone()).collect();
        let blocks: Vec<i64> = updates.iter().map(|(_, b)| *b as i64).collect();

        let result = sqlx::query(
            r#"
            UPDATE entity_features AS ef
               SET last_synced_block = GREATEST(ef.last_synced_block, u.blk)
              FROM UNNEST($1::text[], $2::bigint[]) AS u(addr, blk)
             WHERE ef.address = u.addr
               AND ef.chain_id = 1
            "#,
        )
        .bind(&addresses)
        .bind(&blocks)
        .execute(&self.pool)
        .await?;

        let affected = result.rows_affected();
        debug!(affected, pending = updates.len(), "bumped last_synced_block");
        Ok(affected)
    }

}
