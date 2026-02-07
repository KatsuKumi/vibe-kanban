use std::{str::FromStr, sync::Arc, time::Duration};

use sqlx::{
    Error, Pool, Sqlite,
    migrate::MigrateError,
    sqlite::{
        SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqlitePoolOptions,
        SqliteSynchronous,
    },
};
use utils::assets::asset_dir;

pub mod models;

const SQLITE_MAX_CONNECTIONS: u32 = 10;
const SQLITE_BUSY_TIMEOUT_SECS: u64 = 30;

async fn run_migrations(pool: &Pool<Sqlite>) -> Result<(), Error> {
    use std::collections::HashSet;

    let migrator = sqlx::migrate!("./migrations");
    let mut processed_versions: HashSet<i64> = HashSet::new();

    loop {
        match migrator.run(pool).await {
            Ok(()) => return Ok(()),
            Err(MigrateError::VersionMismatch(version)) => {
                if cfg!(debug_assertions) {
                    // return the error in debug mode to catch migration issues early
                    return Err(sqlx::Error::Migrate(Box::new(
                        MigrateError::VersionMismatch(version),
                    )));
                }

                if !cfg!(windows) {
                    // On non-Windows platforms, we do not attempt to auto-fix checksum mismatches
                    return Err(sqlx::Error::Migrate(Box::new(
                        MigrateError::VersionMismatch(version),
                    )));
                }

                // Guard against infinite loop
                if !processed_versions.insert(version) {
                    return Err(sqlx::Error::Migrate(Box::new(
                        MigrateError::VersionMismatch(version),
                    )));
                }

                // On Windows, there can be checksum mismatches due to line ending differences
                // or other platform-specific issues. Update the stored checksum and retry.
                tracing::warn!(
                    "Migration version {} has checksum mismatch, updating stored checksum (likely platform-specific difference)",
                    version
                );

                // Find the migration with the mismatched version and get its current checksum
                if let Some(migration) = migrator.iter().find(|m| m.version == version) {
                    // Update the checksum in _sqlx_migrations to match the current file
                    sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
                        .bind(&*migration.checksum)
                        .bind(version)
                        .execute(pool)
                        .await?;
                } else {
                    // Migration not found in current set, can't fix
                    return Err(sqlx::Error::Migrate(Box::new(
                        MigrateError::VersionMismatch(version),
                    )));
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
}

#[derive(Clone)]
pub struct DBService {
    pub pool: Pool<Sqlite>,
}

impl DBService {
    pub async fn new() -> Result<DBService, Error> {
        let options = Self::create_connection_options()?;
        let pool_options = Self::create_pool_options();
        let pool = pool_options.connect_with(options).await?;
        run_migrations(&pool).await?;
        Ok(DBService { pool })
    }

    fn create_connection_options() -> Result<SqliteConnectOptions, Error> {
        let database_url = format!(
            "sqlite://{}",
            asset_dir().join("db.sqlite").to_string_lossy()
        );

        Ok(SqliteConnectOptions::from_str(&database_url)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_SECS))
            .pragma("cache_size", "-64000")
            .pragma("temp_store", "MEMORY"))
    }

    fn create_pool_options() -> SqlitePoolOptions {
        SqlitePoolOptions::new()
            .max_connections(SQLITE_MAX_CONNECTIONS)
            .min_connections(2)
            .acquire_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_SECS))
    }

    pub async fn new_with_after_connect<F>(after_connect: F) -> Result<DBService, Error>
    where
        F: for<'a> Fn(
                &'a mut SqliteConnection,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<(), Error>> + Send + 'a>,
            > + Send
            + Sync
            + 'static,
    {
        let options = Self::create_connection_options()?;
        let pool_options = Self::create_pool_options();
        let after_connect = Arc::new(after_connect);

        let pool = pool_options
            .after_connect(move |conn, _meta| {
                let hook = after_connect.clone();
                Box::pin(async move {
                    hook(conn).await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await?;

        run_migrations(&pool).await?;
        Ok(DBService { pool })
    }
}
